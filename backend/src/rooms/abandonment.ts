import type { Room } from '../types/index.js';

/**
 * How long a room nobody is in survives before it is destroyed.
 *
 * Twelve hours covers the case this whole change is for: leave, change game,
 * have dinner, come back. It deliberately does not cover coming back the next
 * evening - that would need real persistence rather than a Redis snapshot, and
 * that is a separate piece of work, not a bigger number here.
 */
export const ABANDON_AFTER_MS = 12 * 60 * 60_000;

/**
 * Whether this room has waited long enough to be destroyed.
 *
 * `now` is a parameter and never `Date.now()`, for the same reason
 * `invitationState` takes one: without it no test can age a room, and the
 * expiry is precisely what has to be proved.
 *
 * No `abandonedAt` means somebody is still in the room, which is the common
 * case and is never abandoned.
 */
export function isAbandoned(room: { abandonedAt?: Date }, now: Date): boolean {
  if (!room.abandonedAt) return false;
  return now.getTime() - room.abandonedAt.getTime() >= ABANDON_AFTER_MS;
}

/**
 * The ids the caller should destroy.
 *
 * Naming them rather than destroying them keeps this pure: tearing a room down
 * needs sockets, cleanups and a broadcast, none of which belong in a decision.
 */
export function abandonedRoomIds(rooms: Map<string, Room>, now: Date): string[] {
  return [...rooms.values()].filter(room => isAbandoned(room, now)).map(room => room.id);
}
