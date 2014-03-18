(function() {
"use strict";


var peerWireSwarm = require('peer-wire-swarm');
var hat = require('hat');
var events = require('events');
var bitfield = require('bitfield');
var eos = require('end-of-stream');
var crypto = require('crypto');
var path = require('path');
var os = require('os');
var piece = require('./piece');
var storage = require('./storage');
var parseTorrent = require('parse-torrent');

var MAX_REQUESTS = 5;
var CHOKE_TIMEOUT = 5000;
var REQUEST_TIMEOUT = 30000;
var SPEED_THRESHOLD = 3 * piece.BLOCK_SIZE;

var noop = function() {};

var thruthy = function() {
	return true;
};

var falsy = function() {
	return false;
};

var toNumber = function(val) {
	return val === true ? 1 : (val || 0);
};

var bufferify = function(store) {
	var that = {};
	var mem = [];

	that.write = function(index, buffer, cb) {
		mem[index] = buffer;
		store.write(index, buffer, function(err) {
			mem[index] = null;
			if (cb) {cb(err);}
		});
	};

	that.read = function(index, cb) {
		if (mem[index]) {return cb(null, mem[index]);}
		store.read(index, cb);
	};

	that.destroy = function(cb) {
		if (!store.destroy) {return cb();}
		store.destroy(cb);
	};

	return that;
};

var engine = function(torrent, opts) {
	if (!opts) {opts = {};}
	if (!opts.path) {opts.path = path.join(opts.tmp || os.tmpDir(), 'peerflix', torrent.infoHash);}
	if (!opts.id) {opts.id = '-PF0007-'+hat(48);}

	var that = new events.EventEmitter();
	var swarm = peerWireSwarm(torrent.infoHash, opts.id, {
		size: opts.connections || opts.size,
		handshake: {
			extension_protocol: true
		}
	});

	var store, bits, pieces, reservations;
	var handleInfoDictionary = function(torrent) {
		store = bufferify(opts.storage || storage(opts.path, torrent));
		that.store = store;
		var pieceLength = torrent.pieceLength;
		var pieceRemainder = (torrent.length % pieceLength) || pieceLength;
		bits = bitfield(torrent.pieces.length);
		that.bitfield = bits;

		pieces = torrent.pieces.map(function(hash, i) {
			return piece(i === torrent.pieces.length-1 ? pieceRemainder : pieceLength);
		});

		reservations = torrent.pieces.map(function() {
			return [];
		});

		process.nextTick(function() {
			that.emit('info-dictionary');
		});

	};
	

	var wires = swarm.wires;
	

	
	

	var selection = [];
	var critical = [];

	that.amInterested = false;

	var verify = function(index, buffer) {
		return crypto.createHash('sha1').update(buffer).digest('hex') === torrent.pieces[index];
	};

	var oninterestchange = function() {
		var prev = that.amInterested;
		that.amInterested = !!selection.length;

		wires.forEach(function(wire) {
			if (that.amInterested) {wire.interested();}
			else {wire.uninterested();}
		});

		if (prev === that.amInterested) {return;}
		if (that.amInterested) {that.emit('interested');}
		else {that.emit('uninterested');}
	};

	var gc = function() {
		if (!has_info_dictionary) {
			return;
		}
		for (var i = 0; i < selection.length; i++) {
			var s = selection[i];
			var oldOffset = s.offset;

			while (!pieces[s.from+s.offset] && s.from+s.offset < s.to) {s.offset++;}

			if (oldOffset !== s.offset) {s.notify();}
			if (s.to !== s.from+s.offset) {continue;}
			if (pieces[s.from+s.offset]) {continue;}

			selection.splice(i, 1);
			i--; // -1 to offset splice
			s.notify();
			oninterestchange();
		}

		if (!selection.length) {that.emit('idle');}
	};

	var onpiececomplete = function(index, buffer) {
		if (!has_info_dictionary) {
			return;
		}
		if (!pieces[index]) {return;}

		pieces[index] = null;
		reservations[index] = null;
		bits.set(index, true);

		for (var i = 0; i < wires.length; i++) {wires[i].have(index);}

		that.emit('verify', index);
		that.emit('download', index, buffer);

		store.write(index, buffer);
		gc();
	};

	var onhotswap = opts.hotswap === false ? falsy : function(wire, index) {
		if (!has_info_dictionary) {
			return;
		}
		var speed = wire.downloadSpeed();
		if (speed < piece.BLOCK_SIZE) {return;}
		if (!reservations[index] || !pieces[index]) {return;}

		var r = reservations[index];
		var minSpeed = Infinity;
		var min;

		for (var i = 0; i < r.length; i++) {
			var other = r[i];
			if (!other || other === wire) {continue;}

			var otherSpeed = other.downloadSpeed();
			if (otherSpeed >= SPEED_THRESHOLD) {continue;}
			if (2 * otherSpeed > speed || otherSpeed > minSpeed) {continue;}

			min = other;
			minSpeed = otherSpeed;
		}

		if (!min) {return false;}

		for (var i = 0; i < r.length; i++) {
			if (r[i] === min) {r[i] = null;}
		}

		for (var i = 0; i < min.requests.length; i++) {
			var req = min.requests[i];
			if (req.piece !== index) {continue;}
			pieces[index].cancel((req.offset / piece.BLOCK_SIZE) | 0);
		}

		that.emit('hotswap', min, wire, index);
		return true;
	};

	var onupdatetick = function() {
		process.nextTick(onupdate);
	};

	var onrequest = function(wire, index, hotswap) {
		if (!has_info_dictionary) {
			return;
		}
		if (!pieces[index]) {return false;}

		var p = pieces[index];
		var reservation = p.reserve();

		if (reservation === -1 && hotswap && onhotswap(wire, index)) {reservation = p.reserve();}
		if (reservation === -1) {return false;}

		var r = reservations[index] || [];
		var offset = p.offset(reservation);
		var size = p.size(reservation);

		var i = r.indexOf(null);
		if (i === -1) {i = r.length;}
		r[i] = wire;

		wire.request(index, offset, size, function(err, block) {
			if (r[i] === wire) {r[i] = null;}

			if (p !== pieces[index]) {return onupdatetick();}

			if (err) {
				p.cancel(reservation);
				onupdatetick();
				return;
			}

			if (!p.set(reservation, block)) {return onupdatetick();}

			var buffer = p.flush();

			if (!verify(index, buffer)) {
				pieces[index] = piece(p.length);
				that.emit('invalid-piece', index, buffer);
				onupdatetick();
				return;
			}

			onpiececomplete(index, buffer);
			onupdatetick();
		});

		return true;
	};

	var onvalidatewire = function(wire) {
		if (wire.requests.length) {return;}

		for (var i = selection.length-1; i >= 0; i--) {
			var next = selection[i];
			for (var j = next.to; j >= next.from + next.offset; j--) {
				if (!wire.peerPieces[j]) {continue;}
				if (onrequest(wire, j, false)) {return;}
			}
		}
	};

	var speedRanker = function(wire) {
		var speed = wire.downloadSpeed() || 1;
		if (speed > SPEED_THRESHOLD) {return thruthy;}

		var secs = MAX_REQUESTS * piece.BLOCK_SIZE / speed;
		var tries = 10;
		var ptr = 0;

		return function(index) {
			if (!has_info_dictionary) {
				return;
			}
			if (!tries || !pieces[index]) {return true;}

			var missing = pieces[index].missing;
			for (; ptr < wires.length; ptr++) {
				var other = wires[ptr];
				var otherSpeed = other.downloadSpeed();

				if (otherSpeed < speed || !other.peerPieces[index]) {continue;}
				if (missing -= otherSpeed * secs > 0) {continue;}

				tries--;
				return false;
			}

			return true;
		};
	};

	var select = function(wire, hotswap) {
		if (wire.requests.length >= MAX_REQUESTS) {return true;}

		var rank = speedRanker(wire);

		for (var i = 0; i < selection.length; i++) {
			var next = selection[i];
			for (var j = next.from + next.offset; j <= next.to; j++) {
				if (!wire.peerPieces[j] || !rank(j)) {continue;}
				while (wire.requests.length < MAX_REQUESTS && onrequest(wire, j, critical[j] || hotswap));
				if (wire.requests.length >= MAX_REQUESTS) {return true;}
			}
		}

		return false;
	};

	var onupdatewire = function(wire) {
		if (wire.peerChoking) {return;}
		if (!wire.downloaded) {return onvalidatewire(wire);}
		select(wire, false) || select(wire, true);
	};

	var onupdate = function() {
		wires.forEach(onupdatewire);
	};

	var peerMayHaveInfoDictionary = function(peer) {
		var extproto_handshake = peer.extended_protocol_data.body;
		var support_mt_metadata = extproto_handshake && extproto_handshake.m && extproto_handshake.m.hasOwnProperty('ut_metadata');
		if (!support_mt_metadata) {
			return;
		}
		return true;
	};

	var canRequestInfodictionary = function(peer) {
		if (peer.peerChoking) {
			return;
		}
		if (!peerMayHaveInfoDictionary(peer)) {
			return;
		}
		if (!peer.extended_handshake_sended) {
			return;
		}
		return true;
	};
	var has_info_dictionary = false;


	var info_dictionary_handeled = false;
	var info_dictionary_pieces = null;
	var metadata_size;
	var getInfoDictionaryPieces = function() {
		if (!info_dictionary_pieces) {
			swarm.wires.forEach(function(peer) {
				if (peerMayHaveInfoDictionary(peer)) {
					if (peer.extended_protocol_data.body.hasOwnProperty('metadata_size')) {
						var full_size = peer.extended_protocol_data.body['metadata_size'];
						metadata_size = full_size;
						var pieces_num = Math.ceil( full_size / peer.metadata_block_size );

						info_dictionary_pieces = new Array(pieces_num);
					}
				}
			});
		}
		return info_dictionary_pieces;
	};
	var metadata_completed = false;
	var checkInfoDictionary = function() {
		if (has_info_dictionary || metadata_completed) {
			return;
		}
		var info_dictionary_pieces = getInfoDictionaryPieces();
		if (!info_dictionary_pieces) {
			return;
		}

		swarm.wires.forEach(function(peer) {
			if (!canRequestInfodictionary(peer)) {
				return;
			}
			for (var i = 0; i < info_dictionary_pieces.length; i++) {
				var piece_num = i;
				if (peer.requested_metadata_pieces[piece_num]) {
					continue;
				}
				peer.requestMetadataPiece(piece_num);
				console.log('info-dictionary requested');
			}

		});
	};
	
	var checkInfoDictionaryCompleteness = function() {
		if (has_info_dictionary) {
			return;
		}
		if (metadata_completed) {
			return;
		}
		var info_dictionary_pieces = getInfoDictionaryPieces();
		if (!info_dictionary_pieces) {
			return;
		}

		var i;
		var incomplete = false;

		for (i = 0; i < info_dictionary_pieces.length; i++) {
			var cur = info_dictionary_pieces[i];
			if (!cur) {
				swarm.wires.forEach(function(peer) {
					if (cur) {
						return;
					}
					cur = peer.requested_metadata_pieces[i] && peer.metadata_pieces[i];

				});
				if (cur) {
					info_dictionary_pieces[i] = cur;
				}
			}

			incomplete = incomplete || !cur;
		}

		if (!incomplete) {


			var result = new Uint8Array(metadata_size);

			var offset = 0;
			for (i = 0; i < info_dictionary_pieces.length; i++) {
				result.set( info_dictionary_pieces[i], offset );
				offset += info_dictionary_pieces[i].byteLength;
			}
			console.assert(offset == metadata_size);


			console.log('has_info_dictionary');


			var trnt = parseTorrent.parseInfoDictionary(new Buffer(result));
			if (torrent.infoHash == trnt.infoHash) {
				that.torrent = torrent = trnt;
				handleInfoDictionary(trnt);
				process.nextTick(gc);
				oninterestchange();
				onupdate();
			} else {

			}
			metadata_completed = true;
			has_info_dictionary = true;
			/*readTorrent(, function(err, trnt) {
				torrent = trnt;
				peerflix.torrent = trnt;
				handleInfoDictionary(trnt);
			});
			
			

			*/
		}

	};

	swarm.on('wire', function(wire) {
		wire.setTimeout(opts.timeout || REQUEST_TIMEOUT, function() {
			that.emit('timeout', wire);
			wire.destroy();
		});

		console.log('wire');


		wire.on('extended_hanshake', checkInfoDictionary);
		wire.on('extended_handshake_sended', checkInfoDictionary);
		wire.on('extprot_ut_metadata_data', checkInfoDictionaryCompleteness );
		checkInfoDictionary();

		if (bits) {
			wire.bitfield(bits);
		}
		if (wire.peerExtensions.extension_protocol) {
			if (!has_info_dictionary) {
				wire.on('unchoke', checkInfoDictionary);
				wire.sendExtendedHandshake();
				wire.interested();

				
			}
			
		}
		if (selection.length) {wire.interested();}

		var timeout = CHOKE_TIMEOUT;
		var id;

		var onchoketimeout = function() {
			if (swarm.queued > 2 * (swarm.size - swarm.wires.length) && wire.amInterested) {return wire.destroy();}
			id = setTimeout(onchoketimeout, timeout);
		};

		wire.on('close', function() {
			clearTimeout(id);
		});

		wire.on('choke', function() {
			clearTimeout(id);
			id = setTimeout(onchoketimeout, timeout);
		});

		wire.on('unchoke', function() {
			clearTimeout(id);
		});

		wire.on('request', function(index, offset, length, cb) {
			if (!has_info_dictionary) {
				return;
			}
			if (pieces[index]) {return;}
			store.read(index, function(err, buffer) {
				if (err) {return cb(err);}
				that.emit('upload', index, offset, length);
				cb(null, buffer.slice(offset, offset+length));
			});
		});

		wire.on('unchoke', onupdate);
		wire.on('bitfield', onupdate);
		wire.on('have', onupdate);

		wire.once('interested', function() {
			wire.unchoke();
		});

		id = setTimeout(onchoketimeout, timeout);
		that.emit('wire', wire);
	});

	that.torrent = torrent;
	that.selection = selection;
	that.swarm = swarm;
	

	that.connect = function(addr) {
		swarm.add(addr);
	};

	that.disconnect = function(addr) {
		swarm.remove(addr);
	};

	that.critical = function(piece, width) {
		for (var i = 0; i < (width || 1); i++) {critical[piece+i] = true;}
	};

	that.select = function(from, to, priority, notify) {
		selection.push({
			from:from,
			to:to,
			offset:0,
			priority: toNumber(priority),
			notify: notify || noop
		});

		selection.sort(function(a, b) {
			return b.priority - a.priority;
		});

		process.nextTick(gc);
		oninterestchange();
		onupdate();
	};

	that.deselect = function(from, to, priority) {
		for (var i = 0; i < selection.length; i++) {
			var s = selection[i];
			if (s.from !== from || s.to !== to) {continue;}
			if (s.priority !== toNumber(priority)){ continue;}
			selection.splice(i, 1);
			i--;
			break;
		}

		oninterestchange();
		onupdate();
	};

	that.bitfield = bits;

	that.verify = function(cb) {
		var done = function() {
			gc();
			if (cb) {cb();}
		};

		var loop = function(i) {
			if (!has_info_dictionary) {
				return;
			}
			if (i >= torrent.pieces.length) {return done();}

			store.read(i, function(err, buffer) {
				if (!buffer) {return loop(i+1);}
				if (!verify(i, buffer)) {return loop(i+1);}

				if (!pieces[i]) {return loop(i+1);}

				pieces[i] = null;
				bits.set(i, true);
				that.emit('verify', i);

				loop(i+1);
			});
		};

		loop(0);
	};

	that.listen = function(port, cb) {
		if (typeof port === 'function') {return that.listen(0, port);}
		swarm.listen(port || 6881, cb);
	};

	that.destroy = function(cb) {
		swarm.destroy();
		if (has_info_dictionary) {
			store.destroy(cb);
		}
		
	};


	has_info_dictionary = !!torrent.files;
	if (has_info_dictionary) {
		handleInfoDictionary(torrent);
	}

	return that;
};

module.exports = engine;
})();