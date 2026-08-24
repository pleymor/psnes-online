import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  findUserById, findUserByGoogleId, findUserByHandle, createUser,
  updateUserAvatar, upsertDevUser, findControlsConfig, updateControlsConfig,
  allocateDiscriminator, claimPseudo, toPublicUser, PseudoFullError
} from '../src/db/users.js';
import { DISCRIMINATOR_SPACE, padDiscriminator } from '../src/utils/pseudo.js';

test('createUser generates an id, both timestamps, and a handle', () => {
  const db = migratedDb();
  const user = createUser(db, { googleId: 'g-1', avatar: null });

  assert.ok(user.id.length > 0, 'an id should have been generated');
  assert.ok(user.createdAt instanceof Date);
  assert.ok(user.updatedAt instanceof Date);
  assert.equal(user.avatar, null);
  assert.equal(user.controlsConfig, null);
  assert.match(user.pseudo, /^[A-Za-z0-9_-]{3,16}$/);
  assert.match(user.discriminator, /^\d{4}$/);
});

test('a new account has not chosen its pseudonym, which is what opens the gate', () => {
  const db = migratedDb();
  const user = createUser(db, { googleId: 'g-1b', avatar: null });

  assert.equal(user.pseudoChosenAt, null);
});

test('dates come back as Date, and are integers on disk', () => {
  const db = migratedDb();
  const user = createUser(db, { googleId: 'g-2', avatar: null });

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

test('findUserByGoogleId finds the row it created', () => {
  const db = migratedDb();
  const created = createUser(db, { googleId: 'g-3', avatar: null });

  assert.equal(findUserByGoogleId(db, 'g-3')!.id, created.id);
  assert.equal(findUserByGoogleId(db, 'absent'), null);
});

test('a handle is found whatever case it is typed in', () => {
  const db = migratedDb();
  const user = insertUser(db, { pseudo: 'Sprite', discriminator: '0417' });

  assert.equal(findUserByHandle(db, 'Sprite', '0417')!.id, user.id);
  // The unique index folds case, so the lookup must too. Otherwise a player
  // typing a friend's handle in the wrong case is told nobody holds it, while
  // the database still refuses to let anyone else take it.
  assert.equal(findUserByHandle(db, 'sprite', '0417')!.id, user.id);
  assert.equal(findUserByHandle(db, 'SPRITE', '0417')!.id, user.id);
});

test('a handle with the wrong discriminator finds nobody', () => {
  const db = migratedDb();
  insertUser(db, { pseudo: 'Sprite', discriminator: '0417' });

  assert.equal(findUserByHandle(db, 'Sprite', '0418'), null);
});

test('updateUserAvatar moves updatedAt forward, which Prisma used to do for us', async () => {
  const db = migratedDb();
  const created = createUser(db, { googleId: 'g-4', avatar: null });
  await new Promise(r => setTimeout(r, 5));

  const updated = updateUserAvatar(db, created.id, 'a.png');

  assert.equal(updated.avatar, 'a.png');
  assert.ok(
    updated.updatedAt.getTime() > created.updatedAt.getTime(),
    'updatedAt must advance: @updatedAt is gone and nothing else will do it'
  );
});

test('a sign-in never overwrites the pseudonym the player chose', () => {
  const db = migratedDb();
  const created = createUser(db, { googleId: 'g-4b', avatar: null });
  const claimed = claimPseudo(db, created.id, 'Chosen');

  // updateUserAvatar is all a sign-in does now. Its predecessor,
  // updateUserProfile, rewrote displayName from the Google profile every time.
  const after = updateUserAvatar(db, created.id, 'b.png');

  assert.equal(after.pseudo, 'Chosen');
  assert.equal(after.discriminator, claimed.discriminator);
  assert.ok(after.pseudoChosenAt instanceof Date);
});

test('claiming a pseudonym stamps that it was chosen', () => {
  const db = migratedDb();
  const user = insertUser(db, { pseudoChosenAt: null });

  const handle = claimPseudo(db, user.id, 'Chosen');

  assert.equal(handle.pseudo, 'Chosen');
  assert.match(handle.discriminator, /^\d{4}$/);
  assert.ok(findUserById(db, user.id)!.pseudoChosenAt instanceof Date);
});

test('claiming refuses a pseudonym the format rule rejects', () => {
  const db = migratedDb();
  const user = insertUser(db);

  assert.throws(() => claimPseudo(db, user.id, 'ab'), TypeError);
  assert.throws(() => claimPseudo(db, user.id, 'Émile'), TypeError);
});

test('two players may share a pseudonym, but never a handle', () => {
  const db = migratedDb();
  const one = insertUser(db, { pseudo: 'Placeholder1' });
  const two = insertUser(db, { pseudo: 'Placeholder2' });

  const first = claimPseudo(db, one.id, 'Mario');
  const second = claimPseudo(db, two.id, 'Mario');

  assert.equal(first.pseudo, 'Mario');
  assert.equal(second.pseudo, 'Mario');
  assert.notEqual(first.discriminator, second.discriminator);
});

test('allocateDiscriminator returns the one slot left when 9 999 are taken', () => {
  const db = migratedDb();
  const insert = db.prepare(`
    INSERT INTO "User" (id, googleId, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (?, ?, 'Crowded', ?, NULL, NULL, NULL, 1, 1)
  `);
  db.transaction(() => {
    for (let n = 0; n < DISCRIMINATOR_SPACE; n++) {
      if (n === 4242) continue;
      insert.run(`u-${n}`, `g-${n}`, padDiscriminator(n));
    }
  })();

  assert.equal(allocateDiscriminator(db, 'Crowded'), '4242');
});

test('a pseudonym whose 10 000 slots are all taken is refused', () => {
  const db = migratedDb();
  const insert = db.prepare(`
    INSERT INTO "User" (id, googleId, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (?, ?, 'Crowded', ?, NULL, NULL, NULL, 1, 1)
  `);
  db.transaction(() => {
    for (let n = 0; n < DISCRIMINATOR_SPACE; n++) insert.run(`u-${n}`, `g-${n}`, padDiscriminator(n));
  })();

  assert.throws(() => allocateDiscriminator(db, 'Crowded'), PseudoFullError);
});

test('a collision on the way to the database is retried, not surfaced', () => {
  const db = migratedDb();
  const squatter = insertUser(db, { pseudo: 'Contested', discriminator: '0001' });
  const claimant = insertUser(db, { pseudo: 'Placeholder3' });

  // A generator that always points at the first free slot. The first call in
  // claimPseudo therefore picks '0000'; we take it out from under it between
  // the read and the write, which is exactly the race the unique index exists
  // to catch. Injecting the generator is what makes this path reachable at
  // all - drawing at random, it would be hit by luck alone.
  let draws = 0;
  const alwaysFirst = () => {
    if (draws++ === 0) {
      db.prepare(`
        INSERT INTO "User" (id, googleId, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
        VALUES ('interloper', 'g-interloper', 'Contested', '0000', NULL, NULL, NULL, 1, 1)
      `).run();
    }
    return 0;
  };

  const handle = claimPseudo(db, claimant.id, 'Contested', alwaysFirst);

  assert.equal(handle.pseudo, 'Contested');
  assert.equal(handle.discriminator, '0002', 'the first two slots were taken by the time it wrote');
  assert.ok(draws > 1, 'the first attempt must have collided and been retried');
  assert.equal(findUserById(db, squatter.id)!.discriminator, '0001', 'the squatter is untouched');
});

test('upsertDevUser puts a dev account into the state it declares', () => {
  const db = migratedDb();
  const input = {
    id: 'dev-user-1', googleId: 'dev-google-id-1',
    pseudo: 'DevOne', discriminator: '0001', pseudoChosenAt: Date.now(),
    avatar: 'first.svg'
  };

  const created = upsertDevUser(db, input);
  assert.equal(created.avatar, 'first.svg');

  const updated = upsertDevUser(db, { ...input, pseudo: 'DevOneBis', avatar: 'second.svg' });
  assert.equal(updated.id, 'dev-user-1');
  assert.equal(updated.avatar, 'second.svg');
  assert.equal(updated.pseudo, 'DevOneBis', 'a fixture is asserted, not merely created');

  const count = db.prepare(`SELECT COUNT(*) AS n FROM "User"`).get() as { n: number };
  assert.equal(count.n, 1);
});

test('a dev account declared as unchosen goes back in front of the gate every time', () => {
  // Found by running migration 0004 against the development database: it
  // leaves every existing row with pseudoChosenAt NULL, and an avatar-only
  // upsert could not put the dev accounts back past the gate. The same
  // mechanism is what makes the onboarding e2e test runnable twice.
  const db = migratedDb();
  const input = {
    id: 'dev-user-3', googleId: 'dev-google-id-3',
    pseudo: 'Newcomer', discriminator: '0003', pseudoChosenAt: null,
    avatar: 'third.svg'
  };

  upsertDevUser(db, input);
  claimPseudo(db, 'dev-user-3', 'Answered');
  assert.ok(findUserById(db, 'dev-user-3')!.pseudoChosenAt instanceof Date);

  const back = upsertDevUser(db, input);

  assert.equal(back.pseudoChosenAt, null, 'signing in again restores the declared state');
  assert.equal(back.pseudo, 'Newcomer');
});

test('a dev sign-in keeps the key bindings set while testing', () => {
  const db = migratedDb();
  const input = {
    id: 'dev-user-1', googleId: 'dev-google-id-1',
    pseudo: 'DevOne', discriminator: '0001', pseudoChosenAt: Date.now(),
    avatar: 'first.svg'
  };

  upsertDevUser(db, input);
  updateControlsConfig(db, 'dev-user-1', '{"up":"KeyW"}');
  upsertDevUser(db, input);

  assert.equal(findControlsConfig(db, 'dev-user-1'), '{"up":"KeyW"}',
    'controls are not part of the identity this function asserts');
});

test('controls config round-trips as an opaque JSON string', () => {
  const db = migratedDb();
  const user = insertUser(db);

  assert.equal(findControlsConfig(db, user.id), null);

  updateControlsConfig(db, user.id, '{"up":"ArrowUp"}');
  assert.equal(findControlsConfig(db, user.id), '{"up":"ArrowUp"}');
});

test('the public view of a player carries four fields and no others', () => {
  const db = migratedDb();
  const user = createUser(db, { googleId: 'g-public', avatar: 'a.png' });

  // The exact key set, because the failure to fear is a field appearing.
  assert.deepEqual(
    Object.keys(toPublicUser(user)).sort(),
    ['avatar', 'discriminator', 'id', 'pseudo']
  );
});
