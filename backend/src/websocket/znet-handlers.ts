import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';

const logger = createLogger('Znet');

/**
 * Relay for ZSNES-style lockstep netplay.
 *
 * ZSNES netplay designates one machine as the server and pushes every pad
 * packet through it. This plays the same role, with one deliberate
 * restriction: the server never looks inside a packet. It assigns player
 * slots, enforces room membership, and forwards bytes.
 *
 * Keeping it opaque matters. The wire format lives in
 * frontend/src/lib/znet/protocol.ts and is covered by tests that run without a
 * server at all; if the relay understood the format too, every protocol change
 * would need a matching deploy and the two copies would eventually disagree
 * about something subtle, which in a lockstep session means a desync.
 */

interface Slot {
	socketId: string;
	userId: string;
	playerIndex: number;
}

/** roomId -> player slots, in join order. */
const roomSlots = new Map<string, Slot[]>();

const MAX_PLAYERS = 2;

/** Largest packet we will relay. A savestate chunk is 16KB plus a header. */
const MAX_PACKET_BYTES = 64 * 1024;

function slotsFor(roomId: string): Slot[] {
	let slots = roomSlots.get(roomId);
	if (!slots) {
		slots = [];
		roomSlots.set(roomId, slots);
	}
	return slots;
}

function channel(roomId: string): string {
	// A separate socket.io room from the lobby channel: netplay traffic is
	// 60 packets a second and has no business reaching a lobby spectator.
	return `znet:${roomId}`;
}

export function registerZnetHandlers(
	socket: Socket,
	user: User,
	io: Server,
	rooms: Map<string, Room>
) {
	const joined = new Set<string>();

	socket.on('znet:join', (data: { roomId: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'znet:join');
		if (!room) {
			/*
			 * Say so when the room is genuinely gone - a restart, or a room
			 * destroyed while the player was away. Staying silent here is what
			 * made a lost session look like a freeze: the socket is healthy,
			 * the client re-joins on every reconnect, and every packet it
			 * sends afterwards is dropped for not being in the channel.
			 *
			 * Only when it is *absent*. A room that exists and simply does not
			 * have this caller in it must keep learning nothing, or the reply
			 * becomes a way to confirm a room id - which is the whole reason
			 * getMemberRoom exists.
			 */
			if (data?.roomId && !rooms.has(data.roomId)) {
				socket.emit('znet:error', {
					roomId: data.roomId,
					code: 'room-gone',
					message: 'This game is no longer on the server. It may have ended while you were away.'
				});
			}
			return;
		}

		const slots = slotsFor(room.id);

		// Reconnecting with the same account reclaims the same slot rather than
		// consuming a new one; the netplay session keys off the player index,
		// and a player who came back as index 2 would drive nothing.
		const existing = slots.find((s) => s.userId === user.id);
		let slot: Slot;

		if (existing) {
			existing.socketId = socket.id;
			slot = existing;
		} else {
			// The room host is always player 1, so its pads land on controller
			// port 1 on both machines.
			const isHost = room.hostId === user.id;
			const playerIndex = isHost ? 0 : nextFreeIndex(slots);
			if (playerIndex < 0 || playerIndex >= MAX_PLAYERS) {
				logger.warn({ roomId: room.id, userId: user.id }, 'Netplay room is full');
				socket.emit('znet:error', {
					roomId: room.id,
					code: 'session-full',
					message: 'This netplay session is full'
				});
				return;
			}
			slot = { socketId: socket.id, userId: user.id, playerIndex };
			slots.push(slot);
		}

		socket.join(channel(room.id));
		joined.add(room.id);

		logger.info(
			{ roomId: room.id, user: user.displayName, playerIndex: slot.playerIndex },
			'Joined netplay session'
		);

		socket.emit('znet:joined', {
			roomId: room.id,
			playerIndex: slot.playerIndex,
			isHost: room.hostId === user.id,
			playerCount: slots.length
		});

		socket.to(channel(room.id)).emit('znet:peer-joined', {
			roomId: room.id,
			playerIndex: slot.playerIndex,
			displayName: user.displayName
		});
	});

	socket.on('znet:packet', (data: { roomId: string; payload: ArrayBuffer | Buffer }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'znet:packet');
		if (!room) return;
		if (!joined.has(room.id)) return;

		const payload = data.payload;
		const length =
			payload instanceof ArrayBuffer
				? payload.byteLength
				: Buffer.isBuffer(payload)
					? payload.length
					: -1;

		if (length < 0 || length > MAX_PACKET_BYTES) {
			logger.warn({ roomId: room.id, userId: user.id, length }, 'Dropped malformed netplay packet');
			return;
		}

		// Straight through, unparsed. See the note at the top of this file.
		socket.to(channel(room.id)).emit('znet:packet', { roomId: room.id, payload });
	});

	socket.on('znet:leave', (data: { roomId: string }) => {
		if (!data?.roomId) return;
		leave(data.roomId);
	});

	socket.on('disconnect', () => {
		for (const roomId of joined) leave(roomId, true);
	});

	function leave(roomId: string, silent = false) {
		if (!joined.delete(roomId)) return;
		socket.leave(channel(roomId));

		const slots = roomSlots.get(roomId);
		if (slots) {
			const index = slots.findIndex((s) => s.socketId === socket.id);
			if (index >= 0) {
				const [gone] = slots.splice(index, 1);
				if (!silent) {
					logger.debug({ roomId, playerIndex: gone.playerIndex }, 'Left netplay session');
				}
				socket
					.to(channel(roomId))
					.emit('znet:peer-left', { roomId, playerIndex: gone.playerIndex });
			}
			if (slots.length === 0) roomSlots.delete(roomId);
		}
	}
}

function nextFreeIndex(slots: Slot[]): number {
	for (let i = 1; i < MAX_PLAYERS; i++) {
		if (!slots.some((s) => s.playerIndex === i)) return i;
	}
	return -1;
}

/** Called when a room is destroyed so slots do not leak. */
export function cleanupZnetRoom(roomId: string): void {
	roomSlots.delete(roomId);
}
