/**
 * The 5-minute KeyConfig cache must not survive a write.
 *
 * `getUserKeyConfig` caches player 1's `KeyConfig` per user, for the room
 * protocol. `PUT /controls` and `POST /controls/reset` invalidate that same
 * cache key (`keyconfig:${userId}`) right after writing, so a player who
 * rebinds does not keep playing on the config they just replaced for up to
 * five minutes.
 *
 * This exercises that exact sequence - write, then invalidate the key the
 * routes use - against the real cache and the real `getUserKeyConfig`. There
 * is no harness in this repo for driving the Express routes themselves
 * (confirmed: no supertest anywhere under backend/test), so this is the
 * closest direct test of the mechanism the routes rely on.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'psnes-user-config-'));
// Set before the first getDb() call, which only ever happens inside a handler.
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { getDb } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertUser } = await import('./helpers.js');
const { updateControlsConfig } = await import('../src/db/users.js');
const { getUserKeyConfig } = await import('../src/services/user-config.js');
const { getDefaultControlsConfig } = await import('../src/utils/key-config.js');
const { cache } = await import('../src/utils/cache.js');

const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a write is visible on the next read, not served from the stale cache', async () => {
  const user = insertUser(db);

  const original = getDefaultControlsConfig();
  updateControlsConfig(db, user.id, JSON.stringify(original));

  const first = await getUserKeyConfig(user.id);
  assert.equal(first.a, 'KeyX', 'reads the stored default first, populating the cache');

  const rebound = getDefaultControlsConfig();
  rebound.p1.keys.a = 'KeyM';
  updateControlsConfig(db, user.id, JSON.stringify(rebound));

  // Same key format (`keyconfig:${userId}`) that PUT /controls and
  // POST /controls/reset delete right after their own write.
  cache.delete(`keyconfig:${user.id}`);

  const second = await getUserKeyConfig(user.id);
  assert.equal(second.a, 'KeyM', 'the rebind is visible immediately, not after five minutes');
});

test('left uninvalidated, the cache would still answer with the old value', async () => {
  const user = insertUser(db);

  const original = getDefaultControlsConfig();
  updateControlsConfig(db, user.id, JSON.stringify(original));
  await getUserKeyConfig(user.id); // populates the cache

  const rebound = getDefaultControlsConfig();
  rebound.p1.keys.a = 'KeyM';
  updateControlsConfig(db, user.id, JSON.stringify(rebound));

  // No cache.delete here: this is the bug the invalidation fixes.
  const stillCached = await getUserKeyConfig(user.id);
  assert.equal(stillCached.a, 'KeyX', 'the cache, left uninvalidated, serves the replaced value');
});
