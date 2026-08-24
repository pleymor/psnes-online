import type { Room } from '../types/index.js';
import { getRedis } from '../db/redis.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RoomSnapshot');

const KEY = 'psnes:rooms:v1';
/**
 * Bumped to 2 when RoomPlayer.displayName became RoomPlayer.pseudo.
 *
 * A snapshot written by the previous build carries the old field name, and
 * restoring it would give every player in a resumed room an undefined
 * pseudonym. The version check in restoreSnapshot already discards a body from
 * another build, so raising this number is the whole fix - at the cost of the
 * rooms in flight across that one deploy, which is what a backend restart
 * costs anyway.
 */
const VERSION = 2;
/**
 * A storage bound, not a lifetime.
 *
 * It used to be an hour and to double as the staleness rule, which it did
 * badly: "stored a long time ago" and "abandoned a long time ago" are different
 * questions, and only the second one has an answer worth acting on. The
 * abandonment sweep answers that one now, at restore, so this only has to
 * outlast any outage a snapshot should survive.
 */
export const TTL_SECONDS = 24 * 60 * 60;
const INTERVAL_MS = 1000;

/**
 * How many idle ticks before the key is touched.
 *
 * `writeSnapshot` skips writing when nothing changed, which means a world that
 * stops changing stops refreshing its key - and a durable room at rest is
 * exactly the state that never changes. An hour against a twenty-four hour TTL
 * leaves room for twenty-two missed refreshes in a row.
 *
 * Counted in ticks rather than measured against a clock: the interval is one
 * second, so counting is deterministic and a test drives it by calling the
 * function, without any time passing.
 */
export const REFRESH_EVERY_TICKS = 3600;

let idleTicks = 0;

/**
 * The subset of the Redis client this module uses, so tests can pass a stub.
 */
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  /** Pushes the deadline back without rewriting a body that has not changed. */
  expire(key: string, seconds: number): Promise<unknown>;
}

interface Snapshot {
  version: number;
  rooms: Room[];
}

let timer: NodeJS.Timeout | null = null;
/**
 * The last blob written, so an unchanged map costs nothing.
 *
 * This is also why the snapshot carries no timestamp: a `savedAt` field would
 * differ on every tick and the comparison would never match.
 */
let lastWritten = '';
/**
 * Whether a Redis read has ever completed without throwing.
 *
 * A failed `restoreRooms` leaves `rooms` empty and `lastWritten` at `''`, and
 * without this flag `writeSnapshot` cannot tell that empty state apart from a
 * boot that read an empty snapshot legitimately. Left unguarded, the interval
 * then overwrites a perfectly good snapshot with `{"rooms":[]}` one second
 * after a transient Redis failure, destroying every in-progress game instead
 * of merely failing to restore them for that one boot. Reflects the read
 * succeeding, not rooms being found - an empty snapshot read cleanly still
 * sets this, since there was nothing wrong to protect against.
 */
let hasReadSucceeded = false;

export function serialiseRooms(rooms: Map<string, Room>): string {
  const snapshot: Snapshot = { version: VERSION, rooms: [...rooms.values()] };
  return JSON.stringify(snapshot);
}

export function deserialiseRooms(raw: string | null): Map<string, Room> {
  const rooms = new Map<string, Room>();
  if (!raw) return rooms;

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(raw) as Snapshot;
  } catch {
    logger.warn('Discarding an unreadable room snapshot');
    return rooms;
  }

  // Refuse rather than coerce. An older Room shape read into the current type
  // gives a lobby that looks fine and behaves wrongly, which is harder to
  // diagnose than starting empty.
  if (snapshot?.version !== VERSION || !Array.isArray(snapshot.rooms)) {
    logger.warn({ version: snapshot?.version }, 'Discarding a room snapshot from another build');
    return rooms;
  }

  for (const room of snapshot.rooms) {
    if (!room?.id || !Array.isArray(room.players) || room.players.length === 0) continue;
    // JSON has no date type, and the rest of the app calls Date methods here.
    room.createdAt = new Date(room.createdAt);
    // Same reason as createdAt: `isAbandoned` calls getTime() on this. Left
    // undefined when absent - a room whose members were all present when the
    // snapshot was written has no deadline running.
    if (room.abandonedAt) room.abandonedAt = new Date(room.abandonedAt);
    rooms.set(room.id, room);
  }

  return rooms;
}

/**
 * Loads the snapshot into `rooms`.
 *
 * Everyone is disconnected by definition at this point, which is now an
 * ordinary state rather than an emergency: each restored member comes back as
 * away, and a room nobody returns to dies on the abandonment clock like any
 * other. The old five-minute restart grace existed because the alternative was
 * losing the room outright; there is no longer anything to lose.
 *
 * `onRestored` is injected rather than imported so this stays testable without
 * a socket.
 */
export async function restoreRooms(
  rooms: Map<string, Room>,
  onRestored: (room: Room) => void,
  store: Store = getRedis() as unknown as Store
): Promise<number> {
  let raw: string | null = null;
  try {
    raw = await store.get(KEY);
  } catch (err) {
    // Redis already backs sessions, so a failure here means the app is in
    // trouble regardless; an empty lobby beats refusing to boot.
    logger.error({ err }, 'Could not read the room snapshot; starting empty');
    return 0;
  }

  hasReadSucceeded = true;
  const restored = deserialiseRooms(raw);
  for (const [id, room] of restored) {
    rooms.set(id, room);
    onRestored(room);
  }

  lastWritten = serialiseRooms(rooms);
  logger.info({ rooms: restored.size }, 'Restored rooms from the snapshot');
  return restored.size;
}

/** Writes the snapshot unless it would be identical to the last one. */
export async function writeSnapshot(
  rooms: Map<string, Room>,
  store: Store = getRedis() as unknown as Store
): Promise<boolean> {
  // Refuse only while both are true: an unread snapshot could still be sitting
  // in Redis, so overwriting it with an empty one on the strength of an empty
  // in-memory map is exactly the failure this guard exists to prevent. Once a
  // room exists, though, writing is both safe and wanted - and a server that
  // failed its very first read must not be locked out of snapshotting forever.
  if (!hasReadSucceeded && rooms.size === 0) return false;

  const body = serialiseRooms(rooms);
  if (body === lastWritten) {
    if (++idleTicks < REFRESH_EVERY_TICKS) return false;
    idleTicks = 0;
    try {
      await store.expire(KEY, TTL_SECONDS);
    } catch (err) {
      logger.error({ err }, 'Could not refresh the room snapshot deadline');
    }
    return false;
  }

  idleTicks = 0;

  try {
    await store.set(KEY, body, { EX: TTL_SECONDS });
    lastWritten = body;
    return true;
  } catch (err) {
    // Never thrown at the caller: this runs on a timer and during shutdown,
    // where a rejection becomes an unhandledRejection at the worst moment.
    logger.error({ err }, 'Could not write the room snapshot');
    return false;
  }
}

export function startRoomSnapshots(rooms: Map<string, Room>): void {
  if (timer) return;
  timer = setInterval(() => void writeSnapshot(rooms), INTERVAL_MS);
  // Nothing should be kept alive by this timer.
  timer.unref();
}

export function stopRoomSnapshots(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * The write that matters. A deployment is a graceful shutdown, so this is what
 * makes the common case exact; the interval only covers a hard crash.
 *
 * Idempotent: a second signal stops an already-stopped timer and writes a blob
 * that is already `lastWritten`.
 */
export async function flushRooms(
  rooms: Map<string, Room>,
  store: Store = getRedis() as unknown as Store
): Promise<void> {
  stopRoomSnapshots();
  await writeSnapshot(rooms, store);
}

/** Test seam: forgets the last write so each test starts from nothing. */
export function resetSnapshotStateForTest(): void {
  lastWritten = '';
  hasReadSucceeded = false;
  idleTicks = 0;
  stopRoomSnapshots();
}
