# Lockstep Resume After Server Restart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lockstep game in progress survives a backend restart and resumes on its own, and no outage can leave the UI stuck when the session underneath has recovered.

**Architecture:** Three independent failures are fixed separately. The client retries the socket forever instead of giving up after 10 attempts. Room state is snapshotted whole into Redis on a 1 s interval and, decisively, on `SIGTERM` — a deployment is a graceful shutdown — then restored at boot, so no room mutation site is instrumented and none can be forgotten. And prolonged silence becomes a *recoverable* session event rather than travelling on the same channel as a fatal error, which is what currently latches the screen into a dead end.

**Tech Stack:** TypeScript throughout. Backend: Node, Express, socket.io, node-redis v4 (`^4.6.13`), Prisma. Frontend: SvelteKit, Svelte 4, socket.io-client. Tests: `node:test` via `tsx`, run from `core/test/`.

**Spec:** `docs/superpowers/specs/2026-08-18-lockstep-resume-after-restart-design.md`

## Global Constraints

- **Comments explain why, not what.** This codebase's comments justify decisions and name the failure a line prevents. Match that. Do not add comments that restate the code.
- **English in code and comments**, including test names.
- **Indentation follows the file you are editing.** `frontend/src/lib/znet/*.ts` and `core/test/*.ts` use tabs. Everything under `backend/src/` and all `.svelte` files use 2 spaces.
- **Node for local commands:** the WSL `node` is not on `PATH` by default. Prefix every command with `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`. A bare `npx` resolves to Windows npm and fails with "Maximum call stack size exceeded".
- **Verification commands** (from the repo root unless stated):
  - `npm run test:all` — the full node suite (69 tests before this plan).
  - `cd frontend && npx svelte-check --tsconfig ./tsconfig.json` — must stay at **0 errors**. It reports 19 pre-existing warnings in 10 files; do not add to them.
  - `cd frontend && npx vite build`
  - `cd backend && npx tsc --noEmit`
- **Do not commit** without the repo owner's approval. Each task's commit step stages and writes the message; ask before running it if you are unsure, and never push.
- **Redis key:** `psnes:rooms:v1`. **Snapshot version:** `1`. **TTL:** 3600 s. **Interval:** 1000 ms. **Grace period:** the existing `DISCONNECT_GRACE_MS = 45_000`. **Silence threshold:** the existing `SILENCE_MS = 15_000`.

---

### Task 1: Prolonged silence becomes a recoverable session event

The session already knows how to recover: `tick()` re-sends pending pads every 8 stalled ticks over a wide window (`session.ts:455-465`), and `handleMessage` already clears `reportedSilence` when a packet arrives (`session.ts:736-737`). What is missing is any event telling the UI, so `LockstepRoom`'s `phase = 'error'` never lifts. Silence also travels on `type: 'error'`, the same channel `fail()` uses for genuinely fatal failures, which must stay terminal.

**Files:**
- Modify: `frontend/src/lib/znet/session.ts` (the `SessionEvent` union around line 62; the silence block in `pump()` around lines 316-335; `handleMessage` around lines 736-737)
- Test: `core/test/netcode.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: two new `SessionEvent.type` values, `'link-lost'` and `'link-restored'`. `'link-lost'` carries `message`; `'link-restored'` carries none. `'error'` keeps its meaning: terminal.

- [ ] **Step 1: Write the failing test**

Append to `core/test/netcode.test.ts` (tabs):

```ts
/* --------------------------------------------------------- link recovery */

test('a link that goes quiet is reported, and so is its return', async () => {
	const harness = await NetplayHarness.create(harnessOptions(6000));
	harness.handshake();
	harness.run(2000);

	// Total outage: every packet is dropped, so both peers stall on pads that
	// will never arrive. This is what a backend restart looks like from here.
	harness.link.setLoss(1);
	harness.run(20_000);

	assert.equal(
		harness.host.events.filter((e) => e.type === 'link-lost').length,
		1,
		'silence must be reported exactly once, not once per tick'
	);
	assert.equal(
		harness.host.events.some((e) => e.type === 'error'),
		false,
		'a recoverable outage must not arrive on the fatal channel'
	);
	assert.equal(harness.host.session.state, 'running', 'the session must not give up');

	const framesBefore = harness.host.session.getStats().framesRun;

	harness.link.setLoss(0);
	harness.run(10_000);

	assert.equal(
		harness.host.events.filter((e) => e.type === 'link-restored').length,
		1,
		'the return of the link must be reported'
	);
	assert.ok(
		harness.host.session.getStats().framesRun > framesBefore,
		'play must actually resume, not merely be reported as resumed'
	);
});

test('a fatal failure is never retracted', () => {
	// A ROM mismatch cannot be recovered from by construction: the two machines
	// could never agree on anything. Keeping it on a separate channel from
	// silence is the point of this change, so prove it stays terminal.
	const link = new SimulatedLink({ latency: 10 });
	const events: SessionEvent[] = [];

	const session = new NetplaySession({
		core: new FakeCore(),
		transport: link.a,
		playerIndex: 0,
		isHost: true,
		romCrc: ROM_CRC,
		readLocalInput: () => 0,
		onEvent: (e) => events.push(e),
		onFrame: () => {}
	});
	session.start();

	// The peer announces a different cartridge. link.b sends to link.a.
	link.b.send(
		encode({
			type: MsgType.Hello,
			protocol: PROTOCOL_VERSION,
			romCrc: ROM_CRC ^ 0xffff,
			playerIndex: 1,
			playerCount: 2
		})
	);
	link.advance(50);

	assert.equal(session.state, 'failed');
	assert.equal(events.filter((e) => e.type === 'error').length, 1, 'the mismatch must be fatal');
	assert.equal(
		events.some((e) => e.type === 'link-restored'),
		false,
		'a fatal error must never be followed by a recovery event'
	);
});
```

This test needs two additions to the file's imports. Extend the protocol import with
`PROTOCOL_VERSION`, and add the session import:

```ts
import {
	MsgType,
	PAD,
	PROTOCOL_VERSION,
	decode,
	encode,
	type NetMsg
} from '../../frontend/src/lib/znet/protocol.js';
import { NetplaySession, type SessionEvent } from '../../frontend/src/lib/znet/session.js';
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
node --import tsx --test core/test/netcode.test.ts 2>&1 | tail -20
```

Expected: the first test fails because no `link-lost` event is ever emitted (the count is 0, and an `error` event is present instead).

- [ ] **Step 3: Widen the event union**

In `frontend/src/lib/znet/session.ts`, change:

```ts
export interface SessionEvent {
	type:
		| 'state'
		| 'desync'
		| 'resync-start'
		| 'resync-done'
		| 'rtt'
		| 'error'
		| 'peer-ready';
```

to:

```ts
export interface SessionEvent {
	type:
		| 'state'
		| 'desync'
		| 'resync-start'
		| 'resync-done'
		| 'rtt'
		/**
		 * The link has gone quiet, and may yet come back. Distinct from
		 * 'error' because it is retractable: the engine re-sends pads while
		 * stalled precisely so that play resumes by itself, and a consumer
		 * that treats this as terminal freezes a session that recovered.
		 */
		| 'link-lost'
		| 'link-restored'
		| 'error'
		| 'peer-ready';
```

- [ ] **Step 4: Emit the two events**

In `pump()`, change the silence report from `type: 'error'` to `type: 'link-lost'` and reword the message, which currently gives advice that cannot be followed — reloading lands on a room that may not exist:

```ts
		if (
			this._state === 'running' &&
			!this.reportedSilence &&
			now - this.lastPacketAt > SILENCE_MS
		) {
			this.reportedSilence = true;
			this.onEvent({
				type: 'link-lost',
				message: 'Lost contact with the other player. Play resumes as soon as the link is back.'
			});
		}
```

In `handleMessage()`, make the existing clear announce itself. The guard is what keeps this to one event per outage rather than one per packet:

```ts
		this.lastPacketAt = this.now();
		if (this.reportedSilence) {
			this.reportedSilence = false;
			this.onEvent({ type: 'link-restored' });
		}
```

- [ ] **Step 5: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
node --import tsx --test core/test/netcode.test.ts 2>&1 | tail -12
npm run test:all 2>&1 | grep -E "ℹ (pass|fail)"
```

Expected: the new tests pass and nothing else regresses. `grep` for `type: 'error'` in `session.ts` and confirm every remaining use is a genuine failure (`fail()` and the ROM/protocol checks).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/znet/session.ts core/test/netcode.test.ts
git commit -m "Tell the UI when a quiet link comes back"
```

---

### Task 2: The lockstep screen recovers instead of latching

`LockstepRoom` maps `type: 'error'` to `phase = 'error'`, which nothing ever leaves. With Task 1 in place the session distinguishes the two cases; the component must too.

**Files:**
- Modify: `frontend/src/lib/components/LockstepRoom.svelte` (state block near `showPauseMenu`; `handleEvent`; the badge markup inside `.screen`; styles)

**Interfaces:**
- Consumes: `SessionEvent` types `'link-lost'` and `'link-restored'` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Add the state**

Next to the other overlay state (near `let stalling = false;`):

```ts
  /**
   * A link that has gone quiet but is expected back.
   *
   * Kept separate from `phase` on purpose: `phase = 'error'` is terminal and
   * swaps in the error screen, whereas this must be able to clear itself. The
   * canvas keeps showing its last frame underneath.
   */
  let linkLost = false;
```

- [ ] **Step 2: Handle the events**

In `handleEvent`, add two cases before `case 'error':`:

```ts
      case 'link-lost':
        linkLost = true;
        logger.warn('The link went quiet', event.message);
        break;
      case 'link-restored':
        linkLost = false;
        logger.info('The link is back; play resumes');
        break;
```

- [ ] **Step 3: Show it, ahead of the stall badge**

A quiet link is also a stall, so this branch has to come first or it never shows. In the `.screen` block, change:

```svelte
    {:else if stallVisible}
```

to:

```svelte
    {:else if linkLost}
      <!-- Not an error screen: this clears itself when packets resume. -->
      <div class="badge badge-warn">
        Connection lost — play resumes as soon as it is back
      </div>
    {:else if stallVisible}
```

And add to the styles, after `.badge`:

```css
  .badge-warn {
    background: rgba(150, 75, 0, 0.9);
  }
```

- [ ] **Step 4: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3 && npx vite build 2>&1 | tail -3
```

Expected: 0 errors, build succeeds. There is no component test harness in this repo (no vitest, no @testing-library), so this task is covered by the type check plus the manual check at the end of the plan. Do not add a component test framework for it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/LockstepRoom.svelte
git commit -m "Let a lockstep game come back from a quiet link"
```

---

### Task 3: A client that never stops trying, and says so

`reconnectionAttempts: 10` with a 5 s ceiling means socket.io gives up after roughly 30-60 s and never retries. A deploy takes longer than that.

**Files:**
- Create: `frontend/src/lib/stores/connection.ts`
- Modify: `frontend/src/lib/api/socket.ts`
- Modify: `frontend/src/routes/+layout.svelte`
- Modify: `frontend/src/routes/room/[id]/+page.svelte` (the `onMount` listener registrations around lines 120-160 and the `onDestroy` around lines 164-176)

**Interfaces:**
- Consumes: nothing.
- Produces: `linkState`, a `Writable<'connected' | 'reconnecting'>` exported from `$lib/stores/connection`.

- [ ] **Step 1: Create the store**

`frontend/src/lib/stores/connection.ts` (2 spaces):

```ts
import { writable } from 'svelte/store';

/**
 * Whether the app has a live socket.
 *
 * Two states, not three: the client now retries for as long as the tab is
 * open, so there is no "gave up" to represent. Starts 'connected' so the
 * banner does not flash during the very first connect, which is not a
 * reconnection and is not worth telling anyone about.
 */
export type LinkState = 'connected' | 'reconnecting';

export const linkState = writable<LinkState>('connected');
```

- [ ] **Step 2: Retry forever, and feed the store**

In `frontend/src/lib/api/socket.ts`, add the import:

```ts
import { linkState } from '$lib/stores/connection';
```

Change the reconnection options:

```ts
    reconnection: true,
    reconnectionDelay: 1000,
    // Forever, with a five second ceiling between tries. Ten attempts gave up
    // after well under a minute, which is shorter than a deployment - and
    // once socket.io has given up it never tries again, so the game was over.
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
```

And report the state from the handlers that already exist:

```ts
  socketInstance.on('connect', () => {
    logger.debug('Socket connected');
    linkState.set('connected');
  });

  socketInstance.on('disconnect', () => {
    logger.debug('Socket disconnected');
    linkState.set('reconnecting');
  });
```

- [ ] **Step 3: Stop the room page from deleting other people's listeners**

`frontend/src/routes/room/[id]/+page.svelte:171` calls `$socket.off('connect')` with no handler, which removes **every** `connect` listener on the socket — including the one Step 2 just added, and the one `SocketTransport` uses to reclaim its netplay slot. The banner would die the first time a player left a room.

Hoist the four handlers to component scope, above `onMount`:

```ts
  function handleReconnect() {
    logger.info('Socket reconnected, rejoining room');
    $socket?.emit('room:join', { roomId });
  }

  function handleRoomUpdated(updatedRoom: Room) {
    if (updatedRoom.id === roomId) {
      room = updatedRoom;
    }
  }

  function handleGameStarted() {
    activeEmulationMode = effectiveEmulationMode ?? EmulationMode.SINGLE;
    gameStarted = true;

    // Prevent scrolling when game is active
    if (browser) {
      document.body.style.overflow = 'hidden';
    }
  }

  function handleGameStopped() {
    activeEmulationMode = null;
    // Restore scrolling
    if (browser) {
      document.body.style.overflow = '';
    }

    // Redirect to home when game is stopped
    goto('/');
  }
```

In `onMount`, replace the four inline registrations with:

```ts
    // Join room
    sock.emit('room:join', { roomId });

    // Rejoin after a reconnect. The server drops a player from the room when
    // its socket disconnects, and socket.io reconnects on its own - but
    // `room:join` only ran in onMount, so the player stayed dropped. The room
    // then sat at one player permanently, which is also what pushed a running
    // game into single-player mode.
    sock.on('connect', handleReconnect);
    sock.on('room:updated', handleRoomUpdated);
    sock.on('game:started', handleGameStarted);
    sock.on('game:stopped', handleGameStopped);
```

And in `onDestroy`, pass the handlers so only our own listeners go:

```ts
  onDestroy(() => {
    if ($socket) {
      $socket.emit('room:leave', { roomId });
      // With the handler, not without: a bare off('connect') removes every
      // connect listener on the shared socket, including the ones that keep
      // the reconnection banner and the netplay slot alive.
      $socket.off('connect', handleReconnect);
      $socket.off('room:updated', handleRoomUpdated);
      $socket.off('game:started', handleGameStarted);
      $socket.off('game:stopped', handleGameStopped);
    }

    if (browser) {
      document.body.style.overflow = '';
    }
  });
```

- [ ] **Step 4: Add the banner**

In `frontend/src/routes/+layout.svelte`, import the store:

```ts
  import { linkState } from '$lib/stores/connection';
```

And render it above the slot:

```svelte
<div class="app">
  {#if $linkState === 'reconnecting'}
    <div class="link-banner" role="status">Connection lost — reconnecting…</div>
  {/if}
  <slot />
</div>
```

With styles:

```css
  .link-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    padding: 0.5rem 1rem;
    text-align: center;
    font-size: 0.9rem;
    background: rgba(150, 75, 0, 0.95);
    color: #fff;
  }
```

**Do not** try to make this banner appear over a fullscreen lockstep game. Only descendants of the fullscreen element render, and the fullscreen element is `.lockstep` inside `LockstepRoom` — this banner sits outside it by design. The in-game signal is Task 2's badge, which is inside. Two signals for two contexts is the intent, not an oversight.

- [ ] **Step 5: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3 && npx vite build 2>&1 | tail -3
```

Expected: 0 errors. Then confirm by hand that `git diff` shows no remaining bare `off('` call in `frontend/src/routes/room/[id]/+page.svelte`:

```bash
grep -n "\.off('" frontend/src/routes/room/\[id\]/+page.svelte
```

Expected: every line passes a handler as its second argument.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/stores/connection.ts frontend/src/lib/api/socket.ts \
        frontend/src/routes/+layout.svelte "frontend/src/routes/room/[id]/+page.svelte"
git commit -m "Keep reconnecting, and say when the link is down"
```

---

### Task 4: One Redis client, reachable from the websocket layer

The client is created inline in `backend/src/index.ts` and not exported. The room snapshot lives under `websocket/`, which `index.ts` already imports, so the client cannot stay there without an import cycle.

**Files:**
- Create: `backend/src/db/redis.ts`
- Modify: `backend/src/index.ts` (the `redis` import at line 7; the client block at lines 96-105)

**Interfaces:**
- Consumes: nothing.
- Produces: `connectRedis(): Promise<RedisClientType>` and `getRedis(): RedisClientType`. `getRedis()` throws if called before `connectRedis()` has resolved.

- [ ] **Step 1: Create the module**

`backend/src/db/redis.ts` (2 spaces):

```ts
import { createClient, type RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

/**
 * The one Redis connection, mirroring db/prisma.ts.
 *
 * Sessions and the room snapshot both need it, and the snapshot lives under
 * websocket/ which index.ts already imports - so keeping the client in
 * index.ts would mean an import cycle.
 *
 * The client is built inside connectRedis() rather than at module scope
 * because index.ts calls dotenv.config() *after* its imports run: reading
 * REDIS_HOST at import time would quietly fall back to localhost in
 * development, where the host comes from .env.
 */
let client: RedisClientType | null = null;

export async function connectRedis(): Promise<RedisClientType> {
  if (client) return client;

  const fresh: RedisClientType = createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  });

  fresh.on('error', err => logger.error({ err }, 'Redis error'));
  await fresh.connect();
  client = fresh;
  return client;
}

export function getRedis(): RedisClientType {
  if (!client) throw new Error('connectRedis() has not completed yet');
  return client;
}
```

- [ ] **Step 2: Consume it from index.ts**

Remove `import { createClient } from 'redis';` (line 7) and add alongside the other local imports:

```ts
import { connectRedis } from './db/redis.js';
```

Replace the whole client block:

```ts
// Redis client
const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
});

redisClient.on('error', (err) => logger.error({ err }, 'Redis error'));
await redisClient.connect();
```

with:

```ts
const redisClient = await connectRedis();
```

`new RedisStore({ client: redisClient })` further down is unchanged.

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd backend && npx tsc --noEmit
```

Expected: no output. Then start the stack and confirm the server still boots and authenticates — sessions go through Redis, so a broken client shows up immediately as a failed login:

```bash
docker compose up --build -d && sleep 20 && curl -s localhost:3000/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/redis.ts backend/src/index.ts
git commit -m "Give the Redis client a home the websocket layer can reach"
```

---

### Task 5: The room snapshot

Serialise the whole `rooms` Map into one Redis key and read it back. Nothing here touches a mutation site, which is the entire point: room state is mutated in place at 28 sites across 5 files, and an instrumented site that gets missed is a silently stale room.

**Files:**
- Create: `backend/src/websocket/room-snapshot.ts`
- Test: `core/test/room-snapshot.test.ts`

**Interfaces:**
- Consumes: `getRedis()` from Task 4.
- Produces:
  - `serialiseRooms(rooms: Map<string, Room>): string`
  - `deserialiseRooms(raw: string | null): Map<string, Room>`
  - `restoreRooms(rooms: Map<string, Room>, holdSeat: (roomId: string, userId: string) => void, store?: Store): Promise<number>`
  - `writeSnapshot(rooms: Map<string, Room>, store?: Store): Promise<boolean>` — resolves `false` when nothing changed
  - `startRoomSnapshots(rooms: Map<string, Room>): void`
  - `stopRoomSnapshots(): void`
  - `flushRooms(rooms: Map<string, Room>, store?: Store): Promise<void>`
  - `Store` is the two-method slice of the Redis client this module uses —
    `get(key)` and `set(key, value, { EX })` — declared in the module and
    defaulting to `getRedis()`. It exists so the tests need no Redis.
  - `resetSnapshotStateForTest(): void` — clears the module's memory of the last write

- [ ] **Step 1: Write the failing test**

`core/test/room-snapshot.test.ts` (tabs). Note it imports a **backend** module; `core/test/relay.test.ts` already does the same, so this is the established home for such tests.

```ts
/**
 * Room snapshot tests.
 *
 * Rooms live in a plain Map in the backend process, so a restart erases every
 * game in progress. These cover the part of the fix that can be got wrong
 * quietly: a snapshot that reads back as a subtly different room is worse than
 * one that fails to read back at all, because the lobby then looks fine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	deserialiseRooms,
	flushRooms,
	serialiseRooms,
	resetSnapshotStateForTest,
	writeSnapshot
} from '../../backend/src/websocket/room-snapshot.js';

function makeRoom(id: string, playerIds: string[]) {
	return {
		id,
		gameId: 'game-1',
		gameTitle: 'Test',
		gameCrc32: 'abcdef01',
		hostId: playerIds[0] ?? 'nobody',
		createdBy: playerIds[0] ?? 'nobody',
		status: 'playing',
		emulationMode: 'lockstep',
		createdAt: new Date('2026-08-18T06:00:00.000Z'),
		players: playerIds.map((userId) => ({
			userId,
			displayName: userId,
			port: 1,
			isReady: true,
			emulationReady: true,
			keyConfig: {}
		}))
	} as never;
}

function populated() {
	return new Map<string, never>([
		['room-a', makeRoom('room-a', ['host', 'guest'])],
		['room-b', makeRoom('room-b', ['solo'])]
	]);
}

test('a populated map survives a round trip', () => {
	const before = populated();
	const after = deserialiseRooms(serialiseRooms(before as never));

	assert.deepEqual([...after.keys()].sort(), ['room-a', 'room-b']);
	assert.equal(after.get('room-a')!.players.length, 2);
	assert.equal(after.get('room-a')!.status, 'playing');
	assert.equal(after.get('room-a')!.gameCrc32, 'abcdef01');
});

test('createdAt comes back as a Date, not the string JSON made of it', () => {
	// The rest of the app calls Date methods on this field, so a string here
	// is a crash somewhere far from the snapshot.
	const after = deserialiseRooms(serialiseRooms(populated() as never));
	const createdAt = after.get('room-a')!.createdAt;

	assert.ok(createdAt instanceof Date, 'createdAt must be a Date');
	assert.equal(createdAt.toISOString(), '2026-08-18T06:00:00.000Z');
});

test('a room with no players is dropped', () => {
	const rooms = populated();
	rooms.set('empty', makeRoom('empty', []));

	const after = deserialiseRooms(serialiseRooms(rooms as never));
	assert.equal(after.has('empty'), false, 'an empty room has nothing to resume');
	assert.equal(after.size, 2);
});

test('a snapshot from another build is discarded rather than coerced', () => {
	// An old Room shape read into the current type is how a restart produces a
	// lobby that is subtly wrong instead of empty.
	const foreign = JSON.stringify({ version: 99, rooms: [makeRoom('room-a', ['host'])] });
	assert.equal(deserialiseRooms(foreign).size, 0);
});

test('unreadable input yields an empty map instead of throwing', () => {
	assert.equal(deserialiseRooms(null).size, 0);
	assert.equal(deserialiseRooms('').size, 0);
	assert.equal(deserialiseRooms('{not json').size, 0);
});

test('an unchanged map is not written twice', async () => {
	// The snapshot runs every second for the life of the process. Writing an
	// identical blob 86400 times a day is pure waste.
	const writes: Array<{ key: string; value: string }> = [];
	const fake = {
		async set(key: string, value: string) {
			writes.push({ key, value });
			return 'OK';
		},
		async get() {
			return null;
		}
	};

	resetSnapshotStateForTest();
	const rooms = populated();

	assert.equal(await writeSnapshot(rooms as never, fake as never), true);
	assert.equal(await writeSnapshot(rooms as never, fake as never), false);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].key, 'psnes:rooms:v1');

	rooms.delete('room-b');
	assert.equal(await writeSnapshot(rooms as never, fake as never), true);
	assert.equal(writes.length, 2);
});

test('flushing twice writes once', async () => {
	// SIGTERM and SIGINT can both arrive, and the shutdown path must be safe to
	// enter twice: a second flush should re-write nothing and re-arm nothing.
	const writes: string[] = [];
	const fake = {
		async set(_key: string, value: string) {
			writes.push(value);
			return 'OK';
		},
		async get() {
			return null;
		}
	};

	resetSnapshotStateForTest();
	const rooms = populated();

	await flushRooms(rooms as never, fake as never);
	await flushRooms(rooms as never, fake as never);

	assert.equal(writes.length, 1, 'the second flush must be a no-op');
});

test('a write failure is swallowed, not thrown at the caller', async () => {
	// This runs on a timer and on the way out. A rejected promise there is an
	// unhandledRejection, and the shutdown path is the last place we want one.
	const failing = {
		async set() {
			throw new Error('redis is gone');
		},
		async get() {
			return null;
		}
	};

	resetSnapshotStateForTest();
	assert.equal(await writeSnapshot(populated() as never, failing as never), false);
});
```

Note the extra second argument to `writeSnapshot` in the last two tests: the client is injectable so the tests need no Redis. Signature in the interface block below reflects it.

- [ ] **Step 2: Run the test and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
node --import tsx --test core/test/room-snapshot.test.ts 2>&1 | tail -8
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

`backend/src/websocket/room-snapshot.ts` (2 spaces):

```ts
import type { Room } from '../types/index.js';
import { getRedis } from '../db/redis.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RoomSnapshot');

const KEY = 'psnes:rooms:v1';
const VERSION = 1;
/** A backstop, so a long outage cannot resurrect a stale world. */
const TTL_SECONDS = 3600;
const INTERVAL_MS = 1000;

/**
 * The subset of the Redis client this module uses, so tests can pass a stub.
 */
interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

interface Snapshot {
  version: number;
  rooms: Room[];
}

let timer: NodeJS.Timeout | null = null;
/**
 * The last blob written, so an unchanged map costs nothing.
 *
 * This is also why the snapshot carries no timestamp: a `savedAt` field would
 * differ on every tick and the comparison would never match.
 */
let lastWritten = '';

export function serialiseRooms(rooms: Map<string, Room>): string {
  const snapshot: Snapshot = { version: VERSION, rooms: [...rooms.values()] };
  return JSON.stringify(snapshot);
}

export function deserialiseRooms(raw: string | null): Map<string, Room> {
  const rooms = new Map<string, Room>();
  if (!raw) return rooms;

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(raw) as Snapshot;
  } catch {
    logger.warn('Discarding an unreadable room snapshot');
    return rooms;
  }

  // Refuse rather than coerce. An older Room shape read into the current type
  // gives a lobby that looks fine and behaves wrongly, which is harder to
  // diagnose than starting empty.
  if (snapshot?.version !== VERSION || !Array.isArray(snapshot.rooms)) {
    logger.warn({ version: snapshot?.version }, 'Discarding a room snapshot from another build');
    return rooms;
  }

  for (const room of snapshot.rooms) {
    if (!room?.id || !Array.isArray(room.players) || room.players.length === 0) continue;
    // JSON has no date type, and the rest of the app calls Date methods here.
    room.createdAt = new Date(room.createdAt);
    rooms.set(room.id, room);
  }

  return rooms;
}

/**
 * Loads the snapshot into `rooms` and holds every restored player's seat.
 *
 * Every player is disconnected by definition at this point, so each one gets
 * the ordinary departure grace period: a room nobody comes back to then dies
 * exactly as it would have if the server had never restarted. `holdSeat` is
 * injected rather than imported so this stays testable without a socket.
 */
export async function restoreRooms(
  rooms: Map<string, Room>,
  holdSeat: (roomId: string, userId: string) => void,
  store: Store = getRedis() as unknown as Store
): Promise<number> {
  let raw: string | null = null;
  try {
    raw = await store.get(KEY);
  } catch (err) {
    // Redis already backs sessions, so a failure here means the app is in
    // trouble regardless; an empty lobby beats refusing to boot.
    logger.error({ err }, 'Could not read the room snapshot; starting empty');
    return 0;
  }

  const restored = deserialiseRooms(raw);
  for (const [id, room] of restored) {
    rooms.set(id, room);
    for (const player of room.players) holdSeat(id, player.userId);
  }

  lastWritten = serialiseRooms(rooms);
  logger.info({ rooms: restored.size }, 'Restored rooms from the snapshot');
  return restored.size;
}

/** Writes the snapshot unless it would be identical to the last one. */
export async function writeSnapshot(
  rooms: Map<string, Room>,
  store: Store = getRedis() as unknown as Store
): Promise<boolean> {
  const body = serialiseRooms(rooms);
  if (body === lastWritten) return false;

  try {
    await store.set(KEY, body, { EX: TTL_SECONDS });
    lastWritten = body;
    return true;
  } catch (err) {
    // Never thrown at the caller: this runs on a timer and during shutdown,
    // where a rejection becomes an unhandledRejection at the worst moment.
    logger.error({ err }, 'Could not write the room snapshot');
    return false;
  }
}

export function startRoomSnapshots(rooms: Map<string, Room>): void {
  if (timer) return;
  timer = setInterval(() => void writeSnapshot(rooms), INTERVAL_MS);
  // Nothing should be kept alive by this timer.
  timer.unref();
}

export function stopRoomSnapshots(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * The write that matters. A deployment is a graceful shutdown, so this is what
 * makes the common case exact; the interval only covers a hard crash.
 *
 * Idempotent: a second signal stops an already-stopped timer and writes a blob
 * that is already `lastWritten`.
 */
export async function flushRooms(
  rooms: Map<string, Room>,
  store: Store = getRedis() as unknown as Store
): Promise<void> {
  stopRoomSnapshots();
  await writeSnapshot(rooms, store);
}

/** Test seam: forgets the last write so each test starts from nothing. */
export function resetSnapshotStateForTest(): void {
  lastWritten = '';
  stopRoomSnapshots();
}
```

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
node --import tsx --test core/test/room-snapshot.test.ts 2>&1 | tail -12
cd backend && npx tsc --noEmit
```

Expected: all tests pass, no type errors.

- [ ] **Step 5: Add the test to the suite**

In the root `package.json`, extend `test:ui` so this file runs with the others:

```json
    "test:ui": "node --import tsx --test core/test/capture-gate.test.ts core/test/input.test.ts core/test/rom-provider.test.ts core/test/room-snapshot.test.ts",
```

Run `npm run test:all` and confirm the third group's count rose by the number of new tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/websocket/room-snapshot.ts core/test/room-snapshot.test.ts package.json
git commit -m "Snapshot the room map so a restart does not erase every game"
```

---

### Task 6: Hold a restored player's seat

`restoreRooms` needs to arm the departure grace period for players who have no socket. The existing `handleLeaveRoom` uses its `socket` argument for exactly one thing — `socket.leave(roomId)` — so it can accept `null` instead of being duplicated.

**Files:**
- Modify: `backend/src/websocket/room-handlers.ts` (`handleLeaveRoom` signature and body around lines 259-297; add `holdRestoredSeat` next to `scheduleLeaveRoom`)

**Interfaces:**
- Consumes: `pendingDepartures`, `departureKey`, `DISCONNECT_GRACE_MS`, `handleLeaveRoom`, all already in this file.
- Produces: `holdRestoredSeat(io: Server, roomId: string, rooms: Map<string, Room>, userId: string, displayName: string, getUserSocket: (id: string) => string | undefined): void`. `handleLeaveRoom`'s second parameter becomes `Socket | null`.

- [ ] **Step 1: Let handleLeaveRoom work without a socket**

Change the signature:

```ts
export async function handleLeaveRoom(
  io: Server,
  socket: Socket | null,
  roomId: string,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
```

and the single line that uses it:

```ts
  // Null when the departure comes from a restored room rather than a live
  // socket: after a restart there is no socket to take out of the channel.
  socket?.leave(roomId);
```

Nothing else in the body touches `socket`; every broadcast already goes through `io`.

- [ ] **Step 2: Add holdRestoredSeat**

Immediately after `cancelScheduledLeave`:

```ts
/**
 * Holds a restored player's seat for the usual grace period.
 *
 * Called once per player when rooms are read back after a restart, where
 * everyone is disconnected by definition. It deliberately reuses the same
 * timer map as `scheduleLeaveRoom`, so `cancelScheduledLeave` releases it
 * through the ordinary path when the player's socket comes back - a returning
 * player needs no special case.
 */
export function holdRestoredSeat(
  io: Server,
  roomId: string,
  rooms: Map<string, Room>,
  userId: string,
  displayName: string,
  getUserSocket: (id: string) => string | undefined
) {
  const key = departureKey(roomId, userId);
  clearTimeout(pendingDepartures.get(key));

  pendingDepartures.set(
    key,
    setTimeout(() => {
      pendingDepartures.delete(key);
      logger.info({ roomId, userId }, 'Restored player did not come back, removing');
      void handleLeaveRoom(io, null, roomId, rooms, { id: userId, displayName } as User, getUserSocket);
    }, DISCONNECT_GRACE_MS)
  );

  logger.debug({ roomId, userId }, 'Holding a restored seat');
}
```

`handleLeaveRoom` reads only `user.id` and `user.displayName`, which is why the cast is safe here; `core/test/relay.test.ts` builds its users the same way.

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd backend && npx tsc --noEmit
cd .. && npm run test:all 2>&1 | grep -E "ℹ (pass|fail)"
```

Expected: no type errors, no regressions. `tsc` is what proves every existing `handleLeaveRoom` call still type-checks against the widened parameter.

- [ ] **Step 4: Commit**

```bash
git add backend/src/websocket/room-handlers.ts
git commit -m "Hold a restored player's seat for the usual grace period"
```

---

### Task 7: Restore at boot, snapshot while running, flush on the way out

**Files:**
- Modify: `backend/src/index.ts` (imports; before `httpServer.listen` at line 182; a new shutdown handler at the end)

**Interfaces:**
- Consumes: `restoreRooms`, `startRoomSnapshots`, `flushRooms` from Task 5; `holdRestoredSeat` from Task 6; `getRooms`, `getUserSocket` already exported from `backend/src/websocket/index.ts`.
- Produces: nothing.

- [ ] **Step 1: Wire the restore**

Add the imports:

```ts
import { initializeWebSocket, getRooms, getUserSocket } from './websocket/index.js';
import { flushRooms, restoreRooms, startRoomSnapshots } from './websocket/room-snapshot.js';
import { holdRestoredSeat } from './websocket/room-handlers.js';
```

(the first line replaces the existing `import { initializeWebSocket } from './websocket/index.js';`)

Then, immediately after `initializeWebSocket(io);` and before `const PORT = ...`:

```ts
const rooms = getRooms();

// Before the port opens, so the first client to reconnect finds its room
// already there rather than racing the restore.
await restoreRooms(rooms, (roomId, userId) => {
  const player = rooms.get(roomId)?.players.find(p => p.userId === userId);
  holdRestoredSeat(io, roomId, rooms, userId, player?.displayName ?? userId, getUserSocket);
});
startRoomSnapshots(rooms);
```

- [ ] **Step 2: Flush on the way out**

At the end of the file, after the `httpServer.listen(...)` block:

```ts
/**
 * A deployment is a graceful shutdown: Docker sends SIGTERM and waits ten
 * seconds. Flushing here is what makes the room snapshot exact for the case
 * that motivated it - the periodic write only covers a hard crash.
 */
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down; saving rooms');

  try {
    await flushRooms(rooms);
  } catch (err) {
    logger.error({ err }, 'Could not save rooms on the way out');
  }

  httpServer.close();
  try {
    await redisClient.quit();
  } catch {
    // Already gone; nothing to salvage and nothing to report.
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 3: Verify by hand — this is the integration check**

There is no automated test for this; restarting the backend from Playwright is not something this suite can do. Run it manually:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd backend && npx tsc --noEmit && cd ..
docker compose up --build -d
sleep 20
```

Then, in a browser: log in, create a room, and confirm it appears. Now restart only the backend and watch the room survive:

```bash
docker compose restart backend
sleep 15
docker compose logs backend | grep -i "Restored rooms"
```

Expected: a log line reporting one restored room, and the room still present in the lobby in the browser without reloading anything. Check the snapshot directly too:

```bash
docker compose exec redis redis-cli --raw GET psnes:rooms:v1 | head -c 400
docker compose exec redis redis-cli TTL psnes:rooms:v1
```

Expected: a JSON blob starting `{"version":1,"rooms":[` and a TTL at or just under 3600.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "Restore rooms at boot and save them on the way out"
```

---

### Task 8: The relay answers instead of going quiet

`znet:join` on a room the server does not have returns `null` silently, so the client waits forever with a healthy socket. This is the safety net for when persistence cannot help: a crash before the first snapshot, or an expired TTL.

**Files:**
- Modify: `backend/src/websocket/znet-handlers.ts` (the `znet:join` handler, lines 58-60)
- Test: `core/test/relay.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `znet:error` payloads now carry `code`: `'room-gone'` for an absent room, `'session-full'` for the existing full case.

- [ ] **Step 1: Write the failing test**

Append to `core/test/relay.test.ts`, following the file's existing `startRig` helper (tabs):

```ts
test('joining a room the server no longer has answers with an error', async () => {
	const rig = await startRig();
	try {
		// What a restart looks like from the relay's point of view: the room is
		// simply not there any more.
		rig.rooms.delete(ROOM_ID);

		const client = ioClient(rig.url, {
			transports: ['websocket'],
			auth: { userId: HOST_ID }
		});
		await once(client, 'connect');

		const failed = once(client, 'znet:error');
		client.emit('znet:join', { roomId: ROOM_ID });
		const [payload] = (await failed) as [{ code?: string }];

		assert.equal(payload.code, 'room-gone');
		client.close();
	} finally {
		await rig.close();
	}
});

test('a non-member still gets silence, not confirmation that a room exists', async () => {
	// Room ids are handed out by GET /api/rooms and by friend notifications,
	// so an error here would turn the new message into a way to probe for
	// them. The room exists; the caller is simply not in it.
	const rig = await startRig();
	try {
		const client = ioClient(rig.url, {
			transports: ['websocket'],
			auth: { userId: 'stranger' }
		});
		await once(client, 'connect');

		let heard: unknown = null;
		client.on('znet:error', (p: unknown) => (heard = p));
		client.on('znet:joined', (p: unknown) => (heard = p));
		client.emit('znet:join', { roomId: ROOM_ID });

		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(heard, null, 'a non-member must learn nothing at all');
		client.close();
	} finally {
		await rig.close();
	}
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
node --import tsx --test core/test/relay.test.ts 2>&1 | tail -12
```

Expected: the first new test times out waiting for `znet:error`; the second already passes and must keep passing.

- [ ] **Step 3: Answer only when the room is absent**

In `znet-handlers.ts`, replace:

```ts
	socket.on('znet:join', (data: { roomId: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'znet:join');
		if (!room) return;
```

with:

```ts
	socket.on('znet:join', (data: { roomId: string }) => {
		const room = getMemberRoom(rooms, data?.roomId, user.id, 'znet:join');
		if (!room) {
			/*
			 * Say so when the room is genuinely gone - a restart, or a room
			 * destroyed while the player was away. Staying silent here is what
			 * made a lost session look like a freeze: the socket is healthy,
			 * the client re-joins on every reconnect, and every packet it
			 * sends afterwards is dropped for not being in the channel.
			 *
			 * Only when it is *absent*. A room that exists and simply does not
			 * have this caller in it must keep learning nothing, or the reply
			 * becomes a way to confirm a room id - which is the whole reason
			 * getMemberRoom exists.
			 */
			if (data?.roomId && !rooms.has(data.roomId)) {
				socket.emit('znet:error', {
					roomId: data.roomId,
					code: 'room-gone',
					message: 'This game is no longer on the server. It may have ended while you were away.'
				});
			}
			return;
		}
```

And give the existing full-session error its code, so the client can tell them apart:

```ts
				socket.emit('znet:error', {
					roomId: room.id,
					code: 'session-full',
					message: 'This netplay session is full'
				});
```

- [ ] **Step 4: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
node --import tsx --test core/test/relay.test.ts 2>&1 | tail -12
npm run test:all 2>&1 | grep -E "ℹ (pass|fail)"
```

Expected: both new tests pass, nothing else regresses.

- [ ] **Step 5: Commit**

```bash
git add backend/src/websocket/znet-handlers.ts core/test/relay.test.ts
git commit -m "Answer a netplay join for a room that is gone"
```

---

### Task 9: The lockstep room reacts to a relay error

`znet:error` has no listener anywhere in the frontend today, so even the existing "this netplay session is full" case is a silent freeze.

**Files:**
- Modify: `frontend/src/lib/components/LockstepRoom.svelte` (`onMount`, `teardown`, and the error overlay markup)

**Interfaces:**
- Consumes: `znet:error` with `{ roomId, code, message }` from Task 8.
- Produces: nothing.

- [ ] **Step 1: Listen for it**

Add the handler next to the other socket handlers:

```ts
  /**
   * A refusal from the relay, which is terminal by nature: the seat or the
   * room is gone, and no amount of waiting brings it back. Distinct from a
   * quiet link, which does come back on its own.
   */
  function onRelayError(payload: { roomId?: string; code?: string; message?: string }) {
    if (payload?.roomId && payload.roomId !== roomId) return;
    linkLost = false;
    errorText = payload?.message ?? 'The netplay session ended';
    phase = 'error';
    logger.error('The relay refused the session', payload);
  }
```

Register it in `onMount`, alongside the `rom:request` registration, so it is listening before boot begins:

```ts
    $socket?.on('znet:error', onRelayError);
```

And remove it in `teardown()`, beside the other `off` calls:

```ts
    $socket?.off('znet:error', onRelayError);
```

- [ ] **Step 2: Offer a way out of the error screen**

The error overlay is currently a dead end. In the `{#if phase === 'error'}` branch inside `.screen`, add a button after the message:

```svelte
        {#if phase === 'error'}
          <p class="error">{errorText}</p>
          <button class="action" on:click={() => goto('/')}>Back to the lobby</button>
        {:else}
```

Add the import at the top of the script:

```ts
  import { goto } from '$app/navigation';
```

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3 && npx vite build 2>&1 | tail -3
```

Expected: 0 errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/LockstepRoom.svelte
git commit -m "Say why a netplay session was refused, and offer a way out"
```

---

### Task 10: Re-enter a game in progress after a reload

`gameStarted` is only set by the `game:started` event, so reloading the tab mid-match shows the room's lobby view even when the room says `playing`. With rooms persisted, honouring that status makes a reload — or a closed tab, or a browser crash — a working recovery path, reusing the mid-session rejoin at `session.ts:807` where the host reseeds the returning peer from its authoritative state.

**Files:**
- Modify: `frontend/src/routes/room/[id]/+page.svelte` (`handleRoomUpdated` and `handleGameStarted` from Task 3)

**Interfaces:**
- Consumes: the named handlers introduced in Task 3.
- Produces: nothing.

- [ ] **Step 1: Factor out entering the game**

Replace `handleGameStarted` with a version that takes the mode explicitly, plus a shared entry point:

```ts
  function enterGame(mode: EmulationMode) {
    activeEmulationMode = mode;
    gameStarted = true;

    // Prevent scrolling when game is active
    if (browser) {
      document.body.style.overflow = 'hidden';
    }
  }

  function handleGameStarted() {
    enterGame(effectiveEmulationMode ?? EmulationMode.SINGLE);
  }
```

- [ ] **Step 2: Rejoin a match that is already running**

Extend `handleRoomUpdated`:

```ts
  function handleRoomUpdated(updatedRoom: Room) {
    if (updatedRoom.id !== roomId) return;
    room = updatedRoom;

    /*
     * A match already in progress: this is a reload, a recovered crash, or a
     * reconnect after the server restarted. Lockstep only, and only with both
     * seats still filled - the netplay session resumes by rejoining a peer
     * that is still there, and there is nothing to rejoin otherwise.
     *
     * The mode is read from the room rather than from
     * `effectiveEmulationMode`, for two reasons. It is a `$:` value and so is
     * still stale in this tick, and it collapses to SINGLE whenever the room
     * momentarily holds one player - which is exactly what happens while the
     * other player is reconnecting, and would drop us into a single-player
     * emulator instead of the match.
     */
    if (
      !gameStarted &&
      updatedRoom.status === 'playing' &&
      updatedRoom.emulationMode === EmulationMode.LOCKSTEP &&
      updatedRoom.players.length >= 2 &&
      updatedRoom.players.some(p => p.userId === $user?.id)
    ) {
      logger.info('Rejoining a match already in progress');
      enterGame(EmulationMode.LOCKSTEP);
    }
  }
```

- [ ] **Step 3: Verify**

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3 && npx vite build 2>&1 | tail -3
```

Expected: 0 errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "frontend/src/routes/room/[id]/+page.svelte"
git commit -m "Walk back into a lockstep match after a reload"
```

---

## Final verification

Automated, from the repo root:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run test:all 2>&1 | grep -E "ℹ (pass|fail)"
cd backend && npx tsc --noEmit && cd ..
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3 && npx vite build 2>&1 | tail -3
```

Expected: every group passes with 0 failures, no type errors, `svelte-check` still at 0 errors and 19 warnings.

Manual, and the only thing that proves the feature — two browser windows, two accounts, a lockstep match in progress:

1. `docker compose up --build -d`, start a lockstep game between two windows, confirm both are playing.
2. `docker compose restart backend`.
3. Both windows should show the reconnection banner, then the "connection lost" badge over the frozen picture, and then **resume by themselves** — no reload, no clicks. The picture continues from the frame both machines stopped on.
4. Check `docker compose logs backend | grep -i "Restored rooms"` reports the room came back.
5. With the game running, reload one window. It should walk straight back into the match rather than showing the room's lobby view, and the host should reseed it.
6. Now the negative path: stop the stack, run `docker compose exec redis redis-cli DEL psnes:rooms:v1` after a restart with a game in progress, and confirm the client shows "This game is no longer on the server" with a working way back to the lobby, instead of hanging.

## Deliberate coverage gaps

State these rather than papering over them:

- **No component tests.** The repo has no Svelte component test harness, and this plan does not add one. Tasks 2, 3, 9 and 10 are covered by `svelte-check`, the build, and the manual run above.
- **No automated restart test.** Playwright cannot restart the backend here reliably. Tasks 5, 6 and 8 cover the logic in isolation; the restart itself is step 2 of the manual list.
- **The 45 s grace timer is not exercised in tests.** `holdRestoredSeat` reuses an existing, already-working timer path, and asserting it would mean mocking timers around Prisma-backed broadcasts. What is tested is that `restoreRooms` calls `holdSeat` once per restored player, which is the part this plan introduces.
