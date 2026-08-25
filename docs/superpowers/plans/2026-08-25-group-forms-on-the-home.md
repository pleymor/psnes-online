# Le groupe se forme sur l'accueil — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Se retrouver et choisir un jeu se font depuis l'accueil : une invitation reçue s'affiche d'elle-même et s'accepte en un clic, un ami s'invite depuis la liste d'amis, et le clic sur un jeu emmène les deux joueurs dans le salon.

**Architecture:** Un groupe est le salon existant sans jeu — aucune entité, aucune migration. Le serveur gagne un seul événement, `room:opened`, émis socket par socket à chaque membre, qui est le seul canal de navigation ; et une jumelle de `markPlayerAway` appelée à la connexion, sans laquelle un membre assis sur l'accueil passe pour absent après un F5. Côté client, deux stores (mon salon en direct, mes invitations reçues) remplacent trois lectures ponctuelles de `/api/rooms`, et la page du salon perd son sélecteur de jeu et son panneau d'invitation.

**Tech Stack:** TypeScript, Svelte 4 / SvelteKit, Socket.IO, Node.js `node:test`, better-sqlite3 (non touché ici).

**Spec:** `docs/superpowers/specs/2026-08-25-group-forms-on-the-home-design.md`

## Global Constraints

- **Aucune migration.** Ce morceau ne touche ni `backend/migrations/` ni le schéma. Si une tâche semble en exiger une, le plan est faux : s'arrêter et le dire.
- **Aucun nouveau champ dans `Room` ni dans `RoomPlayer`**, côté serveur comme côté client. Un groupe est un salon sans `gameId`.
- **`room:opened` se diffuse socket par socket**, via `getUserSocket`, jamais avec `io.to(roomId)`. Un membre assis sur l'accueil n'est plus dans le canal socket.io du salon après un F5. Modèle à copier : `broadcastRoomUpdate` (`backend/src/websocket/room-handlers.ts:909`).
- **Le serveur décide qui navigue, jamais le client.** La carte d'invitation ne lit pas `gameTitle` pour choisir de naviguer.
- **Node n'est pas sur le PATH.** Préfixer chaque commande :
  `export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"`.
  **v20.19.6 est obligatoire pour tout ce qui ouvre la base** (`npm run test:backend`) : sous Node 24 le binding natif de `better-sqlite3` ne se charge pas et *tous* les tests backend échouent, ce qui se lit comme 67 pannes préexistantes. Les suites `test:netplay`, `test:core` et `test:ui` s'en moquent.
- **`npm run check` et `npm run test:all` n'appellent pas le bundler, et le déploiement est `vite build`.** Aucune branche frontend n'est terminée avant un `npm run build --workspace frontend` vert.
- **Ne jamais `git add -A`.** Mettre en scène par chemin. `package-lock.json` n'appartient à aucun commit de ce plan.
- **Les nouvelles clés de traduction vont dans `en` *et* `fr`.** `t()` indexe une union des deux objets (`frontend/src/lib/i18n/translations.ts`, fin de fichier) : une clé présente d'un seul côté casse `svelte-check`.
- **Svelte 4 :** une fonction déclarée puis appelée depuis un `$:` ou un gabarit ne recompile pas quand ses dépendances changent. Toute valeur qui doit suivre l'horloge ou la langue prend ses dépendances **en paramètres** (modèle : `expiryLabel` dans `TopBar.svelte:82`).

---

### Task 1: `room:opened`, le seul canal de navigation

Le signal « va sur la page de ce salon », émis à tous les membres quand un jeu est choisi, et à l'invité qui accepte dans un salon déjà garni.

**Files:**
- Modify: `backend/src/websocket/room-handlers.ts` (handler `room:choose-game` `:236`, handler `lobby:accept` `:433`)
- Test: `backend/test/lobby-protocol.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: événement socket `room:opened` avec la charge `{ roomId: string; reason?: 'invitation' }`. Fonction interne `openRoomForMembers(io, room, getUserSocket, reason?)`.

- [ ] **Step 1: Write the failing tests**

Ajouter à la fin de `backend/test/lobby-protocol.test.ts` :

```ts
test('choosing the game sends both members to the room page, whoever chose', async () => {
  await withLobby(async ({ alice, bob, client, gameId }) => {
    const host = await client(alice);
    const guest = await client(bob);

    host.emit('room:create', {});
    const room = await once<Room>(host, 'room:created');

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await once(guest, 'lobby:accepted');

    // The guest chooses, which is allowed: either member may. Both are told to
    // go, the chooser included - one navigation path, not two.
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

    host.emit('room:create', {});
    const room = await once<Room>(host, 'room:created');
    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await once(guest, 'lobby:accepted');

    /*
     * The guest reconnects, which is what a reload of the library page is. The
     * new socket holds the seat but has never emitted `room:join`, so it is
     * *not* in the room's socket.io channel: an `io.to(roomId)` would reach
     * nobody. This is the whole reason the event is addressed per member.
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

    host.emit('room:create', { gameId, gameTitle: 'Chrono Trigger' });
    const room = await once<Room>(host, 'room:created');

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

    host.emit('room:create', {});
    const room = await once<Room>(host, 'room:created');

    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    let opened = false;
    guest.on('room:opened', () => (opened = true));
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await once(guest, 'lobby:accepted');

    // The group is formed on the library page; there is nothing to open yet.
    assert.equal(opened, false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npx tsx --test backend/test/lobby-protocol.test.ts 2>&1 | tail -30
```

Attendu : les trois premiers échouent sur `timed out waiting for "room:opened"`. Le quatrième passe déjà (rien n'émet cet événement) — c'est normal, il garde son sens comme non-régression.

- [ ] **Step 3: Implement**

Dans `backend/src/websocket/room-handlers.ts`, ajouter la fonction près de `broadcastRoomUpdate` (fin de fichier) :

```ts
/**
 * Tells every member of a room to go to its page.
 *
 * The one navigation channel, used by whoever chose the game *and* by the
 * member who did not - one path, so there is one behaviour to describe.
 *
 * Addressed per member, never with `io.to(room.id)`: a socket only enters a
 * room's channel through `room:create`, `lobby:accept` or `room:join`, and only
 * the room page emits the third. A member sitting on the library page is in the
 * channel until their first reload, and out of it afterwards while still
 * holding their seat - so the channel is exactly the wrong address here.
 *
 * `reason` travels because arriving is not always the same event: an invitee
 * seated into a room that is already playing is told so by the room screen,
 * which is what the `?from=invitation` marker has always been for.
 */
function openRoomForMembers(
  io: Server,
  room: Room,
  getUserSocket: (id: string) => string | undefined,
  reason?: 'invitation'
) {
  const payload = reason ? { roomId: room.id, reason } : { roomId: room.id };

  for (const player of room.players) {
    const socketId = getUserSocket(player.userId);
    if (socketId) io.to(socketId).emit('room:opened', payload);
  }
}
```

Dans `room:choose-game`, juste après `await broadcastRoomUpdate(...)` et avant le `logger.info` final :

```ts
    // Choosing the game is what opens the room: both members go, including the
    // one who just chose.
    openRoomForMembers(io, room, getUserSocket);
```

Dans `lobby:accept`, après `socket.emit('lobby:accepted', ...)` :

```ts
    /*
     * Only when there is something to open.
     *
     * An invitation answered into a room that already has a game is the
     * "invited from a room I was already sitting in" case, and the invitee is
     * taken there as they always were. An invitation into a room with no game
     * forms the group and nothing else: both players stay on their library,
     * which is where the game gets chosen.
     *
     * Decided here rather than by the client: the invitation the invitee holds
     * may name a room that had no game when it was sent and has one now.
     */
    if (room.gameId) {
      const invitee = getUserSocket(user.id);
      if (invitee) io.to(invitee).emit('room:opened', { roomId: room.id, reason: 'invitation' });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npx tsx --test backend/test/lobby-protocol.test.ts 2>&1 | tail -20
```

Attendu : la totalité du fichier verte (44 tests et plus).

- [ ] **Step 5: Commit**

```bash
git add backend/src/websocket/room-handlers.ts backend/test/lobby-protocol.test.ts
git commit -m "Send both players to the room the moment a game is chosen"
```

---

### Task 2: la présence à la connexion

Un membre assis sur sa bibliothèque est marqué absent dès qu'il recharge la page, et son partenaire voit un siège vide. La jumelle de `markPlayerAway` referme l'asymétrie.

**Files:**
- Modify: `backend/src/websocket/room-handlers.ts` (près de `markPlayerAway` `:801`)
- Modify: `backend/src/websocket/index.ts` (import ligne 6, appel avant `:131`)
- Test: `backend/test/lobby-protocol.test.ts`

**Interfaces:**
- Consumes: `markOnline` (`backend/src/rooms/presence.ts`), `broadcastRoomUpdate`.
- Produces: `markPlayerPresent(io, rooms, userId, getUserSocket): Promise<void>`.

- [ ] **Step 1: Wire the harness to mirror production**

Dans `backend/test/lobby-protocol.test.ts`, ajouter l'import à la liste existante :

```ts
const {
  registerRoomHandlers, pendingInvitationsFor, markPlayerAway, markPlayerPresent
} = await import('../src/websocket/room-handlers.js');
```

et, dans `io.on('connection', ...)` de `withLobby`, juste après `registerRoomHandlers`/`registerGameHandlers` :

```ts
    /*
     * The presence half of what `websocket/index.ts` does on a *connection*,
     * mirroring the disconnect half below. A reconnecting member is present
     * again the moment their socket is back, without waiting for a `room:join`
     * that only the room page ever sends.
     */
    void markPlayerPresent(io, rooms, userId, getUserSocket);
```

- [ ] **Step 2: Write the failing test**

Ajouter à la fin du même fichier :

```ts
test('reconnecting makes a member present again, and tells the other one', async () => {
  await withLobby(async ({ alice, bob, client, drop, rooms }) => {
    const host = await client(alice);
    const guest = await client(bob);

    host.emit('room:create', {});
    const room = await once<Room>(host, 'room:created');
    const invitation = createInvitation(db, room.id, alice.id, bob.id, future());
    guest.emit('lobby:accept', { invitationId: invitation.id });
    await once(guest, 'lobby:accepted');

    await drop(bob);
    assert.equal(rooms.get(room.id)!.players.find(p => p.userId === bob.id)!.online, false);

    // A reload of the library page: the seat was never given up, and nothing
    // will emit `room:join` from there.
    const updated = once<Room>(host, 'room:updated');
    await client(bob);
    await updated;

    const seat = rooms.get(room.id)!.players.find(p => p.userId === bob.id)!;
    assert.equal(seat.online, true);
    // And the room is off the abandonment clock again.
    assert.equal(rooms.get(room.id)!.abandonedAt, undefined);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npx tsx --test backend/test/lobby-protocol.test.ts 2>&1 | tail -30
```

Attendu : échec à l'import (`markPlayerPresent is not a function`).

- [ ] **Step 4: Implement**

Dans `backend/src/websocket/room-handlers.ts`, juste avant `markPlayerAway` :

```ts
/**
 * Marks a user present in every room they belong to, and tells those rooms.
 *
 * The exact twin of `markPlayerAway` below, and it exists for the asymmetry it
 * closes: a disconnect marks a member away, but only `room:join` ever marked
 * one back - and only the room page emits it. A member sitting on their library
 * was therefore away for the rest of the session after a single reload, which
 * showed their partner an empty seat and collapsed the room to single player.
 *
 * This does not loosen the "away" guard on `game:start`. `online` already means
 * "a socket is connected and the seat is theirs", not "looking at the room
 * page": leaving that page has not marked anyone away since the lobby stopped
 * dying with it.
 */
export async function markPlayerPresent(
  io: Server,
  rooms: Map<string, Room>,
  userId: string,
  getUserSocket: (id: string) => string | undefined
) {
  for (const room of rooms.values()) {
    if (!markOnline(room, userId)) continue;
    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
  }
}
```

L'import de `markOnline` existe déjà (`:28`).

Dans `backend/src/websocket/index.ts`, étendre l'import de la ligne 6 :

```ts
import { markPlayerAway, markPlayerPresent, pendingInvitationsFor, registerRoomHandlers } from './room-handlers.js';
```

et appeler juste avant l'envoi des invitations en attente (`:131`) :

```ts
  // Back from wherever they were: their seats are theirs again in every room
  // they belong to. Before the two emits below, so the rooms list they receive
  // already says so.
  await markPlayerPresent(io, rooms, user.id, getUserSocket);
```

- [ ] **Step 5: Run the whole file**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npx tsx --test backend/test/lobby-protocol.test.ts 2>&1 | tail -30
```

Attendu : tout vert. **Si un test préexistant échoue**, la cause probable est un `room:updated` supplémentaire reçu plus tôt qu'avant par un test qui attend cet événement : le remède est dans l'attente du test, pas dans le code de production. Si l'échec dit autre chose, s'arrêter et le rapporter.

- [ ] **Step 6: Run the full backend suite**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:backend 2>&1 | tail -15
```

Attendu : 0 échec.

- [ ] **Step 7: Commit**

```bash
git add backend/src/websocket/room-handlers.ts backend/src/websocket/index.ts backend/test/lobby-protocol.test.ts
git commit -m "Make a member present again as soon as their socket is back"
```

---

### Task 3: ce que fait le clic sur un jeu

Une fonction pure, parce que c'est la seule règle de ce morceau qui a trois branches invisibles à l'œil dans un gabarit.

**Files:**
- Create: `frontend/src/lib/rooms/game-click.ts`
- Create: `core/test/game-click.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: rien.
- Produces:
  ```ts
  export type GameClick =
    | { kind: 'launch-solo' }
    | { kind: 'choose-for-group'; roomId: string }
    | { kind: 'blocked'; reason: 'playing' };
  export function gameClick(room: GroupRoom | null | undefined): GameClick;
  export interface GroupRoom { id: string; status: 'waiting' | 'playing'; players: { userId: string }[] }
  ```

- [ ] **Step 1: Write the failing test**

Créer `core/test/game-click.test.ts` :

```ts
/**
 * What a click on a game card does.
 *
 * The same button means three things depending on the state of the group, and
 * that is the one place in this application where that is true - so the rule
 * lives in a function with a name rather than in a chain of conditions inside a
 * template, where the third branch would be the one nobody reads.
 *
 * A `frontend/` module imported straight into a node test, the way
 * `online-players.test.ts` already does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { gameClick } from '../../frontend/src/lib/rooms/game-click.js';

const room = (
  status: 'waiting' | 'playing',
  members: number
) => ({ id: 'r1', status, players: Array.from({ length: members }, (_, i) => ({ userId: `u${i}` })) });

test('with no room at all, a game is launched on its own', () => {
  assert.deepEqual(gameClick(null), { kind: 'launch-solo' });
  assert.deepEqual(gameClick(undefined), { kind: 'launch-solo' });
});

test('a room holding nobody but me is not a group: the game is launched on its own', () => {
  // The leftover of a group the other player left, or of a previous solo game.
  // `room:create` gives up the old seat by itself, so there is nothing special
  // to do here.
  assert.deepEqual(gameClick(room('waiting', 1)), { kind: 'launch-solo' });
});

test('in a group, the game is chosen for the room and the server moves both players', () => {
  assert.deepEqual(gameClick(room('waiting', 2)), { kind: 'choose-for-group', roomId: 'r1' });
});

test('a game already running blocks the click, whatever the group looks like', () => {
  // The server refuses a game change on a playing room, so a click here could
  // only ever earn a refusal. Both shapes are blocked: solo and duo.
  assert.deepEqual(gameClick(room('playing', 2)), { kind: 'blocked', reason: 'playing' });
  assert.deepEqual(gameClick(room('playing', 1)), { kind: 'blocked', reason: 'playing' });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npx tsx --test core/test/game-click.test.ts 2>&1 | tail -15
```

Attendu : échec de résolution du module `game-click.js`.

- [ ] **Step 3: Implement**

Créer `frontend/src/lib/rooms/game-click.ts` :

```ts
/**
 * What a click on a game card should do, given the room I am already in.
 *
 * Three answers, and the reason they are gathered here rather than spread
 * through the library page: the button's meaning changes with the state of the
 * group, and a reader of the template would see two of the three branches at
 * most.
 *
 * Takes the room and nothing else. It is always *my* room - the store only ever
 * exposes the one I am a member of - so there is no identity to check and no
 * way to pass the wrong room without noticing.
 */

/** The little a decision needs to know about a room. */
export interface GroupRoom {
  id: string;
  status: 'waiting' | 'playing';
  players: { userId: string }[];
}

export type GameClick =
  | { kind: 'launch-solo' }
  | { kind: 'choose-for-group'; roomId: string }
  | { kind: 'blocked'; reason: 'playing' };

export function gameClick(room: GroupRoom | null | undefined): GameClick {
  if (!room) return { kind: 'launch-solo' };

  // The server refuses to change the game of a playing room, so this click has
  // nowhere to go. The banner offers the way back into the game instead.
  if (room.status === 'playing') return { kind: 'blocked', reason: 'playing' };

  // A room with only me in it is not a group. Launching gives it up, which
  // `room:create` does on its own.
  if (room.players.length < 2) return { kind: 'launch-solo' };

  return { kind: 'choose-for-group', roomId: room.id };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npx tsx --test core/test/game-click.test.ts 2>&1 | tail -10
```

Attendu : 4 tests verts.

- [ ] **Step 5: Add it to the suite**

Dans `package.json`, ajouter `core/test/game-click.test.ts` à la fin de la liste du script `test:ui`, puis :

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run test:ui 2>&1 | tail -10
```

Attendu : 0 échec.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/rooms/game-click.ts core/test/game-click.test.ts package.json
git commit -m "Name the three things a click on a game card can mean"
```

---

### Task 4: mon salon, en direct

L'accueil lit `/api/rooms` une fois au montage et ne réécoute plus rien : un bandeau construit sur cette lecture serait périmé à l'affichage. Un store remplace les trois lectures ponctuelles (accueil, profil, et la propriété que les deux passent à la `TopBar`).

**Files:**
- Create: `frontend/src/lib/rooms/my-room.ts`
- Modify: `frontend/src/lib/components/TopBar.svelte` (propriété `activeRooms` `:28`, usage `:307`)
- Modify: `frontend/src/routes/+page.svelte` (`:27`, `:37-38`, `:50-60`, `:107`, `:306`)
- Modify: `frontend/src/routes/profile/+page.svelte` (`:33`, `:175-178`, `:236`)

**Interfaces:**
- Consumes: `socket` (`$lib/api/socket`), `user` (`$lib/stores/user`).
- Produces:
  ```ts
  export interface RoomInvitationView { id: string; toUserId: string; toPseudo: string; toAvatar?: string; expiresAt: string }
  export interface RoomView {
    id: string; gameId?: string; gameTitle?: string; gameCoverUrl?: string;
    hostId: string; createdBy: string; status: 'waiting' | 'playing';
    players: { userId: string; pseudo: string; avatar?: string; port: 1 | 2 | null; isReady: boolean; online: boolean }[];
    invitation?: RoomInvitationView;
  }
  export const activeRooms: Readable<RoomView[]>;
  export const myRoom: Readable<RoomView | null>;
  ```

- [ ] **Step 1: Write the store**

Créer `frontend/src/lib/rooms/my-room.ts` :

```ts
/**
 * The rooms this client is entitled to see, kept current.
 *
 * The library page used to read `/api/rooms` once in `onMount` and never listen
 * again, which was enough while the only thing it did with a room was offer a
 * link to it. It is not enough for a banner that has to say who is in the
 * group, who is being waited on, and whether a game is running: every one of
 * those changes after the page has loaded.
 *
 * Three events keep it current, and the server already emits all three:
 * `rooms:list` at every connection (so a reconnect re-seeds this for free),
 * `room:update` whenever a room a member or a friend can see changes, and
 * `room:destroyed` when one dies. `friend:roomCreated` is here too because a
 * friend's brand new room arrives on that event and on no other.
 *
 * The listeners are attached from module scope rather than from a component's
 * `onMount`, deliberately: `rooms:list` is pushed by the server at connection
 * time, and a component that subscribes afterwards would miss it. The HTTP seed
 * covers the opposite race - a socket that was already connected before this
 * module was ever imported.
 */
import { derived, get, writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';
import { socket } from '$lib/api/socket';
import { user } from '$lib/stores/user';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('MyRoom');

export interface RoomInvitationView {
  id: string;
  toUserId: string;
  toPseudo: string;
  toAvatar?: string;
  /** An ISO string: Socket.IO serialises dates on the way out and never revives them. */
  expiresAt: string;
}

export interface RoomView {
  id: string;
  gameId?: string;
  gameTitle?: string;
  gameCoverUrl?: string;
  hostId: string;
  createdBy: string;
  status: 'waiting' | 'playing';
  players: {
    userId: string;
    pseudo: string;
    avatar?: string;
    port: 1 | 2 | null;
    isReady: boolean;
    online: boolean;
  }[];
  /** Only ever present on a room I am a member of: the server strips it otherwise. */
  invitation?: RoomInvitationView;
}

const byId = writable<Map<string, RoomView>>(new Map());

export const activeRooms: Readable<RoomView[]> = derived(byId, map => [...map.values()]);

/**
 * The one room I am a member of, or null.
 *
 * One room at a time is a server rule - `leaveCurrentRoom` gives up the
 * previous one on every create and every accept - which is what makes `find`
 * the right call rather than a list.
 */
export const myRoom: Readable<RoomView | null> = derived(
  [byId, user],
  ([map, me]) => {
    if (!me) return null;
    for (const room of map.values()) {
      if (room.players.some(p => p.userId === me.id)) return room;
    }
    return null;
  }
);

function upsert(room: RoomView | undefined | null) {
  if (!room?.id) return;
  byId.update(map => {
    const next = new Map(map);
    next.set(room.id, room);
    return next;
  });
}

function forget(roomId: string | undefined) {
  if (!roomId) return;
  byId.update(map => {
    const next = new Map(map);
    next.delete(roomId);
    return next;
  });
}

async function seed() {
  try {
    const res = await fetch('/api/rooms', { credentials: 'include' });
    if (!res.ok) return;
    const rooms: RoomView[] = await res.json();
    // Merged rather than replacing: `rooms:list` may already have landed, and
    // it is the fresher of the two.
    for (const room of rooms) if (!get(byId).has(room.id)) upsert(room);
  } catch (error) {
    logger.error('Could not seed the rooms list', error);
  }
}

let attachedTo: Socket | null = null;

function attach(sock: Socket) {
  if (attachedTo === sock) return;
  attachedTo = sock;

  // Replaced wholesale: this is the server's complete answer, already scoped to
  // what this user may see, and it is re-sent on every reconnection.
  sock.on('rooms:list', (rooms: RoomView[]) => byId.set(new Map((rooms ?? []).map(r => [r.id, r]))));
  sock.on('room:update', (room: RoomView) => upsert(room));
  sock.on('room:destroyed', ({ roomId }: { roomId: string }) => forget(roomId));
  sock.on('friend:roomCreated', ({ room }: { room: RoomView }) => upsert(room));

  void seed();
}

if (browser) {
  socket.subscribe(sock => {
    if (sock) attach(sock);
    else {
      attachedTo = null;
      byId.set(new Map());
    }
  });
}
```

- [ ] **Step 2: Read the store from the TopBar**

Dans `frontend/src/lib/components/TopBar.svelte`, supprimer la ligne 28 (`export let activeRooms: any[] = [];`), importer le store :

```ts
  import { activeRooms } from '$lib/rooms/my-room';
```

et passer le store à la liste d'amis (`:307`) :

```svelte
    <FriendsList bind:this={friendsListRef} activeRooms={$activeRooms} on:friendClicked={handleFriendClicked} />
```

- [ ] **Step 3: Drop the two HTTP reads**

Dans `frontend/src/routes/+page.svelte` : supprimer `activeRooms` (`:27`), `loadRooms` (`:50-60`), l'appel dans `loadUserData` (`:107` devient `await loadGames();`), et remplacer `<TopBar {activeRooms} />` par `<TopBar />`. Remplacer les deux dérivés `:37-38` par :

```ts
  import { myRoom } from '$lib/rooms/my-room';

  $: myPartner = $myRoom?.players?.find((p) => p.userId !== $user?.id) ?? null;
```

et, dans le gabarit, `myRoom.id` devient `$myRoom.id`.

Dans `frontend/src/routes/profile/+page.svelte` : supprimer `activeRooms` (`:33`) et son `fetch` (`:175-178`), et remplacer `<TopBar {activeRooms} />` par `<TopBar />`.

- [ ] **Step 4: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -20
npm run build --workspace frontend 2>&1 | tail -8
```

Attendu : 0 erreur, build vert. Puis à l'œil, application lancée : le bouton « reprendre le salon » de l'accueil apparaît toujours quand un salon existe, et disparaît sans rechargement quand on le quitte — ce que la lecture unique ne faisait pas.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/rooms/my-room.ts frontend/src/lib/components/TopBar.svelte frontend/src/routes/+page.svelte frontend/src/routes/profile/+page.svelte
git commit -m "Keep the rooms the screens read in step with the server"
```

---

### Task 5: les gestes du groupe, et les mots pour les dire

Une implémentation d'« inviter », appelée depuis la liste d'amis et depuis le bandeau — pas deux copies, ce qui est exactement ce qui a fait dériver la liste d'amis et l'écran du salon jusqu'ici.

**Files:**
- Create: `frontend/src/lib/rooms/actions.ts`
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `socket`, `myRoom` (Task 4).
- Produces:
  ```ts
  export function inviteToGroup(friendId: string): Promise<void>;
  export function cancelGroupInvitation(invitationId: string): void;
  export function leaveGroup(roomId: string): void;
  export function chooseGameForGroup(roomId: string, game: { id: string; title: string }, saveId?: string): void;
  export function launchSolo(game: { id: string; title: string }, saveId?: string): Promise<void>;
  ```

- [ ] **Step 1: Write the actions**

Créer `frontend/src/lib/rooms/actions.ts` :

```ts
/**
 * The four gestures of a group, in one place.
 *
 * Inviting is reachable from two screens now - the friends drawer and the
 * library's banner - and the friends list and the room screen have already
 * drifted apart once by each holding their own copy of a lobby action. One
 * implementation, two callers.
 */
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { socket } from '$lib/api/socket';
import { myRoom } from '$lib/rooms/my-room';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('GroupActions');

/**
 * Invites a friend, opening the group's room first if there is not one yet.
 *
 * The room created here is the group: an empty room, which "a lobby before the
 * game" made an ordinary state. It is not hidden - the banner appears in the
 * same gesture and names it.
 */
export async function inviteToGroup(friendId: string): Promise<void> {
  const sock = get(socket);
  if (!sock) return;

  const existing = get(myRoom);
  if (existing) {
    sock.emit('lobby:invite', { roomId: existing.id, friendId });
    return;
  }

  // Waited for rather than assumed: the invitation needs the room's id, and
  // `room:created` is the only thing that carries it. A refusal arrives on the
  // `error` channel and is shown by whoever is listening to it, so the timeout
  // here only has to stop this promise from hanging forever.
  const roomId = await new Promise<string | null>(resolve => {
    const timer = setTimeout(() => resolve(null), 5000);
    sock.once('room:created', (room: { id: string }) => {
      clearTimeout(timer);
      resolve(room?.id ?? null);
    });
    sock.emit('room:create', {});
  });

  if (!roomId) {
    logger.error('The group room was never created, so nobody was invited');
    return;
  }

  sock.emit('lobby:invite', { roomId, friendId });
}

/** Takes the group's invitation back. Either member may. */
export function cancelGroupInvitation(invitationId: string): void {
  get(socket)?.emit('lobby:cancel', { invitationId });
}

/** Gives up the seat for real, which is what dissolves a group of two. */
export function leaveGroup(roomId: string): void {
  get(socket)?.emit('room:leave', { roomId });
}

/**
 * Opens the group's room on a game.
 *
 * Nothing navigates here: `room:opened` comes back from the server and carries
 * *both* players, which is the whole point. The save, when there is one, is
 * staged through the server too - in lockstep both machines boot from the same
 * state, so it cannot be a local variable.
 */
export function chooseGameForGroup(
  roomId: string,
  game: { id: string; title: string },
  saveId?: string
): void {
  const sock = get(socket);
  if (!sock) return;

  sock.emit('room:choose-game', { roomId, gameId: game.id, gameTitle: game.title });
  // After the game, never before: choosing a game unstages the previous save.
  if (saveId) sock.emit('room:choose-save', { roomId, saveId });
}

/**
 * Starts a game on my own, with no lobby in between.
 *
 * `autoStart` is the room protocol's own door for this: the room is born
 * playing, and the room page gets `game:started` in reply to its `room:join` -
 * the same path a reconnection takes. It also gives up whatever room I was in,
 * which is what makes a leftover one-player room a non-case.
 */
export async function launchSolo(
  game: { id: string; title: string },
  saveId?: string
): Promise<void> {
  const sock = get(socket);
  if (!sock) return;

  const roomId = await new Promise<string | null>(resolve => {
    const timer = setTimeout(() => resolve(null), 5000);
    sock.once('room:created', (room: { id: string }) => {
      clearTimeout(timer);
      resolve(room?.id ?? null);
    });
    sock.emit('room:create', { gameId: game.id, gameTitle: game.title, autoStart: true });
  });

  if (!roomId) {
    logger.error('The room was never created, so there was nowhere to go');
    return;
  }

  // In the URL rather than in a store: it survives a reload and it is visible
  // when something goes wrong.
  const query = saveId ? `?save=${encodeURIComponent(saveId)}` : '';
  await goto(`/room/${roomId}${query}`);
}
```

- [ ] **Step 2: Add the copy, in both languages**

Dans `frontend/src/lib/i18n/translations.ts`, ajouter dans le bloc `en` (près des clés `friends` / `invitations`) :

```ts
    // Groups, on the library page
    inGroupWith: 'In a group with {name}',
    leaveGroup: 'Leave the group',
    pickAGameTogether: 'Pick a game to play together',
    backToRoom: 'Back to the room',
    gameRunning: 'Game in progress',
    playWith: 'Play with {name}',
    inYourGroup: 'In your group',
    invitedWaiting: 'Invited',
    chooseGameFromLibrary: 'Pick a game from your library to start.',
```

et, aux mêmes emplacements du bloc `fr` :

```ts
    // Groupes, sur la bibliothèque
    inGroupWith: 'En groupe avec {name}',
    leaveGroup: 'Quitter le groupe',
    pickAGameTogether: 'Choisissez un jeu à jouer ensemble',
    backToRoom: 'Retour au salon',
    gameRunning: 'Partie en cours',
    playWith: 'Jouer avec {name}',
    inYourGroup: 'Dans ton groupe',
    invitedWaiting: 'Invité',
    chooseGameFromLibrary: 'Choisissez un jeu dans votre bibliothèque pour commencer.',
```

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -20
```

Attendu : 0 erreur. `actions.ts` n'a pas encore d'appelant, ce que `svelte-check` ne reproche pas.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/rooms/actions.ts frontend/src/lib/i18n/translations.ts
git commit -m "Gather the group's gestures, and name them in both languages"
```

---

### Task 6: l'invitation qui s'affiche d'elle-même

Une carte épinglée, montée dans le layout, donc visible partout — et pas seulement sur les deux pages qui portent la `TopBar`. Le tiroir et son bouton badge disparaissent.

**Files:**
- Create: `frontend/src/lib/lobby/invitations.ts`
- Create: `frontend/src/lib/components/InvitationCard.svelte`
- Create: `frontend/src/lib/stores/in-game.ts`
- Modify: `frontend/src/routes/+layout.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte` (retrait de tout le bloc invitations)

**Interfaces:**
- Consumes: `socket`, `room:opened` (Task 1).
- Produces:
  ```ts
  // lobby/invitations.ts
  export interface Invitation { id: string; roomId: string; fromUserId: string; fromPseudo: string; fromAvatar?: string; gameTitle?: string; expiresAt: string }
  export const invitations: Readable<Invitation[]>;
  export const answering: Readable<string | null>;
  export const invitationError: Readable<string>;
  export function acceptInvitation(id: string): void;
  export function declineInvitation(id: string): void;
  // stores/in-game.ts
  export const inGame: Writable<boolean>;
  ```

- [ ] **Step 1: Move the invitation logic into a store**

Créer `frontend/src/lib/lobby/invitations.ts`. Les quatre règles qui suivent sont **déménagées telles quelles** depuis `TopBar.svelte:92-155` : la liste remplacée et non fusionnée, la clé par identifiant, l'oubli après réponse, et l'attribution d'un refus au seul envoi en vol.

```ts
/**
 * The invitations addressed to me.
 *
 * Lifted out of the top bar, where it was reachable from two pages out of the
 * whole application. Nothing here is new; the comments that came with each rule
 * came with it.
 *
 * Module scope, like `my-room.ts` and for the same reason: the server pushes
 * `lobby:invitations` at connection time, and a listener attached from a
 * component's `onMount` can be late for it.
 */
import { get, writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';
import { socket } from '$lib/api/socket';

export interface Invitation {
  id: string;
  roomId: string;
  fromUserId: string;
  fromPseudo: string;
  fromAvatar?: string;
  /** Absent while the room has no game yet, which is now an ordinary state. */
  gameTitle?: string;
  /** An ISO string, not a Date: Socket.IO never revives them. */
  expiresAt: string;
}

const list = writable<Invitation[]>([]);
const answeringNow = writable<string | null>(null);
const error = writable<string>('');

export const invitations: Readable<Invitation[]> = list;
/** The invitation whose answer is in flight, so a refusal can be attributed. */
export const answering: Readable<string | null> = answeringNow;
export const invitationError: Readable<string> = error;

export function acceptInvitation(id: string): void {
  error.set('');
  answeringNow.set(id);
  get(socket)?.emit('lobby:accept', { invitationId: id });
}

export function declineInvitation(id: string): void {
  error.set('');
  answeringNow.set(id);
  get(socket)?.emit('lobby:decline', { invitationId: id });
}

function forget(invitationId: string) {
  answeringNow.set(null);
  error.set('');
  list.update(current => current.filter(i => i.id !== invitationId));
}

let attachedTo: Socket | null = null;

function attach(sock: Socket) {
  if (attachedTo === sock) return;
  attachedTo = sock;

  // Replaced, not merged: this is the server's whole answer - sent at every
  // connection, already filtered for expiry and for rooms that still exist -
  // and merging would keep resurrecting the ones it left out on purpose.
  sock.on('lobby:invitations', (incoming: Invitation[]) => list.set(incoming ?? []));

  // Keyed by id rather than appended: re-inviting refreshes one row instead of
  // adding another, so the same id arrives again with a later deadline.
  sock.on('lobby:invitation', (invitation: Invitation) =>
    list.update(current => [...current.filter(i => i.id !== invitation.id), invitation])
  );

  // Accepting no longer navigates. The group is formed and both players stay on
  // their library; when there *is* something to open, the server says so with
  // `room:opened` and the layout listens for it.
  sock.on('lobby:accepted', ({ invitationId }: { invitationId: string }) => forget(invitationId));
  sock.on('lobby:declined', ({ invitationId }: { invitationId: string }) => forget(invitationId));

  /*
   * The room took its invitation back.
   *
   * It leaves without a word: the invitee never asked for anything. Leaving the
   * row would offer an invitation the server now refuses, and the only thing
   * accepting it could earn them is an error.
   */
  sock.on('lobby:invitation-cancelled', ({ invitationId }: { invitationId: string }) =>
    forget(invitationId)
  );

  /*
   * Only while an answer of ours is in flight.
   *
   * `error` is the server's general-purpose channel, so a message meant for
   * some other feature has no business surfacing here. The row is left in
   * place: a room that filled up can free a seat again while the ten minutes
   * are still running.
   */
  sock.on('error', (payload: { message?: string }) => {
    if (!get(answeringNow)) return;
    answeringNow.set(null);
    error.set(payload?.message ?? '');
  });
}

if (browser) {
  socket.subscribe(sock => {
    if (sock) attach(sock);
    else {
      attachedTo = null;
      list.set([]);
      answeringNow.set(null);
      error.set('');
    }
  });
}
```

- [ ] **Step 2: The signal that a game is running**

Créer `frontend/src/lib/stores/in-game.ts` :

```ts
import { writable } from 'svelte/store';

/**
 * Whether an emulator is on screen right now.
 *
 * Set by the room page, read by the layout. It exists so that the invitation
 * card can stay out of the way of a running game: a panel over an emulator
 * steals a click, and accepting an invitation mid-game means walking out of the
 * match you are playing.
 *
 * Not derived from the route: the room page is also the lobby, and the lobby is
 * a perfectly good place to be told somebody wants to play.
 */
export const inGame = writable(false);
```

- [ ] **Step 3: Write the card**

Créer `frontend/src/lib/components/InvitationCard.svelte` :

```svelte
<script lang="ts">
  /**
   * An invitation, in front of the player, wherever they are.
   *
   * Not a toast: an invitation is worth ten minutes and must not evaporate
   * after three seconds. It is a pinned card with two buttons, and accepting is
   * one click - which is the whole point of this component's existence. The
   * badge-and-drawer it replaces was two clicks, on two pages out of the whole
   * application.
   */
  import { onMount, onDestroy } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { inGame } from '$lib/stores/in-game';
  import {
    invitations,
    answering,
    invitationError,
    acceptInvitation,
    declineInvitation
  } from '$lib/lobby/invitations';

  let now = Date.now();
  let clock: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    // Ticks the expiry label, and drops a card by itself when the ten minutes
    // run out with nobody having answered - no broadcast comes for that,
    // because nothing happened on the server.
    clock = setInterval(() => (now = Date.now()), 15_000);
  });

  onDestroy(() => clearInterval(clock));

  $: live = $invitations.filter(i => new Date(i.expiresAt).getTime() > now);

  /**
   * `at` and `lang` are arguments rather than reads of `now` and `$language`, so
   * the template tracks them: in Svelte 4 an expression whose dependencies are
   * hidden inside a function body never re-runs when they change, and this one
   * has to tick.
   */
  function expiryLabel(expiresAt: string, at: number, lang: 'en' | 'fr'): string {
    const minutes = Math.ceil((new Date(expiresAt).getTime() - at) / 60_000);
    return minutes <= 1
      ? t(lang, 'expiresInAMinute')
      : t(lang, 'expiresInMinutes', { count: minutes });
  }
</script>

{#if live.length > 0 && !$inGame}
  <div class="invitation-stack">
    {#each live as invitation (invitation.id)}
      <div class="invitation" role="alert">
        <div class="avatar">
          {#if invitation.fromAvatar}
            <img src={invitation.fromAvatar} alt="" />
          {:else}
            👤
          {/if}
        </div>
        <div class="what">
          <strong>{t($language, 'invitedYou', { name: invitation.fromPseudo })}</strong>
          <!-- A room can be waiting with no game at all now, so there is
               nothing to name - say that rather than show an empty line. -->
          <small>{invitation.gameTitle ?? t($language, 'noGameChosen')}</small>
          <small class="expiry">{expiryLabel(invitation.expiresAt, now, $language)}</small>
          {#if $invitationError && $answering === null}
            <small class="error">{$invitationError}</small>
          {/if}
        </div>
        <div class="answers">
          <button
            class="accept"
            disabled={$answering === invitation.id}
            on:click={() => acceptInvitation(invitation.id)}
          >
            {t($language, 'accept')}
          </button>
          <button
            class="decline"
            disabled={$answering === invitation.id}
            on:click={() => declineInvitation(invitation.id)}
          >
            {t($language, 'decline')}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .invitation-stack {
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 2500;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: min(24rem, calc(100vw - 2rem));
  }

  .invitation {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    background: rgba(30, 30, 30, 0.97);
    border: 1px solid rgba(102, 126, 234, 0.45);
    border-left: 4px solid #667eea;
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(10px);
    animation: slideIn 0.25s ease-out;
  }

  @keyframes slideIn {
    from { transform: translateX(1rem); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .avatar {
    width: 2.5rem;
    height: 2.5rem;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #2a2a2a;
    overflow: hidden;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .what strong {
    font-size: 0.9375rem;
    color: #fff;
  }

  .what small {
    font-size: 0.8125rem;
    color: #aaa;
  }

  .expiry {
    color: #888 !important;
  }

  .error {
    color: #ff8a80 !important;
  }

  .answers {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex: 0 0 auto;
  }

  .answers button {
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .answers button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .accept {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
  }

  .decline {
    background: rgba(68, 68, 68, 0.9);
    color: #ddd;
  }

  @media (max-width: 480px) {
    .invitation-stack {
      left: 1rem;
      max-width: none;
    }
  }
</style>
```

- [ ] **Step 4: Mount it, and listen for `room:opened`**

Dans `frontend/src/routes/+layout.svelte` : importer la carte et `waitForSocket`, monter la carte à côté de `<NotificationToast />`, et ajouter l'écoute unique de la navigation.

```ts
  import InvitationCard from '$lib/components/InvitationCard.svelte';
  import { waitForSocket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
```

Dans le `<script>`, après le `onMount` existant :

```ts
  /**
   * The one place a `room:opened` is acted on.
   *
   * It means "go to this room's page", and it is the server's answer to a game
   * being chosen - by me or by the other member - and to an invitation accepted
   * into a room that already has a game. Here rather than on a page, because
   * the whole point is that it reaches a player who is somewhere else.
   *
   * `?from=invitation` is rebuilt from `reason`: the room screen uses it to say
   * so when it lands in a match that is already running.
   */
  function handleRoomOpened({ roomId, reason }: { roomId: string; reason?: string }) {
    if (!roomId) return;
    const query = reason === 'invitation' ? '?from=invitation' : '';
    void goto(`/room/${roomId}${query}`);
  }

  onMount(async () => {
    const sock = await waitForSocket();
    if (!sock) return;
    sock.on('room:opened', handleRoomOpened);
    return () => sock.off('room:opened', handleRoomOpened);
  });
```

et dans le gabarit, juste après `<NotificationToast />` :

```svelte
<InvitationCard />
```

- [ ] **Step 5: Take the drawer out of the TopBar**

Dans `frontend/src/lib/components/TopBar.svelte`, supprimer : l'interface `Invitation` (`:33-47`), `invitations`, `showInvitations`, `invitationError`, `answering`, `now`, `clock`, `liveInvitations` (`:76-79`), `expiryLabel` (`:82`), les cinq handlers `handleInvitations` / `handleInvitation` / `handleAccepted` / `handleDeclined` / `handleCancelled` / `handleError` (`:92-155`), `acceptInvitation` / `declineInvitation` (`:147-160`), les six `on`/`off` de `lobby:*` et `error`, `toggleInvitations` (`:202`), le bouton badge (`:227-232`) et tout le bloc `{#if showInvitations ...}` (`:248-294`) avec les styles `.invites-panel`, `.invite`, `.invite-*`, `.badge`.

`onMount` conserve `waitForSocket` **seulement** si autre chose l'utilise ; sinon il ne reste que `toggleFriends`, le tiroir d'amis et le modal. Supprimer aussi `alive` et l'`onDestroy` s'ils n'ont plus rien à garder, et l'import de `goto` s'il n'est plus utilisé.

- [ ] **Step 6: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -20
npm run build --workspace frontend 2>&1 | tail -8
```

Attendu : 0 erreur, build vert.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/lobby/invitations.ts frontend/src/lib/components/InvitationCard.svelte frontend/src/lib/stores/in-game.ts frontend/src/routes/+layout.svelte frontend/src/lib/components/TopBar.svelte
git commit -m "Put an invitation in front of the player, wherever they are"
```

---

### Task 7: l'accueil, où le groupe se forme et le jeu se choisit

**Files:**
- Modify: `frontend/src/routes/+page.svelte`
- Modify: `frontend/src/lib/components/GameCard.svelte`

**Interfaces:**
- Consumes: `gameClick` (Task 3), `myRoom` (Task 4), `inviteToGroup` / `leaveGroup` / `chooseGameForGroup` / `launchSolo` / `cancelGroupInvitation` (Task 5), les clés de traduction (Task 5).
- Produces: `GameCard` accepte `playDisabled: boolean` et `playLabel: string`.

- [ ] **Step 1: Let a card say what its button does**

Dans `frontend/src/lib/components/GameCard.svelte`, ajouter aux propriétés :

```ts
  export let game: Game;
  /** No click while a game of mine is already running: the server would refuse it. */
  export let playDisabled = false;
  /** « Jouer », or « Jouer avec Bob » - the button says which of the two it is. */
  export let playLabel = '';
```

et remplacer le bouton :

```svelte
    <button on:click={handlePlayClick} class="btn-play" disabled={playDisabled}>
      {playLabel || t($language, 'play')}
    </button>
```

Ajouter le style désactivé à côté de `.btn-play` :

```css
  .btn-play:disabled {
    opacity: 0.45;
    cursor: default;
  }
```

- [ ] **Step 2: Route the click, and show the group**

Dans `frontend/src/routes/+page.svelte`, remplacer `createRoom`, `createEmptyRoom`, `resumeFromSave` et `openRoom` par :

```ts
  import { gameClick } from '$lib/rooms/game-click';
  import {
    inviteToGroup,
    leaveGroup,
    chooseGameForGroup,
    launchSolo,
    cancelGroupInvitation
  } from '$lib/rooms/actions';

  /** Two members and no game running: a group, not a leftover room. */
  $: inGroup = ($myRoom?.players.length ?? 0) >= 2;
  $: groupBusy = $myRoom?.status === 'playing';

  /**
   * Where a click on a card goes.
   *
   * The three answers come from `gameClick`, so this function only carries out
   * what was decided. Nothing navigates in the group branch: `room:opened`
   * comes back from the server and moves both players, which is the point.
   */
  function playGame(game: Game, saveId?: string) {
    // Without a checksum nobody - not even me - can find the file, so ask here
    // rather than open onto an error.
    if (!game.crc32) {
      gameToLink = game;
      return;
    }

    const click = gameClick($myRoom);
    if (click.kind === 'blocked') return;
    if (click.kind === 'choose-for-group') {
      chooseGameForGroup(click.roomId, { id: game.id, title: game.title }, saveId);
      return;
    }
    void launchSolo({ id: game.id, title: game.title }, saveId);
  }
```

Dans l'en-tête du gabarit, remplacer tout le bloc `{#if myRoom} … {:else} … {/if}` (`:317-328`) par le bandeau :

```svelte
        <!-- The group's whole state, in one strip: who is being waited on, who
             is here, and the way back into a game that is already running.
             It replaces the "create a room" button, which had nothing left to
             do once inviting opened the room by itself. -->
        {#if $myRoom}
          <div class="group-strip">
            {#if $myRoom.invitation}
              <span class="group-who">
                {t($language, 'waitingForInvitee', { name: $myRoom.invitation.toPseudo })}
              </span>
              <button class="group-action" on:click={() => cancelGroupInvitation($myRoom.invitation.id)}>
                {t($language, 'cancelInvitation')}
              </button>
            {:else if groupBusy}
              <span class="group-who">
                {t($language, 'gameRunning')}{$myRoom.gameTitle ? ` — ${$myRoom.gameTitle}` : ''}
              </span>
            {:else if myPartner}
              <span class="group-who">{t($language, 'inGroupWith', { name: myPartner.pseudo })}</span>
              <span class="group-hint">{t($language, 'pickAGameTogether')}</span>
            {/if}

            {#if $myRoom.gameId || groupBusy}
              <button class="group-action" on:click={() => goto(`/room/${$myRoom.id}`)}>
                {t($language, 'backToRoom')}
              </button>
            {/if}
            {#if !groupBusy}
              <button class="group-action" on:click={() => leaveGroup($myRoom.id)}>
                {t($language, 'leaveGroup')}
              </button>
            {/if}
          </div>
        {/if}
```

et la grille :

```svelte
              <GameCard
                {game}
                playDisabled={groupBusy}
                playLabel={inGroup && myPartner && !groupBusy
                  ? t($language, 'playWith', { name: myPartner.pseudo })
                  : t($language, 'play')}
                on:play={() => playGame(game)}
                on:details={() => selectedGame = game}
                on:delete={() => handleDeleteRequest(game)}
              />
```

Le `on:resume` de `GameDetailsModal` appelle désormais `playGame` :

```svelte
      on:resume={(e) => { const g = selectedGame; selectedGame = null; if (g) playGame(g, e.detail); }}
```

Styles à ajouter, en remplacement de `.btn-create-room` (`:566-580`) :

```css
  .group-strip {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.625rem 1rem;
    background: rgba(102, 126, 234, 0.12);
    border: 1px solid rgba(102, 126, 234, 0.35);
    border-radius: 10px;
  }

  .group-who {
    font-weight: 600;
    color: #fff;
  }

  .group-hint {
    color: #9aa0b5;
    font-size: 0.875rem;
  }

  .group-action {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .group-action:hover {
    background: rgba(255, 255, 255, 0.16);
  }
```

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -20
npm run build --workspace frontend 2>&1 | tail -8
```

Attendu : 0 erreur, build vert.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/+page.svelte frontend/src/lib/components/GameCard.svelte
git commit -m "Choose the game, and who plays it, from the library"
```

---

### Task 8: inviter depuis la liste d'amis

**Files:**
- Modify: `frontend/src/lib/components/FriendsList.svelte`

**Interfaces:**
- Consumes: `myRoom` (Task 4), `inviteToGroup` / `cancelGroupInvitation` (Task 5), les clés de traduction (Task 5).
- Produces: rien.

- [ ] **Step 1: Add the button and its three states**

Dans `frontend/src/lib/components/FriendsList.svelte`, ajouter aux imports :

```ts
  import { myRoom } from '$lib/rooms/my-room';
  import { inviteToGroup, cancelGroupInvitation } from '$lib/rooms/actions';
```

et, dans le `<script>` :

```ts
  /**
   * Whether this friend can be asked to play, and what to show instead.
   *
   * Read from my own room rather than from a local flag: the invitation lives
   * on the room's public view, so it survives a reload, it is the same fact
   * both members see, and cancelling it from anywhere makes this row change
   * back on its own.
   */
  $: groupFull = ($myRoom?.players.length ?? 0) >= 2;
  $: groupBusy = $myRoom?.status === 'playing';
  $: invitedId = $myRoom?.invitation?.toUserId ?? null;

  function isMember(friendId: string) {
    return $myRoom?.players.some((p) => p.userId === friendId) ?? false;
  }
```

Dans la vue complète, à l'intérieur de `.friend` et **hors** de `.friend-main` (pour que le bouton ne déclenche pas l'ouverture du modal) :

```svelte
          <div class="friend">
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div class="friend-main" on:click={() => openFriendDetails(friendData)}>
              …inchangé…
            </div>
            {#if isMember(friendData.friend.id)}
              <span class="friend-tag">{t($language, 'inYourGroup')}</span>
            {:else if invitedId === friendData.friend.id}
              <button
                class="btn-invite-friend cancel"
                on:click|stopPropagation={() => cancelGroupInvitation($myRoom.invitation.id)}
              >
                {t($language, 'invitedWaiting')} ✕
              </button>
            {:else if !groupFull && !groupBusy && !invitedId}
              <button
                class="btn-invite-friend"
                on:click|stopPropagation={() => inviteToGroup(friendData.friend.id)}
              >
                {t($language, 'invite')}
              </button>
            {/if}
          </div>
```

Styles à ajouter :

```css
  .friend {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .friend-main {
    flex: 1;
    min-width: 0;
  }

  .btn-invite-friend {
    flex: 0 0 auto;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border: none;
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .btn-invite-friend.cancel {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .friend-tag {
    flex: 0 0 auto;
    font-size: 0.75rem;
    color: #9aa0b5;
  }
```

Si `.friend` ou `.friend-main` portent déjà un `display`, fusionner plutôt que dupliquer la règle.

- [ ] **Step 2: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -20
npm run build --workspace frontend 2>&1 | tail -8
```

Attendu : 0 erreur, build vert.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/FriendsList.svelte
git commit -m "Invite a friend from the list where their name already is"
```

---

### Task 9: la page du salon, allégée

Le sélecteur de jeu et le panneau d'invitation partent, avec toute la plomberie qui n'existait que pour eux. La `TopBar` arrive, hors partie.

**Files:**
- Modify: `frontend/src/routes/room/[id]/+page.svelte`

**Interfaces:**
- Consumes: `inGame` (Task 6), `TopBar`.
- Produces: rien.

- [ ] **Step 1: Delete**

Retirer, du `<script>` :

- `showGamePicker`, `showInvite`, `pickerDecided` et son bloc `$:` (`:160-161`, `:222-226`)
- `friends` (`:158`) et `loadFriends` (`:418-425`)
- l'interface `PendingInvitation` (`:172-186`), `pendingInvitation`, `sawRoomView`, `liveInvitation` (`:200-204`), `expiryLabel` (`:210-215`)
- `now` et `clock` (`:188-189`), le `setInterval` (`:609`) et son `clearInterval` (dans `onDestroy`)
- `handleRoomView` (`:337-347`), `seedPendingInvitation` (`:435-448`)
- `handleInviteSent` (`:384`), `handleInviteDeclined` (`:388`), `handleInviteCancelled` (`:393`)
- `chooseGame` (`:451-457`), `inviteFriend` (`:476`), `cancelInvitation` (`:488-490`)
- les `sock.on` / `$socket.off` de `room:update`, `lobby:invite-sent`, `lobby:invitation-declined`, `lobby:cancelled` (`:598`, `:602-604`, `:630`, `:634-636`)
- les appels `void loadFriends();` et `void seedPendingInvitation();` (`:585-586`)

Et du gabarit : les deux boutons « choisir un jeu » / « inviter un ami » (`:741-751`), le panneau du sélecteur de jeu, le panneau « en attente de X » et le panneau de la liste d'amis — soit tout le bloc entre la fin du `{#if showSavePicker …}` et la fermeture de `.lobby-setup`.

Le bloc `{#if room.status === 'waiting'}` **reste** : il ne porte plus que le bouton et le panneau de sauvegarde.

- [ ] **Step 2: Add the bar, and say where the game is chosen**

Dans les imports :

```ts
  import TopBar from '$lib/components/TopBar.svelte';
  import { inGame } from '$lib/stores/in-game';
```

`enterGame` et `handleGameStopped` tiennent le store à jour, et `onDestroy` le remet à zéro — une partie ne « tourne » pas sur une page démontée :

```ts
  function enterGame(mode: EmulationMode) {
    activeEmulationMode = mode;
    gameStarted = true;
    // The invitation card steps aside while this is true: a panel over an
    // emulator steals a click.
    inGame.set(true);
    …
  }
```

Dans `handleGameStopped`, ajouter `inGame.set(false);` à côté de `activeEmulationMode = null;`, et dans `onDestroy`, `inGame.set(false);` à côté du rétablissement de `document.body.style.overflow`.

Dans le gabarit, la barre au-dessus du conteneur, jamais au-dessus d'une partie :

```svelte
{#if !gameStarted}
  <!-- The bar comes with the friends list, which is now the only place an
       invitation is sent from - so the room keeps a way to invite without
       carrying a panel of its own. -->
  <TopBar />
{/if}

<div class="room-container">
```

Et l'indice, quand un salon sans jeu est atteint par une URL tapée à la main (`:783`) :

```svelte
        {#if !room.gameId}
          <p class="start-hint">{t($language, 'chooseGameFromLibrary')}</p>
        {/if}
```

- [ ] **Step 3: Give the bar its room in the layout**

Dans le `<style>`, `.room-container` garde ses `100vh` pour la partie ; la règle du lobby cesse d'en imposer une (`:973`) :

```css
  .room-container:has(.lobby) {
    /* The bar takes the top of the page, so the lobby takes what is left
       rather than a second full viewport - which would push it off screen. */
    height: auto;
    flex: 1;
    padding: 2rem;
  }
```

- [ ] **Step 4: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -20
npm run build --workspace frontend 2>&1 | tail -8
```

Attendu : 0 erreur, build vert. Vérifier à l'œil que le lobby n'a pas de barre de défilement et que la partie occupe toujours tout l'écran sans barre au-dessus.

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/routes/room/[id]/+page.svelte"
git commit -m "Take the invitation panel and the game picker out of the room"
```

---

### Task 10: vérification complète et déploiement

**Files:** aucun (sauf correctifs révélés ici).

- [ ] **Step 1: The whole suite, on the right Node**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all 2>&1 | tail -25
```

Attendu : 0 échec. Un échec massif de `test:backend` (« Module did not self-register ») veut dire que la version de Node est la mauvaise, pas que la branche est cassée.

- [ ] **Step 2: The bundler, which no test runs**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -10
npm run build --workspace frontend 2>&1 | tail -8
```

Attendu : 0 erreur svelte-check, build vert. Aucune route n'est ajoutée par ce plan, donc rien à déclarer dans `prerender.entries`.

- [ ] **Step 3: Drive it with two players**

Application lancée, deux profils de développement (Dev User 1 et Dev User 2), dans deux fenêtres :

1. User 1 ouvre le tiroir d'amis, clique « Inviter » sur User 2. Le bandeau annonce l'attente.
2. La carte apparaît **d'elle-même** chez User 2, sans rechargement. Un clic sur « Accepter » : la carte disparaît, aucun des deux ne change de page, les deux bandeaux disent « en groupe avec ».
3. User 2 recharge sa bibliothèque : le bandeau est toujours là, et User 1 ne le voit pas passer « absent ».
4. User 2 clique un jeu de sa bibliothèque : **les deux** arrivent sur la page du salon, qui n'a ni sélecteur de jeu ni panneau d'invitation, mais garde ports, mode, sauvegarde de départ, Démarrer et Quitter.
5. Démarrer lance la partie chez les deux.
6. Sans groupe, un clic sur un jeu lance la partie directement, sans passer par le lobby.

- [ ] **Step 4: Deploy**

Le déploiement est la fusion dans `main` : `.github/workflows/trigger-deploy.yml` part sur tout push et dispatche vers le dépôt d'infra privé. Aucune migration n'accompagne ce lot, donc rien à coordonner avec l'autre dépôt.

```bash
git push origin HEAD:main
git fetch origin && git rev-parse HEAD origin/main
```

Le message `remote: - Changes must be made through a pull request.` est attendu et trompeur : la référence est mise à jour quand même. **Ce sont les deux empreintes identiques qui prouvent le push**, pas l'absence d'avertissement.

- [ ] **Step 5: Confirm the deploy landed**

```bash
gh run list --limit 3
```

Puis, une fois le déploiement passé, vérifier sur https://snes.pleymor.com qu'une invitation reçue affiche la carte.

---

## Self-review

**Couverture de la spec :**

| Section de la spec | Tâche |
|---|---|
| `room:opened`, les deux émetteurs | 1 |
| Le piège `io.to(roomId)` | 1 (deuxième test) |
| La présence à la connexion | 2 |
| Le clic sur un jeu, trois cas | 3 (règle), 7 (câblage) |
| Un état de salon vivant | 4 |
| Le bandeau du groupe | 7 |
| Inviter depuis la liste d'amis | 5 (action), 8 (bouton) |
| La carte d'invitation, montée dans le layout | 6 |
| Le tiroir supprimé | 6 |
| La page du salon allégée, la `TopBar` gardée | 9 |
| Traductions en + fr | 5 |
| Tests protocole + test pur | 1, 2, 3 |
| Le bundler avant de conclure | 4, 6, 7, 8, 9, 10 |

**Cohérence des noms :** `gameClick` / `GameClick` / `GroupRoom` (T3) sont consommés sous ces noms en T7. `myRoom` / `activeRooms` / `RoomView` (T4) sont consommés sous ces noms en T6, T7, T8. `inviteToGroup`, `cancelGroupInvitation`, `leaveGroup`, `chooseGameForGroup`, `launchSolo` (T5) sont appelés sous ces noms en T7 et T8. `inGame` (T6) est écrit en T9. `markPlayerPresent` (T2) est importé sous ce nom dans `index.ts` et dans le harnais de test.

**Placeholders :** aucun `TBD`. Les seules instructions non littérales sont les listes de suppression de T6 Step 5 et T9 Step 1, qui nomment chaque symbole et sa ligne.
