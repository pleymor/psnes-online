import type { RoomPlayer } from '../types/index.js';

/**
 * The players who are actually here.
 *
 * Since a member who closes their tab keeps their seat, `room.players` answers
 * "who belongs to this room" and no longer answers "who can a game start
 * against". Four sites need the second question and used to ask the first.
 *
 * Do not use this to decide whether the room is full, nor whether the invite
 * panel may be shown. An away member's seat is still theirs, and offering it to
 * someone else is the one thing this whole change exists to prevent.
 */
export function onlinePlayers(room: { players: RoomPlayer[] }): RoomPlayer[] {
  return room.players.filter(p => p.online === true);
}
