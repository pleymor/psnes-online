import { test, afterAll } from 'bun:test';
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

const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertUser } = await import('./helpers.js');
const { findUserById } = await import('../src/db/users.js');
const { createGame, findGameById, saveSram } = await import('../src/db/games.js');
const { createFriendshipRequest, acceptFriendship } = await import('../src/db/friendships.js');
const {
  createInvitation, findInvitationById, markInvitation, deleteExpiredInvitations
} = await import('../src/db/invitations.js');
const { createSave } = await import('../src/db/saves.js');
const {
  registerRoomHandlers, markPlayerAway, markPlayerPresent
} = await import('../src/websocket/room-handlers.js');
const { registerInvitationHandlers, pendingInvitationsFor } = await import('../src/websocket/invitation-handlers.js');
const { toPublicRoomFor } = await import('../src/websocket/room-view.js');
const { registerGameHandlers } = await import('../src/websocket/game-handlers.js');
type Room = import('../src/types/index.js').Room;
type User = import('../src/db/types.js').User;

// `bun test` runs every file in one process, so the getDb() singleton may
// already be holding another file's (closed) handle. See forgetDbForTest.
forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

afterAll(() => {
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
  /** Closes this user's socket for real, and waits for the server to notice. */
  drop(user: User): Promise<void>;
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
  const alice = findUserById(db, insertUser(db, { id: `${tag}-alice`, pseudo: 'Alice' }).id)!;
  const bob = findUserById(db, insertUser(db, { id: `${tag}-bob`, pseudo: 'Bob' }).id)!;
  const carol = findUserById(db, insertUser(db, { id: `${tag}-carol`, pseudo: 'Carol' }).id)!;

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
  /** The in-flight presence update for each user, so `drop` can await it. */
  const awayDone = new Map<string, Promise<void>>();
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const getUserSocket = (id: string) => socketsByUser.get(id);

  io.on('connection', socket => {
    const userId = socket.handshake.auth.userId as string;
    const user = findUserById(db, userId)!;
    socketsByUser.set(userId, socket.id);
    serverSockets.set(userId, socket);
    registerRoomHandlers(socket, io, user, rooms, getUserSocket);
    registerInvitationHandlers(socket, io, user, rooms, getUserSocket);
    // The SRAM and launch handlers live here too, and the defect they carried
    // only shows when a room-handler event (choose-game) and a game-handler
    // event (saveSram) are driven by two different players in the same room.
    registerGameHandlers(socket, io, user.id, rooms, getUserSocket);
    /*
     * The presence half of what `websocket/index.ts` does on a *connection*,
     * mirroring the disconnect half below. A reconnecting member is present
     * again the moment their socket is back, without waiting for a `room:join`
     * that only the room page ever sends.
     */
    void markPlayerPresent(io, rooms, userId, getUserSocket);
    /*
     * The presence half of what `websocket/index.ts` does on a disconnect.
     *
     * Only the half: the real handler first asks the presence map whether this
     * socket closing means the user is actually gone, and that map does not
     * exist here. One socket per user in this file, so the question has one
     * answer and the guard has nothing to decide.
     */
    socket.on('disconnect', () => {
      awayDone.set(userId, markPlayerAway(io, rooms, user, new Date(), getUserSocket));
    });
  });

  await new Promise<void>(done => httpServer.listen(0, done));
  const port = (httpServer.address() as { port: number }).port;

  const clients: ClientSocket[] = [];
  const clientsByUser = new Map<string, ClientSocket>();
  const client = async (user: User) => {
    const socket = connect(`http://localhost:${port}`, {
      auth: { userId: user.id }, transports: ['websocket']
    });
    clients.push(socket);
    clientsByUser.set(user.id, socket);
    await once(socket, 'connect');
    return socket;
  };

  /*
   * A real disconnect, awaited on the server side.
   *
   * The old harness armed the departure timer directly, because a timer was
   * what it tested. What is tested now is what the disconnect handler does, so
   * the socket has to actually close - and the close has to be waited for, or
   * the assertion races the server.
   *
   * The server socket is the thing to wait on, not the client: the client knows
   * it has closed long before the server has run its handler, which is the
   * whole window this would otherwise race.
   */
  const drop = async (user: User) => {
    const server = serverSockets.get(user.id)!;
    const closed = new Promise<void>(done => server.once('disconnect', () => done()));
    clientsByUser.get(user.id)!.close();
    await closed;
    // The handler registered at connection time runs before this one, so its
    // promise is already recorded by now - and awaiting it is what stops the
    // assertions racing an update still in flight.
    await awayDone.get(user.id);
  };

  try {
    await run({
      rooms, alice, bob, carol, client, drop,
      gameId: game.id, gameCrc32: 'DEADBEEF', gameCoverUrl: '/covers/chrono-trigger.png',
      otherGameId: otherGame.id
    });
  } finally {
    for (const socket of clients) socket.close();
    /*
     * `io.close(cb)` waits for the HTTP server underneath to finish closing,
     * and `httpServer.close(cb)` waits for the live connections to end on
     * their own. Under Bun the websockets socket.io upgraded are never counted
     * as ending, so neither callback ever fires and every test in this file
     * times out in teardown rather than in its own body. Dropping the
     * remaining connections explicitly reaches the same end state both
     * runtimes reach on their own once a client is really gone.
     */
    io.close();
    httpServer.closeAllConnections();
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
    assert.equal(invitation.fromPseudo, 'Alice');
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
    assert.equal(seated.pseudo, 'Bob');
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

    const told = once<{ invitationId: string; pseudo: string }>(host, 'lobby:invitation-declined');
    guest.emit('lobby:decline', { invitationId: invitation.id });
    const warning = await told;

    assert.equal(warning.invitationId, invitation.id);
    assert.equal(warning.pseudo, 'Bob');
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
    // The host's copy is awaited too, or it is still in flight when the next
    // `once(host, ...)` below goes up and that one resolves with this room.
    const rechosen = once<Room>(guest, 'room:updated');
    const rechosenByHost = once<Room>(host, 'room:updated');
    host.emit('room:choose-game', { roomId: room.id, gameId: otherGameId, gameTitle: 'Super Metroid' });
    const after = await rechosen;
    await rechosenByHost;
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


/*
 * Away-not-gone is a rule about groups, and this is where the two halves of it
 * are pinned side by side.
 *
 * A seat is kept for somebody a second player is still waiting on. Alone there
 * is nobody waiting, and a room left behind is not free: one player may only be
 * in one room, so a room outliving its only player's window disables every Play
 * button in that player's own library until the sweep gets to it, twelve hours
 * later.
 */
test('a room of one dies with the window of the player in it', async () => {
  await withLobby(async ({ alice, client, rooms, drop }) => {
    const host = await client(alice);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    await drop(alice);

    assert.equal(rooms.get(room.id), undefined, 'nobody was left for it to be for');
  });
});

test('a disconnect still never releases a seat somebody else is waiting on', async () => {
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

    await drop(alice);

    const after = rooms.get(room.id);
    assert.ok(after, 'the room outlives one of its two players');
    assert.deepEqual(after.players.map(p => p.userId).sort(), [alice.id, bob.id].sort());
    assert.equal(after.players.find(p => p.userId === alice.id)!.online, false, 'away, not gone');
  });
});

/*
 * When the battery still reaches the server on the way out, and when it stops.
 *
 * Both emulator rooms write the battery as the player quits, and both also
 * write it again from their teardown. Which of the two actually carries is a
 * property of this handler, not of theirs: `game:saveSram` asks for membership
 * and a chosen game, and nothing else - `game:stop` having already moved the
 * room back to `waiting` is not an obstacle. Giving the seat up is, and quitting
 * a room of one does exactly that before navigating. That is the whole reason
 * the rooms save before the emit rather than trusting teardown to do it.
 */
test('a battery save still lands after game:stop, and is refused once the seat is given up', async () => {
  await withLobby(async ({ alice, gameId, client }) => {
    const player = await client(alice);

    const created = once<Room>(player, 'room:created');
    player.emit('room:create', { gameId, gameTitle: 'Chrono Trigger', autoStart: true });
    const room = await created;

    player.emit('game:stop', { roomId: room.id });
    await once(player, 'game:stopped');

    // Still a member, so teardown's own attempt would have carried too.
    const saved = once(player, 'game:sramSaved');
    player.emit('game:saveSram', {
      roomId: room.id, sramData: Buffer.from([0x11, 0x22]).toString('base64')
    });
    await saved;
    assert.deepEqual([...findGameById(db, gameId)!.sram!], [0x11, 0x22]);

    // And now the seat, which is what quitting a room of one gives up.
    player.emit('room:leave', { roomId: room.id });
    const refused = once(player, 'error');
    player.emit('game:saveSram', {
      roomId: room.id, sramData: Buffer.from([0x99, 0x99]).toString('base64')
    });
    /*
     * The refusal is silence, not a message: `getMemberRoom` returns null and
     * the handler bails. So a second event that does answer is what proves the
     * save had its turn - the same ordering trick as the quit test below.
     *
     * That probe used to be `room:join` answering with an error. It no longer
     * errors: a room link is now a door for accounts too, and `room:leave`
     * removes the player synchronously while deleting the empty room waits on
     * an await - so in that window the room is still there, still waiting, and
     * the leaver is admitted straight back. The probe therefore waits for the
     * success answer instead. What is being tested is the SRAM refusal above,
     * not `room:join`, and that assertion is untouched.
     */
    const back = once<Room>(player, 'room:updated');
    player.emit('room:join', { roomId: room.id });
    await Promise.race([refused, back]);

    assert.deepEqual(
      [...findGameById(db, gameId)!.sram!], [0x11, 0x22],
      'the row still holds what was written while the seat was ours'
    );
  });
});

/*
 * What a player whose room was reaped mid-game is told, and what they can do
 * about it without leaving the game.
 *
 * The refusal carries a code so the room page can tell its own dead room apart
 * from any other complaint on the shared `error` channel, and the code is one
 * value for both halves of the refusal on purpose - see the handler. From
 * there the rebuild is nothing exotic: the same `room:create` the library
 * sends, carrying the same game, coming back already `playing` because the
 * game never stopped.
 */
test('a reaped room refuses the rejoin by name, and can be rebuilt under the running game', async () => {
  await withLobby(async ({ alice, gameId, client, rooms, drop }) => {
    const phone = await client(alice);
    const created = once<Room>(phone, 'room:created');
    phone.emit('room:create', { gameId, gameTitle: 'Chrono Trigger', autoStart: true });
    const room = await created;

    // Chrome goes to the background for longer than a ping timeout.
    await drop(alice);
    assert.equal(rooms.get(room.id), undefined);

    const back = await client(alice);
    const refused = once<{ message: string; code?: string; roomId?: string }>(back, 'error');
    back.emit('room:join', { roomId: room.id });
    const answer = await refused;
    assert.equal(answer.code, 'roomGone', 'named, so the page can act on it');
    assert.equal(answer.roomId, room.id, 'and about the room we asked for');

    const rebuilt = await new Promise<Room>(resolve => {
      back.once('room:created', resolve);
      back.emit('room:create', { gameId, gameTitle: 'Chrono Trigger', autoStart: true });
    });
    assert.notEqual(rebuilt.id, room.id, 'a new room, because the old one is genuinely gone');
    assert.equal(rebuilt.status, 'playing', 'in the state the player is already in');
    assert.equal(rebuilt.gameId, gameId, 'carrying the game still running in front of them');
    assert.equal(rebuilt.players.length, 1);
    assert.equal(rebuilt.players[0].userId, alice.id);

    // And the battery still has somewhere to go, which is the point of keeping
    // the same game rather than starting a fresh anything.
    const saved = once(back, 'game:sramSaved');
    back.emit('game:saveSram', {
      roomId: rebuilt.id, sramData: Buffer.from([0x77]).toString('base64')
    });
    await saved;
    assert.deepEqual([...findGameById(db, gameId)!.sram!], [0x77]);
  });
});

/*
 * The phone that lost its socket mid-game, and then could not put the game down.
 *
 * `game:stop` is the whole of what the quit button does, and a room-scoped
 * event naming a room the server no longer has is dropped without a word -
 * deliberately, since room ids travel and answering a non-member tells them
 * something they should not learn. What changed is how ordinary that state is:
 * a room of one is now reaped when its player's window closes (the test above),
 * and the window only has to go quiet for the ping timeout - a tunnel, a lock
 * screen. Meanwhile the emulator runs entirely in the client and notices none
 * of it, so the player is still playing a game the server has no record of.
 *
 * Pinned here as the reason the client must not treat quitting as a request:
 * the server is within its rights to have nothing to answer, and a quit button
 * that waits for an answer is a quit button that does nothing.
 */
test('a quit naming a room the server no longer has is dropped in silence', async () => {
  await withLobby(async ({ alice, gameId, client, rooms, drop }) => {
    const phone = await client(alice);

    const created = once<Room>(phone, 'room:created');
    phone.emit('room:create', { gameId, gameTitle: 'Chrono Trigger', autoStart: true });
    const room = await created;
    assert.equal(rooms.get(room.id)!.status, 'playing');

    // A tunnel, a lock screen, a main thread the emulator stalled past the
    // ping timeout: the socket closes without the player putting the pad down.
    await drop(alice);
    assert.equal(rooms.get(room.id), undefined, 'a room of one does not outlive its window');

    // socket.io reconnects on its own, and the game never stopped running.
    const back = await client(alice);
    let answered = false;
    back.once('game:stopped', () => { answered = true; });
    back.emit('game:stop', { roomId: room.id });

    /*
     * A second event the server does answer, on the same socket, so the
     * assertion below is not a race: socket.io preserves order, so an answer
     * to this one means the quit ahead of it has already had its turn. Never a
     * sleep, per this file's own rule.
     */
    const refused = once(back, 'error');
    back.emit('room:join', { roomId: room.id });
    await refused;

    assert.equal(answered, false, 'so a client that waits for the answer waits for ever');
  });
});

test('a member who left comes back through room:join, with no new invitation', async () => {
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

    await drop(bob);
    assert.equal(rooms.get(room.id)!.players.find(p => p.userId === bob.id)!.online, false);

    // No invitation is sent, and none is needed: the door is membership.
    const back = await client(bob);
    const rejoined = once<Room>(back, 'room:updated');
    back.emit('room:join', { roomId: room.id });
    await rejoined;

    const after = rooms.get(room.id)!;
    assert.equal(after.players.find(p => p.userId === bob.id)!.online, true);
    assert.equal(after.abandonedAt, undefined);
  });
});

test('creating a room gives up the one you were in, so nobody collects lobbies', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const firstCreated = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const first = await firstCreated;

    const delivered = once<{ id: string }>(guest, 'lobby:invitation');
    host.emit('lobby:invite', { roomId: first.id, friendId: bob.id });
    const acked = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: (await delivered).id });
    await acked;

    const secondCreated = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const second = await secondCreated;

    assert.notEqual(second.id, first.id);
    assert.deepEqual(
      rooms.get(first.id)!.players.map(p => p.userId),
      [bob.id],
      'alice gave up her seat in the room she left behind'
    );
    assert.deepEqual(rooms.get(second.id)!.players.map(p => p.userId), [alice.id]);
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

test('quitter un salon où il reste quelqu un prévient aussi le partant', async () => {
  /*
   * Le partant n'apprenait rien.
   *
   * `handleLeaveRoom` fait `socket.leave(roomId)` puis émet `player:left` et
   * `room:updated` avec `io.to(roomId)` : le partant vient d'être retiré de ce
   * canal, donc il ne reçoit ni l'un ni l'autre. Son magasin gardait le salon,
   * et le bouton « quitter le groupe » restait affiché jusqu'à un F5.
   *
   * Quand il est le dernier, `room:destroyed` part en `io.emit` global et il
   * l'attrape - d'où un comportement qui dépendait du nombre de joueurs.
   */
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const joined = once<Room>(host, 'room:updated');
    guest.emit('room:join', { roomId: room.id });
    await joined;
    assert.equal(rooms.get(room.id)!.players.length, 2);

    // Le partant doit être prévenu, alors qu'il reste un joueur derrière lui.
    const told = once<{ roomId: string }>(guest, 'room:left');
    guest.emit('room:leave', { roomId: room.id });
    assert.equal((await told).roomId, room.id);

    assert.deepEqual(rooms.get(room.id)!.players.map(p => p.userId), [alice.id]);
  });
});

test('room:join ouvre un salon en attente à qui tient le lien, jamais une partie en cours', async () => {
  await withLobby(async ({ alice, bob, client, rooms }) => {
    const host = await client(alice);
    const stranger = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    /*
     * L'invitation n'est plus la seule porte : partager l'URL d'un salon est
     * devenu une façon de s'y retrouver, et refuser un ami connecté là où un
     * inconnu sans compte entrait était l'asymétrie à lever.
     *
     * Ce qui reste fermé, et que ce test garde, c'est une partie en cours.
     */
    const joined = once<Room>(stranger, 'room:updated');
    stranger.emit('room:join', { roomId: room.id });
    await joined;
    assert.deepEqual(rooms.get(room.id)!.players.map(p => p.userId), [alice.id, bob.id]);

    // Et maintenant la limite : une fois la partie lancée, le lien ne vaut plus.
    rooms.get(room.id)!.status = 'playing';
    rooms.get(room.id)!.players = rooms.get(room.id)!.players.filter(p => p.userId === alice.id);
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
  const alice = insertUser(db, { pseudo: 'Alice' });
  const carol = insertUser(db, { pseudo: 'Carol' });
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
  assert.equal(delivered[0].fromPseudo, 'Alice');
  // Still on disk, simply not offered: the sweep is what removes them.
  assert.ok(findInvitationById(db, expired.id));
  assert.ok(findInvitationById(db, dead.id));
});

test('the boot sweep deletes invitations whose deadline has passed, and only those', async () => {
  const alice = insertUser(db, { pseudo: 'Alice' });
  const bob = insertUser(db, { pseudo: 'Bob' });

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
  invitation?: { id: string; toUserId: string; toPseudo: string; expiresAt: string };
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

test('game:start is refused while the other player is away', async () => {
  await withLobby(async ({ alice, bob, client, gameId, drop }) => {
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

    host.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });
    await once(host, 'room:updated');

    await drop(bob);

    /*
     * The failure this prevents has no error message of its own: lockstep waits
     * for both cores, so starting against an absent player leaves two screens
     * waiting for each other with nothing to click. A refusal is the only
     * outcome anybody can act on.
     */
    const refused = once<{ message: string }>(host, 'error');
    host.emit('game:start', { roomId: room.id });
    assert.match((await refused).message, /away|not here|connected/i);
  });
});

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
    const dave = insertUser(db, { id: `${room.id}-dave`, pseudo: 'Dave' });
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
    assert.equal(waiting.invitation?.toPseudo, 'Bob', 'the screen names who is being waited on');
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
    const dave = findUserById(db, insertUser(db, { id: `${alice.id}-dave`, pseudo: 'Dave' }).id)!;
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

    assert.equal((await memberView).invitation?.toPseudo, 'Bob',
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


/*
 * Staging a save to start on, from the lobby.
 *
 * The library could already send a room to a save through `?save=`, but only
 * before the room existed - so somebody who created the room from the Play
 * button, or who joined someone else's, had no way to say where to start. These
 * cover the rule that makes it safe in a room of two: the creator decides, the
 * way they already decide the latency mode, and the guards are the ones
 * `game:load` applies at boot rather than a second, looser set.
 */

/** A save on `gameId`, with bytes nobody reads here. */
function stageable(gameId: string, name: string, slotNumber = 1) {
  return createSave(db, {
    gameId, slotNumber, name, data: Buffer.from('state'), screenshot: null
  });
}

/** Alice's room on Chrono Trigger, with Bob in it. */
async function roomOfTwo(lobby: Lobby) {
  const host = await lobby.client(lobby.alice);
  const guest = await lobby.client(lobby.bob);

  const created = once<Room>(host, 'room:created');
  host.emit('room:create', {});
  const room = await created;

  const delivered = once<{ id: string }>(guest, 'lobby:invitation');
  host.emit('lobby:invite', { roomId: room.id, friendId: lobby.bob.id });
  const acked = once(guest, 'lobby:accepted');
  guest.emit('lobby:accept', { invitationId: (await delivered).id });
  await acked;

  /*
   * Both copies, not just the guest's. `room:updated` goes to every member, and
   * waiting for only one of the two leaves the other still in flight: the next
   * `once(host, 'room:updated')` a test registers then catches *this* event
   * instead of the one it is about to provoke, and reads a room from one step
   * ago. Under `node --test` the host's copy happened to land first and the bug
   * never showed; it is a race either way.
   */
  const chosen = once<Room>(guest, 'room:updated');
  const chosenByHost = once<Room>(host, 'room:updated');
  host.emit('room:choose-game', { roomId: room.id, gameId: lobby.gameId, gameTitle: 'Chrono Trigger' });
  await Promise.all([chosen, chosenByHost]);

  return { host, guest, room };
}

test('the creator stages a save, and both players are told which one', async () => {
  await withLobby(async lobby => {
    const { host, guest, room } = await roomOfTwo(lobby);
    const save = stageable(lobby.gameId, 'Before Lavos');

    const hostSees = once<Room>(host, 'room:updated');
    const guestSees = once<Room>(guest, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });

    for (const view of [await hostSees, await guestSees]) {
      assert.equal(view.resumeSaveId, save.id);
      // The name travels with the id so that the guest can be told what the
      // room will start on without asking for a list of megabyte savestates.
      assert.equal(view.resumeSaveName, 'Before Lavos');
    }
  });
});

test('a guest cannot stage a save, even one of their own', async () => {
  await withLobby(async lobby => {
    const { guest, room } = await roomOfTwo(lobby);
    // Bob's own row for the same ROM: the checksum matches, so ownership is
    // not what refuses this. Only being the creator is.
    const bobsGame = createGame(db, {
      title: 'Chrono Trigger', filename: 'ct.sfc', crc32: 'DEADBEEF', userId: lobby.bob.id,
      ...NO_METADATA, coverUrl: null
    });
    const save = stageable(bobsGame.id, "Bob's run");

    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await refused;

    assert.equal(lobby.rooms.get(room.id)!.resumeSaveId, undefined);
  });
});

test('the creator cannot stage a save that is not theirs', async () => {
  await withLobby(async lobby => {
    const { host, room } = await roomOfTwo(lobby);
    const bobsGame = createGame(db, {
      title: 'Chrono Trigger', filename: 'ct.sfc', crc32: 'DEADBEEF', userId: lobby.bob.id,
      ...NO_METADATA, coverUrl: null
    });
    const save = stageable(bobsGame.id, "Bob's run");

    const refused = once<{ message: string }>(host, 'error');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await refused;

    assert.equal(lobby.rooms.get(room.id)!.resumeSaveId, undefined);
  });
});

test('a save from another game is refused when it is staged, not at boot', async () => {
  await withLobby(async lobby => {
    const { host, room } = await roomOfTwo(lobby);
    // Super Metroid, in a Chrono Trigger room: CAFEBABE against DEADBEEF.
    const save = stageable(lobby.otherGameId, 'Wrong game');

    const refused = once<{ message: string }>(host, 'error');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await refused;

    /*
     * The point of the whole handler. `game:load` catches this too, but only
     * once the emulator has booted - so the mistake used to surface as an error
     * over a running game instead of as a refusal in the lobby.
     */
    assert.equal(lobby.rooms.get(room.id)!.resumeSaveId, undefined);
  });
});

test('a staged save is dropped when the room changes game', async () => {
  await withLobby(async lobby => {
    const { host, guest, room } = await roomOfTwo(lobby);
    const save = stageable(lobby.gameId, 'Before Lavos');

    const staged = once<Room>(host, 'room:updated');
    // The guest's copy of the same update, awaited rather than left in flight:
    // arming the next listener while it is on the wire catches this one instead.
    const guestStaged = once<Room>(guest, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    assert.equal((await staged).resumeSaveId, save.id);
    await guestStaged;

    // A save belongs to a game. Keeping it across a change of game is how the
    // URL path used to earn a "that save belongs to a different game" at boot
    // for a room nobody had asked to resume.
    const regamed = once<Room>(guest, 'room:updated');
    host.emit('room:choose-game', { roomId: room.id, gameId: lobby.otherGameId, gameTitle: 'Super Metroid' });
    const after = await regamed;
    assert.equal(after.resumeSaveId, undefined);
    assert.equal(after.resumeSaveName, undefined);
  });
});

test('the creator can unstage, and start from the beginning after all', async () => {
  await withLobby(async lobby => {
    const { host, room } = await roomOfTwo(lobby);
    const save = stageable(lobby.gameId, 'Before Lavos');

    const staged = once<Room>(host, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await staged;

    const cleared = once<Room>(host, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: null });
    const after = await cleared;
    assert.equal(after.resumeSaveId, undefined);
    assert.equal(after.resumeSaveName, undefined);
  });
});

test('a guest arriving after the save was staged still sees it', async () => {
  await withLobby(async lobby => {
    const host = await lobby.client(lobby.alice);
    const created = once<Room>(host, 'room:created');
    host.emit('room:create', { gameId: lobby.gameId, gameTitle: 'Chrono Trigger' });
    const room = await created;

    const save = stageable(lobby.gameId, 'Before Lavos');
    const staged = once<Room>(host, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await staged;

    /*
     * Through the public view rather than through whichever event carries the
     * room on arrival: `toPublicRoom` is the only builder every path uses, so
     * this is the assertion that covers all of them at once.
     */
    const asBobSees = toPublicRoomFor(lobby.rooms.get(room.id)!, lobby.bob.id);
    assert.equal(asBobSees.resumeSaveId, save.id);
    assert.equal(asBobSees.resumeSaveName, 'Before Lavos');
  });
});

/*
 * Where the players are sent, and by whom.
 *
 * `room:opened` is the one navigation channel: choosing the game is what opens
 * the room, and both members go - the chooser included, so that there is one
 * path to describe rather than two. The second test below is the reason the
 * event is addressed per member rather than to the room's channel.
 */

test('choosing the game sends both members to the room page, whoever chose', async () => {
  await withLobby(async ({ alice, bob, client, gameId }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    const accepted = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await accepted;

    // The guest chooses, which is allowed: either member may.
    const hostOpened = once<{ roomId: string; reason?: string }>(host, 'room:opened');
    const guestOpened = once<{ roomId: string; reason?: string }>(guest, 'room:opened');
    guest.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });

    assert.deepEqual(await hostOpened, { roomId: room.id });
    assert.deepEqual(await guestOpened, { roomId: room.id });
  });
});

test('a member who is not in the room channel is still told to go', async () => {
  await withLobby(async ({ alice, bob, client, drop, gameId }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    const accepted = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await accepted;

    /*
     * The guest reconnects, which is what reloading the library page is. The new
     * socket holds the seat but has never emitted `room:join`, so it is *not* in
     * the room's socket.io channel: an `io.to(room.id)` would reach nobody.
     */
    await drop(bob);
    const reloaded = await client(bob);
    const opened = once<{ roomId: string }>(reloaded, 'room:opened');

    host.emit('room:choose-game', { roomId: room.id, gameId, gameTitle: 'Chrono Trigger' });

    assert.deepEqual(await opened, { roomId: room.id });
  });
});

test('accepting into a room that already has a game sends the invitee there', async () => {
  await withLobby(async ({ alice, bob, client, gameId }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', { gameId, gameTitle: 'Chrono Trigger' });
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    const opened = once<{ roomId: string; reason?: string }>(guest, 'room:opened');
    guest.emit('lobby:accept', { invitationId: invitation.id });

    assert.deepEqual(await opened, { roomId: room.id, reason: 'invitation' });
  });
});

test('accepting into a room with no game leaves the invitee where they are', async () => {
  await withLobby(async ({ alice, bob, client }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    let opened = false;
    guest.on('room:opened', () => (opened = true));
    const accepted = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await accepted;

    // The group is formed on the library page; there is nothing to open yet.
    assert.equal(opened, false);
  });
});

test('reconnecting makes a member present again, and tells the other one', async () => {
  await withLobby(async ({ alice, bob, client, drop, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    const accepted = once(guest, 'lobby:accepted');
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await accepted;

    await drop(bob);
    assert.equal(rooms.get(room.id)!.players.find(p => p.userId === bob.id)!.online, false);

    /*
     * A reload of the library page. The seat was never given up, and nothing on
     * that page will ever emit `room:join` - which is why the seat used to stay
     * marked away for the rest of the session, showing the partner an empty
     * chair and collapsing the room to a single player.
     */
    const updated = once<Room>(host, 'room:updated');
    await client(bob);
    await updated;

    const seat = rooms.get(room.id)!.players.find(p => p.userId === bob.id)!;
    assert.equal(seat.online, true);
    // And the room is off the abandonment clock again.
    assert.equal(rooms.get(room.id)!.abandonedAt, undefined);
  });
});

/*
 * Who may ask the server to open a save, and who is served by the answer.
 *
 * The pair below is the server half of a rule the client has to know: a guest
 * asking for the room's staged save gets a refusal, and needs nothing else,
 * because the answer to the *creator's* request is broadcast to the whole room.
 * A lockstep guest that asked anyway had "Not authorized to load this save"
 * thrown at it on every resume, while the resume itself worked perfectly around
 * the refusal - which is exactly the shape of bug that survives for months.
 */

test('a guest asking for the creator\'s staged save is refused', async () => {
  await withLobby(async lobby => {
    const { host, guest, room } = await roomOfTwo(lobby);
    const save = stageable(lobby.gameId, 'Before Lavos');

    const staged = once<Room>(guest, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await staged;

    const refused = once<{ message: string }>(guest, 'error');
    guest.emit('game:load', { roomId: room.id, saveId: save.id });
    assert.equal((await refused).message, 'Not authorized to load this save');
  });
});

test('the creator asking is served, and the answer reaches both players', async () => {
  await withLobby(async lobby => {
    const { host, guest, room } = await roomOfTwo(lobby);
    const save = stageable(lobby.gameId, 'Before Lavos');

    const staged = once<Room>(guest, 'room:updated');
    host.emit('room:choose-save', { roomId: room.id, saveId: save.id });
    await staged;

    // Both, from the one request: this is what makes the guest's own request
    // pointless rather than merely unauthorised.
    const hostGets = once<{ saveId: string; name: string }>(host, 'game:loaded');
    const guestGets = once<{ saveId: string; name: string }>(guest, 'game:loaded');
    host.emit('game:load', { roomId: room.id, saveId: save.id });

    for (const loaded of [await hostGets, await guestGets]) {
      assert.equal(loaded.saveId, save.id);
      assert.equal(loaded.name, 'Before Lavos');
    }
  });
});
