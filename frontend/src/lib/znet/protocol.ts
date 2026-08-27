/**
 * Wire protocol for ZSNES-style lockstep netplay.
 *
 * Everything is a flat binary frame. The hot path (pad packets, 60 per second
 * per player) has to stay small enough that it never fragments, and the
 * control messages are rare enough that sharing the same encoder costs
 * nothing. JSON would have been simpler to read and roughly 8x larger for the
 * only message that ships continuously.
 */

/**
 * 2 added `strain` to the pad packet, 3 the sender's own input delay. A mismatch
 * fails the handshake rather than degrading, which is right: both peers load the
 * same deployed bundle, and a peer that silently ignored either field would
 * starve its partner with no way for either to find out why.
 */
export const PROTOCOL_VERSION = 3;

export enum MsgType {
	Hello = 1,
	Pads = 3,
	Crc = 4,
	State = 5,
	StateAck = 6,
	Desync = 7,
	Ping = 8,
	Pong = 9
}

/** Libretro joypad bit positions. Pads travel as raw masks, never translated. */
export const PAD = {
	B: 1 << 0,
	Y: 1 << 1,
	SELECT: 1 << 2,
	START: 1 << 3,
	UP: 1 << 4,
	DOWN: 1 << 5,
	LEFT: 1 << 6,
	RIGHT: 1 << 7,
	A: 1 << 8,
	X: 1 << 9,
	L: 1 << 10,
	R: 1 << 11
} as const;

export type PadMask = number;

export interface HelloMsg {
	type: MsgType.Hello;
	protocol: number;
	romCrc: number;
	playerIndex: number;
	playerCount: number;
}

/**
 * A run of pads starting at `baseFrame`, one entry per consecutive frame.
 *
 * Each packet deliberately repeats the last few frames the sender already
 * transmitted. A lost datagram then costs nothing: the next one carries the
 * missing pad. Asking for a retransmit instead would cost a full round trip
 * during which every peer is stalled, which is the one thing lockstep cannot
 * absorb.
 */
export interface PadsMsg {
	type: MsgType.Pads;
	playerIndex: number;
	epoch: number;
	baseFrame: number;
	/**
	 * How many of the sender's last 128 frames ran late *waiting on us*, capped
	 * at 255.
	 *
	 * Late means a gap wider than 1.5 times the machine's frame, which is a
	 * stutter a player sees. Frames the sender delayed by itself are excluded at
	 * the source: they look identical from here and no delay of ours can mend
	 * them, so counting them turned this field into an instruction to raise the
	 * delay for ever. This is the one number that separates a peer in
	 * trouble from a peer merely following: in lockstep one side always runs at
	 * the edge of the other's production, so its buffer sits near zero and its
	 * stall counter climbs even on a flawless link - but its frames still land on
	 * time. Measured against a deliberately generous split, the follower's late
	 * count was zero while its stalled-tick count was in the thousands.
	 *
	 * It travels because the fix does not belong to the peer that needs it: what
	 * fills a peer's buffer is its *partner's* input delay, and nothing it
	 * controls itself.
	 */
	strain: number;
	/**
	 * How far ahead of its current frame the sender samples its own input.
	 *
	 * The receiver needs it to know how far behind the sender is *entitled* to
	 * sit, which is what sizes the stall re-send window. It cannot be derived
	 * from the packet: the delay shows only in the gap between the sender's
	 * current frame and its newest pad, and the sender's current frame is not on
	 * the wire.
	 *
	 * Nor can it be assumed equal to our own. The two delays are deliberately
	 * independent - an uneven split is a feature, see `setInputDelay` - and a
	 * production session where the strain loop had walked one side to sixteen
	 * frames while the other sat at four deadlocked permanently the first time a
	 * packet went missing, because the re-send reached back only as far as this
	 * side's own delay.
	 */
	inputDelay: number;
	pads: PadMask[];
}

export interface CrcMsg {
	type: MsgType.Crc;
	playerIndex: number;
	epoch: number;
	frame: number;
	crc: number;
}

/**
 * A chunk of the host's savestate, plus the session parameters.
 *
 * The parameters ride along on every chunk rather than in a separate "start"
 * message on purpose. A separate message can arrive *after* the state it was
 * meant to configure - jitter reorders packets freely - and a guest that
 * adopts a state under the wrong input delay primes the wrong startup frames
 * and stalls forever. Three bytes per chunk removes the ordering problem.
 */
export interface StateMsg {
	type: MsgType.State;
	epoch: number;
	frame: number;
	totalLength: number;
	chunkIndex: number;
	chunkCount: number;
	inputDelay: number;
	crcInterval: number;
	/** Whether `payload` (across all chunks) is gzipped. */
	compressed: boolean;
	payload: Uint8Array;
}

export interface StateAckMsg {
	type: MsgType.StateAck;
	epoch: number;
	frame: number;
}

export interface DesyncMsg {
	type: MsgType.Desync;
	epoch: number;
	frame: number;
}

export interface PingMsg {
	type: MsgType.Ping;
	id: number;
}

export interface PongMsg {
	type: MsgType.Pong;
	id: number;
}

export type NetMsg =
	| HelloMsg
	| PadsMsg
	| CrcMsg
	| StateMsg
	| StateAckMsg
	| DesyncMsg
	| PingMsg
	| PongMsg;

export function encode(msg: NetMsg): Uint8Array {
	switch (msg.type) {
		case MsgType.Hello: {
			const buf = new Uint8Array(8);
			const view = new DataView(buf.buffer);
			buf[0] = MsgType.Hello;
			buf[1] = msg.protocol;
			view.setUint32(2, msg.romCrc >>> 0, true);
			buf[6] = msg.playerIndex;
			buf[7] = msg.playerCount;
			return buf;
		}
		case MsgType.Pads: {
			// A ten-byte header: neither the buffer report nor the sender's delay
			// fit in the eight the packet originally carried, and stealing spare
			// bits from playerIndex or the pad count would have saved a byte on a
			// packet that already has room to spare before it fragments.
			const buf = new Uint8Array(10 + msg.pads.length * 2);
			const view = new DataView(buf.buffer);
			buf[0] = MsgType.Pads;
			buf[1] = msg.playerIndex;
			buf[2] = msg.epoch;
			buf[3] = msg.pads.length;
			view.setUint32(4, msg.baseFrame >>> 0, true);
			buf[8] = Math.max(0, Math.min(255, msg.strain | 0));
			buf[9] = Math.max(0, Math.min(255, msg.inputDelay | 0));
			for (let i = 0; i < msg.pads.length; i++) {
				view.setUint16(10 + i * 2, msg.pads[i] & 0xffff, true);
			}
			return buf;
		}
		case MsgType.Crc: {
			const buf = new Uint8Array(12);
			const view = new DataView(buf.buffer);
			buf[0] = MsgType.Crc;
			buf[1] = msg.playerIndex;
			buf[2] = msg.epoch;
			view.setUint32(4, msg.frame >>> 0, true);
			view.setUint32(8, msg.crc >>> 0, true);
			return buf;
		}
		case MsgType.State: {
			const buf = new Uint8Array(20 + msg.payload.length);
			const view = new DataView(buf.buffer);
			buf[0] = MsgType.State;
			buf[1] = msg.epoch;
			buf[2] = msg.inputDelay;
			buf[3] = msg.compressed ? 1 : 0;
			view.setUint32(4, msg.frame >>> 0, true);
			view.setUint32(8, msg.totalLength >>> 0, true);
			view.setUint16(12, msg.chunkIndex, true);
			view.setUint16(14, msg.chunkCount, true);
			view.setUint16(16, msg.crcInterval, true);
			buf.set(msg.payload, 20);
			return buf;
		}
		case MsgType.StateAck: {
			const buf = new Uint8Array(8);
			const view = new DataView(buf.buffer);
			buf[0] = MsgType.StateAck;
			buf[1] = msg.epoch;
			view.setUint32(4, msg.frame >>> 0, true);
			return buf;
		}
		case MsgType.Desync: {
			const buf = new Uint8Array(8);
			const view = new DataView(buf.buffer);
			buf[0] = MsgType.Desync;
			buf[1] = msg.epoch;
			view.setUint32(4, msg.frame >>> 0, true);
			return buf;
		}
		case MsgType.Ping:
		case MsgType.Pong: {
			const buf = new Uint8Array(8);
			const view = new DataView(buf.buffer);
			buf[0] = msg.type;
			view.setUint32(4, msg.id >>> 0, true);
			return buf;
		}
	}
}

export function decode(data: Uint8Array): NetMsg | null {
	if (data.length < 1) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	switch (data[0]) {
		case MsgType.Hello:
			if (data.length < 8) return null;
			return {
				type: MsgType.Hello,
				protocol: data[1],
				romCrc: view.getUint32(2, true),
				playerIndex: data[6],
				playerCount: data[7]
			};
		case MsgType.Pads: {
			if (data.length < 10) return null;
			const count = data[3];
			if (data.length < 10 + count * 2) return null;
			const pads: number[] = new Array(count);
			for (let i = 0; i < count; i++) {
				pads[i] = view.getUint16(10 + i * 2, true);
			}
			return {
				type: MsgType.Pads,
				playerIndex: data[1],
				epoch: data[2],
				baseFrame: view.getUint32(4, true),
				strain: data[8],
				inputDelay: data[9],
				pads
			};
		}
		case MsgType.Crc:
			if (data.length < 12) return null;
			return {
				type: MsgType.Crc,
				playerIndex: data[1],
				epoch: data[2],
				frame: view.getUint32(4, true),
				crc: view.getUint32(8, true)
			};
		case MsgType.State: {
			if (data.length < 20) return null;
			return {
				type: MsgType.State,
				epoch: data[1],
				inputDelay: data[2],
				compressed: data[3] === 1,
				frame: view.getUint32(4, true),
				totalLength: view.getUint32(8, true),
				chunkIndex: view.getUint16(12, true),
				chunkCount: view.getUint16(14, true),
				crcInterval: view.getUint16(16, true),
				payload: data.slice(20)
			};
		}
		case MsgType.StateAck:
			if (data.length < 8) return null;
			return { type: MsgType.StateAck, epoch: data[1], frame: view.getUint32(4, true) };
		case MsgType.Desync:
			if (data.length < 8) return null;
			return { type: MsgType.Desync, epoch: data[1], frame: view.getUint32(4, true) };
		case MsgType.Ping:
			if (data.length < 8) return null;
			return { type: MsgType.Ping, id: view.getUint32(4, true) };
		case MsgType.Pong:
			if (data.length < 8) return null;
			return { type: MsgType.Pong, id: view.getUint32(4, true) };
		default:
			return null;
	}
}
