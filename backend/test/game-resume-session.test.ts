/**
 * `game:resume` ne doit jamais renouveler `playSessionId`.
 *
 * C'est la règle la plus fragile de la tâche 8, et la plus facile à casser
 * sans le vouloir : trois sites du code écrivent `status = 'playing'`, et un
 * remaniement qui les "factorise" en un seul appel à `beginPlaySession` a
 * l'air d'un nettoyage. Il romprait en silence la déduplication autour d'une
 * pause - les deux rapports du même KO qui l'encadrent porteraient deux
 * identifiants, et la ligne serait écrite deux fois.
 *
 * `play-session.test.ts` ne pilote que la fonction pure ; ceci pilote le vrai
 * handler `game:resume` (et `game:start`, pour le contraste), à travers un
 * faux socket qui capture les `on(event, handler)` et les rejoue à la
 * demande - pas un serveur socket.io réel, qui serait disproportionné pour ce
 * qu'il y a à prouver ici. La base SQLite, elle, est réelle : `game:start`
 * traverse `broadcastRoomUpdate`, qui lit `getDb()`.
 */

import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'psnes-game-resume-'));
// Avant le premier import qui pourrait toucher getDb() : lui seul lit
// DATABASE_URL, et seulement au premier appel.
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { registerGameHandlers } = await import('../src/websocket/game-handlers.js');
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

/**
 * Un faux socket qui capture les gestionnaires par nom d'événement et les
 * rejoue à la demande - le même principe que `fakeSocket()` dans
 * `anonymous.test.ts`, étendu pour rendre ce que le gestionnaire rend (une
 * promesse, pour `game:start` qui est `async`).
 */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
      return this;
    },
    emit() {
      // Personne n'écoute ; seul l'état du salon est vérifié.
    },
    fire(event: string, payload: unknown) {
      return handlers.get(event)?.(payload);
    }
  };
}

/** `io.to(...).emit(...)` est appelé partout ; personne n'écoute ici non plus. */
const fakeIo = { to: () => ({ emit() {} }) };

const noSocket = () => undefined;

function room(): Room {
  return {
    id: 'r1',
    hostId: 'host',
    createdBy: 'host',
    players: [{
      userId: 'host',
      pseudo: 'Host',
      port: 1,
      isReady: true,
      emulationReady: false,
      online: true,
      keyConfig: {} as never
    }],
    status: 'waiting',
    gameId: 'g1',
    gameTitle: 'Some Game',
    emulationMode: 'lockstep',
    latencyMode: 'auto',
    createdAt: new Date()
  } as Room;
}

test('game:start pose une session neuve ; game:pause puis game:resume la conservent', async () => {
  const rooms = new Map<string, Room>();
  const r = room();
  rooms.set(r.id, r);

  const socket = fakeSocket();
  registerGameHandlers(socket as never, fakeIo as never, 'host', rooms, noSocket);

  await socket.fire('game:start', { roomId: r.id });
  assert.equal(r.status, 'playing');
  const started = r.playSessionId;
  assert.ok(started, 'game:start doit poser une session');

  socket.fire('game:pause', { roomId: r.id });
  assert.equal(r.status, 'paused');
  assert.equal(r.playSessionId, started, 'une pause ne touche pas la session');

  socket.fire('game:resume', { roomId: r.id });
  assert.equal(r.status, 'playing');
  assert.equal(
    r.playSessionId,
    started,
    'game:resume ne doit renouveler ni le statut ni la session : c est la reprise d une pause, pas un nouveau début'
  );
});
