import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

/*
 * The lobby protocol, driven over real sockets.
 *
 * This is the only test in the repository that exercises a websocket handler,
 * and it exists because five handlers - create, choose-game, invite, accept,
 * decline - carry rules that no type can express: who may invite whom, what an
 * invitation is still worth once its room has been deleted, and whether an
 * error message tells a stranger something it should not.
 *
 * Nothing here is mocked except the one thing a socket cannot bring: the real
 * server reads the user id out of the Express session, so the handshake below
 * carries it instead. `registerRoomHandlers` takes the user as a parameter, so
 * every handler runs exactly the code production runs.
 *
 * Two rules kept this file from being flaky. It never sleeps - the only waits
 * are for the event being tested, and an invitation is aged by being created
 * with a deadline already in the past, the way `invitationState`'s own unit
 * tests age one. And every socket, every server and the database are closed,
 * because a leaked handle would hang the whole suite.
 */

const dir = mkdtempSync(join(tmpdir(), 'psnes-lobby-'));
// Set before the first getDb() call, which only ever happens inside a handler.
process.env.DATABASE_URL = `file:${join(dir, 'lobby.db')}`;

const { getDb } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertUser } = await import('./helpers.js');
const { findUserById } = await import('../src/db/users.js');
const { createGame } = await import('../src/db/games.js');
const { createFriendshipRequest, acceptFriendship } = await import('../src/db/friendships.js');
const {
  createInvitation, findInvitationById, markInvitation, deleteExpiredInvitations
} = await import('../src/db/invitations.js');
const { registerRoomHandlers, pendingInvitationsFor } = await import('../src/websocket/room-handlers.js');
type Room = import('../src/types/index.js').Room;
type User = import('../src/db/types.js').User;

const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

/** Waits for one event. Never for a duration: that is what makes this file deterministic. */
function once<T>(socket: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

interface Lobby {
  rooms: Map<string, Room>;
  alice: User;
  bob: User;
  /** A stranger: a pending friend request with Alice, never accepted. */
  carol: User;
  /** Alice's own library, with a checksum the server recorded. */
  gameId: string;
  gameCrc32: string;
  otherGameId: string;
  client(user: User): Promise<ClientSocket>;
}

let seq = 0;

/**
 * A running server with the real handlers, three users and one game.
 *
 * Users are fresh per lobby so that tests sharing the one database file never
 * see each other's invitation rows.
 */
async function withLobby(run: (lobby: Lobby) => Promise<void>): Promise<void> {
  const tag = `t${++seq}`;
  const alice = findUserById(db, insertUser(db, { id: `${tag}-alice`, displayName: 'Alice' }).id)!;
  const bob = findUserById(db, insertUser(db, { id: `${tag}-bob`, displayName: 'Bob' }).id)!;
  const carol = findUserById(db, insertUser(db, { id: `${tag}-carol`, displayName: 'Carol' }).id)!;

  acceptFriendship(db, createFriendshipRequest(db, alice.id, bob.id).id);
  // Left pending on purpose: a request nobody accepted is not a friendship.
  createFriendshipRequest(db, alice.id, carol.id);

  const game = createGame(db, {
    title: 'Chrono Trigger', filename: 'ct.sfc', crc32: 'DEADBEEF', userId: alice.id, ...NO_METADATA
  });
  const otherGame = createGame(db, {
    title: 'Super Metroid', filename: 'sm.sfc', crc32: 'CAFEBABE', userId: alice.id, ...NO_METADATA
  });

  const rooms = new Map<string, Room>();
  const socketsByUser = new Map<string, string>();
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);

  io.on('connection', socket => {
    const userId = socket.handshake.auth.userId as string;
    const user = findUserById(db, userId)!;
    socketsByUser.set(userId, socket.id);
    registerRoomHandlers(socket, io, user, rooms, id => socketsByUser.get(id));
  });

  await new Promise<void>(done => httpServer.listen(0, done));
  const port = (httpServer.address() as { port: number }).port;

  const clients: ClientSocket[] = [];
  const client = async (user: User) => {
    const socket = connect(`http://localhost:${port}`, {
      auth: { userId: user.id }, transports: ['websocket']
    });
    clients.push(socket);
    await once(socket, 'connect');
    return socket;
  };

  try {
    await run({ rooms, alice, bob, carol, gameId: game.id, gameCrc32: 'DEADBEEF', otherGameId: otherGame.id, client });
  } finally {
    for (const socket of clients) socket.close();
    await new Promise<void>(done => io.close(() => done()));
    if (httpServer.listening) await new Promise<void>(done => httpServer.close(() => done()));
  }
}

const TEN_MINUTES = 600_000;
const future = () => new Date(Date.now() + TEN_MINUTES);
/** An invitation created with this deadline is already expired, with no waiting. */
const past = () => new Date(Date.now() - 1);

test('a room is created with no game at all, and waits', async () => {
  await withLobby(async ({ alice, client, rooms }) => {
    const host = await client(alice);
    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    assert.equal(room.gameId, undefined);
    assert.equal(room.gameTitle, undefined);
    assert.equal(room.status, 'waiting');
    assert.equal(room.players.length, 1);
    assert.equal(rooms.get(room.id)?.hostId, alice.id);
  });
});

test('room:create refuses the two payloads it cannot make sense of', async () => {
  await withLobby(async ({ alice, gameId, client, rooms }) => {
    const host = await client(alice);

    // autoStart puts a room straight into `playing`; with no game that is a
    // state nothing can render and nothing can run.
    const refusedStart = once<{ message: string }>(host, 'error');
    host.emit('room:create', { autoStart: true });
    assert.match((await refusedStart).message, /without a game/);

    // Half a game would be a room whose gameId every guarded handler refuses.
    const refusedHalf = once<{ message: string }>(host, 'error');
    host.emit('room:create', { gameId });
    assert.match((await refusedHalf).message, /id and a title/);

    assert.equal(rooms.size, 0, 'neither refusal may leave a room behind');
  });
});

test('a non-member can neither choose the game nor invite, and learns nothing else', async () => {
  await withLobby(async ({ alice, bob, carol, gameId, client }) => {
    const host = await client(alice);
    await client(bob);
    const stranger = await client(carol);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const refusedChoice = once<{ message: string }>(stranger, 'error');
    stranger.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });
    assert.equal((await refusedChoice).message, 'Room not found');

    /*
     * The order of the checks is the point of this assertion. Membership is
     * tested before friendship, so someone outside the room gets the room
     * answer and never learns whether Alice and Bob are friends.
     */
    const refusedInvite = once<{ message: string }>(stranger, 'error');
    stranger.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    assert.equal((await refusedInvite).message, 'Room not found');
  });
});

test('only an accepted friend can be invited', async () => {
  await withLobby(async ({ alice, carol, client }) => {
    const host = await client(alice);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    // Alice and Carol have a request between them, never accepted.
    const refused = once<{ message: string }>(host, 'error');
    host.emit('lobby:invite', { roomId: room.id, friendId: carol.id });
    assert.match((await refused).message, /only invite a friend/);

    assert.equal(pendingInvitationsFor(db, carol.id, new Map([[room.id, room]]), new Date()).length, 0,
      'a refused invitation is one that was never written');
  });
});

test('an invitation reaches a connected friend, and re-inviting does not duplicate it', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const delivered = once<Record<string, unknown>>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const invitation = await delivered;

    assert.equal(invitation.roomId, room.id);
    assert.equal(invitation.fromUserId, alice.id);
    assert.equal(invitation.fromDisplayName, 'Alice');
    assert.equal(invitation.gameTitle, undefined, 'the room has no game yet, and says so');

    const redelivered = once<Record<string, unknown>>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    assert.equal((await redelivered).id, invitation.id, 'the same invitation comes back');

    const rows = db.prepare(`SELECT COUNT(*) AS c FROM "RoomInvitation" WHERE toUserId = ?`)
      .get(bob.id) as { c: number };
    assert.equal(rows.c, 1, 'reaching a friend twice must not leave two rows');
  });
});

test('accepting an invitation really seats the guest, through the join path', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const invitation = await delivered;

    const guestSees = once<Room>(guest, 'room:updated');
    const acked = once<{ roomId: string }>(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    const seen = await guestSees;
    assert.equal((await acked).roomId, room.id);

    assert.deepEqual(seen.players.map(p => [p.userId, p.port]), [[alice.id, 1], [bob.id, 2]]);

    /*
     * The server's own room, not just the broadcast: these are the fields only
     * the shared join path fills in. If `lobby:accept` ever grew its own copy
     * of the player construction, this is what would drift.
     */
    const seated = rooms.get(room.id)!.players.find(p => p.userId === bob.id)!;
    assert.equal(seated.port, 2);
    assert.equal(seated.isReady, true);
    assert.equal(seated.emulationReady, false);
    assert.equal(seated.displayName, 'Bob');
    assert.equal(typeof seated.keyConfig, 'object');
    assert.ok(seated.keyConfig, 'a seat without a key config would be a copy, not the join path');

    assert.equal(findInvitationById(db, invitation.id)!.status, 'accepted');
  });
});

test('an invitation cannot be accepted twice', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const invitation = await delivered;

    const acked = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await acked;

    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    assert.match((await refused).message, /already been answered/);
  });
});

test('a declined invitation does not become acceptable afterwards', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());

    const declined = once(guest, 'lobby:declined');
    guest.emit('lobby:decline', { invitationId: invitation.id });
    await declined;

    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    assert.match((await refused).message, /already been answered/);

    assert.equal(rooms.get(room.id)!.players.length, 1, 'and nobody joined');
  });
});

test('an expired invitation is refused', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    // Aged by its deadline, not by waiting: the row is expired the moment it exists.
    const invitation = createInvitation(db, room.id, alice.id, bob.id, past());

    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    assert.match((await refused).message, /expired/);

    assert.equal(rooms.get(room.id)!.players.length, 1);
  });
});

test('an invitation to a room that is gone is refused, and marked so it cannot be retried', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const guest = await client(bob);

    /*
     * A row naming a room that is not in the map. This is not a contrived
     * state: a room whose last player leaves is deleted, and an unclean
     * shutdown leaves rows behind, so `pending` says nobody answered - never
     * that there is anywhere to go.
     */
    const invitation = createInvitation(db, 'a-room-that-died', alice.id, bob.id, future());

    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    assert.equal((await refused).message, 'That room no longer exists');

    assert.notEqual(findInvitationById(db, invitation.id)!.status, 'pending');
  });
});

test('another user cannot answer an invitation that is not theirs', async () => {
  await withLobby(async ({ alice, bob, carol, client }) => {
    const host = await client(alice);
    const stranger = await client(carol);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());

    // The same answer as for an id that does not exist: telling them apart
    // would confirm that somebody else's invitation is real.
    const refused = once<{ message: string }>(stranger, 'error');
    stranger.emit('lobby:accept', { invitationId: invitation.id });
    assert.equal((await refused).message, 'Invitation not found');

    assert.equal(findInvitationById(db, invitation.id)!.status, 'pending');
  });
});

test('declining warns the inviter', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());

    const told = once<{ invitationId: string; displayName: string }>(host, 'lobby:invitation-declined');
    guest.emit('lobby:decline', { invitationId: invitation.id });
    const warning = await told;

    assert.equal(warning.invitationId, invitation.id);
    assert.equal(warning.displayName, 'Bob');
    assert.equal(findInvitationById(db, invitation.id)!.status, 'declined');
  });
});

test('choosing the game reaches both players with the server\'s own checksum, and can be redone', async () => {
  await withLobby(async ({ alice, bob, gameId, otherGameId, gameCrc32, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const acked = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: (await delivered).id });
    await acked;

    const hostSees = once<Room>(host, 'room:updated');
    const guestSees = once<Room>(guest, 'room:updated');
    host.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });

    for (const view of [await hostSees, await guestSees]) {
      assert.equal(view.gameTitle, 'Chrono Trigger');
      assert.equal(view.gameId, gameId);
      // Not from the payload: the guest picks a file off their own disk with it.
      assert.equal(view.gameCrc32, gameCrc32);
    }

    // Changing one's mind before the launch is ordinary use, not an error.
    const rechosen = once<Room>(guest, 'room:updated');
    host.emit('room:choose-game', { roomId: room.id, gameId: otherGameId, gameTitle: 'Super Metroid' });
    const after = await rechosen;
    assert.equal(after.gameTitle, 'Super Metroid');
    assert.equal(after.gameCrc32, 'CAFEBABE');

    /*
     * And the nuance the room screen has to know about: `Game.id` rows are
     * per-user, so a chooser who does not own the id gets no checksum rather
     * than someone else's. The room keeps a game with no checksum, which is
     * exactly the case `romAvailability` reports as `unknown`.
     */
    const unowned = once<Room>(host, 'room:updated');
    guest.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });
    assert.equal((await unowned).gameCrc32, undefined);
  });
});

test('an empty room takes its invitations with it', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());

    const destroyed = once<{ roomId: string }>(host, 'room:destroyed');
    host.emit('room:leave', { roomId: room.id });
    assert.equal((await destroyed).roomId, room.id);

    assert.equal(rooms.has(room.id), false);
    assert.equal(findInvitationById(db, invitation.id), null);
  });
});

test('a member can still rejoin, and a room that is gone answers instead of throwing', async () => {
  await withLobby(async ({ alice, gameId, client, rooms }) => {
    const host = await client(alice);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', { gameId, gameTitle: 'Chrono Trigger' });
    const room = await created;

    // The reconnection path: the seat is already theirs, so nothing is added.
    const rejoined = once<Room>(host, 'room:updated');
    host.emit('room:join', { roomId: room.id });
    assert.equal((await rejoined).players.length, 1);
    assert.equal(rooms.get(room.id)!.players.length, 1);

    const refused = once<{ message: string }>(host, 'error');
    host.emit('room:join', { roomId: 'no-such-room' });
    assert.equal((await refused).message, 'Room not found');
  });
});

test('the connection-time list keeps only live invitations naming live rooms', async () => {
  const alice = insertUser(db, { displayName: 'Alice' });
  const carol = insertUser(db, { displayName: 'Carol' });
  const roomId = `room-${carol.id}`;
  const rooms = new Map<string, Room>([[roomId, {
    id: roomId, hostId: alice.id, createdBy: alice.id, players: [],
    status: 'waiting', emulationMode: 'lockstep', createdAt: new Date()
  }]]);

  const live = createInvitation(db, roomId, alice.id, carol.id, future());
  const expired = createInvitation(db, roomId, alice.id, carol.id, past());
  const dead = createInvitation(db, 'a-room-that-died', alice.id, carol.id, future());
  const answered = createInvitation(db, roomId, alice.id, carol.id, future());
  markInvitation(db, answered.id, 'declined');

  const delivered = pendingInvitationsFor(db, carol.id, rooms, new Date());

  assert.deepEqual(delivered.map(i => i.id), [live.id]);
  assert.equal(delivered[0].fromDisplayName, 'Alice');
  // Still on disk, simply not offered: the sweep is what removes them.
  assert.ok(findInvitationById(db, expired.id));
  assert.ok(findInvitationById(db, dead.id));
});

test('the boot sweep deletes invitations whose deadline has passed, and only those', async () => {
  const alice = insertUser(db, { displayName: 'Alice' });
  const bob = insertUser(db, { displayName: 'Bob' });

  const live = createInvitation(db, 'room-live', alice.id, bob.id, future());
  const expired = createInvitation(db, 'room-expired', alice.id, bob.id, past());
  const answeredButLive = createInvitation(db, 'room-answered', alice.id, bob.id, future());
  markInvitation(db, answeredButLive.id, 'accepted');

  const swept = deleteExpiredInvitations(db, new Date());

  assert.ok(swept >= 1, 'the expired row is gone');
  assert.equal(findInvitationById(db, expired.id), null);
  assert.ok(findInvitationById(db, live.id));
  assert.ok(findInvitationById(db, answeredButLive.id), 'a deadline in the future is not the sweep\'s business');

  // The same boundary as invitationState: expired to a reader is expired here.
  const onTheDot = createInvitation(db, 'room-boundary', alice.id, bob.id, new Date());
  assert.equal(deleteExpiredInvitations(db, new Date(onTheDot.expiresAt)), 1);
  assert.equal(findInvitationById(db, onTheDot.id), null);
});
