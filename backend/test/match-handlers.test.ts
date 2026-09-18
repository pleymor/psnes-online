/**
 * `match:report` : le port est un rôle netcode, pas le siège du salon.
 *
 * `rankableAt` (dans `match-handlers.ts`) doit dériver `p1UserId`/`p2UserId`
 * de `room.hostId`, jamais de `RoomPlayer.port`. Le siège se réassigne à tout
 * moment via `room:selectPort` sans jamais toucher `hostId`, alors que le
 * client pose toujours `playerIndex: isHost ? 0 : 1` - l'hôte est donc
 * toujours au port 1 côté netcode, quel que soit le siège qu'il occupe à
 * l'écran. Une lecture par `p.port === 1` créditerait le perdant dès qu'un
 * échange de sièges a eu lieu avant le KO.
 *
 * Suit le patron de faux socket de `game-resume-session.test.ts` : un vrai
 * handler, une vraie base SQLite, pas de serveur socket.io.
 */

import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'psnes-match-handlers-'));
// Avant le premier import qui pourrait toucher getDb() : lui seul lit
// DATABASE_URL, et seulement au premier appel.
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { registerMatchHandlers } = await import('../src/websocket/match-handlers.js');
type Room = import('../src/types/index.js').Room;

// `bun test` fait tourner tous les fichiers dans un seul processus, donc le
// singleton getDb() peut déjà tenir un descripteur (fermé) d'un autre fichier.
forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let serial = 0;

/** Un compte réel, identifiable - copie du patron d'`helpers.ts#insertUser`. */
function insertUser(): { id: string } {
  const now = Date.now();
  const n = serial++;
  const id = `user-${now}-${n}`;
  db.prepare(`
    INSERT INTO "User" (id, googleId, isAnonymous, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, 0, @pseudo, @discriminator, @now, NULL, NULL, @now, @now)
  `).run({
    id,
    googleId: `g-${now}-${n}`,
    pseudo: 'Tester',
    discriminator: String(n % 10000).padStart(4, '0'),
    now
  });
  return { id };
}

/** Le même patron que `game-resume-session.test.ts`. */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
      return this;
    },
    fire(event: string, payload: unknown) {
      return handlers.get(event)?.(payload);
    }
  };
}

test("un rapport crédite l'hôte au port 1 même quand il occupe le siège 2", () => {
  const host = insertUser();
  const guest = insertUser();

  // L'hôte a échangé son siège avec l'invité : room:selectPort les a mis en
  // porte-à-faux avec le rôle netcode. hostId reste host, comme toujours.
  const room: Room = {
    id: 'r1',
    hostId: host.id,
    createdBy: host.id,
    players: [
      { userId: host.id, pseudo: 'Host', port: 2, isReady: true, emulationReady: true, online: true, keyConfig: {} as never },
      { userId: guest.id, pseudo: 'Guest', port: 1, isReady: true, emulationReady: true, online: true, keyConfig: {} as never }
    ],
    status: 'playing',
    gameId: 'g1',
    gameTitle: 'Some Game',
    gameCrc32: 'DEADBEEF',
    playSessionId: 'session-1',
    emulationMode: 'lockstep',
    latencyMode: 'auto',
    createdAt: new Date()
  } as Room;

  const rooms = new Map<string, Room>([[room.id, room]]);
  const socket = fakeSocket();
  registerMatchHandlers(socket as never, {} as never, host.id, rooms);

  // `playerIndex: isHost ? 0 : 1` fait de l'hôte le port 1 côté netcode ; le
  // verdict dit donc que le port 1 (l'hôte) a gagné.
  socket.fire('match:report', {
    roomId: room.id,
    frame: 120,
    winner: 1,
    p1Health: 90,
    p2Health: 0
  });

  const stored = db.prepare(
    `SELECT p1UserId, p2UserId FROM "Match" WHERE roomId = ?`
  ).get(room.id) as { p1UserId: string | null; p2UserId: string | null };

  assert.equal(stored.p1UserId, host.id, "le port 1 doit rester l'hôte, pas le siège 1");
  assert.equal(stored.p2UserId, guest.id);
});
