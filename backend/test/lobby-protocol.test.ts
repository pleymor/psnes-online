import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server, type Socket as ServerSocket } from 'socket.io';
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
const { createGame, findGameById, saveSram } = await import('../src/db/games.js');
const { createFriendshipRequest, acceptFriendship } = await import('../src/db/friendships.js');
const {
  createInvitation, findInvitationById, markInvitation, deleteExpiredInvitations
} = await import('../src/db/invitations.js');
const {
  registerRoomHandlers, pendingInvitationsFor, scheduleLeaveRoom, cancelScheduledLeave
} = await import('../src/websocket/room-handlers.js');
const { toPublicRoomFor } = await import('../src/websocket/room-view.js');
const { registerGameHandlers } = await import('../src/websocket/game-handlers.js');
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
  /** Alice's own library, with the checksum and cover the server recorded. */
  gameId: string;
  gameCrc32: string;
  gameCoverUrl: string;
  otherGameId: string;
  client(user: User): Promise<ClientSocket>;
  /**
   * Exactly what `websocket/index.ts` does when a socket drops, except that
   * the grace period is one a test can watch elapse.
   */
  drop(user: User, roomId: string, delayMs?: number): void;
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
    title: 'Chrono Trigger', filename: 'ct.sfc', crc32: 'DEADBEEF', userId: alice.id,
    ...NO_METADATA, coverUrl: '/covers/chrono-trigger.png'
  });
  const otherGame = createGame(db, {
    title: 'Super Metroid', filename: 'sm.sfc', crc32: 'CAFEBABE', userId: alice.id,
    ...NO_METADATA, coverUrl: '/covers/super-metroid.png'
  });

  const rooms = new Map<string, Room>();
  const socketsByUser = new Map<string, string>();
  const serverSockets = new Map<string, ServerSocket>();
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const getUserSocket = (id: string) => socketsByUser.get(id);

  io.on('connection', socket => {
    const userId = socket.handshake.auth.userId as string;
    const user = findUserById(db, userId)!;
    socketsByUser.set(userId, socket.id);
    serverSockets.set(userId, socket);
    registerRoomHandlers(socket, io, user, rooms, getUserSocket);
    // The SRAM and launch handlers live here too, and the defect they carried
    // only shows when a room-handler event (choose-game) and a game-handler
    // event (saveSram) are driven by two different players in the same room.
    registerGameHandlers(socket, io, user.id, rooms, getUserSocket);
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

  const drop = (user: User, roomId: string, delayMs?: number) =>
    scheduleLeaveRoom(io, serverSockets.get(user.id)!, roomId, rooms, user, getUserSocket, delayMs);

  try {
    await run({
      rooms, alice, bob, carol, client, drop,
      gameId: game.id, gameCrc32: 'DEADBEEF', gameCoverUrl: '/covers/chrono-trigger.png',
      otherGameId: otherGame.id
    });
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
      // Neither of these comes from the payload: the other player picks a file
      // off their own disk with the checksum, and the cover is rendered as an
      // image source in someone else's room.
      assert.equal(view.gameCrc32, gameCrc32);
      assert.equal(view.gameCoverUrl, '/covers/chrono-trigger.png');
    }

    // Changing one's mind before the launch is ordinary use, not an error.
    const rechosen = once<Room>(guest, 'room:updated');
    host.emit('room:choose-game', { roomId: room.id, gameId: otherGameId, gameTitle: 'Super Metroid' });
    const after = await rechosen;
    assert.equal(after.gameTitle, 'Super Metroid');
    assert.equal(after.gameCrc32, 'CAFEBABE');
    // Overwritten, not merged: the previous game's cover would be visibly wrong.
    assert.equal(after.gameCoverUrl, '/covers/super-metroid.png');

    /*
     * And the nuance the room screen has to know about: `Game.id` rows are
     * per-user, so a chooser who does not own the id gets no checksum rather
     * than someone else's.
     */
    const unowned = once<Room>(host, 'room:updated');
    guest.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });
    assert.equal((await unowned).gameCrc32, undefined);
  });
});

test('a room takes its cover from the server, and never wears one with no game', async () => {
  await withLobby(async ({ alice, bob, gameId, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    /*
     * A cover is an image source that the other player's screen renders, so it
     * comes from the game row the server holds - never from whoever named the
     * game. And a room with no game has no cover to wear, whatever the payload
     * asks for.
     */
    const bare = once<Room>(host, 'room:created');
    host.emit('room:create', { gameCoverUrl: 'http://elsewhere.example/x.png' });
    const bareRoom = await bare;
    assert.equal(bareRoom.gameCoverUrl, undefined);
    assert.equal(bareRoom.gameId, undefined);

    const withGame = once<Room>(host, 'room:created');
    host.emit('room:create', {
      gameId, gameTitle: 'Chrono Trigger', gameCoverUrl: 'http://elsewhere.example/x.png'
    });
    const room = await withGame;
    assert.equal(room.gameCoverUrl, '/covers/chrono-trigger.png');

    // And the same on the guest's path into someone else's room.
    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const acked = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: (await delivered).id });
    await acked;

    const seen = once<Room>(host, 'room:updated');
    guest.emit('room:choose-game', {
      roomId: room.id, gameId, gameTitle: 'Chrono Trigger',
      gameCoverUrl: 'http://elsewhere.example/x.png'
    });
    // The guest does not own this id, so the server has no facts to copy - and
    // publishes none rather than the ones it was handed.
    assert.equal((await seen).gameCoverUrl, undefined);
    assert.equal((await seen).gameCrc32, undefined);
  });
});

test('re-inviting restarts the clock instead of handing over the leftovers', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    // A row about to run out, as if the first invitation had been sent nine and
    // a half minutes ago. Aged by its deadline, never by waiting.
    const stale = createInvitation(db, room.id, alice.id, bob.id, new Date(Date.now() + 5_000));

    const delivered = once<{ id: string; expiresAt: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const view = await delivered;

    assert.equal(view.id, stale.id, 'still one invitation, not a second one');
    // The wire turns a Date into an ISO string, which is why this parses first.
    assert.ok(
      new Date(view.expiresAt).getTime() > Date.now() + 9 * 60_000,
      'a re-invited friend gets the full ten minutes, not thirty seconds'
    );
    assert.ok(findInvitationById(db, stale.id)!.expiresAt.getTime() > stale.expiresAt.getTime());

    const rows = db.prepare(`SELECT COUNT(*) AS c FROM "RoomInvitation" WHERE toUserId = ?`)
      .get(bob.id) as { c: number };
    assert.equal(rows.c, 1);
  });
});

test('a seat is released once the grace period elapses', async () => {
  await withLobby(async ({ alice, bob, client, rooms, drop }) => {
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
    assert.equal(rooms.get(room.id)!.players.length, 2);

    // Thirty milliseconds instead of forty-five seconds: the same code path,
    // and the only reason the delay is a parameter.
    const left = once<{ userId: string }>(host, 'player:left');
    drop(bob, room.id, 30);

    assert.equal((await left).userId, bob.id);
    assert.deepEqual(rooms.get(room.id)!.players.map(p => p.userId), [alice.id]);
  });
});

test('a dropped socket keeps its seat, and its real timer cannot hold the process open', async () => {
  await withLobby(async ({ alice, bob, client, rooms, drop }) => {
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

    /*
     * The real forty-five seconds this time, and the timer is deliberately
     * left armed when the test returns.
     *
     * Two things at once. A dropped socket is a blink, not a departure, so the
     * seat must still be there on the next line - removing it on the spot is
     * what used to destroy rooms mid-game. And this is the canary for the
     * timer being `unref`'d: were it not, this single line would add
     * forty-five seconds to the whole suite's exit.
     */
    drop(bob, room.id);

    assert.deepEqual(
      rooms.get(room.id)!.players.map(p => p.userId),
      [alice.id, bob.id],
      'a blink is not a departure'
    );
  });
});

test('a player who comes back inside the grace period keeps their seat', async () => {
  await withLobby(async ({ alice, bob, client, rooms, drop }) => {
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

    drop(bob, room.id, 30);
    cancelScheduledLeave(room.id, bob.id);

    /*
     * A second departure is the clock, so that nothing here sleeps: Alice's
     * timer is armed after Bob's and for the same delay, so when it fires Bob's
     * deadline has certainly passed. Bob still holding his seat at that point
     * is proof the cancellation took.
     */
    const left = once<{ userId: string }>(guest, 'player:left');
    drop(alice, room.id, 30);

    assert.equal((await left).userId, alice.id);
    assert.deepEqual(rooms.get(room.id)!.players.map(p => p.userId), [bob.id]);
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

test('room:join is a return trip, not a door: a non-member is refused while a seated player still gets back in', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const stranger = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    // Bob was never invited - the invitation is the only door now, and
    // `room:join` gives him the same answer any other room-scoped event gives
    // a non-member, rather than letting him in.
    const refused = once<{ message: string }>(stranger, 'error');
    stranger.emit('room:join', { roomId: room.id });
    assert.equal((await refused).message, 'Room not found');
    assert.deepEqual(rooms.get(room.id)!.players.map(p => p.userId), [alice.id]);

    // Alice, already seated, still gets back in through the same event.
    const rejoined = once<Room>(host, 'room:updated');
    host.emit('room:join', { roomId: room.id });
    assert.equal((await rejoined).players.length, 1);
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

/*
 * Battery saves, when the guest is the one who chose the game.
 *
 * `Game.id` is per-user: two players who own the same ROM own two different
 * rows. A room only ever holds the *chooser's* id, so the moment the guest
 * picks the game - the capability this whole branch exists for - that id is
 * not the host's, and the host is the machine that writes the battery file.
 * Everything below drives that exact pairing over real sockets.
 */

/** Invites Bob and seats him, which every SRAM test needs before it can start. */
async function seat(
  host: ClientSocket, guest: ClientSocket, roomId: string, bobId: string
): Promise<void> {
  const delivered = once<{ id: string }>(guest, 'lobby:invitation');
  host.emit('lobby:invite', { roomId, friendId: bobId });
  const acked = once(guest, 'lobby:accepted');
  guest.emit('lobby:accept', { invitationId: (await delivered).id });
  await acked;
}

/** Bob's own copy of the same cart: same checksum, a different row. */
function bobsOwnCopy(bobId: string) {
  return createGame(db, {
    title: 'Chrono Trigger', filename: 'ct.sfc', crc32: 'DEADBEEF', userId: bobId,
    ...NO_METADATA, coverUrl: '/covers/chrono-trigger.png'
  });
}

test('the guest chooses the game and the host saves: the battery lands in the host\'s own row', async () => {
  await withLobby(async ({ alice, bob, gameId, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;
    await seat(host, guest, room.id, bob.id);

    // Bob picks the cart out of *his* library, so the room now carries his row.
    const bobsGame = bobsOwnCopy(bob.id);
    const chosen = once<Room>(host, 'room:updated');
    guest.emit('room:choose-game', { roomId: room.id, gameId: bobsGame.id, gameTitle: 'Chrono Trigger' });
    const withGame = await chosen;
    assert.equal(withGame.gameId, bobsGame.id, 'the room holds the chooser\'s row, as it always has');
    assert.equal(withGame.gameCrc32, 'DEADBEEF', 'and the checksum that relates the two rows');

    // Alice is the host, so Alice's machine is the one that persists.
    const saved = once(host, 'game:sramSaved');
    host.emit('game:saveSram', { roomId: room.id, sramData: Buffer.from([0x5a, 0x5a, 0x01]).toString('base64') });
    await saved;

    const aliceRow = findGameById(db, gameId)!;
    assert.ok(aliceRow.sram, 'Alice\'s own row is where an hour of play has to end up');
    assert.deepEqual([...aliceRow.sram!], [0x5a, 0x5a, 0x01]);
    assert.ok(aliceRow.sramUpdatedAt instanceof Date);

    // And nothing was written into somebody else's library on the way.
    assert.equal(findGameById(db, bobsGame.id)!.sram, null);
  });
});

test('the guest chooses the game and the host loads: the host gets their own battery file back', async () => {
  await withLobby(async ({ alice, bob, gameId, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    // An hour of play already on disk, in Alice's row.
    saveSram(db, gameId, alice.id, Buffer.from([0xa5, 0xa5, 0x02]));

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;
    await seat(host, guest, room.id, bob.id);

    const bobsGame = bobsOwnCopy(bob.id);
    // Bob's copy holds different bytes, so a mix-up cannot pass unnoticed.
    saveSram(db, bobsGame.id, bob.id, Buffer.from([0xff, 0xff, 0xff]));

    const chosen = once<Room>(host, 'room:updated');
    guest.emit('room:choose-game', { roomId: room.id, gameId: bobsGame.id, gameTitle: 'Chrono Trigger' });
    await chosen;

    const loaded = once<{ sramData: string | null }>(host, 'game:sramLoaded');
    host.emit('game:loadSram', { roomId: room.id });
    const payload = await loaded;

    assert.ok(payload.sramData, 'the cart must not boot empty on the host\'s own battery file');
    assert.deepEqual([...Buffer.from(payload.sramData!, 'base64')], [0xa5, 0xa5, 0x02]);
  });
});

test('a player with no copy of the room\'s cart is refused out loud, never acknowledged', async () => {
  await withLobby(async ({ alice, bob, gameId, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', { gameId, gameTitle: 'Chrono Trigger' });
    const room = await created;
    await seat(host, guest, room.id, bob.id);

    // Bob owns nothing with this checksum: there is no row of his to write to,
    // and a write that changes nothing must not come back as a success.
    let acknowledged = false;
    guest.once('game:sramSaved', () => { acknowledged = true; });
    const refusedSave = once<{ message: string }>(guest, 'error');
    guest.emit('game:saveSram', { roomId: room.id, sramData: Buffer.from([1, 2, 3]).toString('base64') });
    assert.match((await refusedSave).message, /do not have a copy/i);
    assert.equal(acknowledged, false, 'the old bug was exactly this acknowledgement');

    // Nor may the refusal have reached into the host's library instead.
    assert.equal(findGameById(db, gameId)!.sram, null);

    let loadedAnyway = false;
    guest.once('game:sramLoaded', () => { loadedAnyway = true; });
    const refusedLoad = once<{ message: string }>(guest, 'error');
    guest.emit('game:loadSram', { roomId: room.id });
    assert.match((await refusedLoad).message, /do not have a copy/i);
    assert.equal(loadedAnyway, false, 'and reading someone else\'s battery is not an answer either');
  });
});

test('game:start is refused while no game has been chosen', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;
    await seat(host, guest, room.id, bob.id);

    /*
     * Reaching this needs a crafted client - the button is disabled and
     * `room:create` refuses `autoStart` without a game. Guarded anyway,
     * because the state it produces has no way out: `status` leaves `waiting`,
     * so `room:choose-game` starts refusing, both screens render nothing, and
     * there is no quit button on either of them.
     */
    let started = false;
    guest.once('game:started', () => { started = true; });
    const refused = once<{ message: string }>(host, 'error');
    host.emit('game:start', { roomId: room.id });
    assert.match((await refused).message, /No game has been chosen/);

    assert.equal(started, false);
    assert.equal(rooms.get(room.id)!.status, 'waiting', 'and the room stays where it can still be fixed');
  });
});

/**
 * What the public room view says about the invitation a room is waiting on.
 *
 * `expiresAt` is a string here and not a `Date`: Socket.IO serialises dates on
 * the way out and never revives them, so this is what a client actually holds.
 */
interface RoomView {
  id: string;
  invitation?: { id: string; toUserId: string; toDisplayName: string; expiresAt: string };
}

/**
 * The next `room:update` for this room that satisfies `matches`.
 *
 * Not `once`: a single room produces several public views in quick succession
 * - created, seated, invited - and taking whichever arrives first is how this
 * file would start failing on a busy machine. Still a wait for an event and
 * never for a duration.
 */
function viewWhere(
  socket: ClientSocket, roomId: string, matches: (view: RoomView) => boolean, ms = 5000
): Promise<RoomView> {
  return new Promise<RoomView>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room:update', onView);
      reject(new Error('timed out waiting for a matching room:update'));
    }, ms);

    function onView(view: RoomView) {
      if (view?.id !== roomId || !matches(view)) return;
      clearTimeout(timer);
      socket.off('room:update', onView);
      resolve(view);
    }

    socket.on('room:update', onView);
  });
}

test('a room takes one invitation at a time, and refuses the second', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    // A second accepted friend, so the refusal below can only be about the
    // invitation already standing: `lobby:invite` checks friendship before
    // anything else, and Carol's request with Alice was never accepted.
    const dave = insertUser(db, { id: `${room.id}-dave`, displayName: 'Dave' });
    acceptFriendship(db, createFriendshipRequest(db, alice.id, dave.id).id);

    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    await delivered;

    // Racing three friends is what this gives up, and it is given up on the
    // server: a rule only the screen enforced would let two tabs disagree with
    // it about what the room is waiting on.
    const refused = once<{ message: string }>(host, 'error');
    host.emit('lobby:invite', { roomId: room.id, friendId: dave.id });
    assert.match((await refused).message, /already been invited/);

    const rows = db.prepare(`SELECT COUNT(*) AS c FROM "RoomInvitation" WHERE roomId = ?`)
      .get(room.id) as { c: number };
    assert.equal(rows.c, 1, 'a refused invitation is one that was never written');
  });
});

test('cancelling takes the invitation out of the room view, so the invite panel comes back', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invited = viewWhere(host, room.id, view => Boolean(view.invitation));
    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const invitationId = (await delivered).id;

    /*
     * The room view is the whole point of the feature. Hiding the friend list
     * on the strength of a local flag would be a fact about one browser tab: a
     * reload would offer the panel again while the invitation was still
     * running, and would go on hiding it once the invitation had expired.
     */
    const waiting = await invited;
    assert.equal(waiting.invitation?.id, invitationId);
    assert.equal(waiting.invitation?.toUserId, bob.id);
    assert.equal(waiting.invitation?.toDisplayName, 'Bob', 'the screen names who is being waited on');
    assert.ok(new Date(waiting.invitation!.expiresAt).getTime() > Date.now(),
      'and says when the wait runs out');

    const cleared = viewWhere(host, room.id, view => !view.invitation);
    const droppedFromTray = once<{ invitationId: string }>(guest, 'lobby:invitation-cancelled');
    host.emit('lobby:cancel', { invitationId });

    assert.equal((await cleared).invitation, undefined,
      'the panel comes back because the room says so, not because a tab decided to');
    assert.equal((await droppedFromTray).invitationId, invitationId,
      'the invitee must lose it, or they accept something that no longer exists');

    // Withdrawn is not refused. Reusing `declined` would put the wrong sentence
    // in front of the invitee and leave the table unreadable afterwards.
    assert.equal(findInvitationById(db, invitationId)!.status, 'cancelled');
  });
});

test('an invitation that has run out does not block the next one', async () => {
  await withLobby(async ({ alice, bob, carol, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    /*
     * Aged by its deadline, never by waiting.
     *
     * Nothing writes `expired` into the table when it happens - there is nobody
     * watching as the ten minutes pass - so this row goes on reading `pending`
     * forever. A handler that trusted the column would let it lock Alice out of
     * inviting anybody, in a room whose invitation nobody can even see.
     */
    const ranOut = createInvitation(db, room.id, alice.id, carol.id, past());

    /*
     * Forced to the front of the ordering, and this is what makes the test a
     * guard rather than a coin flip.
     *
     * `listPendingInvitationsForRoom` orders `createdAt DESC` in epoch
     * milliseconds. Left alone, Carol's dead row and Bob's live one are written
     * a millisecond or more apart, so Bob sorts first and an implementation
     * that read `invitation.status` would *still* answer Bob - the assertion
     * below would pass and the defect would survive. Only a same-millisecond
     * tie surfaced Carol, which made detection a function of how fast the
     * machine was: five runs in nine, measured.
     *
     * With Carol pinned first, a status-reading implementation always answers
     * Carol and always fails. The correct implementation stays deterministic
     * too, because `invitationState` drops her before ordering can matter.
     */
    db.prepare(`UPDATE "RoomInvitation" SET createdAt = ? WHERE id = ?`)
      .run(Date.now() + 60_000, ranOut.id);

    const invited = viewWhere(host, room.id, view => Boolean(view.invitation));
    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const invitation = await delivered;

    assert.notEqual(invitation.id, ranOut.id, 'the dead row is not reused, it is ignored');
    assert.equal((await invited).invitation?.toUserId, bob.id,
      'and the room shows the live invitation, not the one that ran out');
    assert.equal(findInvitationById(db, ranOut.id)!.status, 'pending',
      'the dead row still reads pending: the column has never been the state');
  });
});

test('only a member of the room may cancel its invitation, whoever sent it', async () => {
  await withLobby(async ({ alice, bob, carol, client }) => {
    const host = await client(alice);
    const stranger = await client(carol);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    /*
     * Planted with Bob as the sender, which no handler produces today - a room
     * holding a pending invitation holds exactly one player, so the sender and
     * the only member are the same person. It is what makes the rule visible:
     * Alice may cancel because she is in the room, not because she sent it.
     */
    const invitation = createInvitation(db, room.id, bob.id, carol.id, future());

    // The same answer as for an id that does not exist. Telling the two apart
    // would confirm to an outsider that a room they are not in is waiting on
    // somebody - and Carol here is the invitee, which still is not membership.
    const refused = once<{ message: string }>(stranger, 'error');
    stranger.emit('lobby:cancel', { invitationId: invitation.id });
    assert.equal((await refused).message, 'Invitation not found');
    assert.equal(findInvitationById(db, invitation.id)!.status, 'pending');

    const cancelled = once<{ invitationId: string }>(host, 'lobby:cancelled');
    host.emit('lobby:cancel', { invitationId: invitation.id });
    assert.equal((await cancelled).invitationId, invitation.id);
    assert.equal(findInvitationById(db, invitation.id)!.status, 'cancelled');
  });
});

test('the invitee\'s name reaches the room, and stops there', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);

    /*
     * A friend of Alice's who is not in the room and has never met Bob.
     *
     * The public view goes to the host's friends as well as to the room's
     * players, which is right for everything else it carries - a friend
     * watching the lobby list is meant to see the room. The invitation is
     * different: it names a third person, with their display name and their
     * avatar. Alice inviting Bob is between Alice and Bob.
     *
     * Befriended before the room exists, and that ordering is load-bearing:
     * `services/friends.getFriendships` caches for thirty seconds, and
     * `room:create` warms that cache. A friendship accepted after it would not
     * be seen by any broadcast this test could then make, and the assertion
     * below would pass for the wrong reason - Dave receiving nothing at all.
     */
    const dave = findUserById(db, insertUser(db, { id: `${alice.id}-dave`, displayName: 'Dave' }).id)!;
    acceptFriendship(db, createFriendshipRequest(db, alice.id, dave.id).id);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const onlooker = await client(dave);

    const memberView = viewWhere(host, room.id, view => Boolean(view.invitation));
    // The first public view Dave ever sees for this room: he came online after
    // it was created, so nothing has reached him before this broadcast.
    const onlookerView = viewWhere(onlooker, room.id, () => true);
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });

    assert.equal((await memberView).invitation?.toDisplayName, 'Bob',
      'a member has to see it, or the panel this feature is made of cannot exist');
    assert.equal((await onlookerView).invitation, undefined,
      'and an onlooker never learns who was invited');

    /*
     * The same scoping on the two list paths, which hand out the identical
     * view: `rooms:list` at connection time and GET /api/rooms. Called
     * directly - this harness registers only the room handlers, so neither
     * list is reachable over the socket here, and leaving them uncovered is
     * how three of the four call sites would drift apart.
     */
    const live = rooms.get(room.id)!;
    assert.ok(toPublicRoomFor(live, alice.id).invitation, 'a member listing rooms still sees it');
    assert.equal(toPublicRoomFor(live, dave.id).invitation, undefined,
      'and listing a friend\'s room does not extend to whom they invited');
  });
});

test('a withdrawn invitation is not reported to the invitee as one they answered', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: room.id, friendId: bob.id });
    const invitationId = (await delivered).id;

    const cancelled = once(host, 'lobby:cancelled');
    host.emit('lobby:cancel', { invitationId });
    await cancelled;

    /*
     * The mid-click race, which is the only way a real invitee reaches this:
     * their tray still holds the row when the cancellation lands. Nobody
     * answered anything, so the sentence must not say they did - that is the
     * conflation the fourth status exists to prevent, and this is the last
     * place it survived.
     */
    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('lobby:accept', { invitationId });
    const message = (await refused).message;
    assert.match(message, /withdrawn/);
    assert.doesNotMatch(message, /answered/);
  });
});
