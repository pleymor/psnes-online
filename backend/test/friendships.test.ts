import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  listAcceptedFriendshipsFor, listAcceptedFriendshipsWithProfiles,
  listPendingRequestsFor, listFriendshipPairsFor, findFriendshipById,
  findFriendshipBetween, createFriendshipRequest, acceptFriendship, deleteFriendship
} from '../src/db/friendships.js';

test('a new request is pending, and findable from either side', () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });

  const created = createFriendshipRequest(db, ada.id, bo.id);

  assert.equal(created.status, 'pending');
  assert.ok(created.id.length > 0);
  assert.equal(findFriendshipBetween(db, ada.id, bo.id)!.id, created.id);
  assert.equal(findFriendshipBetween(db, bo.id, ada.id)!.id, created.id,
    'the pair is unordered: a request in either direction is the same friendship');
  assert.equal(findFriendshipBetween(db, ada.id, 'stranger'), null);
});

test('createFriendshipRequest returns both profiles nested, as the callers destructure them', () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });

  const created = createFriendshipRequest(db, ada.id, bo.id);

  assert.equal(created.initiator.pseudo, 'Ada');
  assert.equal(created.receiver.pseudo, 'Bob');
});

test('a nested profile carries these four fields and no others', () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });

  const created = createFriendshipRequest(db, ada.id, bo.id);

  // The exact key set, not the presence of the expected keys.
  //
  // The failure to fear here is a field turning up, not one going missing:
  // this query used to select all eight columns of User, so every friend
  // received googleId, email and controlsConfig. A field-by-field assertion
  // would pass just as happily if a SELECT * came back in six months.
  const expected = ['avatar', 'discriminator', 'id', 'pseudo'];
  assert.deepEqual(Object.keys(created.initiator).sort(), expected);
  assert.deepEqual(Object.keys(created.receiver).sort(), expected);
});

test('pending requests list only those received, with the initiator attached', () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });
  const cy = insertUser(db, { pseudo: 'Cyd' });

  createFriendshipRequest(db, ada.id, bo.id);   // Bo receives
  createFriendshipRequest(db, bo.id, cy.id);    // Bo sends

  const requests = listPendingRequestsFor(db, bo.id);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].initiator.pseudo, 'Ada');
});

test('accepting moves the status and advances updatedAt', async () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });
  const created = createFriendshipRequest(db, ada.id, bo.id);
  await new Promise(r => setTimeout(r, 5));

  const accepted = acceptFriendship(db, created.id);

  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.updatedAt.getTime() > created.updatedAt.getTime(),
    'the friends list shows updatedAt as "friends since"; it has to move');
  assert.equal(accepted.initiator.pseudo, 'Ada');
  assert.equal(accepted.receiver.pseudo, 'Bob');
});

test('accepted friendships are listed from both sides, pending ones are not', () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });
  const cy = insertUser(db, { pseudo: 'Cyd' });

  const accepted = createFriendshipRequest(db, ada.id, bo.id);
  acceptFriendship(db, accepted.id);
  createFriendshipRequest(db, ada.id, cy.id); // stays pending

  assert.equal(listAcceptedFriendshipsFor(db, ada.id).length, 1);
  assert.equal(listAcceptedFriendshipsFor(db, bo.id).length, 1);
  assert.equal(listAcceptedFriendshipsFor(db, cy.id).length, 0);
});

test('the profile-carrying list gives both sides, whichever end you are', () => {
  const db = migratedDb();
  const ada = insertUser(db, { pseudo: 'Ada' });
  const bo = insertUser(db, { pseudo: 'Bob' });
  acceptFriendship(db, createFriendshipRequest(db, ada.id, bo.id).id);

  const [fromBo] = listAcceptedFriendshipsWithProfiles(db, bo.id);

  assert.equal(fromBo.initiator.pseudo, 'Ada');
  assert.equal(fromBo.receiver.pseudo, 'Bob');
  assert.equal(fromBo.initiatorId, ada.id);
});

test('listFriendshipPairsFor returns every link regardless of status', () => {
  const db = migratedDb();
  const ada = insertUser(db);
  const bo = insertUser(db);
  const cy = insertUser(db);
  acceptFriendship(db, createFriendshipRequest(db, ada.id, bo.id).id);
  createFriendshipRequest(db, ada.id, cy.id);

  const pairs = listFriendshipPairsFor(db, ada.id);

  assert.equal(pairs.length, 2, 'search filters out pending links too, so they must be here');
  assert.deepEqual(Object.keys(pairs[0]).sort(), ['initiatorId', 'receiverId', 'status']);
});

test('deleting removes the row and leaves both users standing', () => {
  const db = migratedDb();
  const ada = insertUser(db);
  const bo = insertUser(db);
  const created = createFriendshipRequest(db, ada.id, bo.id);

  deleteFriendship(db, created.id);

  assert.equal(findFriendshipById(db, created.id), null);
  const users = db.prepare(`SELECT COUNT(*) AS n FROM "User"`).get() as { n: number };
  assert.equal(users.n, 2);
});

test('deleting a user cascades their friendships away', () => {
  const db = migratedDb();
  const ada = insertUser(db);
  const bo = insertUser(db);
  createFriendshipRequest(db, ada.id, bo.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(ada.id);

  const left = db.prepare(`SELECT COUNT(*) AS n FROM "Friendship"`).get() as { n: number };
  assert.equal(left.n, 0, 'onDelete: Cascade only works with foreign_keys ON');
});
