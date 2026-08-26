import type { Room } from '../types/index.js';
import { onlinePlayers } from './online-players.js';

/**
 * The one place `abandonedAt` is set and cleared.
 *
 * Three paths trigger a presence change - a socket dropping, an explicit
 * departure, and the restore that follows a restart - and a room whose flag
 * disagrees with its occupants fails in one of two ways, both bad. Never set,
 * and the room is immortal: nobody is in it, so nobody can dissolve it, and the
 * sweep never names it. Set while two people are playing, and the room vanishes
 * under them twelve hours later.
 *
 * Keeping the transition in one function is what makes those two failures a
 * property of five lines rather than of three call sites.
 */

/** Marks a member away. Returns whether they were a member at all. */
export function markOffline(room: Room, userId: string, now: Date): boolean {
  const player = room.players.find(p => p.userId === userId);
  if (!player) return false;

  player.online = false;
  // Not reset if already set: the deadline starts when the room emptied, not
  // when the last straggler's socket finally timed out.
  if (onlinePlayers(room).length === 0 && !room.abandonedAt) room.abandonedAt = now;

  return true;
}

/** Marks a member present. Returns whether they were a member at all. */
export function markOnline(room: Room, userId: string): boolean {
  const player = room.players.find(p => p.userId === userId);
  if (!player) return false;

  player.online = true;
  room.abandonedAt = undefined;

  return true;
}

/**
 * Whether this room dies with the member who just left it.
 *
 * A room with one member is that member's own: nobody else is waiting in it,
 * nothing in it means anything to anyone else, and keeping it alive after their
 * window closes leaves a room `playing` with nobody in it - which is what
 * disables every Play button in their own library, since one player may only be
 * in one room. Two members is a group, and a group survives one of them
 * dropping: that is what `markOffline` above is for.
 */
export function endsWithItsPlayer(room: Room): boolean {
  return room.players.length <= 1;
}
