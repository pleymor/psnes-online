import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';

const logger = createLogger('RomTransfer');

/**
 * Hands a room's ROM to whichever player does not have it.
 *
 * ROMs live on players' machines now, which leaves whoever joins a room for a
 * cartridge they have no local copy of. Asking them to go and find a file they
 * may not have is the end of the session, so the other player sends it across
 * instead.
 *
 * This used to run one way only, host to guest, on the premise that the host
 * "by definition" holds the cartridge. That premise is false, and production
 * showed it on 2026-09-09: a library entry lives on the server while the bytes
 * live on one device, so a host playing from a second machine - or from a
 * browser whose storage was cleared - is the one without the file. Their
 * requests were dropped here, three times over two minutes, while the guest sat
 * holding the dump. Direction is now decided by who is missing what.
 *
 * What replaces "only the host may send" is "only to someone who asked". That
 * is the guard that was actually wanted: being in a room is not consent to
 * receive four megabytes, and having asked is. It is tracked per room in a
 * WeakMap, so an unanswered request costs nothing and is collected with the
 * room rather than needing a sweep.
 *
 * The server's part stays deliberately small: it checks that both ends are in
 * the room and that the recipient asked, then forwards chunks. It does not
 * assemble them, does not hold them, and never writes one down. That is the
 * whole point of the change this exists to support - a chunk is in memory only
 * for as long as it takes to pass it on.
 */

/** One chunk. Comfortably under the relay's own packet ceiling. */
const MAX_CHUNK_BYTES = 48 * 1024;

/**
 * Largest ROM we will pass along. The biggest commercial SNES cartridge is 6MB
 * (Tales of Phantasia); 12 leaves room for oddities without letting the socket
 * become a way to push arbitrary volume at another player.
 */
const MAX_ROM_BYTES = 12 * 1024 * 1024;

interface ChunkMessage {
	roomId: string;
	to: string;
	seq: number;
	total: number;
	byteLength: number;
	payload: ArrayBuffer | Buffer;
}

/**
 * Who is waiting for a ROM, and how far along the answer is.
 *
 * Keyed by the room object rather than by its id: the entry then dies with the
 * room, with no expiry to tune and no sweep to forget to run. A request that is
 * never answered simply stays open for as long as the room lives, which is the
 * right answer - the player did ask, and is still waiting.
 */
interface Pending {
	/** How many pieces this transfer says it takes; unknown until the first arrives. */
	total: number | null;
	/**
	 * Which pieces have gone through, by sequence number rather than as a count.
	 *
	 * A count would close the transfer too early whenever two answers overlap,
	 * which they do: both machines boot at once, so the asker repeats itself
	 * until someone replies and the answerer then serves every copy of the
	 * question it queued. Four arrivals of two distinct pieces would look like a
	 * finished four-piece transfer, and the two that never came would leave the
	 * receiver waiting out its stall timeout for a ROM it can no longer be sent.
	 */
	seen: Set<number>;
}

const awaiting = new WeakMap<Room, Map<string, Pending>>();

function askedFor(room: Room): Map<string, Pending> {
	let map = awaiting.get(room);
	if (!map) {
		map = new Map();
		awaiting.set(room, map);
	}
	return map;
}

export function registerRomTransferHandlers(
	socket: Socket,
	user: User,
	io: Server,
	rooms: Map<string, Room>,
	getUserSocket: (id: string) => string | undefined
) {
	/**
	 * A player asking the rest of the room for the cartridge.
	 *
	 * Everyone else is asked, which in a two-player room is the one other
	 * player. Whoever has the file answers; whoever has not says so, and the
	 * asker falls back to picking the file by hand.
	 */
	socket.on('rom:request', (data: { roomId: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'rom:request');
		if (!room) return;

		const others = room.players
			.map((p) => p.userId)
			.filter((id) => id !== user.id)
			.map((id) => ({ id, socketId: getUserSocket(id) }))
			.filter((peer): peer is { id: string; socketId: string } => Boolean(peer.socketId));

		if (others.length === 0) {
			socket.emit('rom:unavailable', {
				roomId: room.id,
				reason: 'The other player is not connected'
			});
			return;
		}

		// Recorded before the question goes out, so an answer that comes back in
		// the same tick is not refused for arriving too promptly.
		askedFor(room).set(user.id, { total: null, seen: new Set() });

		logger.info({ roomId: room.id, from: user.pseudo }, 'A player asked the room for the ROM');
		for (const peer of others) {
			io.to(peer.socketId).emit('rom:request', { roomId: room.id, from: user.id });
		}
	});

	socket.on('rom:chunk', (data: ChunkMessage) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'rom:chunk');
		if (!room) return;

		// The recipient has to be in this room; a room id does not authorise
		// pushing bytes at an arbitrary account.
		if (!room.players.some((p) => p.userId === data.to)) return;

		// And they have to have asked. This is what stops one player streaming
		// at the other under the guise of a transfer nobody wanted.
		const pending = askedFor(room).get(data.to);
		if (!pending) {
			logger.warn(
				{ roomId: room.id, userId: user.id, to: data.to },
				'Dropped a ROM chunk nobody asked for'
			);
			return;
		}

		const payload = data.payload;
		const length =
			payload instanceof ArrayBuffer
				? payload.byteLength
				: Buffer.isBuffer(payload)
					? payload.length
					: -1;

		if (length < 0 || length > MAX_CHUNK_BYTES) {
			logger.warn({ roomId: room.id, length }, 'Dropped an oversized ROM chunk');
			return;
		}
		if (!Number.isInteger(data.total) || data.total < 1 || data.total * MAX_CHUNK_BYTES > MAX_ROM_BYTES) {
			logger.warn({ roomId: room.id, total: data.total }, 'Dropped a ROM transfer of implausible size');
			return;
		}

		const target = getUserSocket(data.to);
		if (!target) return;

		io.to(target).emit('rom:chunk', {
			roomId: room.id,
			seq: data.seq,
			total: data.total,
			byteLength: data.byteLength,
			payload
		});

		// Tracked by sequence number rather than by watching for the last one: the
		// receiver is written to accept pieces in any order, and the relay should
		// not be the one component that quietly requires them to be in order.
		pending.total ??= data.total;
		pending.seen.add(data.seq);
		if (pending.seen.size >= pending.total) askedFor(room).delete(data.to);
	});

	/** No copy here either, so the asker should stop waiting and pick the file itself. */
	socket.on('rom:unavailable', (data: { roomId: string; to: string; reason?: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'rom:unavailable');
		if (!room) return;
		if (!askedFor(room).has(data.to)) return;

		const target = getUserSocket(data.to);
		if (!target) return;

		askedFor(room).delete(data.to);
		io.to(target).emit('rom:unavailable', { roomId: room.id, reason: data.reason });
	});
}
