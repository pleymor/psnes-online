import type { RoomPlayer } from '$lib/types';

/**
 * The players who are actually here.
 *
 * A deliberate twin of `backend/src/rooms/online-players.ts`. The two processes
 * share no module, so this is three duplicated lines rather than a package
 * invented for the occasion - but nothing stops them drifting, which is why
 * each side has its own test.
 *
 * Do not use this to decide whether the room is full, nor whether the invite
 * panel may be shown. An away member's seat is still theirs.
 */
export function onlinePlayers(room: { players: RoomPlayer[] }): RoomPlayer[] {
	return room.players.filter((p) => p.online === true);
}
