/**
 * The 5-minute KeyConfig cache must not survive a write.
 *
 * `getUserKeyConfig` caches player 1's `KeyConfig` per user, for the room
 * protocol. `writeUserControls` - called by both `PUT /controls` and
 * `POST /controls/reset` - writes the config and invalidates that same cache
 * key (`keyconfig:${userId}`) in the same place, so a player who rebinds does
 * not keep playing on the config they just replaced for up to five minutes.
 *
 * The invalidation lives in `writeUserControls` itself, in the module that
 * owns the cache, specifically so it can be exercised here without an HTTP
 * layer - this repo has no supertest/route-driving harness (confirmed: no
 * supertest anywhere under backend/test), and a rule that only a route
 * handler could trigger would only be testable through one.
 */

import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'psnes-user-config-'));
// Set before the first getDb() call, which only ever happens inside a handler.
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertUser } = await import('./helpers.js');
const { updateControlsConfig } = await import('../src/db/users.js');
const { getUserKeyConfig, writeUserControls } = await import('../src/services/user-config.js');
const { getDefaultControlsConfig } = await import('../src/utils/key-config.js');

// `bun test` runs every file in one process, so the getDb() singleton may
// already be holding another file's (closed) handle. See forgetDbForTest.
forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('writeUserControls makes a rebind visible on the very next read', async () => {
  const user = insertUser(db);

  const original = getDefaultControlsConfig();
  writeUserControls(user.id, original);

  const first = await getUserKeyConfig(user.id);
  assert.equal(first.a, 'KeyX', 'reads the stored default first, warming the cache');

  const rebound = getDefaultControlsConfig();
  rebound.p1.keys.a = 'KeyM';
  writeUserControls(user.id, rebound);

  const second = await getUserKeyConfig(user.id);
  assert.equal(second.a, 'KeyM', 'the rebind is visible immediately, not after five minutes');
});

test('a write that bypasses writeUserControls leaves the stale cache in place', async () => {
  // The control case: writing straight to the database, the way
  // writeUserControls did before it also invalidated the cache, reproduces
  // the staleness bug - proving the cache is real, not a silent no-op, and
  // that invalidation is what closes the gap.
  const user = insertUser(db);

  const original = getDefaultControlsConfig();
  updateControlsConfig(db, user.id, JSON.stringify(original));
  await getUserKeyConfig(user.id); // warms the cache

  const rebound = getDefaultControlsConfig();
  rebound.p1.keys.a = 'KeyM';
  updateControlsConfig(db, user.id, JSON.stringify(rebound)); // no invalidation

  const stillCached = await getUserKeyConfig(user.id);
  assert.equal(stillCached.a, 'KeyX', 'the cache, left uninvalidated, serves the replaced value');
});
