/**
 * Who may send a ROM to whom.
 *
 * The relay was written for one direction - host to guest - on the premise
 * that "the host has the cartridge by definition". That premise is false: a
 * library entry lives on the server and the bytes live on one device, so
 * playing from a second machine, or after clearing the browser's storage,
 * leaves the HOST as the one without the file. Production caught it on
 * 2026-09-09: the host asked three times over two minutes and the relay threw
 * every request away, while the guest sat there holding the dump.
 *
 * So what these pin down is that the relay carries bytes in whichever
 * direction they are needed, and that "only to someone who asked" - not "only
 * from the host" - is what keeps a player from pushing megabytes at the other.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server, Socket } from 'socket.io';
import type { Room, User } from '../src/types/index.js';
import { registerRomTransferHandlers } from '../src/websocket/rom-transfer.js';

const HOST = 'user-host';
const GUEST = 'user-guest';

function room(over: Partial<Room> = {}): Room {
  return {
    id: 'room-1',
    hostId: HOST,
    createdBy: HOST,
    players: [{ userId: HOST }, { userId: GUEST }],
    status: 'playing',
    emulationMode: 'lockstep',
    ...over
  } as Room;
}

/**
 * The relay's four collaborators, faked.
 *
 * `registerRomTransferHandlers` already takes every one of them as an
 * argument, so nothing here reaches around the code under test: the handlers
 * are the real ones, and what is recorded is what a real socket would have
 * been told to send.
 */
function relay(
  rooms: Map<string, Room>,
  /** Qui est joignable. Par défaut tout le monde ; un onglet fermé n'a plus de socket. */
  getUserSocket: (id: string) => string | undefined = (id) => `socket:${id}`
) {
  const handlers = new Map<string, (payload: never) => void>();
  const delivered: Array<{ to: string; event: string; payload: unknown }> = [];

  const connect = (user: User) => {
    const mine = new Map<string, (payload: never) => void>();
    const socket = {
      on: (event: string, handler: (payload: never) => void) => mine.set(event, handler),
      emit: (event: string, payload: unknown) =>
        delivered.push({ to: `socket:${user.id}`, event, payload })
    } as unknown as Socket;

    const io = {
      to: (target: string) => ({
        emit: (event: string, payload: unknown) => delivered.push({ to: target, event, payload })
      })
    } as unknown as Server;

    registerRomTransferHandlers(socket, user, io, rooms, getUserSocket);
    for (const [event, handler] of mine) handlers.set(`${user.id}:${event}`, handler);
  };

  const send = (userId: string, event: string, payload: unknown) => {
    const handler = handlers.get(`${userId}:${event}`);
    assert.ok(handler, `no handler registered for ${event}`);
    handler(payload as never);
  };

  return { connect, send, delivered };
}

const asUser = (id: string): User => ({ id, pseudo: id } as User);

const chunk = (over: Record<string, unknown> = {}) => ({
  roomId: 'room-1',
  seq: 0,
  total: 1,
  byteLength: 4,
  payload: new ArrayBuffer(4),
  ...over
});

test('a guest who lacks the ROM still reaches the host', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(GUEST, 'rom:request', { roomId: 'room-1' });

  assert.deepEqual(
    wire.delivered.filter(d => d.event === 'rom:request').map(d => d.to),
    [`socket:${HOST}`]
  );
});

test('a host who lacks the ROM reaches the guest', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(HOST, 'rom:request', { roomId: 'room-1' });

  // The whole bug: this used to be dropped on the floor because the asker
  // happened to be the host, and the host is not always the one with the file.
  assert.deepEqual(
    wire.delivered.filter(d => d.event === 'rom:request').map(d => d.to),
    [`socket:${GUEST}`]
  );
});

test('a request is never handed back to whoever asked', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(GUEST));

  wire.send(GUEST, 'rom:request', { roomId: 'room-1' });

  assert.equal(
    wire.delivered.some(d => d.event === 'rom:request' && d.to === `socket:${GUEST}`),
    false
  );
});

test('a guest may answer the host that asked', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));
  wire.send(HOST, 'rom:request', { roomId: 'room-1' });

  wire.send(GUEST, 'rom:chunk', chunk({ to: HOST }));

  const chunks = wire.delivered.filter(d => d.event === 'rom:chunk');
  assert.equal(chunks.length, 1, 'the guest holding the dump has to be allowed to send it');
  assert.equal(chunks[0].to, `socket:${HOST}`);
});

test('nobody receives bytes they did not ask for', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(HOST, 'rom:chunk', chunk({ to: GUEST }));

  // This is the guard that replaces "only the host may send". Being in the
  // room is not consent to receive four megabytes; having asked is.
  assert.equal(wire.delivered.filter(d => d.event === 'rom:chunk').length, 0);
});

test('a member with no copy either can say so, whichever side asked', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));
  wire.send(HOST, 'rom:request', { roomId: 'room-1' });

  wire.send(GUEST, 'rom:unavailable', { roomId: 'room-1', to: HOST, reason: 'no copy here' });

  const answers = wire.delivered.filter(d => d.event === 'rom:unavailable');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].to, `socket:${HOST}`);
});

test('an outstanding request does not survive the transfer that answered it', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));
  wire.send(HOST, 'rom:request', { roomId: 'room-1' });
  wire.send(GUEST, 'rom:chunk', chunk({ to: HOST, seq: 0, total: 1 }));

  wire.send(GUEST, 'rom:chunk', chunk({ to: HOST, seq: 0, total: 1 }));

  // Otherwise one request is a standing licence to push bytes for as long as
  // the room lives.
  assert.equal(wire.delivered.filter(d => d.event === 'rom:chunk').length, 1);
});

test('a stranger to the room is refused in both directions', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser('outsider'));

  wire.send('outsider', 'rom:request', { roomId: 'room-1' });
  wire.send('outsider', 'rom:chunk', chunk({ to: HOST }));

  assert.equal(wire.delivered.length, 0);
});

test('two overlapping answers still deliver every piece', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));
  wire.send(HOST, 'rom:request', { roomId: 'room-1' });

  // Both machines boot at once, so the asker repeats itself until someone
  // answers - and the answerer serves every copy of the question it queued.
  // Two sends therefore interleave, and counting raw arrivals would close the
  // transfer at four chunks with two of the four sequences never forwarded.
  for (const seq of [0, 0, 1, 1, 2, 3]) {
    wire.send(GUEST, 'rom:chunk', chunk({ to: HOST, seq, total: 4 }));
  }

  const seqs = wire.delivered
    .filter(d => d.event === 'rom:chunk')
    .map(d => (d.payload as { seq: number }).seq);
  assert.deepEqual([...new Set(seqs)].sort(), [0, 1, 2, 3]);
});

/*
 * Offrir un jeu depuis la bibliotheque.
 *
 * Le transfert n existait qu a l interieur d une partie, declenche par
 * l absence de fichier au moment du lancement - donc partager etait un effet
 * de bord, a l instant precis ou deux joueurs attendaient. Le proprietaire a
 * demande le 2026-09-10 de le decorreler : un joueur envoie un de ses jeux a
 * l ami de son groupe, depuis la bibliotheque, quand personne n attend.
 *
 * Un groupe EST un salon, donc rien ne change cote autorisation : les memes
 * gardes portent l offre. Ce qui manquait au protocole tient en deux
 * evenements et un champ.
 */

test('une offre atteint l autre joueur, en nommant qui l envoie', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(HOST, 'rom:offer', { roomId: 'room-1', crc32: 'DEADBEEF', title: 'Umihara Kawase' });

  const offers = wire.delivered.filter(d => d.event === 'rom:offer');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].to, `socket:${GUEST}`);
  assert.deepEqual(offers[0].payload, {
    roomId: 'room-1', crc32: 'DEADBEEF', title: 'Umihara Kawase', from: HOST
  });
});

test('une offre n est jamais renvoyee a celui qui l a faite', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));

  wire.send(HOST, 'rom:offer', { roomId: 'room-1', crc32: 'DEADBEEF', title: 'X' });

  assert.equal(wire.delivered.some(d => d.to === `socket:${HOST}`), false);
});

test('un etranger au salon n offre rien', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser('outsider'));

  wire.send('outsider', 'rom:offer', { roomId: 'room-1', crc32: 'DEADBEEF', title: 'X' });

  assert.equal(wire.delivered.length, 0);
});

test('la demande nomme le dump voulu, pas seulement le salon', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(GUEST, 'rom:request', { roomId: 'room-1', crc32: 'DEADBEEF' });

  // Sans ce champ la demande veut dire « envoie-moi le jeu DU SALON », ce qui
  // est faux des que le jeu partage n est pas celui que le salon porte - et en
  // bibliotheque, le salon n en porte souvent aucun.
  const asked = wire.delivered.find(d => d.event === 'rom:request')!;
  assert.deepEqual(asked.payload, { roomId: 'room-1', from: GUEST, crc32: 'DEADBEEF' });
});

test('une demande sans dump reste ce qu elle etait', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(GUEST, 'rom:request', { roomId: 'room-1' });

  // Le flux en partie ne doit pas bouger d un cheveu.
  const asked = wire.delivered.find(d => d.event === 'rom:request')!;
  assert.deepEqual(asked.payload, { roomId: 'room-1', from: GUEST });
});

test('un refus revient a celui qui a offert', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(HOST));
  wire.connect(asUser(GUEST));

  wire.send(GUEST, 'rom:offer-declined', { roomId: 'room-1', to: HOST });

  // Sans ca le bouton de l expediteur attendrait une reponse qui ne vient pas.
  const declined = wire.delivered.filter(d => d.event === 'rom:offer-declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0].to, `socket:${HOST}`);
});

test('un refus ne s adresse qu a un membre du salon', () => {
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms);
  wire.connect(asUser(GUEST));

  wire.send(GUEST, 'rom:offer-declined', { roomId: 'room-1', to: 'outsider' });

  assert.equal(wire.delivered.length, 0);
});

test('une offre que personne ne peut recevoir le dit a celui qui l a faite', () => {
  // Le seul membre joignable est l offrant : l autre a ferme son onglet, ou
  // n a jamais eu de socket. Sans reponse, son bouton attend pour toujours -
  // et le journal disait « offered a game » comme si tout allait bien, parce
  // qu il etait ecrit AVANT de savoir si quelqu un avait ete atteint.
  const rooms = new Map([['room-1', room()]]);
  const wire = relay(rooms, (id) => (id === HOST ? `socket:${HOST}` : undefined));
  wire.connect(asUser(HOST));

  wire.send(HOST, 'rom:offer', { roomId: 'room-1', crc32: 'DEADBEEF', title: 'X' });

  const answers = wire.delivered.filter(d => d.event === 'rom:offer-declined');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].to, `socket:${HOST}`);
  assert.equal((answers[0].payload as { reason: string }).reason, 'unreachable');
  assert.equal(wire.delivered.some(d => d.event === 'rom:offer'), false);
});
