import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  findUserById, findUserByGoogleId, findUserByEmail, createUser,
  updateUserProfile, upsertDevUser, findControlsConfig, updateControlsConfig,
  searchUsers
} from '../src/db/users.js';

test('createUser generates an id and both timestamps', () => {
  const db = migratedDb();
  const user = createUser(db, {
    googleId: 'g-1', email: 'a@example.test', displayName: 'Ada', avatar: null
  });

  assert.ok(user.id.length > 0, 'an id should have been generated');
  assert.ok(user.createdAt instanceof Date);
  assert.ok(user.updatedAt instanceof Date);
  assert.equal(user.avatar, null);
  assert.equal(user.controlsConfig, null);
});

test('dates come back as Date, and are integers on disk', () => {
  const db = migratedDb();
  const user = createUser(db, {
    googleId: 'g-2', email: 'b@example.test', displayName: 'Bo', avatar: null
  });

  const raw = db.prepare(`SELECT typeof(createdAt) AS t FROM "User" WHERE id = ?`)
    .get(user.id) as { t: string };
  assert.equal(raw.t, 'integer', 'Prisma stored dates as epoch millis; so do we');

  const read = findUserById(db, user.id);
  assert.ok(read!.createdAt instanceof Date);
  assert.equal(read!.createdAt.getTime(), user.createdAt.getTime());
});

test('findUserById returns null rather than throwing on a missing row', () => {
  const db = migratedDb();
  assert.equal(findUserById(db, 'nobody'), null);
});

test('findUserByGoogleId and findUserByEmail find the same row', () => {
  const db = migratedDb();
  const created = createUser(db, {
    googleId: 'g-3', email: 'c@example.test', displayName: 'Cy', avatar: null
  });

  assert.equal(findUserByGoogleId(db, 'g-3')!.id, created.id);
  assert.equal(findUserByEmail(db, 'c@example.test')!.id, created.id);
  assert.equal(findUserByGoogleId(db, 'absent'), null);
});

test('updateUserProfile moves updatedAt forward, which Prisma used to do for us', async () => {
  const db = migratedDb();
  const created = createUser(db, {
    googleId: 'g-4', email: 'd@example.test', displayName: 'Di', avatar: null
  });
  await new Promise(r => setTimeout(r, 5));

  const updated = updateUserProfile(db, created.id, { displayName: 'Dee', avatar: 'a.png' });

  assert.equal(updated.displayName, 'Dee');
  assert.equal(updated.avatar, 'a.png');
  assert.ok(
    updated.updatedAt.getTime() > created.updatedAt.getTime(),
    'updatedAt must advance: @updatedAt is gone and nothing else will do it'
  );
});

test('upsertDevUser creates then updates only the avatar', () => {
  const db = migratedDb();
  const input = {
    id: 'dev-user-1', googleId: 'dev-google-id-1',
    email: 'user1@dev.local', displayName: 'Dev User 1', avatar: 'first.svg'
  };

  const created = upsertDevUser(db, input);
  assert.equal(created.avatar, 'first.svg');

  const updated = upsertDevUser(db, { ...input, displayName: 'Ignored', avatar: 'second.svg' });
  assert.equal(updated.id, 'dev-user-1');
  assert.equal(updated.avatar, 'second.svg');
  assert.equal(updated.displayName, 'Dev User 1', 'only the avatar is refreshed, as before');

  const count = db.prepare(`SELECT COUNT(*) AS n FROM "User"`).get() as { n: number };
  assert.equal(count.n, 1);
});

test('controls config round-trips as an opaque JSON string', () => {
  const db = migratedDb();
  const user = insertUser(db);

  assert.equal(findControlsConfig(db, user.id), null);

  updateControlsConfig(db, user.id, '{"up":"ArrowUp"}');
  assert.equal(findControlsConfig(db, user.id), '{"up":"ArrowUp"}');
});

test('searchUsers matches email or display name, excludes the caller, and caps results', () => {
  const db = migratedDb();
  const me = insertUser(db, { displayName: 'Searcher', email: 'me@example.test' });
  insertUser(db, { displayName: 'Mario Fan', email: 'mario@example.test' });
  insertUser(db, { displayName: 'Someone', email: 'zelda@example.test' });

  const byName = searchUsers(db, me.id, 'Mario', 10);
  assert.equal(byName.length, 1);
  assert.equal(byName[0].displayName, 'Mario Fan');

  const byEmail = searchUsers(db, me.id, 'zelda', 10);
  assert.equal(byEmail.length, 1);

  const self = searchUsers(db, me.id, 'Searcher', 10);
  assert.equal(self.length, 0, 'the caller is never their own suggestion');

  const capped = searchUsers(db, me.id, 'example.test', 1);
  assert.equal(capped.length, 1);
});

test('searchUsers never exposes googleId or timestamps', () => {
  const db = migratedDb();
  const me = insertUser(db);
  insertUser(db, { displayName: 'Visible' });

  const [found] = searchUsers(db, me.id, 'Visible', 10);
  assert.deepEqual(Object.keys(found).sort(), ['avatar', 'displayName', 'email', 'id']);
});
