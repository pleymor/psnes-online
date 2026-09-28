import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { registerVrVoice, MAX_SIGNAL_BYTES } from '../src/websocket/vr-voice.js';
import { gateAnonymousSocket } from '../src/websocket/anonymous-gate.js';
import { ANONYMOUS_FORBIDDEN } from '../src/auth/anonymous.js';
import type { Room } from '../src/types/index.js';

/*
 * Qui s'entend en VR, sur de vraies sockets.
 *
 * La règle de confidentialité est la raison d'être du fichier : le serveur ne
 * relaie une négociation qu'entre deux amis acceptés du même espace. Si le
 * relais s'élargissait un jour - à tout le lobby, à tout le salon - « une
 * inconnue n'entend personne » et « un signal vers un non-pair ne part pas »
 * doivent échouer bruyamment. L'audio lui-même n'est pas ici : il ne passe
 * jamais par le serveur, et `e2e/vr-voice.spec.ts` le fait couler entre deux
 * navigateurs.
 *
 * Les amitiés sont injectées plutôt que lues en base : elles sont la donnée du
 * test, et la lecture en base est celle, déjà éprouvée, de `vr-lobby.ts`.
 */

interface PeersEvent {
  peers: { id: string; initiator: boolean }[];
}

function once<T>(socket: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Le prochain `vr:voice:peers` qui satisfait `matches`. */
function peersWhere(socket: ClientSocket, matches: (ids: string[]) => boolean, ms = 5000): Promise<PeersEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('vr:voice:peers', onPeers);
      reject(new Error('timed out waiting for matching vr:voice:peers'));
    }, ms);
    function onPeers(event: PeersEvent) {
      if (!matches(event.peers.map(p => p.id).sort())) return;
      clearTimeout(timer);
      socket.off('vr:voice:peers', onPeers);
      resolve(event);
    }
    socket.on('vr:voice:peers', onPeers);
  });
}

/**
 * Combien d'évènements arrivent pendant `ms`. La seule attente d'une durée du
 * fichier : prouver qu'un signal NE part PAS demande de regarder passer du temps.
 */
function countDuring(socket: ClientSocket, event: string, ms = 300): Promise<number> {
  return new Promise(resolve => {
    let seen = 0;
    const onEvent = () => { seen += 1; };
    socket.on(event, onEvent);
    setTimeout(() => {
      socket.off(event, onEvent);
      resolve(seen);
    }, ms);
  });
}

interface Harness {
  client(userId: string): Promise<ClientSocket>;
  rooms: Map<string, Room>;
  unfriend(a: string, b: string): void;
}

function room(id: string, members: string[]): Room {
  return {
    id,
    hostId: members[0],
    createdBy: members[0],
    players: members.map((userId, i) => ({
      userId, pseudo: userId, port: (i + 1) as 1 | 2, isReady: true, emulationReady: true, keyConfig: {}
    })),
    status: 'playing'
  } as unknown as Room;
}

async function withVoice(run: (h: Harness) => Promise<void>): Promise<void> {
  // Alice et Bob sont amis, Dan aussi avec Alice ; Carol n'est l'amie de personne.
  const friends: Record<string, Set<string>> = {
    alice: new Set(['bob', 'dan']),
    bob: new Set(['alice']),
    dan: new Set(['alice']),
    carol: new Set(),
    anon: new Set()
  };
  const rooms = new Map<string, Room>();
  const http = createServer();
  const io = new Server(http);
  const voice = registerVrVoice(io, rooms, { friendIdsOf: id => new Set(friends[id] ?? []) });
  io.on('connection', socket => {
    const id = socket.handshake.auth.userId as string;
    gateAnonymousSocket(socket, { isAnonymous: id === 'anon' });
    voice.attach(socket, { id, pseudo: id } as never);
  });
  await new Promise<void>(resolve => http.listen(0, resolve));
  const port = (http.address() as AddressInfo).port;
  const clients: ClientSocket[] = [];

  try {
    await run({
      rooms,
      async client(userId) {
        const socket = connect(`http://127.0.0.1:${port}`, {
          auth: { userId }, transports: ['websocket'], forceNew: true
        });
        clients.push(socket);
        await once(socket, 'connect');
        return socket;
      },
      unfriend(a, b) {
        friends[a]?.delete(b);
        friends[b]?.delete(a);
        voice.forgetFriendship(a, b);
      }
    });
  } finally {
    for (const socket of clients) socket.close();
    // Sous Bun, ni `io.close(cb)` ni `http.close(cb)` ne rappellent tant que des
    // websockets restent comptées : on coupe explicitement, comme `vr-lobby.test.ts`.
    io.close();
    http.closeAllConnections();
    if (http.listening) await new Promise<void>(done => http.close(() => done()));
  }
}

test('deux amis au lobby se voient comme pairs, avec un seul initiateur', async () => {
  await withVoice(async h => {
    const alice = await h.client('alice');
    const bob = await h.client('bob');

    const alone = once<PeersEvent>(alice, 'vr:voice:peers');
    alice.emit('vr:voice:join', { roomId: null });
    assert.deepEqual((await alone).peers, []);

    const aliceSees = peersWhere(alice, ids => ids.includes('bob'));
    const bobSees = peersWhere(bob, ids => ids.includes('alice'));
    bob.emit('vr:voice:join', { roomId: null });
    const [a, b] = await Promise.all([aliceSees, bobSees]);
    assert.equal(a.peers.length, 1);
    assert.equal(b.peers.length, 1);
    // Exactement un des deux fait l'offre.
    assert.notEqual(a.peers[0].initiator, b.peers[0].initiator);
  });
});

test('un signal passe entre pairs, sans rien porter d\'autre que lui et son expéditeur', async () => {
  await withVoice(async h => {
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const ready = peersWhere(bob, ids => ids.includes('alice'));
    alice.emit('vr:voice:join', { roomId: null });
    bob.emit('vr:voice:join', { roomId: null });
    await ready;

    const received = once<{ from: string; signal: unknown }>(bob, 'vr:voice:signal');
    alice.emit('vr:voice:signal', { to: 'bob', signal: { type: 'offer', sdp: 'v=0' } });
    assert.deepEqual(await received, { from: 'alice', signal: { type: 'offer', sdp: 'v=0' } });
  });
});

test('une inconnue au lobby n\'a aucun pair, et ses signaux ne partent pas', async () => {
  await withVoice(async h => {
    const alice = await h.client('alice');
    const carol = await h.client('carol');
    alice.emit('vr:voice:join', { roomId: null });
    const carolSees = once<PeersEvent>(carol, 'vr:voice:peers');
    carol.emit('vr:voice:join', { roomId: null });
    assert.deepEqual((await carolSees).peers, []);

    const heard = countDuring(alice, 'vr:voice:signal');
    carol.emit('vr:voice:signal', { to: 'alice', signal: { type: 'offer', sdp: 'v=0' } });
    assert.equal(await heard, 0);
  });
});

test('un ami qui n\'est pas dans le même espace n\'est pas un pair', async () => {
  await withVoice(async h => {
    h.rooms.set('r1', room('r1', ['alice', 'bob']));
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    alice.emit('vr:voice:join', { roomId: 'r1' });
    const bobSees = once<PeersEvent>(bob, 'vr:voice:peers');
    bob.emit('vr:voice:join', { roomId: null });
    assert.deepEqual((await bobSees).peers, [], 'Bob au lobby, Alice en partie');

    const heard = countDuring(bob, 'vr:voice:signal');
    alice.emit('vr:voice:signal', { to: 'bob', signal: { type: 'offer' } });
    assert.equal(await heard, 0);

    // Bob la rejoint dans le salon : ils s'entendent.
    const together = peersWhere(alice, ids => ids.includes('bob'));
    bob.emit('vr:voice:join', { roomId: 'r1' });
    await together;
  });
});

test('un salon dont on n\'est pas membre est refusé, et en sortir coupe la parole', async () => {
  await withVoice(async h => {
    h.rooms.set('r1', room('r1', ['alice', 'bob']));
    h.rooms.set('r2', room('r2', ['alice', 'dan']));
    const alice = await h.client('alice');
    const dan = await h.client('dan');
    alice.emit('vr:voice:join', { roomId: 'r1' });

    // Dan nomme le salon d'Alice et Bob, où il n'est pas assis : aucune réponse.
    const answered = countDuring(dan, 'vr:voice:peers');
    dan.emit('vr:voice:join', { roomId: 'r1' });
    assert.equal(await answered, 0);

    // Alice rejoint le salon de Dan, puis en est retirée : le signal ne passe plus.
    const together = peersWhere(dan, ids => ids.includes('alice'));
    alice.emit('vr:voice:join', { roomId: 'r2' });
    dan.emit('vr:voice:join', { roomId: 'r2' });
    await together;
    h.rooms.get('r2')!.players = h.rooms.get('r2')!.players.filter(p => p.userId !== 'alice');
    const heard = countDuring(alice, 'vr:voice:signal');
    dan.emit('vr:voice:signal', { to: 'alice', signal: { type: 'offer' } });
    assert.equal(await heard, 0);
  });
});

test('partir, ou perdre le socket, retire le pair chez l\'autre', async () => {
  await withVoice(async h => {
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const ready = peersWhere(alice, ids => ids.includes('bob'));
    alice.emit('vr:voice:join', { roomId: null });
    bob.emit('vr:voice:join', { roomId: null });
    await ready;

    const gone = peersWhere(alice, ids => ids.length === 0);
    bob.emit('vr:voice:leave');
    await gone;

    const back = peersWhere(alice, ids => ids.includes('bob'));
    bob.emit('vr:voice:join', { roomId: null });
    await back;
    const lost = peersWhere(alice, ids => ids.length === 0);
    bob.disconnect();
    await lost;
  });
});

test('défaire une amitié en séance raccroche les deux, tout de suite', async () => {
  await withVoice(async h => {
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const ready = peersWhere(bob, ids => ids.includes('alice'));
    alice.emit('vr:voice:join', { roomId: null });
    bob.emit('vr:voice:join', { roomId: null });
    await ready;

    const aliceAlone = peersWhere(alice, ids => ids.length === 0);
    const bobAlone = peersWhere(bob, ids => ids.length === 0);
    h.unfriend('alice', 'bob');
    await Promise.all([aliceAlone, bobAlone]);

    const heard = countDuring(bob, 'vr:voice:signal');
    alice.emit('vr:voice:signal', { to: 'bob', signal: { type: 'offer' } });
    assert.equal(await heard, 0);
  });
});

test('un signal trop gros est jeté', async () => {
  await withVoice(async h => {
    const alice = await h.client('alice');
    const bob = await h.client('bob');
    const ready = peersWhere(bob, ids => ids.includes('alice'));
    alice.emit('vr:voice:join', { roomId: null });
    bob.emit('vr:voice:join', { roomId: null });
    await ready;

    const heard = countDuring(bob, 'vr:voice:signal');
    alice.emit('vr:voice:signal', { to: 'bob', signal: { sdp: 'x'.repeat(MAX_SIGNAL_BYTES + 1) } });
    assert.equal(await heard, 0);
  });
});

test('une session anonyme ne peut pas ouvrir la voix', async () => {
  await withVoice(async h => {
    const anon = await h.client('anon');
    const refused = once<{ code: string; event: string }>(anon, 'error');
    anon.emit('vr:voice:join', { roomId: null });
    const error = await refused;
    assert.equal(error.code, ANONYMOUS_FORBIDDEN);
    assert.equal(error.event, 'vr:voice:join');
  });
});
