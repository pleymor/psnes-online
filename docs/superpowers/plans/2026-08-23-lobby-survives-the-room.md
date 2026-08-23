# Le salon survit à la partie — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un salon cesse de mourir quand ses joueurs le quittent : partir devient une absence, pas un départ, et on y revient sans ré-inviter.

**Architecture:** `RoomPlayer` gagne `online`, `Room` gagne `abandonedAt`. Une déconnexion bascule le booléen au lieu de retirer le joueur, ce qui permet de supprimer entièrement la machinerie de délai de grâce. Un balayeur détruit les salons abandonnés depuis douze heures, et devient la seule autorité sur la péremption — le TTL de l'instantané Redis redevient une simple borne de stockage.

**Tech Stack:** TypeScript, Node.js `node:test`, Socket.IO, Svelte/SvelteKit, Redis (instantané), better-sqlite3 (non touché ici).

**Spec:** `docs/superpowers/specs/2026-08-23-lobby-survives-the-room-design.md`

## Global Constraints

- **Aucune migration.** Ce morceau ne touche pas `backend/migrations/` ni la base SQLite. Si une tâche semble en exiger une, c'est que le plan est faux — s'arrêter et le dire.
- **L'horloge est toujours un paramètre.** Aucune fonction de décision n'appelle `Date.now()` ni `new Date()` en interne. Sans ça, aucun test ne peut faire vieillir un salon. Modèle à suivre : `backend/src/rooms/invitation-state.ts`.
- **Durée d'abandon : 12 heures** (`ABANDON_AFTER_MS = 12 * 60 * 60_000`).
- **TTL de l'instantané : 24 heures** (`TTL_SECONDS = 24 * 60 * 60`). Rafraîchissement tous les **3600 tics**.
- **Tout minuteur est `unref`'d.** Un minuteur qui garde le processus en vie fait passer la suite de tests de 0,9 s à 48 s. C'est déjà arrivé deux fois dans ce dépôt.
- **Commande de test backend :** `npm run test:backend`. Suite complète : `npm run test:all`. Ces deux-là ne lancent **pas** Playwright ; `npm run test:e2e` est séparé et doit être lancé explicitement.
- **Node n'est pas sur le PATH par défaut.** Préfixer : `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | tail -1)/bin:$PATH"`.
- **Ne jamais `git add -A`.** Mettre en scène par chemin ; `package-lock.json` est modifié par l'installation et ne fait partie d'aucun commit de ce plan.

---

### Task 1: `onlinePlayers` côté serveur

Le compteur unique des sites qui doivent compter les présents plutôt que les membres. Écrit avant ses appelants pour que ceux-ci n'aient jamais à comparer à la main.

**Files:**
- Create: `backend/src/rooms/online-players.ts`
- Test: `backend/test/presence.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `onlinePlayers(room: { players: RoomPlayer[] }): RoomPlayer[]`

- [ ] **Step 1: Write the failing test**

Créer `backend/test/presence.test.ts` :

```ts
/**
 * Presence, as a pure decision.
 *
 * A member who is offline is still a member: their seat is theirs, they hold
 * their port, and nobody may take either. What they cannot do is be counted
 * as someone a game can start against. These tests fix that distinction,
 * which four call sites depend on and none of them can express in a type.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { onlinePlayers } from '../src/rooms/online-players.js';

const player = (userId: string, online: boolean) =>
  ({ userId, displayName: userId, port: null, isReady: true, emulationReady: false, online }) as never;

test('only the players who are here are counted', () => {
  const room = { players: [player('alice', true), player('bob', false)] };
  assert.deepEqual(onlinePlayers(room as never).map(p => p.userId), ['alice']);
});

test('a room where nobody is here counts nobody, and does not throw', () => {
  const room = { players: [player('alice', false), player('bob', false)] };
  assert.deepEqual(onlinePlayers(room as never), []);
});

/*
 * Rooms read back from a snapshot written before this field existed have no
 * `online` at all. Absent must mean offline: counting `undefined` as present
 * would let a game start against a player who is not there, which is the exact
 * failure this whole module exists to prevent.
 */
test('a player restored without the field is treated as away, not as present', () => {
  const room = { players: [{ userId: 'alice', port: 1, isReady: true }] };
  assert.deepEqual(onlinePlayers(room as never), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | tail -1)/bin:$PATH"
node --import tsx --test backend/test/presence.test.ts
```

Attendu : ÉCHEC, `Cannot find module '../src/rooms/online-players.js'`.

- [ ] **Step 3: Write minimal implementation**

Créer `backend/src/rooms/online-players.ts` :

```ts
import type { RoomPlayer } from '../types/index.js';

/**
 * The players who are actually here.
 *
 * Since a member who closes their tab keeps their seat, `room.players` answers
 * "who belongs to this room" and no longer answers "who can a game start
 * against". Four sites need the second question and used to ask the first.
 *
 * Do not use this to decide whether the room is full, nor whether the invite
 * panel may be shown. An away member's seat is still theirs, and offering it to
 * someone else is the one thing this whole change exists to prevent.
 */
export function onlinePlayers(room: { players: RoomPlayer[] }): RoomPlayer[] {
  return room.players.filter(p => p.online === true);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test backend/test/presence.test.ts
```

Attendu : PASS, 3 tests.

Note : le champ `online` n'existe pas encore sur `RoomPlayer` ; `p.online === true` ne compilera pas tant que la tâche 3 ne l'a pas ajouté. Ajouter le champ **maintenant** dans `backend/src/types/index.ts:26`, à la ligne suivant `emulationReady` :

```ts
  /**
   * Whether this member currently has a socket connected.
   *
   * Optional because rooms read back from a snapshot written before this field
   * existed have no value for it, and absent has to mean away.
   */
  online?: boolean;
```

- [ ] **Step 5: Verify the whole backend suite is still green**

```bash
npm run test:backend
```

Attendu : 0 échec.

- [ ] **Step 6: Commit**

```bash
git add backend/src/rooms/online-players.ts backend/test/presence.test.ts backend/src/types/index.ts
git commit -m "Count the players who are here, not the ones who belong"
```

---

### Task 2: La décision d'abandon

Quand un salon a-t-il assez attendu pour mourir. Fonction pure, horloge en paramètre, borne exacte prouvée.

**Files:**
- Create: `backend/src/rooms/abandonment.ts`
- Modify: `backend/test/presence.test.ts` (ajouts en fin de fichier)

**Interfaces:**
- Consumes: rien.
- Produces:
  - `ABANDON_AFTER_MS: number`
  - `isAbandoned(room: { abandonedAt?: Date }, now: Date): boolean`
  - `abandonedRoomIds(rooms: Map<string, Room>, now: Date): string[]`

- [ ] **Step 1: Write the failing test**

Ajouter à la fin de `backend/test/presence.test.ts` :

```ts
import { ABANDON_AFTER_MS, abandonedRoomIds, isAbandoned } from '../src/rooms/abandonment.js';

const AT = new Date('2026-08-23T20:00:00.000Z');
const ago = (ms: number) => new Date(AT.getTime() - ms);

test('a room somebody is still in is never abandoned', () => {
  assert.equal(isAbandoned({}, AT), false);
});

test('a room abandoned less than the deadline ago survives', () => {
  assert.equal(isAbandoned({ abandonedAt: ago(ABANDON_AFTER_MS - 1) }, AT), false);
});

/*
 * The exact instant, on its own line.
 *
 * `>=` and `>` differ by one millisecond and by nothing a reader would notice,
 * which is why the boundary gets a test of its own rather than being implied by
 * the two either side of it. The invitation deadline has the same test for the
 * same reason.
 */
test('a room abandoned exactly the deadline ago is abandoned', () => {
  assert.equal(isAbandoned({ abandonedAt: ago(ABANDON_AFTER_MS) }, AT), true);
});

test('twelve hours is the deadline', () => {
  assert.equal(ABANDON_AFTER_MS, 12 * 60 * 60_000);
});

test('the sweep names the abandoned rooms and leaves the others alone', () => {
  const rooms = new Map<string, never>([
    ['live', { id: 'live', abandonedAt: undefined } as never],
    ['recent', { id: 'recent', abandonedAt: ago(60_000) } as never],
    ['stale', { id: 'stale', abandonedAt: ago(ABANDON_AFTER_MS + 1) } as never]
  ]);

  assert.deepEqual(abandonedRoomIds(rooms as never, AT), ['stale']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test backend/test/presence.test.ts
```

Attendu : ÉCHEC, `Cannot find module '../src/rooms/abandonment.js'`.

- [ ] **Step 3: Write minimal implementation**

Créer `backend/src/rooms/abandonment.ts` :

```ts
import type { Room } from '../types/index.js';

/**
 * How long a room nobody is in survives before it is destroyed.
 *
 * Twelve hours covers the case this whole change is for: leave, change game,
 * have dinner, come back. It deliberately does not cover coming back the next
 * evening - that would need real persistence rather than a Redis snapshot, and
 * that is a separate piece of work, not a bigger number here.
 */
export const ABANDON_AFTER_MS = 12 * 60 * 60_000;

/**
 * Whether this room has waited long enough to be destroyed.
 *
 * `now` is a parameter and never `Date.now()`, for the same reason
 * `invitationState` takes one: without it no test can age a room, and the
 * expiry is precisely what has to be proved.
 *
 * No `abandonedAt` means somebody is still in the room, which is the common
 * case and is never abandoned.
 */
export function isAbandoned(room: { abandonedAt?: Date }, now: Date): boolean {
  if (!room.abandonedAt) return false;
  return now.getTime() - room.abandonedAt.getTime() >= ABANDON_AFTER_MS;
}

/** The ids the caller should destroy. Naming them rather than destroying them
 *  keeps this pure: tearing a room down needs sockets, cleanups and a
 *  broadcast, none of which belong in a decision. */
export function abandonedRoomIds(rooms: Map<string, Room>, now: Date): string[] {
  return [...rooms.values()].filter(room => isAbandoned(room, now)).map(room => room.id);
}
```

Ajouter le champ dans `backend/src/types/index.ts`, dans `interface Room`, après `createdAt` :

```ts
  /**
   * When the last member went away, or absent while somebody is still here.
   *
   * A room no longer dies when it empties, so this is what eventually kills
   * one. Set and cleared in exactly one place - `rooms/presence.ts` - because
   * three call sites trigger the transition and a room whose flag disagrees
   * with its occupants either lives for ever or vanishes under two players.
   */
  abandonedAt?: Date;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test backend/test/presence.test.ts
```

Attendu : PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/rooms/abandonment.ts backend/test/presence.test.ts backend/src/types/index.ts
git commit -m "Decide when a room nobody is in has waited long enough"
```

---

### Task 3: La bascule de présence, et la suppression de la machinerie de grâce

Le cœur du morceau. Une déconnexion marque hors ligne au lieu de retirer, et tout le mécanisme de délai de grâce disparaît.

**Files:**
- Create: `backend/src/rooms/presence.ts`
- Modify: `backend/test/presence.test.ts`
- Modify: `backend/src/websocket/room-handlers.ts` (supprimer les lignes 659-773 environ ; adapter `joinRoom:602`)
- Modify: `backend/src/websocket/index.ts:155-162`
- Modify: `backend/src/websocket/room-snapshot.ts:82-116` (`restoreRooms`)
- Modify: `backend/src/index.ts:22, 256-259`
- Modify: `backend/test/lobby-protocol.test.ts` (4 tests remplacés, harnais `drop` remplacé)

**Interfaces:**
- Consumes: `ABANDON_AFTER_MS` non utilisé ici ; `Room`, `RoomPlayer`.
- Produces:
  - `markOffline(room: Room, userId: string, now: Date): boolean` — rend `true` si le joueur était membre
  - `markOnline(room: Room, userId: string): boolean` — idem

- [ ] **Step 1: Write the failing test**

Ajouter à `backend/test/presence.test.ts` :

```ts
import { markOffline, markOnline } from '../src/rooms/presence.js';

const roomWith = (...players: Array<{ userId: string; online: boolean }>) =>
  ({ id: 'r', players: players.map(p => ({ ...p, displayName: p.userId, port: null, isReady: true, emulationReady: false })) }) as never;

test('going away flips the flag and leaves the seat alone', () => {
  const room = roomWith({ userId: 'alice', online: true }, { userId: 'bob', online: true });
  markOffline(room, 'alice', AT);

  assert.deepEqual((room as never as { players: { userId: string }[] }).players.map(p => p.userId), ['alice', 'bob']);
  assert.equal((room as never as { players: { online?: boolean }[] }).players[0].online, false);
});

test('the room is only marked abandoned once the last member has gone', () => {
  const room = roomWith({ userId: 'alice', online: true }, { userId: 'bob', online: true }) as never as { abandonedAt?: Date };

  markOffline(room as never, 'alice', AT);
  assert.equal(room.abandonedAt, undefined, 'bob is still here');

  markOffline(room as never, 'bob', AT);
  assert.deepEqual(room.abandonedAt, AT);
});

test('the first member back clears the abandonment', () => {
  const room = roomWith({ userId: 'alice', online: false }, { userId: 'bob', online: false }) as never as { abandonedAt?: Date };
  room.abandonedAt = ago(60_000);

  markOnline(room as never, 'alice');
  assert.equal(room.abandonedAt, undefined);
});

/*
 * The failure this guards is a room that outlives everything and cannot be
 * reached: nobody is in it, so nobody can dissolve it, and with no
 * `abandonedAt` the sweep never names it either.
 */
test('a stranger changes nothing, and cannot strand the room', () => {
  const room = roomWith({ userId: 'alice', online: true }) as never as { abandonedAt?: Date };

  assert.equal(markOffline(room as never, 'carol', AT), false);
  assert.equal(room.abandonedAt, undefined, 'alice is still here');
});

test('going away twice does not move the deadline', () => {
  const room = roomWith({ userId: 'alice', online: true }) as never as { abandonedAt?: Date };

  markOffline(room as never, 'alice', ago(60_000));
  markOffline(room as never, 'alice', AT);

  assert.deepEqual(room.abandonedAt, ago(60_000), 'the clock started when they left, not when we noticed again');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test backend/test/presence.test.ts
```

Attendu : ÉCHEC, `Cannot find module '../src/rooms/presence.js'`.

- [ ] **Step 3: Write the presence module**

Créer `backend/src/rooms/presence.ts` :

```ts
import type { Room } from '../types/index.js';
import { onlinePlayers } from './online-players.js';

/**
 * The one place `abandonedAt` is set and cleared.
 *
 * Three paths trigger a presence change - a socket dropping, an explicit
 * departure, and the restore that follows a restart - and a room whose flag
 * disagrees with its occupants fails in one of two ways, both bad. Never set,
 * and the room is immortal: nobody is in it, so nobody can dissolve it, and the
 * sweep never names it. Set while two people are playing, and the room vanishes
 * under them twelve hours later.
 *
 * Keeping the transition in one function is what makes those two failures a
 * property of five lines rather than of three call sites.
 */

/** Marks a member away. Returns whether they were a member at all. */
export function markOffline(room: Room, userId: string, now: Date): boolean {
  const player = room.players.find(p => p.userId === userId);
  if (!player) return false;

  player.online = false;
  // Not reset if already set: the deadline starts when the room emptied, not
  // when the last straggler's socket finally timed out.
  if (onlinePlayers(room).length === 0 && !room.abandonedAt) room.abandonedAt = now;

  return true;
}

/** Marks a member present. Returns whether they were a member at all. */
export function markOnline(room: Room, userId: string): boolean {
  const player = room.players.find(p => p.userId === userId);
  if (!player) return false;

  player.online = true;
  room.abandonedAt = undefined;

  return true;
}
```

- [ ] **Step 4: Run the presence tests**

```bash
node --import tsx --test backend/test/presence.test.ts
```

Attendu : PASS, 13 tests.

- [ ] **Step 5: Delete the grace-period machinery**

Dans `backend/src/websocket/room-handlers.ts`, supprimer entièrement : le bloc de commentaire et la constante `pendingDepartures`, `DISCONNECT_GRACE_MS`, `RESTART_GRACE_MS`, `departureKey`, `armDeparture`, `scheduleLeaveRoom`, `cancelScheduledLeave`, `holdRestoredSeat` — soit tout ce qui va du commentaire « Departures waiting out their grace period » jusqu'à la ligne précédant `export async function handleLeaveRoom`.

Dans le même fichier :

- `room:leave` (ligne ~485) : supprimer la ligne `if (data?.roomId) cancelScheduledLeave(data.roomId, user.id);` et son commentaire.
- `joinRoom` (ligne ~602) : remplacer

```ts
  // Whichever door they came through, arriving reclaims a seat that is waiting
  // out its grace period.
  cancelScheduledLeave(room.id, user.id);
```

par

```ts
  // Whichever door they came through, arriving is what makes them present -
  // and takes the room off the abandonment clock.
  markOnline(room, user.id);
```

…et, dans la construction du `RoomPlayer` de la branche invité, ajouter `online: true,` après `emulationReady: false,`. Faire de même dans `room:create` (`room-handlers.ts:~150`), où le créateur est assis.

Ajouter l'import en tête de fichier :

```ts
import { markOnline } from '../rooms/presence.js';
```

Note : `markOnline` est appelé avant la recherche de `existingPlayer`, donc il rend `false` pour un invité qui n'est pas encore assis — sans effet, ce qui est correct : c'est le `online: true` de sa construction qui le place.

- [ ] **Step 6: Rewire the disconnect**

Dans `backend/src/websocket/index.ts`, remplacer le bloc `rooms.forEach` (lignes ~155-162) par :

```ts
    // Away, not gone. Their seat, their port and their membership are all
    // still theirs; what changes is that a game can no longer start against
    // them, and that an empty room starts counting down.
    const now = new Date();
    rooms.forEach(room => {
      if (markOffline(room, user.id, now)) {
        io.to(room.id).emit('room:updated', room);
        void broadcastRoomUpdate(io, room, getUserSocket);
      }
    });
```

Adapter les imports : retirer `scheduleLeaveRoom` de l'import de `./room-handlers.js` (ligne 6), y ajouter `broadcastRoomUpdate` s'il n'y est pas, et ajouter `import { markOffline } from '../rooms/presence.js';`.

Vérifier que `broadcastRoomUpdate` est bien exporté depuis `room-handlers.ts` ; s'il ne l'est pas, l'exporter.

- [ ] **Step 7: Rewire the restore**

Dans `backend/src/websocket/room-snapshot.ts`, `restoreRooms` : remplacer le paramètre `holdSeat` par `onRestored`, et le corps de la boucle.

```ts
/**
 * Loads the snapshot into `rooms`.
 *
 * Everyone is disconnected by definition at this point, which is now an
 * ordinary state rather than an emergency: each restored member comes back as
 * away, and a room nobody returns to dies on the abandonment clock like any
 * other. The old five-minute restart grace existed because the alternative was
 * losing the room outright; there is no longer anything to lose.
 *
 * `onRestored` is injected rather than imported so this stays testable without
 * a socket.
 */
export async function restoreRooms(
  rooms: Map<string, Room>,
  onRestored: (room: Room) => void,
  store: Store = getRedis() as unknown as Store
): Promise<number> {
```

Dans `deserialiseRooms`, à côté de la ligne `room.createdAt = new Date(room.createdAt);`, ajouter :

```ts
    // Same reason as createdAt: JSON has no date type, and `isAbandoned` calls
    // getTime() on this. Left undefined when absent - a room whose members were
    // all present when the snapshot was written has no deadline running.
    if (room.abandonedAt) room.abandonedAt = new Date(room.abandonedAt);
```

Dans la boucle de `restoreRooms`, remplacer

```ts
    rooms.set(id, room);
    for (const player of room.players) holdSeat(id, player.userId);
```

par

```ts
    rooms.set(id, room);
    onRestored(room);
```

- [ ] **Step 8: Rewire the caller in index.ts**

Dans `backend/src/index.ts`, remplacer l'import de `holdRestoredSeat` (ligne 22) par `import { markOffline } from './rooms/presence.js';` et l'appel (lignes 256-259) par :

```ts
const bootedAt = new Date();
await restoreRooms(rooms, room => {
  // A restart dropped everybody, through no action of theirs. An existing
  // `abandonedAt` is kept: the deadline began when the room emptied, and a
  // deploy must not hand an abandoned room another twelve hours.
  for (const player of room.players) markOffline(room, player.userId, bootedAt);
});
```

- [ ] **Step 9: Replace the four protocol tests that guarded the old machinery**

Dans `backend/test/lobby-protocol.test.ts` :

1. Retirer `scheduleLeaveRoom, cancelScheduledLeave` de l'import (ligne 45).
2. Remplacer le harnais `drop` (lignes ~152-154) par un qui coupe vraiment la socket.

D'abord, indexer les clients par utilisateur. `clients` (ligne ~144) est un tableau servant au nettoyage ; ajouter à côté :

```ts
  const clientsByUser = new Map<string, ClientSocket>();
```

…et dans le helper `client(user)`, après `clients.push(socket)`, ajouter `clientsByUser.set(user.id, socket);`.

Puis :

```ts
  /* A real disconnect, awaited on the server side.
   *
   * The old harness called `scheduleLeaveRoom` directly, because what was being
   * tested was a timer. What is being tested now is what the disconnect handler
   * does, so the socket has to actually close - and the close has to be waited
   * for, or the assertion races the server.
   *
   * The server socket is the thing to wait on, not the client: the client knows
   * it has closed long before the server has run its handler, which is the
   * whole window this would otherwise race. */
  const drop = async (user: User) => {
    const server = serverSockets.get(user.id)!;
    const closed = new Promise<void>(done => server.once('disconnect', () => done()));
    clientsByUser.get(user.id)!.close();
    await closed;
  };
```

Attention pour la tâche 3, test de retour : après un `drop`, le même utilisateur se reconnecte par `client(bob)`, ce qui écrase son entrée dans `clientsByUser` et `serverSockets`. C'est voulu — la nouvelle socket est la bonne — mais ça veut dire qu'un second `drop(bob)` porterait sur la nouvelle connexion. Ne pas s'en étonner.

Adapter la signature dans l'interface du harnais (ligne ~92) : `drop(user: User): Promise<void>;`.

3. Remplacer le test `'a seat is released once the grace period elapses'` (ligne 569) par :

```ts
test('a disconnect never releases the seat, even from the last player in the room', async () => {
  await withLobby(async ({ alice, client, rooms, drop }) => {
    const host = await client(alice);

    const created = once<Room>(host, 'room:created');
    host.emit('room:create', {});
    const room = await created;

    await drop(alice);

    const after = rooms.get(room.id);
    assert.ok(after, 'the room outlives the only player in it');
    assert.deepEqual(after.players.map(p => p.userId), [alice.id]);
    assert.equal(after.players[0].online, false, 'away, not gone');
    assert.ok(after.abandonedAt instanceof Date, 'and the clock has started');
  });
});
```

4. Remplacer `'a dropped socket keeps its seat, and its real timer cannot hold the process open'` (ligne 595) et `'a player who comes back inside the grace period keeps their seat'` (ligne 630) par un seul :

```ts
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
```

5. Supprimer entièrement le test `'a restarted seat outlives a deployment, unlike a disconnected one'` (ligne 1205) et son commentaire de section `// --- a restart is not a departure ---`. Les deux constantes qu'il compare n'existent plus.

- [ ] **Step 10: Run the full backend suite**

```bash
npm run test:backend
```

Attendu : 0 échec. Si un test échoue en citant `scheduleLeaveRoom` ou `holdRestoredSeat`, c'est un appelant oublié — le chercher avec `grep -rn "scheduleLeaveRoom\|cancelScheduledLeave\|holdRestoredSeat\|GRACE_MS" backend core frontend e2e`.

- [ ] **Step 11: Typecheck**

```bash
npx tsc --noEmit -p backend/tsconfig.json
```

Attendu : exit 0.

- [ ] **Step 12: Commit**

```bash
git add backend/src/rooms/presence.ts backend/test/presence.test.ts \
        backend/src/websocket/room-handlers.ts backend/src/websocket/index.ts \
        backend/src/websocket/room-snapshot.ts backend/src/index.ts \
        backend/test/lobby-protocol.test.ts
git commit -m "Make absence a fact instead of a countdown"
```

---

### Task 4: Les quatre sites qui comptaient les membres

Sans ceci, une partie se lance contre un absent et les deux écrans s'attendent pour toujours.

**Files:**
- Create: `frontend/src/lib/rooms/online-players.ts`
- Modify: `backend/src/websocket/game-handlers.ts:42, 74`
- Modify: `backend/src/websocket/room-view.ts:143` et `:88-94`
- Modify: `frontend/src/lib/types.ts` (`RoomPlayer`)
- Modify: `frontend/src/routes/room/[id]/+page.svelte:71`
- Modify: `backend/test/lobby-protocol.test.ts`

**Interfaces:**
- Consumes: `onlinePlayers` (tâche 1).
- Produces: `onlinePlayers(room: { players: RoomPlayer[] }): RoomPlayer[]` côté client, dans `frontend/src/lib/rooms/online-players.ts`.

- [ ] **Step 1: Write the failing protocol test**

Ajouter à `backend/test/lobby-protocol.test.ts`, à côté du test `'game:start is refused while no game has been chosen'` :

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --import tsx --test backend/test/lobby-protocol.test.ts
```

Attendu : ÉCHEC — le test expire en attendant `error`, parce que `game:start` réussit aujourd'hui.

- [ ] **Step 3: Fix the two backend counting sites**

Dans `backend/src/websocket/game-handlers.ts`, ajouter l'import `import { onlinePlayers } from '../rooms/online-players.js';` puis, ligne ~42, remplacer :

```ts
    const playersWithPorts = room.players.filter(p => p.port !== null && p.isReady);
    if (playersWithPorts.length === 0) {
      socket.emit('error', { message: 'At least one player must select a controller port' });
      return;
    }
```

par :

```ts
    const seated = room.players.filter(p => p.port !== null && p.isReady);
    if (seated.length === 0) {
      socket.emit('error', { message: 'At least one player must select a controller port' });
      return;
    }

    /*
     * A seat is not a presence.
     *
     * A member who closed their tab keeps their port - it is theirs, and giving
     * it away is the thing this release exists to stop - so `seated` says
     * nothing about whether they are here. Lockstep waits for both cores, so
     * starting without them hangs both screens with no error and no way out but
     * the URL bar. There is no message for that failure; this refusal is it.
     */
    if (seated.some(p => p.online !== true)) {
      socket.emit('error', { message: 'A player is away. Wait for them to come back before starting.' });
      return;
    }
```

Ligne ~74, dans `game:ready`, remplacer :

```ts
    const playersWithPorts = room.players.filter(p => p.port !== null);
    const allReady = playersWithPorts.every(p => p.emulationReady);
```

par :

```ts
    // Online, deliberately: an away member holding a port would never report
    // its emulator ready, so `game:go` would never be sent and the start would
    // stall in silence.
    const seatedAndHere = onlinePlayers(room).filter(p => p.port !== null);
    const allReady = seatedAndHere.length > 0 && seatedAndHere.every(p => p.emulationReady);
```

- [ ] **Step 4: Run the protocol test to verify it passes**

```bash
node --import tsx --test backend/test/lobby-protocol.test.ts
```

Attendu : PASS.

- [ ] **Step 5: Stop showing an empty room to friends, and publish presence**

Dans `backend/src/websocket/room-view.ts` :

Ajouter `online: p.online === true,` au `players.map` de `toPublicRoom` (ligne ~88), pour que le client puisse afficher « absent ».

Puis, dans `isRoomVisibleTo` (ligne 143), remplacer le corps par :

```ts
export function isRoomVisibleTo(room: Room, userId: string, audience: Set<string>): boolean {
  // A member sees their own room whatever its state - that is the door back in.
  if (room.players.some(p => p.userId === userId)) return true;

  // Friends see it only while somebody is in it. A durable room nobody has
  // opened since last night is not news; leaving it in the list would show a
  // friend as "in a room" all night.
  if (onlinePlayers(room).length === 0) return false;

  return audience.has(room.createdBy) || audience.has(room.hostId);
}
```

Ajouter l'import `import { onlinePlayers } from '../rooms/online-players.js';`.

- [ ] **Step 6: Make the client type honest, and add its own accessor**

Dans `frontend/src/lib/types.ts`, ajouter à `RoomPlayer` :

```ts
  /** Whether this member has a socket connected right now. Absent means away. */
  online?: boolean;
```

Créer `frontend/src/lib/rooms/online-players.ts` :

```ts
import type { RoomPlayer } from '$lib/types';

/**
 * The players who are actually here.
 *
 * A deliberate twin of `backend/src/rooms/online-players.ts`. The two
 * processes share no module, so this is three duplicated lines rather than a
 * package invented for the occasion - but nothing stops them drifting, which
 * is why each side has its own test.
 */
export function onlinePlayers(room: { players: RoomPlayer[] }): RoomPlayer[] {
	return room.players.filter((p) => p.online === true);
}
```

- [ ] **Step 7: Fix the client counting site**

Dans `frontend/src/routes/room/[id]/+page.svelte`, importer l'accesseur et remplacer la ligne 71 :

```ts
  /*
   * Online, not member count.
   *
   * A partner who closed their tab is still in `room.players`, so counting
   * members here would put a single player into netplay: two cores exchanging
   * inputs with nobody on the other end.
   */
  $: isSinglePlayer = room ? onlinePlayers(room).length <= 1 : true;
```

Laisser **inchangées** les lignes 625 et 688 (`room.players.length < 2`) : elles gardent le panneau d'invitation, et le siège d'un absent lui appartient toujours.

- [ ] **Step 8: Verify the frontend still compiles**

```bash
npm run check --workspace frontend
```

Attendu : 0 erreur.

- [ ] **Step 9: Run the full suite**

```bash
npm run test:all && npx tsc --noEmit -p backend/tsconfig.json
```

Attendu : 0 échec, exit 0.

- [ ] **Step 10: Commit**

```bash
git add backend/src/websocket/game-handlers.ts backend/src/websocket/room-view.ts \
        backend/test/lobby-protocol.test.ts frontend/src/lib/types.ts \
        frontend/src/lib/rooms/online-players.ts frontend/src/routes/room/\[id\]/+page.svelte
git commit -m "Refuse to start a game against somebody who is not there"
```

---

### Task 5: `room:leave` devient un geste, pas un cycle de vie

C'est la ligne qui cause le symptôme d'origine.

**Files:**
- Modify: `frontend/src/routes/room/[id]/+page.svelte:513-517` et le gabarit
- Modify: `frontend/src/lib/i18n` (les deux clés de traduction)

**Interfaces:**
- Consumes: rien de neuf. `room:leave` garde exactement sa sémantique serveur.
- Produces: rien pour les tâches suivantes.

- [ ] **Step 1: Stop emitting the departure on unmount**

Dans `onDestroy` (ligne ~513), supprimer la ligne `$socket.emit('room:leave', { roomId });` et la remplacer par ce commentaire, au-dessus des `off` :

```ts
      /*
       * No `room:leave` here, deliberately, and this line is the whole point of
       * the release.
       *
       * Emitting it on unmount made navigating to the library a permanent
       * departure - and the last one out destroyed the room - which is why
       * playing together twice took two invitations. Leaving is now a button,
       * and going away is just a socket that is no longer here.
       */
```

- [ ] **Step 2: Add the explicit button**

Dans le gabarit, à côté des commandes du salon, ajouter :

```svelte
<button class="btn-leave" on:click={() => (confirmingLeave = true)}>
  {t($language, 'leaveRoom')}
</button>

{#if confirmingLeave}
  <div class="confirm-leave">
    <p>{t($language, 'leaveRoomWarning')}</p>
    <button on:click={leaveRoom}>{t($language, 'leaveRoom')}</button>
    <button on:click={() => (confirmingLeave = false)}>{t($language, 'cancel')}</button>
  </div>
{/if}
```

Et dans le script :

```ts
  let confirmingLeave = false;

  /*
   * The only path that gives up a seat.
   *
   * Confirmed because it is not undoable from this side: the other player has
   * to invite you again, and if you were the last one out the room is gone
   * along with its invitations.
   */
  function leaveRoom() {
    $socket?.emit('room:leave', { roomId });
    goto('/');
  }
```

- [ ] **Step 3: Add the translation keys**

Le fichier est `frontend/src/lib/i18n/translations.ts`, et il porte **deux** langues : l'anglais autour de la ligne 132 et le français autour de la ligne 418 (repère : la clé `chooseGameToStart` existe dans les deux). Toute clé ajoutée doit l'être **dans les deux blocs** — le type est dérivé de l'un d'eux, donc en oublier un produit soit une erreur de compilation, soit une clé anglaise affichée en français.

| Clé | en | fr |
|---|---|---|
| `leaveRoom` | `Leave room` | `Quitter le salon` |
| `leaveRoomWarning` | `Your partner will have to invite you again.` | `Ton partenaire devra t'inviter à nouveau.` |

Réutiliser `cancel` si la clé existe déjà (`grep -n "cancel:" frontend/src/lib/i18n/translations.ts`) ; sinon l'ajouter aux deux blocs de la même façon.

- [ ] **Step 4: Verify**

```bash
npm run check --workspace frontend && npm run build --workspace frontend
```

Attendu : 0 erreur, exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/room/\[id\]/+page.svelte frontend/src/lib/i18n
git commit -m "Turn leaving into a button instead of a side effect of navigating"
```

---

### Task 6: Un seul salon à la fois

Sans mort automatique, un joueur accumule des salons que rien ne détruit.

**Files:**
- Modify: `backend/src/websocket/room-handlers.ts` (`room:create`, `lobby:accept`)
- Modify: `backend/test/lobby-protocol.test.ts`

**Interfaces:**
- Consumes: `handleLeaveRoom` (déjà exporté depuis `room-handlers.ts`).
- Produces: `leaveCurrentRoom(io, socket, rooms, user, getUserSocket): Promise<void>` — fonction locale au module, non exportée.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --import tsx --test backend/test/lobby-protocol.test.ts
```

Attendu : ÉCHEC — Alice figure encore dans les deux salons.

- [ ] **Step 3: Implement**

Dans `backend/src/websocket/room-handlers.ts`, ajouter au-dessus de `registerRoomHandlers` :

```ts
/**
 * Gives up whatever room the caller was already in.
 *
 * A room no longer dies when it empties, so without this a player accumulates
 * rooms nobody can reach: they are not in them, so they cannot dissolve them,
 * and the other member is left waiting in a lobby its partner has forgotten.
 * One room at a time is what keeps the door on the home screen unambiguous.
 */
async function leaveCurrentRoom(
  io: Server,
  socket: Socket,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
  // Copied before iterating: handleLeaveRoom can delete from `rooms`.
  const current = [...rooms.values()].filter(r => r.players.some(p => p.userId === user.id));
  for (const room of current) {
    await handleLeaveRoom(io, socket, room.id, rooms, user, getUserSocket);
  }
}
```

Puis l'appeler en première instruction du corps de `room:create`, et dans `lobby:accept` **juste avant** l'appel à `joinRoom` — jamais avant, sous peine de faire abandonner son salon à quelqu'un dont l'invitation va être refusée.

- [ ] **Step 4: Run it to verify it passes**

```bash
node --import tsx --test backend/test/lobby-protocol.test.ts
```

Attendu : PASS.

- [ ] **Step 5: Run the full suite**

```bash
npm run test:all
```

Attendu : 0 échec.

- [ ] **Step 6: Commit**

```bash
git add backend/src/websocket/room-handlers.ts backend/test/lobby-protocol.test.ts
git commit -m "Hold one room at a time, now that rooms do not clean up after themselves"
```

---

### Task 7: L'instantané, et le balayage

Un salon durable au repos est exactement l'état que le mécanisme actuel laisse expirer en silence.

**Files:**
- Modify: `backend/src/websocket/room-snapshot.ts`
- Modify: `backend/src/index.ts`
- Modify: `core/test/room-snapshot.test.ts`

**Interfaces:**
- Consumes: `abandonedRoomIds`, `isAbandoned` (tâche 2).
- Produces: `Store` gagne `expire(key: string, seconds: number): Promise<unknown>`; `REFRESH_EVERY_TICKS: number`.

- [ ] **Step 1: Write the failing test**

Ajouter à `core/test/room-snapshot.test.ts` :

```ts
test('an unchanging world keeps its key alive instead of letting it expire', async () => {
	resetSnapshotStateForTest();

	const sets: string[] = [];
	const expires: number[] = [];
	const store = {
		get: async () => null,
		set: async (_k: string, body: string) => void sets.push(body),
		expire: async (_k: string, seconds: number) => void expires.push(seconds)
	};

	await restoreRooms(new Map(), () => {}, store as never);

	const rooms = populated();
	await writeSnapshot(rooms as never, store as never);
	assert.equal(sets.length, 1, 'the first write happens');

	// One short of the refresh: still nothing but the original write.
	for (let i = 0; i < REFRESH_EVERY_TICKS - 1; i++) {
		await writeSnapshot(rooms as never, store as never);
	}
	assert.deepEqual(expires, [], 'no touch before the interval is up');

	await writeSnapshot(rooms as never, store as never);
	assert.deepEqual(expires, [TTL_SECONDS], 'and one touch when it is');
	assert.equal(sets.length, 1, 'without rewriting a body that did not change');
});
```

Importer `REFRESH_EVERY_TICKS` et `TTL_SECONDS` en tête du fichier — les deux devront être exportés.

- [ ] **Step 2: Run it to verify it fails**

```bash
node --import tsx --test core/test/room-snapshot.test.ts
```

Attendu : ÉCHEC, `REFRESH_EVERY_TICKS` n'est pas exporté.

- [ ] **Step 3: Implement the refresh**

Dans `backend/src/websocket/room-snapshot.ts` :

```ts
/**
 * A storage bound, not a lifetime.
 *
 * It used to be an hour and to double as the staleness rule, which it did
 * badly: "stored a long time ago" and "abandoned a long time ago" are different
 * questions, and only the second one has an answer worth acting on. The
 * abandonment sweep answers that one now, at restore, so this only has to
 * outlast any outage a snapshot should survive.
 */
export const TTL_SECONDS = 24 * 60 * 60;

/**
 * How many idle ticks before the key is touched.
 *
 * `writeSnapshot` skips writing when nothing changed, which means a world that
 * stops changing stops refreshing its key - and a durable room at rest is
 * exactly the state that never changes. An hour against a twenty-four hour TTL
 * leaves room for twenty-two missed refreshes in a row.
 *
 * Counted in ticks rather than measured against a clock: the interval is one
 * second, so counting is deterministic and a test drives it by calling the
 * function, without any time passing.
 */
export const REFRESH_EVERY_TICKS = 3600;

let idleTicks = 0;
```

Dans `writeSnapshot`, remplacer le court-circuit :

```ts
  const body = serialiseRooms(rooms);
  if (body === lastWritten) {
    if (++idleTicks < REFRESH_EVERY_TICKS) return false;
    idleTicks = 0;
    try {
      await store.expire(KEY, TTL_SECONDS);
    } catch (err) {
      logger.error({ err }, 'Could not refresh the room snapshot deadline');
    }
    return false;
  }

  idleTicks = 0;
```

Ajouter `expire(key: string, seconds: number): Promise<unknown>;` à l'interface `Store`, et `idleTicks = 0;` dans `resetSnapshotStateForTest`.

- [ ] **Step 4: Run it to verify it passes**

```bash
node --import tsx --test core/test/room-snapshot.test.ts
```

Attendu : PASS.

- [ ] **Step 5: Sweep at boot**

Dans `backend/src/index.ts`, juste après le `await restoreRooms(...)` de la tâche 3 :

```ts
/*
 * The sweep runs at restore, and that is what makes the TTL a storage bound
 * rather than a lifetime: however long the key sat in Redis, what decides a
 * room's fate is how long it has been empty.
 */
for (const roomId of abandonedRoomIds(rooms, bootedAt)) {
  rooms.delete(roomId);
  logger.info({ roomId }, 'Swept a room nobody came back to');
}
```

Puis armer le balayage périodique, à côté de `startRoomSnapshots(rooms)` :

```ts
// Hourly: twelve hours is the deadline, so an hour of slack costs nothing and
// keeps this off the hot path. `unref` for the usual reason - a sweep must
// never be what holds the process open.
const sweep = setInterval(() => {
  for (const roomId of abandonedRoomIds(rooms, new Date())) {
    rooms.delete(roomId);
    logger.info({ roomId }, 'Swept a room nobody came back to');
  }
}, 60 * 60_000);
sweep.unref();
```

Ajouter `import { abandonedRoomIds } from './rooms/abandonment.js';`.

- [ ] **Step 6: Run everything**

```bash
npm run test:all && npx tsc --noEmit -p backend/tsconfig.json
```

Attendu : 0 échec, exit 0. Si la suite met soudain des dizaines de secondes, c'est un `unref` manquant.

- [ ] **Step 7: Commit**

```bash
git add backend/src/websocket/room-snapshot.ts backend/src/index.ts core/test/room-snapshot.test.ts
git commit -m "Keep the key of a world that stopped changing, and sweep what nobody came back to"
```

---

### Task 8: La porte sur l'écran principal, et l'absence à l'écran

Le dernier morceau visible : voir qu'on a un salon, et y retourner.

**Files:**
- Modify: `frontend/src/routes/+page.svelte:112-145, 268-274`
- Modify: `frontend/src/routes/room/[id]/+page.svelte` (gabarit des joueurs)
- Modify: `frontend/src/lib/i18n`

**Interfaces:**
- Consumes: `activeRooms` (déjà chargé par `loadRooms()`), `room.players[].online` (tâche 4), `onlinePlayers` côté client (tâche 4).
- Produces: rien.

- [ ] **Step 1: Find the room you are already in**

Dans `frontend/src/routes/+page.svelte`, après `let activeRooms: any[] = [];` :

```ts
  /*
   * The room you are already a member of, if any.
   *
   * `/api/rooms` and `rooms:list` both already carry it - a member always sees
   * their own room, whatever its state - so this door needs no new event and no
   * new field.
   */
  $: myRoom = activeRooms.find((r) => r.players?.some((p: any) => p.userId === $user?.id));
  $: myPartner = myRoom?.players?.find((p: any) => p.userId !== $user?.id);
```

- [ ] **Step 2: Show it instead of the create button**

Remplacer le bouton (ligne ~271) :

```svelte
{#if myRoom}
  <button class="btn-create-room" on:click={() => goto(`/room/${myRoom.id}`)}>
    {myPartner
      ? `${t($language, 'resumeRoomWith')} ${myPartner.displayName}`
      : t($language, 'resumeRoom')}
  </button>
{:else}
  <button class="btn-create-room" on:click={createEmptyRoom}>
    {t($language, 'createRoom')}
  </button>
{/if}
```

- [ ] **Step 3: Show absence in the room**

Dans `frontend/src/routes/room/[id]/+page.svelte`, là où chaque joueur est rendu, ajouter à côté du nom :

```svelte
{#if player.userId !== $user?.id && player.online !== true}
  <span class="player-away">{t($language, 'playerAway')}</span>
{/if}
```

Et un style discret — l'absence est une information, pas une alarme :

```css
  .player-away {
    font-size: 0.8rem;
    opacity: 0.6;
    font-style: italic;
  }
```

- [ ] **Step 4: Add the three translation keys**

Dans `frontend/src/lib/i18n/translations.ts`, **dans les deux blocs** (en ~132, fr ~418) :

| Clé | en | fr |
|---|---|---|
| `resumeRoom` | `Resume room` | `Reprendre le salon` |
| `resumeRoomWith` | `Resume room with` | `Reprendre le salon avec` |
| `playerAway` | `away` | `absent` |

- [ ] **Step 5: Verify**

```bash
npm run check --workspace frontend && npm run build --workspace frontend && npm run test:all
```

Attendu : 0 erreur, exit 0, 0 échec.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/+page.svelte frontend/src/routes/room/\[id\]/+page.svelte frontend/src/lib/i18n
git commit -m "Put the room you are already in on the screen you come back to"
```

---

## Vérification finale, avant de conclure quoi que ce soit

- [ ] `npm run test:all` — 0 échec.
- [ ] `npx tsc --noEmit -p backend/tsconfig.json` — exit 0.
- [ ] `npm run check --workspace frontend` — 0 erreur.
- [ ] `npm run build --workspace frontend` — exit 0.
- [ ] **`npm run test:e2e`** — lancé explicitement. Le morceau précédent a appris que `test:all` ne lance pas Playwright, et que huit tâches sont passées au vert pendant que quatre fichiers bout-en-bout devenaient faux. Ne pas déduire du vert de `test:all`.
- [ ] `grep -rn "scheduleLeaveRoom\|cancelScheduledLeave\|holdRestoredSeat\|GRACE_MS" backend core frontend e2e` — aucun résultat.

## La passe à la main, à deux joueurs

Deux profils de navigateur — la session est un cookie, donc deux fenêtres du même profil sont la même personne. En `AUTH_MODE=dev`, l'accueil déconnecté offre « Dev User 1 » et « Dev User 2 ». Les deux comptes doivent être amis.

- [ ] Créer un salon, inviter, accepter, choisir un jeu.
- [ ] **Le cas d'origine** : l'un revient à la bibliothèque. Il voit « reprendre le salon avec X », l'autre le voit « absent ». Il y retourne — **sans invitation** — et choisit un autre jeu.
- [ ] Fermer complètement l'onglet, rouvrir, revenir : même résultat.
- [ ] **Lancer pendant que l'autre est absent** : refusé, avec un message qui le dit. C'est la garde qui compte le plus.
- [ ] « Quitter le salon », confirmer : le siège est rendu, et l'autre voit un salon à un joueur. Revenir demande alors une nouvelle invitation.
- [ ] Quitter des deux côtés : le salon disparaît.
- [ ] Créer un salon en étant déjà dans un autre : le premier est abandonné, pas dupliqué.
- [ ] **La liste d'amis** : un ami dont le salon n'a personne dedans ne doit pas paraître en salon.
- [ ] Redémarrer le backend pendant que les deux sont dans un salon : ils reviennent dans le même salon, en ligne, sans réinvitation.

## Ce que ce plan ne fait pas

- **Pas de migration**, pas de persistance SQLite. Douze heures, puis il faut ré-inviter une fois. Décidé.
- **Pas de fusion de `room:updated` et `room:update`.** Toujours reporté, et la tâche 3 ajoute une émission de plus à la dette.
- **Pas de correction du défaut nº1** (l'invitation visible seulement depuis l'accueil ou le profil). Morceau à part.
- **La sentinelle du `unref` disparaît** avec la machinerie qu'elle surveillait. La tâche 7 en réintroduit une exigence — un balayage horaire `unref`'d — que rien ne garde automatiquement. C'est consigné plutôt que corrigé ici.
