import type { Room } from '../types/index.js';
import { getRedis } from '../db/redis.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RoomSnapshot');

const KEY = 'psnes:rooms:v1';
const VERSION = 1;
/** A backstop, so a long outage cannot resurrect a stale world. */
const TTL_SECONDS = 3600;
const INTERVAL_MS = 1000;

/**
 * The subset of the Redis client this module uses, so tests can pass a stub.
 */
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
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
    rooms.set(room.id, room);
  }

  return rooms;
}

/**
 * Loads the snapshot into `rooms` and holds every restored player's seat.
 *
 * Every player is disconnected by definition at this point, so each one gets
 * the ordinary departure grace period: a room nobody comes back to then dies
 * exactly as it would have if the server had never restarted. `holdSeat` is
 * injected rather than imported so this stays testable without a socket.
 */
export async function restoreRooms(
  rooms: Map<string, Room>,
  holdSeat: (roomId: string, userId: string) => void,
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

  const restored = deserialiseRooms(raw);
  for (const [id, room] of restored) {
    rooms.set(id, room);
    for (const player of room.players) holdSeat(id, player.userId);
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
  const body = serialiseRooms(rooms);
  if (body === lastWritten) return false;

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
  stopRoomSnapshots();
}
