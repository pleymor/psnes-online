import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';

const logger = createLogger('RomTransfer');

/**
 * Hands a room's ROM from the host to a guest who does not have it.
 *
 * ROMs live on players' machines now, which leaves the guest who joins a room
 * for a cartridge they do not own. Asking them to go and find a file they may
 * not have is the end of the session, so the host - who by definition has it
 * loaded - sends it across instead.
 *
 * The server's part is deliberately small: it checks that both ends are in the
 * room, then forwards chunks between them. It does not assemble them, does not
 * hold them, and never writes one down. That is the whole point of the change
 * this exists to support - a chunk is in memory only for as long as it takes to
 * pass it on.
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

export function registerRomTransferHandlers(
	socket: Socket,
	user: User,
	io: Server,
	rooms: Map<string, Room>,
	getUserSocket: (id: string) => string | undefined
) {
	/**
	 * A guest asking the host for the cartridge.
	 *
	 * Only the host is asked. Any other member would be a guest too, and just
	 * as likely to be missing the file.
	 */
	socket.on('rom:request', (data: { roomId: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'rom:request');
		if (!room) return;

		if (room.hostId === user.id) return;

		const hostSocket = getUserSocket(room.hostId);
		if (!hostSocket) {
			socket.emit('rom:unavailable', { roomId: room.id, reason: 'The host is not connected' });
			return;
		}

		logger.info({ roomId: room.id, from: user.pseudo }, 'Guest asked the host for the ROM');
		io.to(hostSocket).emit('rom:request', { roomId: room.id, from: user.id });
	});

	socket.on('rom:chunk', (data: ChunkMessage) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'rom:chunk');
		if (!room) return;

		// Only the host sends. Otherwise a guest could stream bytes at the other
		// player under the guise of a transfer they never asked for.
		if (room.hostId !== user.id) {
			logger.warn({ roomId: room.id, userId: user.id }, 'Rejected a ROM chunk from a non-host');
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

		// The recipient has to be in this room; a room id does not authorise
		// pushing bytes at an arbitrary account.
		if (!room.players.some((p) => p.userId === data.to)) return;

		const target = getUserSocket(data.to);
		if (!target) return;

		io.to(target).emit('rom:chunk', {
			roomId: room.id,
			seq: data.seq,
			total: data.total,
			byteLength: data.byteLength,
			payload
		});
	});

	/** The host has no copy either, so the guest should stop waiting and ask its player. */
	socket.on('rom:unavailable', (data: { roomId: string; to: string; reason?: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'rom:unavailable');
		if (!room || room.hostId !== user.id) return;

		const target = getUserSocket(data.to);
		if (!target) return;

		io.to(target).emit('rom:unavailable', { roomId: room.id, reason: data.reason });
	});
}
