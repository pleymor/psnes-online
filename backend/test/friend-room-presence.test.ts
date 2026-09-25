import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

/*
 * « Dans un salon » suit l'appartenance, plus la création.
 *
 * Le défaut : A crée un salon, B le rejoint, A le quitte. Le salon survit pour
 * B - et chez les amis de A, A restait « dans un salon », parce que la liste
 * rangeait les salons par leur créateur. B, lui, n'y apparaissait jamais chez
 * ses propres amis, puisqu'il n'avait rien créé.
 *
 * Deux moitiés. Le calcul, sur des salons faits à la main. Puis le protocole,
 * sur de vrais sockets et les vrais gestionnaires, avec quatre comptes : A et B
 * qui jouent, C ami de A seul, D ami de B seul - de quoi voir à la fois que
 * chacun apprend ce qu'il doit, et que personne n'apprend le statut d'un
 * joueur qui n'est pas son ami.
 */

const dir = mkdtempSync(join(tmpdir(), 'psnes-friend-presence-'));
process.env.DATABASE_URL = `file:${join(dir, 'presence.db')}`;

const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertUser } = await import('./helpers.js');
const { findUserById } = await import('../src/db/users.js');
const { createFriendshipRequest, acceptFriendship } = await import('../src/db/friendships.js');
const { registerRoomHandlers } = await import('../src/websocket/room-handlers.js');
const { registerInvitationHandlers } = await import('../src/websocket/invitation-handlers.js');
const { getOnlineFriends } = await import('../src/services/friends.js');
const { roomPresenceOf, presenceIn } = await import('../src/websocket/friend-presence.js');
type Room = import('../src/types/index.js').Room;
type User = import('../src/db/types.js').User;
type FriendRoomPresence = import('../src/websocket/friend-presence.js').FriendRoomPresence;

forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function room(id: string, createdBy: string, members: { userId: string; online: boolean }[]): Room {
  return {
    id, createdBy, hostId: members[0]?.userId ?? createdBy,
    players: members.map((m, i) => ({
      userId: m.userId, pseudo: m.userId, port: (i + 1) as 1 | 2,
      isReady: true, emulationReady: false, online: m.online
    })),
    status: 'waiting', emulationMode: 'lockstep', latencyMode: 'auto', createdAt: new Date()
  } as Room;
}

test('le salon d un joueur est celui dont il est membre, pas celui qu il a créé', () => {
  // A a créé ce salon puis l'a quitté : il n'y reste que B.
  const rooms = [room('r1', 'a', [{ userId: 'b', online: true }])];

  assert.equal(roomPresenceOf('a', rooms), null);
  assert.deepEqual(roomPresenceOf('b', rooms), { roomId: 'r1', gameTitle: undefined, status: 'waiting' });
});

test('un membre du salon d un autre y est, alors qu il n a rien créé', () => {
  const rooms = [room('r1', 'a', [{ userId: 'a', online: true }, { userId: 'b', online: true }])];
  rooms[0].gameTitle = 'Chrono Trigger';
  rooms[0].status = 'playing';

  assert.deepEqual(roomPresenceOf('b', rooms), { roomId: 'r1', gameTitle: 'Chrono Trigger', status: 'playing' });
});

test('un membre absent garde son siège, et donc son salon, tant qu un autre y est', () => {
  const rooms = [room('r1', 'a', [{ userId: 'a', online: false }, { userId: 'b', online: true }])];
  assert.equal(roomPresenceOf('a', rooms)?.roomId, 'r1');
});

test('un salon où personne n est présent ne compte pour personne', () => {
  const empty = room('r1', 'a', [{ userId: 'a', online: false }, { userId: 'b', online: false }]);
  assert.equal(presenceIn(empty), null);
  assert.equal(roomPresenceOf('a', [empty]), null);
});

/** Attend un événement, jamais une durée. */
function once<T>(socket: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

interface Change { userId: string; room: FriendRoomPresence | null }

/** Le prochain `friend:roomChanged` qui parle de `userId`. */
function changeFor(socket: ClientSocket, userId: string, ms = 5000): Promise<Change> {
  return new Promise<Change>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no friend:roomChanged for ${userId}`)), ms);
    const handler = (change: Change) => {
      if (change.userId !== userId) return;
      clearTimeout(timer);
      socket.off('friend:roomChanged', handler);
      resolve(change);
    };
    socket.on('friend:roomChanged', handler);
  });
}

test('quand le créateur part, ses amis le voient sortir et ceux de celui qui reste le voient toujours dedans', async () => {
  const a = findUserById(db, insertUser(db, { id: 'p-a', pseudo: 'Alice' }).id)!;
  const b = findUserById(db, insertUser(db, { id: 'p-b', pseudo: 'Bob' }).id)!;
  const c = findUserById(db, insertUser(db, { id: 'p-c', pseudo: 'Carol' }).id)!;
  const d = findUserById(db, insertUser(db, { id: 'p-d', pseudo: 'Dan' }).id)!;
  const befriend = (x: User, y: User) => acceptFriendship(db, createFriendshipRequest(db, x.id, y.id).id);
  befriend(a, b);
  befriend(a, c);
  befriend(b, d);

  const rooms = new Map<string, Room>();
  const socketsByUser = new Map<string, string>();
  const getUserSocket = (id: string) => socketsByUser.get(id);
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);

  io.on('connection', socket => {
    const user = findUserById(db, socket.handshake.auth.userId as string)!;
    socketsByUser.set(user.id, socket.id);
    // Le même appel que `websocket/index.ts`, salon compris.
    socket.on('friends:getOnlineStatus', async () => {
      socket.emit('friends:online', await getOnlineFriends(
        user.id, { socketFor: getUserSocket }, { isInVr: () => false },
        { roomOf: id => roomPresenceOf(id, rooms.values()) }
      ));
    });
    registerRoomHandlers(socket, io, user, rooms, getUserSocket);
    registerInvitationHandlers(socket, io, user, rooms, getUserSocket);
  });

  await new Promise<void>(done => httpServer.listen(0, done));
  const port = (httpServer.address() as { port: number }).port;
  const clients: ClientSocket[] = [];
  /** Tout ce que chacun a reçu sur ce canal, pour vérifier ce qu'il n'a PAS reçu. */
  const heard = new Map<string, Change[]>();
  const client = async (user: User) => {
    const socket = connect(`http://localhost:${port}`, { auth: { userId: user.id }, transports: ['websocket'] });
    clients.push(socket);
    const log: Change[] = [];
    heard.set(user.id, log);
    socket.on('friend:roomChanged', (change: Change) => log.push(change));
    await once(socket, 'connect');
    return socket;
  };
  /** La réponse complète, qui sert aussi de barrière : elle part après tout ce qui a été émis avant. */
  const onlineStatus = async (socket: ClientSocket) => {
    const answer = once<{ id: string; room: FriendRoomPresence | null }[]>(socket, 'friends:online');
    socket.emit('friends:getOnlineStatus');
    return new Map((await answer).map(f => [f.id, f.room]));
  };

  try {
    const sa = await client(a);
    const sb = await client(b);
    const sc = await client(c);
    const sd = await client(d);

    // A crée : C, son ami, le voit dans un salon.
    const cSeesA = changeFor(sc, a.id);
    const created = once<Room>(sa, 'room:created');
    sa.emit('room:create', {});
    const made = await created;
    assert.equal((await cSeesA).room?.roomId, made.id);

    // B rejoint le salon de A : D, ami de B seul, le voit dans un salon, bien
    // que B n'ait rien créé.
    const invitation = once<{ id: string }>(sb, 'lobby:invitation');
    sa.emit('lobby:invite', { roomId: made.id, friendId: b.id });
    const dSeesB = changeFor(sd, b.id);
    sb.emit('lobby:accept', { invitationId: (await invitation).id });
    assert.equal((await dSeesB).room?.roomId, made.id);

    // Tout ce que l'arrivée de B a émis est arrivé : sans cette barrière, le
    // « A est dans le salon » d'avant le départ pourrait être pris pour la
    // réponse au départ.
    for (const socket of [sa, sb, sc, sd]) await onlineStatus(socket);

    // A quitte. Le salon survit pour B.
    const cSeesALeave = changeFor(sc, a.id);
    const bSeesALeave = changeFor(sb, a.id);
    const dSeesBStay = changeFor(sd, b.id);
    const left = once(sa, 'room:left');
    sa.emit('room:leave', { roomId: made.id });
    await left;
    assert.equal((await cSeesALeave).room, null, 'C voit A hors de tout salon');
    assert.equal((await bSeesALeave).room, null, 'B voit A hors de tout salon');
    assert.equal((await dSeesBStay).room?.roomId, made.id, 'D voit B toujours dans son salon');
    assert.ok(rooms.has(made.id));

    // Un rechargement : l'état se reconstruit depuis le serveur, pareil.
    assert.equal((await onlineStatus(sc)).get(a.id), null);
    assert.equal((await onlineStatus(sd)).get(b.id)?.roomId, made.id);
    assert.equal((await onlineStatus(sa)).get(b.id)?.roomId, made.id, 'A voit B toujours dans le salon');

    // Aucune fuite : C n'est pas l'ami de B, D n'est pas celui de A.
    assert.deepEqual(heard.get(c.id)!.filter(ch => ch.userId !== a.id), []);
    assert.deepEqual(heard.get(d.id)!.filter(ch => ch.userId !== b.id), []);
    assert.equal((await onlineStatus(sc)).has(b.id), false);
    assert.equal((await onlineStatus(sd)).has(a.id), false);

    // B part à son tour, le salon meurt : D le voit sortir.
    const dSeesBLeave = changeFor(sd, b.id);
    sb.emit('room:leave', { roomId: made.id });
    assert.equal((await dSeesBLeave).room, null);
    assert.equal(rooms.has(made.id), false);
  } finally {
    for (const socket of clients) socket.close();
    io.close();
    httpServer.closeAllConnections();
    if (httpServer.listening) await new Promise<void>(done => httpServer.close(() => done()));
  }
});
