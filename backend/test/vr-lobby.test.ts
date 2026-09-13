import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

/*
 * Le lobby VR, sur de vraies sockets.
 *
 * Ce fichier reprend le montage de `lobby-protocol.test.ts` - un vrai serveur,
 * de vrais clients, une vraie base - parce que ce qui est testé ici n'est pas
 * une fonction mais un régime : un battement qui parle tout seul, à qui il faut,
 * et à personne d'autre.
 *
 * Le test de confidentialité est la raison d'être du fichier. L'ensemble des
 * destinataires est calculé par le serveur à partir des amitiés acceptées, et
 * jamais fourni par le client ; si la diffusion s'élargissait un jour à tous les
 * présents, « un non-ami en VR est invisible des deux côtés » et « un joueur ne
 * se voit jamais lui-même » doivent échouer bruyamment.
 *
 * Comme dans le fichier modèle, on n'attend jamais une durée quand on peut
 * attendre un évènement - à une exception près, et c'est toujours la même :
 * prouver qu'aucun instantané n'arrive demande de regarder passer du temps. Ces
 * trois endroits sont commentés là où ils sont.
 */

const dir = mkdtempSync(join(tmpdir(), 'psnes-vr-lobby-'));
// Posé avant le premier getDb(), qui n'a lieu que dans un gestionnaire.
process.env.DATABASE_URL = `file:${join(dir, 'vr-lobby.db')}`;

const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { insertUser } = await import('./helpers.js');
const { findUserById } = await import('../src/db/users.js');
const { createFriendshipRequest, acceptFriendship } = await import('../src/db/friendships.js');
const { Presence } = await import('../src/websocket/presence.js');
const { registerVrLobby, BEAT_MS } = await import('../src/websocket/vr-lobby.js');
type User = import('../src/db/types.js').User;

// `bun test` fait tourner tous les fichiers dans un seul processus, donc le
// singleton getDb() peut encore tenir la poignée (fermée) d'un autre fichier.
forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `[x, y, z, qx, qy, qz, qw]`, tel qu'il voyage sur le fil. */
type WirePose = [number, number, number, number, number, number, number];

interface Peer {
  id: string;
  head: WirePose;
  left: WirePose | null;
  right: WirePose | null;
}

interface Snapshot {
  peers: Peer[];
}

/** Une pose reconnaissable à son premier nombre, avec ou sans les mains. */
function poseAt(x: number, hands = false) {
  return {
    head: [x, 1.6, -2, 0, 0, 0, 1] as WirePose,
    left: hands ? ([x - 0.2, 1.2, -1.8, 0, 0, 0, 1] as WirePose) : null,
    right: hands ? ([x + 0.2, 1.2, -1.8, 0, 0, 0, 1] as WirePose) : null
  };
}

const ALICE_POSE = poseAt(-2);
const BOB_POSE = poseAt(2, true);
/** La pose de Bob depuis un socket neuf : reconnaissable à son x. */
const BOB_AGAIN = poseAt(7, true);
const CAROL_POSE = poseAt(11);

/** Attend un évènement. Jamais une durée : c'est ce qui rend ce fichier fiable. */
function once<T>(socket: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Le prochain `vr:lobby` qui satisfait `matches`.
 *
 * Pas `once` : le battement produit un instantané toutes les 66 ms, et celui
 * qui arrive juste après un `emit` a été calculé AVANT que le serveur ne l'ait
 * traité. Prendre le premier venu, c'est lire un monde vieux d'une image - la
 * même course que celle que `viewWhere` évite dans `lobby-protocol.test.ts`.
 */
function lobbyWhere(
  socket: ClientSocket, matches: (snapshot: Snapshot) => boolean, ms = 5000
): Promise<Snapshot> {
  return new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('vr:lobby', onSnapshot);
      reject(new Error('timed out waiting for a matching vr:lobby'));
    }, ms);

    function onSnapshot(snapshot: Snapshot) {
      if (!matches(snapshot)) return;
      clearTimeout(timer);
      socket.off('vr:lobby', onSnapshot);
      resolve(snapshot);
    }

    socket.on('vr:lobby', onSnapshot);
  });
}

/**
 * Les `count` prochains instantanés, dans l'ordre.
 *
 * Sert à affirmer qu'une propriété tient sur plusieurs battements, et pas juste
 * sur celui qu'on a eu la chance d'attraper : c'est ce qui fait la différence
 * entre « B est visible » et « B reste visible ».
 */
function collect<T>(socket: ClientSocket, event: string, count: number, ms = 5000): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const seen: T[] = [];
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out after ${seen.length}/${count} "${event}"`));
    }, ms);

    function onEvent(payload: T) {
      seen.push(payload);
      if (seen.length < count) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(seen);
    }

    socket.on(event, onEvent);
  });
}

/**
 * Combien d'évènements arrivent pendant `ms`.
 *
 * La seule attente d'une durée de ce fichier, et elle est irréductible :
 * prouver qu'un battement NE tourne PAS, c'est regarder passer du temps sans
 * rien voir. Aucun autre test ne s'en sert.
 */
function countDuring(socket: ClientSocket, event: string, ms: number): Promise<number> {
  return new Promise<number>(resolve => {
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
  alice: User;
  bob: User;
  /** Une inconnue : une demande d'amitié avec Alice, jamais acceptée. */
  carol: User;
  client(user: User): Promise<ClientSocket>;
  /** Ferme ce socket-là pour de vrai, et attend que le serveur l'ait vu. */
  drop(socket: ClientSocket): Promise<void>;
  /** Combien de battements tournent en ce moment. Voir `countBeats`. */
  beatsRunning(): number;
}

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/**
 * Compte les battements armés, en comptant les `setInterval` de 66 ms.
 *
 * Passer par le global est intrusif, et c'est pourtant la seule façon de voir
 * la chose : un battement qui tourne sur une carte VIDE n'émet rien, donc
 * « armé pour rien » et « pas armé » sont rigoureusement indiscernables de
 * l'extérieur. Sans ce compteur, la version « toujours armé » passerait tous
 * les tests - vérifié, la mutation survivait.
 *
 * Tout est délégué au vrai timer, seul `BEAT_MS` est compté - la période de
 * `ping` de socket.io en est à trois ordres de grandeur - et le global est
 * remis en place dans le `finally` du harnais : `bun test` partage un seul
 * processus, et une globale laissée derrière soi casse les fichiers suivants.
 */
function countBeats(): { running(): number; restore(): void } {
  const live = new Set<unknown>();

  globalThis.setInterval = ((handler: never, delay?: number, ...args: never[]) => {
    const handle = realSetInterval(handler, delay, ...args);
    if (delay === BEAT_MS) live.add(handle);
    return handle;
  }) as typeof globalThis.setInterval;

  globalThis.clearInterval = ((handle?: never) => {
    live.delete(handle);
    realClearInterval(handle);
  }) as typeof globalThis.clearInterval;

  return {
    running: () => live.size,
    restore: () => {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  };
}

let seq = 0;

/**
 * Un serveur qui tourne avec le vrai module, trois comptes et une amitié.
 *
 * Les comptes sont neufs à chaque fois : les fichiers de test partagent un seul
 * fichier de base, et deux harnais qui se marcheraient sur les amitiés
 * donneraient des instantanés incompréhensibles.
 */
async function withVrLobby(run: (harness: Harness) => Promise<void>): Promise<void> {
  const tag = `v${++seq}`;
  const alice = findUserById(db, insertUser(db, { id: `${tag}-alice`, pseudo: 'Alice' }).id)!;
  const bob = findUserById(db, insertUser(db, { id: `${tag}-bob`, pseudo: 'Bob' }).id)!;
  const carol = findUserById(db, insertUser(db, { id: `${tag}-carol`, pseudo: 'Carol' }).id)!;

  acceptFriendship(db, createFriendshipRequest(db, alice.id, bob.id).id);
  // Laissée en attente exprès : une demande que personne n'a acceptée n'est pas
  // une amitié, et c'est tout l'objet du test de confidentialité.
  createFriendshipRequest(db, alice.id, carol.id);

  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const presence = new Presence();
  // Posé AVANT l'enregistrement : c'est un battement armé là, avant que
  // quiconque n'ait mis un casque, qu'il s'agit de voir.
  const beats = countBeats();
  const vrLobby = registerVrLobby(io, presence);
  const serverSockets = new Map<string, ServerSocket>();

  io.on('connection', socket => {
    const userId = socket.handshake.auth.userId as string;
    const user = findUserById(db, userId)!;
    serverSockets.set(socket.id, socket);
    // L'ordre de `websocket/index.ts` : la présence d'abord - `attach` en
    // dépend pour joindre les amis - puis les écouteurs VR.
    presence.register(user, socket.id);
    vrLobby.attach(socket, user);
    // La moitié présence de ce que fait `websocket/index.ts` sur un disconnect,
    // avec sa garde : c'est elle qui rend la reconnexion tardive testable ici.
    socket.on('disconnect', () => { presence.unregister(user.id, socket.id); });
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

  /*
   * Une vraie fermeture, attendue côté serveur.
   *
   * C'est le socket serveur qu'il faut attendre et pas le client : le client se
   * sait fermé bien avant que le serveur n'ait exécuté son gestionnaire, et
   * c'est exactement la fenêtre qui rendrait les assertions aléatoires. L'écoute
   * posée ici court après celle du module, donc l'attendre garantit que la
   * sortie a déjà été traitée.
   */
  const drop = async (socket: ClientSocket) => {
    // L'identifiant AVANT la fermeture : socket.io-client l'efface en partant.
    const id = socket.id!;
    const server = serverSockets.get(id)!;
    const closed = new Promise<void>(done => server.once('disconnect', () => done()));
    socket.close();
    await closed;
  };

  try {
    await run({ alice, bob, carol, client, drop, beatsRunning: beats.running });
  } finally {
    // Avant tout le reste : un battement encore armé tiendrait le processus
    // éveillé et ferait traîner la suite entière.
    vrLobby.stop();
    beats.restore();
    for (const socket of clients) socket.close();
    /*
     * Sous Bun, les websockets que socket.io a montées ne sont jamais comptées
     * comme terminées, donc ni `io.close(cb)` ni `httpServer.close(cb)` ne
     * rappellent jamais. On coupe donc explicitement, comme le fait déjà
     * `lobby-protocol.test.ts`.
     */
    io.close();
    httpServer.closeAllConnections();
    if (httpServer.listening) await new Promise<void>(done => httpServer.close(() => done()));
  }
}

test('deux amis en VR se voient dans leur instantané', async () => {
  await withVrLobby(async ({ alice, bob, client }) => {
    const a = await client(alice);
    const b = await client(bob);

    /*
     * « En VR » voyage sur le canal des amis, et volontairement : c'est un état
     * d'ami comme « en ligne ». Sans lui, personne ne saurait depuis la page à
     * plat qu'il y a quelqu'un à rejoindre - et on ne met pas un casque au
     * hasard.
     */
    const told = once<{ userId: string; online: boolean; inVr: boolean }>(a, 'friend:statusChanged');
    b.emit('vr:enter');
    b.emit('vr:pose', BOB_POSE);
    assert.deepEqual(await told, { userId: bob.id, online: true, inVr: true });

    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);

    const seenByAlice = await lobbyWhere(a, s => s.peers.length === 1);
    assert.equal(seenByAlice.peers[0].id, bob.id);
    assert.deepEqual(seenByAlice.peers[0].head, BOB_POSE.head);
    // Les mains voyagent avec la tête, dans le même message : c'est ce qui fait
    // qu'un ami n'a jamais des mains d'une image et une tête d'une autre.
    assert.deepEqual(seenByAlice.peers[0].left, BOB_POSE.left);
    assert.deepEqual(seenByAlice.peers[0].right, BOB_POSE.right);

    const seenByBob = await lobbyWhere(b, s => s.peers.length === 1);
    assert.equal(seenByBob.peers[0].id, alice.id);
    assert.deepEqual(seenByBob.peers[0].head, ALICE_POSE.head);
    // Alice n'a pas sorti ses manettes, et ça se dit plutôt que de s'inventer.
    assert.equal(seenByBob.peers[0].left, null);
    assert.equal(seenByBob.peers[0].right, null);
  });
});

test('un joueur ne se voit jamais lui-même', async () => {
  await withVrLobby(async ({ alice, bob, client }) => {
    const a = await client(alice);
    // Un ami connecté, mais sans casque : il y a donc quelqu'un dans la liste
    // d'amis d'Alice, et personne à voir.
    await client(bob);

    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);

    const snapshots = await collect<Snapshot>(a, 'vr:lobby', 4);
    for (const snapshot of snapshots) {
      assert.deepEqual(
        snapshot.peers, [],
        'un joueur seul en VR n\'a personne à voir, à commencer par lui-même'
      );
    }
  });
});

test('un non-ami en VR est invisible des deux côtés', async () => {
  await withVrLobby(async ({ alice, carol, client }) => {
    const a = await client(alice);
    const c = await client(carol);

    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    c.emit('vr:enter');
    c.emit('vr:pose', CAROL_POSE);

    /*
     * LE test de confidentialité de la fonctionnalité.
     *
     * Sur plusieurs battements, parce qu'une fuite qui n'arriverait qu'une image
     * sur dix serait une fuite quand même. Les deux reçoivent bien des
     * instantanés - donc le battement tourne, et les voit tous les deux - et
     * aucun des deux n'y trouve l'autre.
     */
    const [aliceSaw, carolSaw] = await Promise.all([
      collect<Snapshot>(a, 'vr:lobby', 5),
      collect<Snapshot>(c, 'vr:lobby', 5)
    ]);

    for (const snapshot of aliceSaw) {
      assert.equal(
        snapshot.peers.find(peer => peer.id === carol.id), undefined,
        'un non-ami en VR ne doit jamais apparaître dans un instantané'
      );
      assert.deepEqual(snapshot.peers, [], 'et rien d\'autre ne doit s\'y être glissé');
    }
    for (const snapshot of carolSaw) {
      assert.equal(
        snapshot.peers.find(peer => peer.id === alice.id), undefined,
        'un non-ami en VR ne doit jamais apparaître dans un instantané'
      );
      assert.deepEqual(snapshot.peers, [], 'et rien d\'autre ne doit s\'y être glissé');
    }
  });
});

test('un départ est une absence dans l\'instantané suivant', async () => {
  await withVrLobby(async ({ alice, bob, client }) => {
    const a = await client(alice);
    const b = await client(bob);

    b.emit('vr:enter');
    b.emit('vr:pose', BOB_POSE);
    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    await lobbyWhere(a, s => s.peers.length === 1);

    const vrEvents: string[] = [];
    a.onAny(name => { if (name.startsWith('vr:')) vrEvents.push(name); });

    b.emit('vr:leave');
    const after = await lobbyWhere(a, s => s.peers.length === 0);
    assert.deepEqual(after.peers, []);

    /*
     * Et surtout : rien n'a été dit. Présence et position étant le même message,
     * la course « il est parti » contre « voici sa pose » n'existe pas, et c'est
     * la raison d'être de cette forme. `friend:statusChanged` n'est pas un
     * message de départ du lobby : il parle à la liste d'amis, depuis la page à
     * plat, d'un état d'ami.
     */
    assert.deepEqual(
      [...new Set(vrEvents)], ['vr:lobby'],
      'un départ est une absence, pas un message'
    );
  });
});

test('une déconnexion vaut un départ', async () => {
  await withVrLobby(async ({ alice, bob, client, drop }) => {
    const a = await client(alice);
    const b = await client(bob);

    b.emit('vr:enter');
    b.emit('vr:pose', BOB_POSE);
    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    await lobbyWhere(a, s => s.peers.length === 1);

    // Un casque qu'on repose, une batterie vide, un tunnel : le socket se ferme
    // sans que personne n'ait dit au revoir.
    await drop(b);

    const after = await collect<Snapshot>(a, 'vr:lobby', 3);
    for (const snapshot of after) {
      assert.deepEqual(
        snapshot.peers, [],
        'un ami dont le socket est mort ne doit pas rester planté dans le décor'
      );
    }
  });
});

test('vr:enter reçu deux fois n\'ajoute pas un second joueur', async () => {
  await withVrLobby(async ({ alice, bob, client }) => {
    const a = await client(alice);
    const b = await client(bob);

    b.emit('vr:enter');
    b.emit('vr:pose', BOB_POSE);
    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    await lobbyWhere(a, s => s.peers.length === 1);

    // Entrer est un ÉTAT, pas un évènement : un client qui réémet au retour d'un
    // menu ne doit ni se dédoubler, ni disparaître.
    b.emit('vr:enter');

    const snapshots = await collect<Snapshot>(a, 'vr:lobby', 8);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.peers.length, 1, 'entrer deux fois ne fait pas deux joueurs');
      assert.equal(snapshot.peers[0].id, bob.id);
      assert.deepEqual(
        snapshot.peers[0].head, BOB_POSE.head,
        'et la réentrée garde la pose, sinon l\'ami clignote hors du monde'
      );
    }
  });
});

test('une pose malformée est rejetée sans casser le battement', async () => {
  await withVrLobby(async ({ alice, bob, client }) => {
    const a = await client(alice);
    const b = await client(bob);

    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    b.emit('vr:enter');

    // Trois nombres manquants, puis un composant qui n'en est pas un. Une pose
    // à moitié valide qui passerait mettrait un NaN dans une matrice, donc un
    // ami qui disparaît du rendu de tous ses amis sans un mot dans un journal.
    b.emit('vr:pose', { head: [1, 2], left: null, right: null });
    b.emit('vr:pose', { head: ['x', 1, 2, 3, 4, 5, 6], left: null, right: null });

    // B est présent mais pas situé : on ne l'annonce pas, plutôt que de
    // l'annoncer à l'origine du décor. Que ces quatre instantanés arrivent
    // prouve du même coup que le battement n'est pas tombé.
    const refused = await collect<Snapshot>(a, 'vr:lobby', 4);
    for (const snapshot of refused) {
      assert.deepEqual(snapshot.peers, [], 'une pose malformée ne situe personne');
    }

    b.emit('vr:pose', BOB_POSE);
    const good = await lobbyWhere(a, s => s.peers.length === 1);
    assert.deepEqual(good.peers[0].head, BOB_POSE.head);
    assert.deepEqual(good.peers[0].left, BOB_POSE.left);

    // Et la validation est par membre : une main invalide coûte la main, pas la
    // tête - et elle n'hérite pas non plus de celle du message d'avant.
    b.emit('vr:pose', { head: BOB_POSE.head, left: [1, 2], right: BOB_POSE.right });
    const handless = await lobbyWhere(a, s => s.peers[0]?.left === null);
    assert.deepEqual(handless.peers[0].head, BOB_POSE.head);
    assert.deepEqual(handless.peers[0].right, BOB_POSE.right);
  });
});

test('un client qui inonde est plafonné, pas déconnecté', async () => {
  await withVrLobby(async ({ alice, bob, client }) => {
    const a = await client(alice);
    const b = await client(bob);

    b.emit('vr:enter');
    b.emit('vr:pose', BOB_POSE);
    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    await lobbyWhere(a, s => s.peers.length === 1);

    // Une rafale peut venir d'un réveil de tâche ou d'une image en retard.
    // Couper la session de quelqu'un pour ça serait une punition sans faute.
    for (let i = 0; i < 200; i += 1) b.emit('vr:pose', BOB_POSE);

    const still = await collect<Snapshot>(a, 'vr:lobby', 3);
    assert.equal(b.connected, true, 'un client qui inonde est plafonné, jamais déconnecté');
    for (const snapshot of still) {
      assert.equal(snapshot.peers.length, 1, 'et ses amis continuent d\'être servis');
      assert.deepEqual(snapshot.peers[0].head, BOB_POSE.head);
    }
  });
});

test('le battement ne tourne pas quand personne n\'est en VR', async () => {
  await withVrLobby(async ({ alice, client, beatsRunning }) => {
    const a = await client(alice);

    /*
     * Un serveur au repos ne doit pas se réveiller quinze fois par seconde pour
     * parcourir une carte vide.
     *
     * Les deux moitiés de l'assertion ne disent PAS la même chose, et c'est
     * exprès : compter les messages ne prouve que le silence, et un battement
     * qui tourne sur une carte vide est déjà silencieux. Seul le compteur de
     * `setInterval` voit la différence entre « armé pour rien » et « pas armé »
     * - sans lui la version toujours armée passe, ce qui a été vérifié.
     *
     * Les seules attentes d'une durée du fichier sont ici, et elles sont
     * irréductibles : on affirme une absence.
     */
    assert.equal(beatsRunning(), 0, 'aucun battement tant que personne n\'a mis un casque');
    assert.equal(
      await countDuring(a, 'vr:lobby', 300), 0,
      'sans personne en VR, rien ne doit partir'
    );

    a.emit('vr:enter');
    await once(a, 'vr:lobby');
    // Un seul, pour tout le lobby : chacun reçoit un message par battement quel
    // que soit son nombre d'amis présents, et il n'y a pas un réveil par joueur.
    assert.equal(beatsRunning(), 1, 'un unique battement, armé au premier entrant');

    a.emit('vr:leave');
    // Le désarmement est synchrone dans le gestionnaire ; cette fenêtre-ci ne
    // laisse passer que les instantanés déjà en vol au moment du départ.
    await countDuring(a, 'vr:lobby', 100);
    assert.equal(beatsRunning(), 0, 'et il se rendort quand le dernier casque est parti');
    assert.equal(
      await countDuring(a, 'vr:lobby', 300), 0,
      'plus personne en VR, donc plus rien sur le fil'
    );
  });
});

test('une reconnexion tardive ne retire pas la présence VR de la connexion neuve', async () => {
  await withVrLobby(async ({ alice, bob, client, drop }) => {
    const a = await client(alice);
    const first = await client(bob);

    a.emit('vr:enter');
    a.emit('vr:pose', ALICE_POSE);
    first.emit('vr:enter');
    first.emit('vr:pose', BOB_POSE);
    await lobbyWhere(a, s => s.peers[0]?.head[0] === BOB_POSE.head[0]);

    /*
     * Le piège que `presence.ts` documente, et qui a déjà fait disparaître des
     * joueurs de la liste d'amis de ce dépôt : le client revient et enregistre
     * son nouveau socket tout de suite, tandis que le serveur peut ne déclarer
     * l'ancien mort que vingt secondes plus tard.
     */
    const second = await client(bob);
    second.emit('vr:enter');
    second.emit('vr:pose', BOB_AGAIN);
    // Attendre la pose du socket neuf, c'est s'assurer que la mort de l'ancien
    // arrive bien APRÈS son enregistrement - sans quoi il n'y a pas de piège.
    await lobbyWhere(a, s => s.peers[0]?.head[0] === BOB_AGAIN.head[0]);

    await drop(first);

    const after = await collect<Snapshot>(a, 'vr:lobby', 4);
    for (const snapshot of after) {
      assert.equal(
        snapshot.peers.length, 1,
        'la mort du vieux socket ne doit pas effacer la connexion neuve'
      );
      assert.equal(snapshot.peers[0].id, bob.id);
      assert.deepEqual(snapshot.peers[0].head, BOB_AGAIN.head);
    }
  });
});
