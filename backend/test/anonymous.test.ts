/**
 * Le joueur anonyme : une identité sans compte, et tout ce qu'elle n'ouvre pas.
 *
 * Le mot est `anonymous` et non `guest` : dans ce dépôt un `guest` est le pair
 * non-hôte d'un salon (`room-view.ts`, `p2p-manager.ts`, `protocol.ts`,
 * `device-library-guest.test.ts`). `host`/`guest` est un rôle dans un salon,
 * `anonymous` est une identité : deux axes différents, donc deux mots.
 *
 * La moitié la plus importante de ce fichier n'est pas ce qu'un anonyme peut
 * faire, c'est ce qu'il ne peut pas : entrer dans un autre salon que le sien,
 * réclamer un pseudonyme, atteindre une route de compte, ou hériter des droits
 * que `room:setEmulationMode` et consorts réservent au créateur du salon.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUser,
  createAnonymousUser,
  deleteAnonymousUser,
  sweepAnonymousUsers,
  findUserById
} from '../src/db/users.js';
import {
  ANONYMOUS_FORBIDDEN,
  anonymousDoorDecision,
  anonymousJoinEnabled,
  anonymousRoomOf,
  mayEnterRoom
} from '../src/auth/anonymous.js';
import { gateAnonymousSocket, isAccountOnly } from '../src/websocket/anonymous-gate.js';
import { getJoinableRoom } from '../src/websocket/guards.js';
import { toSelf } from '../src/api/auth.js';
import { requireAccount, requirePseudo } from '../src/middleware/auth.js';
import type { Room } from '../src/types/index.js';
import { migratedDb, insertUser } from './helpers.js';

// ------------------------------------------------------------------ migration

test('googleId devient nullable, et les identifiants Google existants survivent', () => {
  const db = migratedDb();
  const account = insertUser(db, { googleId: 'g-survivor' });

  const columns = db.prepare(`PRAGMA table_info('User')`).all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const googleId = columns.find(c => c.name === 'googleId');

  assert.ok(googleId, 'la colonne reste : c est toujours la clé de jointure OAuth');
  assert.equal(googleId.notnull, 0, 'un anonyme n a pas d identifiant Google à y mettre');
  assert.equal(findUserById(db, account.id)?.googleId, 'g-survivor');
  db.close();
});

test('isAnonymous existe, vaut 0 par défaut, et un compte Google le reste', () => {
  const db = migratedDb();
  const account = createUser(db, { googleId: 'g-account', avatar: null });

  assert.equal(account.isAnonymous, false);
  assert.equal(insertUser(db, {}).id && findUserById(db, insertUser(db, {}).id)?.isAnonymous, false);
  db.close();
});

test('deux joueurs anonymes coexistent, malgré l index unique sur googleId', () => {
  // L index unique de 0001 est toujours là. SQLite laisse passer plusieurs
  // NULL : c est exactement pour ça que la migration rend la colonne nullable
  // plutôt que d inventer une valeur - un espace de noms fabriqué gardé par un
  // index unique se remplit et finit par refuser une entrée légitime.
  const db = migratedDb();

  const a = createAnonymousUser(db, {});
  const b = createAnonymousUser(db, {});

  assert.notEqual(a.id, b.id);
  assert.equal(a.googleId, null);
  assert.equal(b.googleId, null);
  db.close();
});

// -------------------------------------------------------------- la ligne créée

test('createAnonymousUser pose une ligne anonyme, sans pseudonyme choisi', () => {
  const db = migratedDb();

  const anon = createAnonymousUser(db, {});

  assert.equal(anon.isAnonymous, true);
  assert.equal(anon.googleId, null);
  // `pseudoChosenAt` garde son seul sens : « ce compte a répondu au portique ».
  // Un anonyme ne le franchit jamais, il en est dispensé - c est la troisième
  // branche de `requirePseudo`, pas une date posée à la va-vite.
  assert.equal(anon.pseudoChosenAt, null);
  // Un pseudonyme quand même : chaque écran qui liste des joueurs lit `pseudo`
  // sans condition, une ligne vide s y afficherait comme un trou.
  assert.ok(anon.pseudo.length >= 3);
  assert.match(anon.discriminator, /^\d{4}$/);
  db.close();
});

test('un anonyme peut se présenter sous le pseudonyme qu il tape', () => {
  const db = migratedDb();

  const anon = createAnonymousUser(db, { pseudo: 'Passant' });

  assert.equal(anon.pseudo, 'Passant');
  db.close();
});

test('un pseudonyme invalide est refusé, pas nettoyé en silence', () => {
  const db = migratedDb();

  assert.throws(() => createAnonymousUser(db, { pseudo: 'a' }), TypeError);
  assert.throws(() => createAnonymousUser(db, { pseudo: 'Élise' }), TypeError);
  db.close();
});

// ------------------------------------------------------- ce qui reste derrière

test('sweepAnonymousUsers efface les anonymes périmés et ne touche à aucun compte', () => {
  const db = migratedDb();
  const account = insertUser(db, {});
  const stale = createAnonymousUser(db, {});
  const fresh = createAnonymousUser(db, {});

  db.prepare(`UPDATE "User" SET createdAt = ? WHERE id = ?`)
    .run(Date.now() - 48 * 3_600_000, stale.id);

  const swept = sweepAnonymousUsers(db, new Date(Date.now() - 24 * 3_600_000));

  assert.equal(swept, 1);
  assert.equal(findUserById(db, stale.id), null);
  assert.ok(findUserById(db, fresh.id), 'une session en cours n est pas du ménage');
  assert.ok(findUserById(db, account.id), 'un compte n est jamais balayé, si vieux soit-il');
  db.close();
});

test('deleteAnonymousUser refuse de supprimer un compte', () => {
  const db = migratedDb();
  const account = insertUser(db, {});

  assert.equal(deleteAnonymousUser(db, account.id), false);
  assert.ok(findUserById(db, account.id), 'la porte de sortie des anonymes n efface pas les comptes');
  db.close();
});

// ---------------------------------------------------------------- la politique

test('la porte anonyme est ouverte par défaut et se ferme par variable d environnement', () => {
  assert.equal(anonymousJoinEnabled({}), true);
  assert.equal(anonymousJoinEnabled({ ANONYMOUS_JOIN: 'off' }), false);
  assert.equal(anonymousJoinEnabled({ ANONYMOUS_JOIN: 'on' }), true);
});

test('une session anonyme ne nomme qu un salon, et rien sans lui', () => {
  assert.equal(anonymousRoomOf({ anonymousRoomId: 'room-1' }), 'room-1');
  assert.equal(anonymousRoomOf({}), null);
  assert.equal(anonymousRoomOf(undefined), null);
  assert.equal(anonymousRoomOf({ anonymousRoomId: 42 }), null);
});

test('un anonyme n entre que dans le salon que sa session nomme', () => {
  const anon = { isAnonymous: true };
  const session = { anonymousRoomId: 'room-1' };

  assert.equal(mayEnterRoom(anon, session, 'room-1'), true);
  // Le lien reçu ouvre une porte, pas le bâtiment : un identifiant de salon
  // circule (liste des salons, notifications d amis), donc en tenir un ne doit
  // jamais suffire à y entrer.
  assert.equal(mayEnterRoom(anon, session, 'room-2'), false);
  assert.equal(mayEnterRoom(anon, {}, 'room-1'), false);
});

test('un compte entre par les portes habituelles, pas par celle-ci', () => {
  // `mayEnterRoom` répond « non » pour un compte : ce n est pas un refus, c est
  // que la question ne le concerne pas - son chemin reste l invitation, et
  // confondre les deux ferait de cette fonction une seconde autorisation
  // d entrée qu il faudrait garder en accord avec la première.
  assert.equal(mayEnterRoom({ isAnonymous: false }, { anonymousRoomId: 'room-1' }, 'room-1'), false);
});

// ---------------------------------------------------------- le portique HTTP

function spyResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(body: unknown) { sent.body = body; return res; }
  };
  return { res, sent };
}

test('requireAccount refuse un anonyme en 403, distinct du 401 et du 409', () => {
  const { res, sent } = spyResponse();
  let nexted = 0;

  requireAccount(
    { user: { id: 'a1', isAnonymous: true, pseudoChosenAt: null } } as never,
    res as never,
    () => { nexted++; }
  );

  // 403 et non 409 : contrairement au compte tenu par le portique du
  // pseudonyme, il ne manque ici aucune condition qu un anonyme pourrait
  // remplir. Il n a pas le droit, point - et le client doit pouvoir le lire
  // sans deviner.
  assert.equal(sent.status, 403);
  assert.deepEqual(sent.body, { error: ANONYMOUS_FORBIDDEN });
  assert.equal(nexted, 0);
});

test('requirePseudo a une troisième branche : l anonyme, refusé avant le pseudonyme', () => {
  const { res, sent } = spyResponse();
  let nexted = 0;

  requirePseudo(
    { user: { id: 'a1', isAnonymous: true, pseudoChosenAt: null } } as never,
    res as never,
    () => { nexted++; }
  );

  // Sans cette branche, `pseudoChosenAt === null` renverrait PSEUDO_REQUIRED :
  // le client afficherait la modale d embarquement à quelqu un qui n a pas de
  // compte à embarquer, et surtout la seule route ouverte pour en sortir -
  // `/api/pseudo` - lui donnerait un pseudonyme définitif dans l espace des
  // handles.
  assert.equal(sent.status, 403);
  assert.deepEqual(sent.body, { error: ANONYMOUS_FORBIDDEN });
  assert.equal(nexted, 0);
});

test('un compte qui a choisi son pseudonyme passe toujours les deux portiques', () => {
  for (const guard of [requireAccount, requirePseudo]) {
    const { res, sent } = spyResponse();
    let nexted = 0;
    guard(
      { user: { id: 'u1', isAnonymous: false, pseudoChosenAt: new Date() } } as never,
      res as never,
      () => { nexted++; }
    );
    assert.equal(nexted, 1);
    assert.equal(sent.status, undefined);
  }
});

// ------------------------------------------------------------------ la porte

test('la porte refuse un salon inexistant et un salon plein de la même façon', () => {
  // Un identifiant de salon circule. Répondre « plein » plutôt que
  // « inexistant » ferait de cette route, ouverte sans authentification, un
  // oracle qui confirme l existence d un salon à qui tient son identifiant.
  const absent = anonymousDoorDecision({ enabled: true, signedIn: false, blocked: false, room: null });
  const full = anonymousDoorDecision({ enabled: true, signedIn: false, blocked: false, room: { players: 2 } });

  assert.deepEqual(absent, full);
  assert.equal(absent.ok, false);
  assert.equal(absent.ok === false && absent.status, 404);
});

test('la porte compte les essais avant même de regarder le salon', () => {
  // L ordre est la décision : lire le salon d abord ferait de la limite une
  // protection qui arrive après l information qu elle devait protéger.
  const decision = anonymousDoorDecision({ enabled: true, signedIn: false, blocked: true, room: { players: 0 } });

  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 429);
});

test('la porte refuse quelqu un qui a déjà une session', () => {
  const decision = anonymousDoorDecision({ enabled: true, signedIn: true, blocked: false, room: { players: 0 } });

  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 409);
});

test('la porte fermée par le déploiement refuse tout le monde', () => {
  const decision = anonymousDoorDecision({ enabled: false, signedIn: false, blocked: false, room: { players: 0 } });

  assert.equal(decision.ok, false);
  assert.equal(decision.ok === false && decision.status, 403);
});

test('la porte refuse un pseudonyme invalide, et accepte l absence de pseudonyme', () => {
  const bad = anonymousDoorDecision({ enabled: true, signedIn: false, blocked: false, room: { players: 1 }, pseudo: 'x' });
  const none = anonymousDoorDecision({ enabled: true, signedIn: false, blocked: false, room: { players: 1 } });

  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.status, 400);
  assert.equal(none.ok, true);
});

test('la porte laisse entrer dans un salon qui a de la place', () => {
  const decision = anonymousDoorDecision({
    enabled: true, signedIn: false, blocked: false, room: { players: 1 }, pseudo: 'Passant'
  });

  assert.deepEqual(decision, { ok: true, pseudo: 'Passant' });
});

test('toSelf dit qu un joueur est anonyme, et ne demande pas de pseudonyme', () => {
  const self = toSelf({
    id: 'a1', googleId: null, isAnonymous: true, pseudo: 'Passant', discriminator: '0007',
    pseudoChosenAt: null, avatar: null, controlsConfig: null, createdAt: new Date(), updatedAt: new Date()
  });

  assert.equal(self.isAnonymous, true);
  // `needsPseudo` lève la modale bloquante et retient le socket. Un anonyme a
  // `pseudoChosenAt` null comme un compte neuf, donc sans cette distinction il
  // se retrouverait derrière un portique qu il ne peut pas franchir.
  assert.equal(self.needsPseudo, false);
  // L ensemble exact des clés, comme self-view.test.ts : une colonne ajoutée à
  // User plus tard ne peut pas rejoindre la réponse par accident.
  assert.deepEqual(
    Object.keys(self).sort(),
    ['avatar', 'discriminator', 'id', 'isAnonymous', 'needsPseudo', 'pseudo']
  );
});

// --------------------------------------------------------- la grille du socket

test('les événements réservés aux comptes couvrent la configuration du salon', () => {
  // Rejoindre un salon n est pas pouvoir le reconfigurer. Ces trois-là
  // décident pour les deux joueurs, et deux d entre eux sont déjà réservés au
  // créateur - ce qu un anonyme ne peut jamais être, puisqu il ne crée rien.
  // La liste le dit quand même, plutôt que de laisser la garantie reposer sur
  // une propriété d un autre fichier.
  for (const event of ['room:create', 'room:choose-game', 'room:choose-save',
                       'room:setEmulationMode', 'room:setLatencyMode', 'room:release-game']) {
    assert.equal(isAccountOnly(event), true, `${event} doit être réservé aux comptes`);
  }
});

test('les événements réservés aux comptes couvrent les bibliothèques et les amis', () => {
  for (const event of ['game:save', 'game:load', 'game:saveSram',
                       'lobby:invite', 'lobby:accept', 'lobby:decline', 'lobby:cancel',
                       'friends:getOnlineStatus']) {
    assert.equal(isAccountOnly(event), true, `${event} doit être réservé aux comptes`);
  }
});

test('jouer reste ouvert : s asseoir, se dire prêt, lancer, mettre en pause, quitter', () => {
  // La liste inverse compte autant : un anonyme qui ne peut pas prendre un
  // port ni signaler son émulateur prêt est assis dans un salon où rien ne
  // démarrera jamais, ce qui est une autre façon de ne pas l avoir laissé
  // entrer.
  for (const event of ['room:join', 'room:leave', 'room:selectPort', 'room:unselectPort',
                       'room:toggleReady', 'room:updateKeyConfig', 'game:start', 'game:ready',
                       'game:pause', 'game:stop', 'p2p:join', 'webrtc:signal', 'sync:checksum']) {
    assert.equal(isAccountOnly(event), false, `${event} doit rester ouvert`);
  }
});

test('un socket anonyme n entend jamais les événements réservés aux comptes', () => {
  const heard: string[] = [];
  const socket = fakeSocket();
  gateAnonymousSocket(socket as never, { isAnonymous: true });

  socket.on('room:create', () => heard.push('room:create'));
  socket.on('room:selectPort', () => heard.push('room:selectPort'));
  socket.fire('room:create', {});
  socket.fire('room:selectPort', {});

  // Refusé à l enregistrement plutôt que dans chaque gestionnaire : une garde
  // par gestionnaire est une garde que le prochain gestionnaire ajouté
  // oubliera, et c est exactement ce qu il ne faut pas pour une règle
  // d autorisation.
  assert.deepEqual(heard, ['room:selectPort']);
  assert.deepEqual(socket.refused, ['room:create']);
});

test('un socket de compte n est grillagé par rien', () => {
  const heard: string[] = [];
  const socket = fakeSocket();
  gateAnonymousSocket(socket as never, { isAnonymous: false });

  socket.on('room:create', () => heard.push('room:create'));
  socket.fire('room:create', {});

  assert.deepEqual(heard, ['room:create']);
});

// ------------------------------------------------------ la porte d un salon

test('getJoinableRoom rend le salon que la session anonyme nomme', () => {
  const rooms = roomMap('room-1', 'room-2');

  const joined = getJoinableRoom(rooms, 'room-1', anonUser(), { anonymousRoomId: 'room-1' }, 'room:join');

  assert.equal(joined?.id, 'room-1');
});

test('getJoinableRoom refuse à un anonyme tout autre salon', () => {
  const rooms = roomMap('room-1', 'room-2');

  assert.equal(getJoinableRoom(rooms, 'room-2', anonUser(), { anonymousRoomId: 'room-1' }, 'room:join'), null);
  assert.equal(getJoinableRoom(rooms, 'room-1', anonUser(), {}, 'room:join'), null);
});

test('getJoinableRoom ne change rien pour un compte : la qualité de membre reste la règle', () => {
  const rooms = roomMap('room-1');
  const account = { id: 'u1', isAnonymous: false };

  // Non-membre : refusé, comme avant. Une session anonyme portée par un compte
  // - ce que rien ne produit, mais qu une session recyclée pourrait - ne lui
  // ouvre aucune porte de plus.
  assert.equal(getJoinableRoom(rooms, 'room-1', account, { anonymousRoomId: 'room-1' }, 'room:join'), null);

  rooms.get('room-1')!.players.push({ userId: 'u1' } as never);
  assert.equal(getJoinableRoom(rooms, 'room-1', account, {}, 'room:join')?.id, 'room-1');
});

function anonUser() {
  return { id: 'a1', isAnonymous: true };
}

/** Le minimum d'un salon que `getJoinableRoom` regarde : son id et ses joueurs. */
function roomMap(...ids: string[]): Map<string, Room> {
  return new Map(ids.map(id => [id, { id, players: [] }])) as unknown as Map<string, Room>;
}

function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    refused: [] as string[],
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return this;
    },
    emit(event: string, payload: { code?: string }) {
      if (event === 'error' && payload?.code === ANONYMOUS_FORBIDDEN) this.refused.push(this.lastFired);
    },
    lastFired: '',
    fire(event: string, payload: unknown) {
      this.lastFired = event;
      handlers.get(event)?.(payload);
    }
  };
}
