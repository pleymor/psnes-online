# VR Multiplayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player in a group start a two-player lockstep game from inside the VR room, choosing the save and the controller port on the curved screen, while their friend uses the ordinary flat room page.

**Architecture:** The curved screen gains a second mode — a canvas panel while no game runs, the emulator's `DataTexture` while one does. Every decision lives in a pure module under `lib/` (`vr/launch-options.ts`, `vr/panels/launch.ts`), and the netplay boot sequence is extracted from `LockstepRoom.svelte` into a headless `rooms/lockstep-engine.ts`, the netplay twin of `rooms/solo-engine.ts`. `VrShell.svelte` wires them. The server is not modified.

**Tech Stack:** Svelte 4, three.js 0.185.1, TypeScript, Bun, `bun:test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-04-vr-multijoueur-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Lockstep only.** Not `streaming`, not `dual`. `P2PRoom` has no `game:loaded` listener at all, so a staged save has no meaning there.
- **Saves are found by CRC32, never by `gameId`.** Each player has their own `Game` row for one dump; a room whose game the friend chose carries *their* id.
- **Save summaries come from the `games` store.** Never `/api/games/:id/saves` — it returns the savestates themselves, about a megabyte each.
- **A chosen save applies exactly once, after boot, never reactively.** A reactive value is pushed back down on the next `room:updated` and rewinds the game.
- **Only the host loads the cartridge SRAM.** The host's state is what both peers adopt; loading SRAM on the guest would change one machine and not the other.
- **`room:choose-save` is creator-only** (`backend/src/websocket/room-handlers.ts:383`). When the player did not open the room, the save list is drawn and inert, with a line saying why.
- **A game absent from this device is refused with a notice**, never transferred over the relay. The notice tells the player to launch it once outside VR.
- **Every failure names itself on the launch screen.** Nothing fails silently: a black headset with nothing in the logs cost a whole session on 2026-09-03.
- **The server is not modified.** No new events, no relaxed rules.
- **Decision logic lives in a `lib/` module, not in a component.** `VrShell.svelte` and `TopBar.svelte` have no component-test harness in this project, and three bugs came out of them.
- **New test files must be added to `test:ui` in `package.json`**, whose list is explicit rather than a glob, and both counts must be checked to move — the test count and the file count.
- **Every new assertion must be proven able to fail** by mutating the code it guards.
- Run from the repo root: `bun run test:ui`. Run `bun run check` and `bun run build` from `frontend/`.

---

## File Structure

**Created:**

- `frontend/src/lib/vr/launch-options.ts` — the pure model of the launch screen: which game, which saves, whether the save may be chosen, my port, my friend's state, whether the ROM is here, whether the game may start. Imports nothing from `three` and nothing from Svelte.
- `frontend/src/lib/vr/panels/launch.ts` — the region layout and the canvas painter for that model, mirroring `panels/library.ts` and `panels/profile.ts`.
- `frontend/src/lib/rooms/lockstep-engine.ts` — the headless netplay boot, the twin of `rooms/solo-engine.ts`.
- `core/test/vr-launch-options.test.ts`
- `core/test/vr-panel-launch.test.ts`
- `core/test/lockstep-engine.test.ts`

**Modified:**

- `frontend/src/lib/vr/screen.ts` — a canvas mode beside the `DataTexture` mode.
- `frontend/src/lib/vr/scene.ts` — the screen joins the raycast set; the pointer gate becomes "no target while a game runs".
- `frontend/src/lib/rooms/my-room.ts` — `RoomView` gains `gameCrc32` and `resumeSaveId`, which the server already sends.
- `frontend/src/lib/components/VrShell.svelte` — the launch screen replaces the immediate launch, for solo and for a group.
- `frontend/src/lib/i18n/translations.ts` — the launch screen's wording, both locales.
- `package.json` — the three new test files join `test:ui`.

**Deliberately untouched:** every file under `backend/`, `LockstepRoom.svelte` (the extraction copies its sequence rather than rewriting the component), and `SoloRoom.svelte`.

---

### Task 1: The launch screen's model

**Files:**
- Create: `frontend/src/lib/vr/launch-options.ts`
- Create: `core/test/vr-launch-options.test.ts`
- Modify: `package.json` (add the test file to `test:ui`)

**Interfaces:**
- Consumes: nothing. This module imports nothing at all — no `three`, no Svelte, no stores.
- Produces: `launchOptions(input) => LaunchOptions | null`, plus the types
  `LaunchRoom`, `LibraryGame`, `LaunchSave`, `FriendState`, `LaunchOptions`,
  `LaunchBlock`. Task 2 paints a `LaunchOptions`; Task 6 and Task 7 build the input.

- [ ] **Step 1: Write the failing test**

Create `core/test/vr-launch-options.test.ts`:

```ts
/**
 * What the launch screen shows, decided away from the screen.
 *
 * Three rules here are load-bearing rather than cosmetic, and each is a trap
 * documented in the code this replaces.
 *
 * A dump is found by CRC32, never by game id. Each player has their own `Game`
 * row for one dump, so a room whose game the friend chose carries THEIR id, and
 * looking that up in my library finds nothing.
 *
 * The save may only be chosen by whoever opened the room. The server refuses
 * otherwise (`room-handlers.ts:383`), and the refusal arrives as an `error`
 * that nothing in a headset displays - so the screen has to know before it asks.
 *
 * And nothing may claim the launch is possible when it is not. A ROM this
 * device cannot read must be named as such, because the alternative - measured
 * on 2026-09-03 - is a black screen with nothing in the logs.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  launchOptions,
  type LaunchRoom,
  type LibraryGame
} from '../../frontend/src/lib/vr/launch-options.js';

const SAVE = { id: 's1', name: 'Before the boss', slotNumber: 1 };

function library(over: Partial<LibraryGame> = {}): LibraryGame[] {
  return [
    { id: 'mine', title: 'Super Mario World', crc32: 'aaaa1111', saves: [SAVE], ...over }
  ];
}

function room(over: Partial<LaunchRoom> = {}): LaunchRoom {
  return {
    id: 'r1',
    createdBy: 'me',
    status: 'waiting',
    gameCrc32: 'aaaa1111',
    players: [
      { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
      { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: true }
    ],
    ...over
  };
}

const OPENABLE = new Set(['aaaa1111']);

test('the dump is found by CRC32, not by game id', () => {
  // The room carries the friend's game id for the same cartridge. Looking that
  // up here would find nothing and the screen would have no game to draw.
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({ gameCrc32: 'aaaa1111' }),
    me: 'me',
    openable: OPENABLE
  });

  assert.ok(options, 'the dump is in the library and must be found');
  assert.equal(options.game.title, 'Super Mario World');
});

test('a dump that is in no library entry has nothing to show', () => {
  const options = launchOptions({
    library: library(),
    crc32: 'ffff9999',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options, null);
});

test('the saves come from the library entry, never from a request', () => {
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.deepEqual(options!.saves, [SAVE]);
});

test('the save may be chosen in solo, because the room does not exist yet', () => {
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.mayChooseSave, true);
});

test('the save may not be chosen when somebody else opened the room', () => {
  // Not a preference: the server refuses, and the refusal is invisible in a
  // headset. Where the game starts is not a private choice.
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({ createdBy: 'you' }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.mayChooseSave, false);
});

test('the chosen save comes from the room in a group, and from the staged value in solo', () => {
  const inGroup = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({ resumeSaveId: 's1' }),
    me: 'me',
    openable: OPENABLE,
    stagedSaveId: 'ignored'
  });
  assert.equal(inGroup!.chosenSaveId, 's1', 'the room is the truth once it exists');

  const alone = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE,
    stagedSaveId: 's1'
  });
  assert.equal(alone!.chosenSaveId, 's1', 'nothing else holds it before the room exists');
});

test('there is no friend when there is no group', () => {
  const alone = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(alone!.friend, null);

  const oneSeat = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({ players: [{ userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true }] }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(oneSeat!.friend, null, 'a room with only me in it is not a group');
});

test('the friend is named with the state that decides whether the game can start', () => {
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: false }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });

  assert.deepEqual(options!.friend, { pseudo: 'Bob', online: false, port: null, isReady: false });
});

test('my port is read from my own row, and is null before I sit', () => {
  const seated = launchOptions({
    library: library(), crc32: 'aaaa1111', room: room(), me: 'me', openable: OPENABLE
  });
  assert.equal(seated!.myPort, 1);

  const standing = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: null, isReady: false, online: true },
        { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: true }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(standing!.myPort, null);
});

test('a ROM this device cannot read blocks the launch and says so', () => {
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room(),
    me: 'me',
    openable: new Set<string>()
  });

  assert.equal(options!.romHere, false);
  assert.equal(options!.blocked, 'rom-missing', 'silence here is a black screen in the headset');
});

test('a room already playing blocks the launch', () => {
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({ status: 'playing' }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, 'already-playing');
});

test('a group with nobody seated blocks the launch, mirroring the server', () => {
  // `game:start` refuses when no player has a port and is ready. Offering the
  // button anyway would earn an error nothing in here displays.
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: null, isReady: false, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: true }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, 'no-seat');
});

test('solo needs no seat', () => {
  // There is no port to pick alone, so the server's seating rule cannot apply.
  const options = launchOptions({
    library: library(), crc32: 'aaaa1111', room: null, me: 'me', openable: OPENABLE
  });
  assert.equal(options!.blocked, null);
});

test('a missing ROM outranks a missing seat', () => {
  // The player can do something about a seat from in here. They cannot do
  // anything about a ROM that is not on the device, so that is what to say.
  const options = launchOptions({
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: null, isReady: false, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: true }
      ]
    }),
    me: 'me',
    openable: new Set<string>()
  });
  assert.equal(options!.blocked, 'rom-missing');
});
```

- [ ] **Step 2: Add the file to `test:ui` and run it to see it fail**

In `package.json`, append ` core/test/vr-launch-options.test.ts` inside the
`test:ui` string, after `core/test/vr-prepare.test.ts`. The list is explicit
rather than a glob: a file left out of it runs nowhere while the suite still
reports all-green.

Run: `bun run test:ui`
Expected: FAIL, `Cannot find module '.../vr/launch-options.js'`. The file count
must have moved by one — if it did not, the path in `test:ui` is wrong.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/vr/launch-options.ts`:

```ts
/**
 * What the launch screen shows, decided away from the screen.
 *
 * The same shape as `rooms/game-click.ts`: a pure function over the little a
 * decision needs to know, gathered here rather than spread through a painter
 * where a reader would see two branches out of five. It imports nothing - no
 * `three`, no Svelte, no store - so every rule below is testable under Bun.
 *
 * Three of those rules exist because the alternative was measured and cost a
 * session:
 *
 *   - A dump is found by CRC32. Each player has their own `Game` row for one
 *     cartridge, so a room whose game the friend chose carries THEIR id.
 *   - The save may only be chosen by whoever opened the room. The server
 *     refuses otherwise, with an `error` that nothing in a headset draws.
 *   - A launch that cannot succeed says which of its reasons stopped it,
 *     because a headset has no console and its logs are unreadable from
 *     inside.
 */

/** One save, as the library store already holds it. */
export interface LaunchSave {
	id: string;
	name: string;
	slotNumber: number;
}

/** The little this needs from `stores/games`' `Game`. */
export interface LibraryGame {
	id: string;
	title: string;
	coverUrl?: string;
	crc32?: string | null;
	saves: readonly LaunchSave[];
}

/** The little this needs from a room. */
export interface LaunchRoom {
	id: string;
	/** Who may stage a save. Not the host: the host can change hands. */
	createdBy: string;
	status: 'waiting' | 'playing';
	gameCrc32?: string;
	/** The save the room will start on, staged through `room:choose-save`. */
	resumeSaveId?: string;
	players: {
		userId: string;
		pseudo: string;
		port: 1 | 2 | null;
		isReady: boolean;
		online: boolean;
	}[];
}

export interface FriendState {
	pseudo: string;
	online: boolean;
	port: 1 | 2 | null;
	isReady: boolean;
}

/** Why a launch is refused. Ordered by what the player can do about it. */
export type LaunchBlock = 'rom-missing' | 'already-playing' | 'no-seat';

export interface LaunchOptions {
	game: { title: string; coverUrl?: string; crc32: string };
	/** Empty when nothing has ever been saved for this dump. */
	saves: readonly LaunchSave[];
	/** The save this launch will start on, or null for a fresh game. */
	chosenSaveId: string | null;
	/** False when somebody else opened the room: `room:choose-save` refuses. */
	mayChooseSave: boolean;
	/** null before I have taken a seat, and always in solo. */
	myPort: 1 | 2 | null;
	/** null when there is no group - a room holding only me is not one. */
	friend: FriendState | null;
	/** Whether this device can read the ROM at all. */
	romHere: boolean;
	blocked: LaunchBlock | null;
}

export interface LaunchInput {
	/** The library, as `stores/games` holds it. */
	library: readonly LibraryGame[];
	/** The dump to launch: the one just clicked, or the one the room carries. */
	crc32: string;
	/** null in solo - there is no room until the launch creates one. */
	room: LaunchRoom | null;
	/** My own user id. */
	me: string;
	/** What this device can open, from `resolvableHere`. */
	openable: ReadonlySet<string>;
	/**
	 * A save staged locally, before any room exists to hold it.
	 *
	 * Solo only. Once a room exists its `resumeSaveId` is the truth, because
	 * that is the value both players see and the one the engine resolves.
	 */
	stagedSaveId?: string | null;
}

/** null when the dump is in no library entry: there is nothing to draw. */
export function launchOptions(input: LaunchInput): LaunchOptions | null {
	const entry = input.library.find((game) => game.crc32 === input.crc32);
	if (!entry) return null;

	const room = input.room;
	const mine = room?.players.find((player) => player.userId === input.me) ?? null;
	// A room holding only me is not a group, the same rule `game-click.ts` uses.
	const other = room && room.players.length >= 2
		? room.players.find((player) => player.userId !== input.me) ?? null
		: null;

	const romHere = input.openable.has(input.crc32);

	return {
		game: { title: entry.title, coverUrl: entry.coverUrl, crc32: input.crc32 },
		saves: entry.saves,
		chosenSaveId: room ? room.resumeSaveId ?? null : input.stagedSaveId ?? null,
		// In solo the room does not exist yet, so it will be created by me.
		mayChooseSave: !room || room.createdBy === input.me,
		myPort: mine?.port ?? null,
		friend: other
			? { pseudo: other.pseudo, online: other.online, port: other.port, isReady: other.isReady }
			: null,
		romHere,
		blocked: blockedBy(room, romHere)
	};
}

/**
 * Ordered by what the player can do about it, not by severity.
 *
 * A missing ROM comes first because it is the only one they cannot fix from
 * inside the headset - a seat is two buttons away, and a playing room has the
 * game itself to go back to.
 */
function blockedBy(room: LaunchRoom | null, romHere: boolean): LaunchBlock | null {
	if (!romHere) return 'rom-missing';
	if (!room) return null;
	if (room.status === 'playing') return 'already-playing';

	// Mirrors `game:start`'s own guard: it refuses when no player has both a
	// port and readiness. Offering the button anyway earns an `error` that
	// nothing in an immersive session displays.
	if (room.players.length >= 2 && !room.players.some((p) => p.port !== null && p.isReady)) {
		return 'no-seat';
	}
	return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun run test:ui`
Expected: PASS, with the test count up by 14 and the file count up by 1.

- [ ] **Step 5: Prove each rule can fail**

Mutate the implementation one change at a time and confirm the suite fails each
time, then restore it. A test that cannot fail guards nothing, and this branch
series already produced one of those.

- `game.crc32 === input.crc32` → `game.id === input.crc32`
- `room.createdBy === input.me` → `true`
- `room.players.length >= 2` (in `other`) → `room.players.length >= 1`
- `if (!romHere) return 'rom-missing';` → deleted
- the `no-seat` branch → deleted

- [ ] **Step 6: Typecheck and commit**

Run from `frontend/`: `bun run check`
Expected: 0 errors, and the same 15 warnings across 9 files as the baseline.

```bash
git add frontend/src/lib/vr/launch-options.ts core/test/vr-launch-options.test.ts package.json
git commit -m "Decide what the VR launch screen shows, away from the screen"
```

---

### Task 2: The launch panel's layout and painter

**Files:**
- Create: `frontend/src/lib/vr/panels/launch.ts`
- Create: `core/test/vr-panel-launch.test.ts`
- Modify: `package.json`, `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `LaunchOptions`, `LaunchSave` from Task 1's `vr/launch-options.ts`; `PanelSize` and `Region` from `vr/panel.ts`.
- Produces: `LAUNCH_PANEL_SIZE: PanelSize`, `layoutLaunchPanel(options, labels) => Region[]`, `drawLaunchPanel(ctx, options, regions, { labels, hoverId })`, `interface LaunchLabels`. Task 3 hands the canvas; Task 6 supplies the labels.

**Region ids, which Task 6 dispatches on:** `save:none`, `save:<saveId>`, `port:1`, `port:2`, `launch`.

- [ ] **Step 1: Write the failing test**

Create `core/test/vr-panel-launch.test.ts`:

```ts
/**
 * The launch screen, drawn on the curved screen because no game is running yet.
 *
 * Three rules are load-bearing.
 *
 * A save list the player may not act on is DRAWN and carries no regions. That
 * is the whole of decision D3: the server refuses a save staged by anyone but
 * the room's creator, so offering the click would earn an `error` that nothing
 * in a headset displays - while hiding the list would leave a guest unable to
 * see what they are about to join, which is the thing the rule exists to
 * prevent.
 *
 * A blocked launch carries no `launch` region. The button cannot be present
 * and dead: a press that does nothing is indistinguishable from a headset that
 * has stopped responding.
 *
 * And the chosen save is marked by something other than a colour. Two states
 * whose only difference is a fill produce an identical list of `fillText`
 * calls, and a test for "the choice is visible" would have nothing to compare -
 * the trap the profile band's preset cards already fell into.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  LAUNCH_PANEL_SIZE,
  layoutLaunchPanel,
  drawLaunchPanel,
  type LaunchLabels
} from '../../frontend/src/lib/vr/panels/launch.js';
import type { LaunchOptions } from '../../frontend/src/lib/vr/launch-options.js';

const LABELS: LaunchLabels = {
  newGame: 'New game',
  saveLockedByCreator: 'Your friend opened this room, so they choose where it starts.',
  launch: 'Launch',
  port1: 'Player 1',
  port2: 'Player 2',
  waitingForFriend: 'Waiting for your friend',
  friendReady: 'Ready',
  romMissing: 'This game is not on this device. Launch it once outside VR.',
  alreadyPlaying: 'This room is already playing.',
  noSeat: 'Somebody has to take a controller first.'
};

const SAVES = [
  { id: 's1', name: 'Before the boss', slotNumber: 1 },
  { id: 's2', name: 'Chapter two', slotNumber: 2 }
];

function options(over: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    game: { title: 'Super Mario World', crc32: 'aaaa1111' },
    saves: SAVES,
    chosenSaveId: null,
    mayChooseSave: true,
    myPort: null,
    friend: null,
    romHere: true,
    blocked: null,
    ...over
  };
}

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  const placed: Array<{ text: string; x: number }> = [];
  return {
    texts,
    calls,
    placed,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    drawImage() { calls.push('drawImage'); },
    fillText(text: string, x: number) { texts.push(text); placed.push({ text, x }); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    placed: Array<{ text: string; x: number }>;
  };
}

function draw(o: LaunchOptions, hoverId: string | null = null) {
  const ctx = recordingContext();
  drawLaunchPanel(ctx, o, layoutLaunchPanel(o, LABELS), { labels: LABELS, hoverId });
  return ctx;
}

test('every save is offered, and so is starting fresh', () => {
  const ids = layoutLaunchPanel(options(), LABELS).map((r) => r.id);
  assert.ok(ids.includes('save:none'), 'starting over must always be reachable');
  assert.ok(ids.includes('save:s1'));
  assert.ok(ids.includes('save:s2'));
});

test('a save list the player may not act on is drawn, and carries no regions', () => {
  const locked = options({ mayChooseSave: false, chosenSaveId: 's1' });
  const ids = layoutLaunchPanel(locked, LABELS).map((r) => r.id);

  assert.ok(!ids.some((id) => id.startsWith('save:')), 'the server would refuse these clicks');

  const drawn = draw(locked).texts.join('\n');
  assert.ok(drawn.includes('Before the boss'), 'a guest has to see what they are joining');
  assert.ok(drawn.includes(LABELS.saveLockedByCreator), 'and why they cannot change it');
});

test('the ports are offered only when there is a group', () => {
  const alone = layoutLaunchPanel(options(), LABELS).map((r) => r.id);
  assert.ok(!alone.includes('port:1'), 'there is no port to pick alone');

  const grouped = layoutLaunchPanel(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } }),
    LABELS
  ).map((r) => r.id);
  assert.ok(grouped.includes('port:1'));
  assert.ok(grouped.includes('port:2'));
});

test('a blocked launch has no launch region, and says which block it is', () => {
  for (const [blocked, label] of [
    ['rom-missing', LABELS.romMissing],
    ['already-playing', LABELS.alreadyPlaying],
    ['no-seat', LABELS.noSeat]
  ] as const) {
    const o = options({ blocked, romHere: blocked !== 'rom-missing' });
    const ids = layoutLaunchPanel(o, LABELS).map((r) => r.id);
    assert.ok(!ids.includes('launch'), `a dead ${blocked} button reads as a frozen headset`);
    assert.ok(draw(o).texts.includes(label), `${blocked} was not explained`);
  }
});

test('an unblocked launch has its region', () => {
  assert.ok(layoutLaunchPanel(options(), LABELS).map((r) => r.id).includes('launch'));
});

test('the chosen save is marked by more than a colour', () => {
  // Two states differing only by a fill draw the identical set of fillText
  // calls, and "the choice is visible" would have nothing to compare.
  const none = draw(options({ chosenSaveId: null })).texts;
  const one = draw(options({ chosenSaveId: 's1' })).texts;
  assert.notDeepEqual(none, one, 'nothing on the canvas says which save is chosen');
});

test('the friend is named with their state', () => {
  const drawn = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(drawn.includes('Bob'));
});

test('every region stays on the panel and none overlap', () => {
  const o = options({
    friend: { pseudo: 'Bob', online: true, port: null, isReady: false },
    blocked: null
  });
  const regions = layoutLaunchPanel(o, LABELS);
  for (const r of regions) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off-panel`);
    assert.ok(r.x + r.w <= LAUNCH_PANEL_SIZE.width, `${r.id} runs off the right`);
    assert.ok(r.y + r.h <= LAUNCH_PANEL_SIZE.height, `${r.id} runs off the bottom`);
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('a long save name is truncated rather than run into the ports', () => {
  const o = options({
    saves: [{ id: 's1', name: 'A'.repeat(200), slotNumber: 1 }],
    friend: { pseudo: 'Bob', online: true, port: 2, isReady: true }
  });
  const region = layoutLaunchPanel(o, LABELS).find((r) => r.id === 'save:s1');
  const drawn = draw(o).placed.find((p) => p.text.startsWith('A'));

  assert.ok(region && drawn, 'the save was not drawn');
  // The fixture's own metric, the same one the profile band's test uses.
  assert.ok(
    drawn.x + drawn.text.length * 9 <= region.x + region.w,
    'a long name escaped its row'
  );
});
```

- [ ] **Step 2: Add the file to `test:ui` and run it**

Append ` core/test/vr-panel-launch.test.ts` to the `test:ui` list.

Run: `bun run test:ui`
Expected: FAIL on the missing module, with the file count up by one.

- [ ] **Step 3: Add the wording, both locales**

In `frontend/src/lib/i18n/translations.ts`, beside the other `vr*` keys, in the
English locale:

```ts
    vrNewGame: 'New game',
    vrSaveLockedByCreator: 'Your friend opened this room, so they choose where it starts.',
    vrLaunch: 'Launch',
    vrPort1: 'Player 1',
    vrPort2: 'Player 2',
    vrWaitingForFriend: 'Waiting for your friend',
    vrFriendReady: 'Ready',
    vrRomMissing: 'This game is not on this device. Launch it once outside VR.',
    vrAlreadyPlaying: 'This room is already playing.',
    vrNoSeat: 'Somebody has to take a controller first.',
```

and in the French one:

```ts
    vrNewGame: 'Nouvelle partie',
    vrSaveLockedByCreator: 'Ton ami a ouvert ce salon, c\'est donc lui qui choisit le point de départ.',
    vrLaunch: 'Lancer',
    vrPort1: 'Joueur 1',
    vrPort2: 'Joueur 2',
    vrWaitingForFriend: 'En attente de ton ami',
    vrFriendReady: 'Prêt',
    vrRomMissing: 'Ce jeu n\'est pas sur cet appareil. Lance-le une fois hors VR.',
    vrAlreadyPlaying: 'Ce salon joue déjà.',
    vrNoSeat: 'Quelqu\'un doit d\'abord prendre une manette.',
```

`core/test/i18n-parity.test.ts` will fail on a key present in one locale only,
and on an empty value. Run `bun run test:ui` after this step to confirm it passes.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/lib/vr/panels/launch.ts`:

```ts
/**
 * The launch screen: which game, from where, on which controller.
 *
 * Drawn on the curved screen rather than on a lectern, and that is the point:
 * it is the only surface straight ahead. The lecterns sit at plus and minus
 * sixty degrees, which is how a whole panel went unnoticed on the first
 * hardware test, and a choice nobody finds is worse than no choice at all.
 *
 * Three rules the layout enforces rather than merely honours:
 *
 *   - A save list the player may not act on is DRAWN and carries no regions.
 *     The server refuses a save staged by anyone but the room's creator, so
 *     the click would earn an `error` no headset displays; hiding the list
 *     instead would leave a guest unable to see what they are joining, which
 *     is the thing that rule exists to prevent.
 *   - A blocked launch has no `launch` region at all. A present, dead button
 *     is indistinguishable from a headset that has stopped responding.
 *   - The chosen save is marked with a glyph, not only a fill. Two states
 *     differing by a colour draw an identical set of `fillText` calls, and the
 *     test for "the choice is visible" would have nothing to compare.
 */

import type { PanelSize, Region } from '../panel';
import type { LaunchOptions, LaunchSave } from '../launch-options';

export const LAUNCH_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 56;
const COVER = { x: PAD, y: 96, w: 240, h: 168 };

/** The save list: left column, clear of the ports on the right. */
const SAVE_X = PAD;
const SAVE_Y = 312;
const SAVE_W = 470;
const SAVE_H = 56;
const SAVE_GAP = 12;
/** Beyond this the list scrolls nowhere: it is simply capped. */
const SAVE_LIMIT = 5;

const PORT_X = 560;
const PORT_Y = 312;
const PORT_W = 240;
const PORT_H = 76;
const PORT_GAP = 16;
const FRIEND_Y = 268;

const LAUNCH_W = 400;
const LAUNCH_H = 96;
const LAUNCH_Y = 620;

export interface LaunchLabels {
	newGame: string;
	saveLockedByCreator: string;
	launch: string;
	port1: string;
	port2: string;
	waitingForFriend: string;
	friendReady: string;
	romMissing: string;
	alreadyPlaying: string;
	noSeat: string;
}

/** The rows the list shows, capped, with "start fresh" always first. */
function saveRows(options: LaunchOptions): Array<{ id: string; save: LaunchSave | null }> {
	const rows: Array<{ id: string; save: LaunchSave | null }> = [{ id: 'save:none', save: null }];
	for (const save of options.saves.slice(0, SAVE_LIMIT)) {
		rows.push({ id: `save:${save.id}`, save });
	}
	return rows;
}

export function layoutLaunchPanel(options: LaunchOptions, _labels: LaunchLabels): Region[] {
	const regions: Region[] = [];

	// Drawn either way; clickable only when the server would accept it.
	if (options.mayChooseSave) {
		saveRows(options).forEach((row, index) => {
			regions.push({
				id: row.id,
				x: SAVE_X,
				y: SAVE_Y + index * (SAVE_H + SAVE_GAP),
				w: SAVE_W,
				h: SAVE_H
			});
		});
	}

	// No port to pick alone: `readVrPad` is the only pad on this machine.
	if (options.friend) {
		regions.push({ id: 'port:1', x: PORT_X, y: PORT_Y, w: PORT_W, h: PORT_H });
		regions.push({
			id: 'port:2',
			x: PORT_X,
			y: PORT_Y + PORT_H + PORT_GAP,
			w: PORT_W,
			h: PORT_H
		});
	}

	// Absent rather than dead. See the header.
	if (options.blocked === null) {
		regions.push({
			id: 'launch',
			x: (LAUNCH_PANEL_SIZE.width - LAUNCH_W) / 2,
			y: LAUNCH_Y,
			w: LAUNCH_W,
			h: LAUNCH_H
		});
	}

	return regions;
}

/** Cuts a string to fit `width` at the current font, with an ellipsis. */
function truncate(ctx: CanvasRenderingContext2D, text: string, width: number): string {
	if (ctx.measureText(text).width <= width) return text;
	let cut = text;
	while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) {
		cut = cut.slice(0, -1);
	}
	return `${cut}…`;
}

function drawRow(
	ctx: CanvasRenderingContext2D,
	region: Region,
	text: string,
	chosen: boolean,
	live: boolean,
	hovered: boolean
): void {
	ctx.fillStyle = chosen ? '#232a44' : '#1c1c26';
	ctx.fillRect(region.x, region.y, region.w, region.h);

	ctx.font = '22px system-ui, sans-serif';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	// Dimmed when the row cannot be acted on, so "drawn but inert" is visible
	// rather than only true.
	ctx.fillStyle = live ? '#e8e8f0' : '#79798a';
	ctx.fillText(
		truncate(ctx, text, region.w - 64),
		region.x + 16,
		region.y + region.h / 2
	);

	if (chosen) {
		// A glyph, not just the fill. See the header.
		ctx.fillStyle = '#7aa2ff';
		ctx.textAlign = 'right';
		ctx.fillText('●', region.x + region.w - 16, region.y + region.h / 2);
		ctx.textAlign = 'left';
	}
	if (hovered) {
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
	}
}

function drawButton(
	ctx: CanvasRenderingContext2D,
	region: Region,
	label: string,
	active: boolean,
	hovered: boolean
): void {
	ctx.fillStyle = active ? '#2f3a5c' : '#1c1c26';
	ctx.fillRect(region.x, region.y, region.w, region.h);
	ctx.fillStyle = '#ffffff';
	ctx.font = '600 26px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, region.x + region.w / 2, region.y + region.h / 2);
	if (hovered) {
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
	}
}

function blockedLabel(options: LaunchOptions, labels: LaunchLabels): string | null {
	switch (options.blocked) {
		case 'rom-missing':
			return labels.romMissing;
		case 'already-playing':
			return labels.alreadyPlaying;
		case 'no-seat':
			return labels.noSeat;
		default:
			return null;
	}
}

export function drawLaunchPanel(
	ctx: CanvasRenderingContext2D,
	options: LaunchOptions,
	regions: readonly Region[],
	opts: { labels: LaunchLabels; hoverId: string | null }
): void {
	const { width, height } = LAUNCH_PANEL_SIZE;
	const { labels } = opts;

	ctx.save();
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = '#101018';
	ctx.fillRect(0, 0, width, height);

	ctx.fillStyle = '#ffffff';
	ctx.font = '600 34px system-ui, sans-serif';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.fillText(truncate(ctx, options.game.title, width - PAD * 2), PAD, TITLE_Y);

	// A placeholder rectangle rather than a fetch: the cover is drawn by the
	// caller when it has one, for the reason `VrShell`'s library panel already
	// gives - a cross-origin image drawn into a canvas taints the whole
	// texture and WebGL then refuses the upload.
	ctx.fillStyle = '#1c1c26';
	ctx.fillRect(COVER.x, COVER.y, COVER.w, COVER.h);

	const byId = new Map(regions.map((region) => [region.id, region]));

	// Drawn from the rows, not from the regions: the list exists even when it
	// has no regions at all.
	saveRows(options).forEach((row, index) => {
		const region = byId.get(row.id) ?? {
			id: row.id,
			x: SAVE_X,
			y: SAVE_Y + index * (SAVE_H + SAVE_GAP),
			w: SAVE_W,
			h: SAVE_H
		};
		drawRow(
			ctx,
			region,
			row.save ? row.save.name : labels.newGame,
			options.chosenSaveId === (row.save?.id ?? null),
			options.mayChooseSave,
			opts.hoverId === row.id
		);
	});

	if (!options.mayChooseSave) {
		ctx.font = '20px system-ui, sans-serif';
		ctx.fillStyle = '#8a8a98';
		ctx.textAlign = 'left';
		ctx.fillText(
			truncate(ctx, labels.saveLockedByCreator, SAVE_W),
			SAVE_X,
			SAVE_Y - 28
		);
	}

	if (options.friend) {
		ctx.font = '22px system-ui, sans-serif';
		ctx.fillStyle = '#c2c2d2';
		ctx.textAlign = 'left';
		const state = options.friend.isReady ? labels.friendReady : labels.waitingForFriend;
		ctx.fillText(`${options.friend.pseudo} — ${state}`, PORT_X, FRIEND_Y);

		const one = byId.get('port:1');
		const two = byId.get('port:2');
		if (one) drawButton(ctx, one, labels.port1, options.myPort === 1, opts.hoverId === 'port:1');
		if (two) drawButton(ctx, two, labels.port2, options.myPort === 2, opts.hoverId === 'port:2');
	}

	const launch = byId.get('launch');
	if (launch) {
		drawButton(ctx, launch, labels.launch, true, opts.hoverId === 'launch');
	} else {
		const why = blockedLabel(options, labels);
		if (why) {
			ctx.font = '24px system-ui, sans-serif';
			ctx.fillStyle = '#e8b0b0';
			ctx.textAlign = 'center';
			ctx.fillText(truncate(ctx, why, width - PAD * 2), width / 2, LAUNCH_Y + LAUNCH_H / 2);
		}
	}

	ctx.restore();
}
```

- [ ] **Step 5: Run the tests**

Run: `bun run test:ui`
Expected: PASS, the test count up by 9.

- [ ] **Step 6: Prove each rule can fail**

- `if (options.mayChooseSave)` around the save regions → removed
- `if (options.blocked === null)` around the `launch` region → removed
- the `chosen` glyph block in `drawRow` → removed
- `truncate` → `return text`

- [ ] **Step 7: Typecheck and commit**

```bash
git add frontend/src/lib/vr/panels/launch.ts core/test/vr-panel-launch.test.ts \
        frontend/src/lib/i18n/translations.ts package.json
git commit -m "Draw the launch screen, with its refusals visible"
```

---

### Task 3: A canvas mode on the curved screen

**Files:**
- Modify: `frontend/src/lib/vr/screen.ts`

**Interfaces:**
- Consumes: `PanelSize`, `Region` from `vr/panel.ts`; `visibleU`, `curvedScreenGeometry` from `vr/screen-geometry.ts` (unchanged).
- Produces, added to `VrScreen`: `paintPanel(size, draw)`, `isPanel()`, `panelSize()`, and a mutable `regions: Region[]`. Task 4 raycasts against `mesh` and reads `regions`/`panelSize()`; Task 6 calls `paintPanel`.

**Verified before writing, so the implementer does not have to guess:** the
curved geometry puts `v = 0` at the bottom (`screen-geometry.ts`, where
`positions[bottom + 1] = -top` pairs with `uvs[uv + 1] = 0`), which is the same
convention `PlaneGeometry` uses — so `panel.ts`'s `hit()`, whose `uvToCanvas`
reverses the axis exactly once, works on this mesh **unchanged**. Nothing about
the v flip needs adjusting.

- [ ] **Step 1: Split the rebuild in two**

`rebuild(width, height, stride)` currently does the geometry and the texture
together, which a panel cannot use: it wants the geometry at full `uMax` and no
`DataTexture` at all. Replace it with two functions. In
`frontend/src/lib/vr/screen.ts`, the geometry half:

```ts
  function rebuildGeometry(uMax: number): void {
    mesh.geometry.dispose();
    const { positions, uvs, indices } = curvedScreenGeometry({
      radius: placement.radius,
      arc: placement.arc,
      height: placement.height,
      uMax
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    mesh.geometry = geometry;
  }
```

and the picture half, which is the old `rebuild` minus its geometry block:

```ts
  function rebuildPicture(width: number, height: number, stride: number): void {
    rebuildGeometry(visibleU(width, stride));

    texture?.dispose();
    texture = new THREE.DataTexture(
      new Uint8Array(stride * height * 4),
      stride,
      height,
      THREE.RGBAFormat
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    material.map = texture;
    material.needsUpdate = true;

    builtFor = { width, height, stride };
    mode = 'picture';
  }
```

Every existing call to `rebuild(...)` — in `upload` and in `showTestPattern` —
becomes `rebuildPicture(...)`.

- [ ] **Step 2: Add the panel state**

Beside the existing `texture` and `builtFor` declarations:

```ts
  let panelCanvas: HTMLCanvasElement | null = null;
  let panelCtx: CanvasRenderingContext2D | null = null;
  let panelTexture: THREE.CanvasTexture | null = null;
  let panelAt: PanelSize | null = null;
  /** Which of the two things this screen currently is. */
  let mode: 'picture' | 'panel' = 'picture';
  /** Replaced whenever the launch screen is laid out. `scene.aimedAt` reads it. */
  const regions: Region[] = [];
```

- [ ] **Step 3: Add `paintPanel`, `isPanel` and `panelSize` to the returned object**

```ts
    /**
     * Turns the screen into a canvas and paints it.
     *
     * The paint and the upload are one call for the reason `panel-mesh.ts`
     * gives about its own: a forgotten `needsUpdate` leaves a panel correct in
     * memory and stale on the player's face, which is the most confusing way
     * this shape can fail.
     */
    paintPanel(size: PanelSize, draw: (ctx: CanvasRenderingContext2D) => void): void {
      if (!panelCanvas) {
        panelCanvas = document.createElement('canvas');
        panelCanvas.width = size.width;
        panelCanvas.height = size.height;
        panelCtx = panelCanvas.getContext('2d');
        if (!panelCtx) throw new Error('no 2d context for the screen panel');
        panelTexture = new THREE.CanvasTexture(panelCanvas);
        panelTexture.colorSpace = THREE.SRGBColorSpace;
        // Linear, unlike the picture: this is text on a two-and-a-half-metre
        // screen, and nearest-neighbour text at an angle is unreadable.
        panelTexture.minFilter = THREE.LinearFilter;
        panelTexture.magFilter = THREE.LinearFilter;
        panelTexture.generateMipmaps = false;
        panelAt = size;
      }

      if (mode !== 'panel') {
        // uMax 1, not the picture's width/stride: the game's geometry stops
        // half way across the texture, and reusing it would show the player
        // the left half of a launch screen with no clue why.
        rebuildGeometry(1);
        material.map = panelTexture;
        material.needsUpdate = true;
        /*
         * And the picture's shape is deliberately forgotten.
         *
         * `upload` only rebuilds when the surface's shape differs from
         * `builtFor`. Left alone, the first frame of a game would find its
         * shape unchanged, skip the rebuild, and upload into the panel's
         * geometry - a picture stretched across a mesh built for something
         * else, which is exactly the class of silent wrongness this file's
         * header warns about.
         */
        builtFor = { width: -1, height: -1, stride: -1 };
        mode = 'panel';
      }

      draw(panelCtx!);
      panelTexture!.needsUpdate = true;
    },

    isPanel: () => mode === 'panel',
    panelSize: () => panelAt,
    regions,
```

Add the three to the `VrScreen` interface, with `regions: Region[]`, and import
`PanelSize` and `Region` from `./panel`.

- [ ] **Step 4: Dispose the canvas texture too**

In `dispose()`, beside `texture?.dispose()`:

```ts
      panelTexture?.dispose();
```

- [ ] **Step 5: Typecheck, build and commit**

There is no test for this task, and that is stated rather than hidden: `screen.ts`
imports `three` and creates a real canvas, so it cannot run under Bun. Its
geometry is covered by `core/test/vr-screen-geometry.test.ts`, which is untouched
here, and the behaviour added is exercised end to end by Task 6.

Run from `frontend/`: `bun run check` then `bun run build`.
Expected: 0 errors, the same 15 warnings across 9 files, and a successful build.

```bash
git add frontend/src/lib/vr/screen.ts
git commit -m "Let the curved screen be a canvas while no game is running"
```

---

### Task 4: The screen becomes a pointer target

**Files:**
- Modify: `frontend/src/lib/vr/scene.ts`

**Interfaces:**
- Consumes: `screen.isPanel()`, `screen.regions`, `screen.panelSize()` from Task 3.
- Produces: `aimedAt()` may now return `{ panel: 'screen', region }`. Task 6 dispatches on that `'screen'` id.

- [ ] **Step 1: Replace the gate and the target set**

`aimedAt()` opens with `if (!panelGroup.visible) return null;` and raycasts
`panelMeshes`. Replace both:

```ts
  function aimedAt(): PointerTarget | null {
    /*
     * Which meshes are targets, and why the rule moved.
     *
     * It used to be "nothing while the panels are hidden", which was a
     * shorthand for the real rule: the trigger is the SNES R button while a
     * game is running, and letting it also be a pointer would make a shot
     * register as a menu press. The screen is now a target too when it is a
     * launch screen, so the shorthand stopped being true - the rule below is
     * the one that was always meant.
     */
    const targets: THREE.Object3D[] = [];
    if (panelGroup.visible) targets.push(...panelMeshes);
    if (screen.isPanel()) targets.push(screen.mesh);
    if (targets.length === 0) return null;

    for (const controller of controllers) {
```

and inside the loop, the intersect line and what follows it:

```ts
      const [first] = raycaster.intersectObjects(targets, false);
      if (!first?.uv) continue;
      const uv = { x: first.uv.x, y: first.uv.y };

      // The screen is not in `panels`, so it needs its own lookup rather than
      // a `find` that would silently return undefined and skip the controller.
      if (first.object === screen.mesh) {
        const size = screen.panelSize();
        if (!size) continue;
        const onScreen = hit(screen.regions, uv, size);
        if (onScreen) return { panel: 'screen', region: onScreen };
        continue;
      }

      const panel = panels.find((candidate) => candidate.mesh === first.object);
      if (!panel) continue;

      const region = hit(panel.regions, uv, panel.size);
      if (region) return { panel: panel.id, region };
```

- [ ] **Step 2: Check the header still tells the truth**

`scene.ts`'s header describes the animation loop and the reference space. If it
also describes the pointer as panel-only, correct it — a comment that
contradicts the code is the defect that cost this project three deploys in
September.

- [ ] **Step 3: Typecheck, build and commit**

Run from `frontend/`: `bun run check` then `bun run build`.

```bash
git add frontend/src/lib/vr/scene.ts
git commit -m "Aim at the curved screen while it is a launch screen"
```

---

### Task 5: The headless lockstep boot

**Files:**
- Create: `frontend/src/lib/rooms/lockstep-engine.ts`
- Create: `core/test/lockstep-engine.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `NetplaySession`, `normaliseRom`, `romCrc32`, `FrameGovernor` and the types `SessionEvent`, `Transport` from `$lib/znet` — the same barrel imports `LockstepRoom.svelte` already uses, so they are known exported. `TickResult` from `$lib/znet/session` (declared there at line 85 as `'ran' | 'stalled' | 'idle'`).
- Produces: `createLockstepEngine(options) => Promise<LockstepEngine>` with `{ session, governor, adoptState, stop }`, plus `LockstepEngineOptions`, `LockstepSessionLike`, `SramPort`, `AudioPort`. Task 8 calls it.

**Why the session arrives through a factory with a default:** the ordering is
the thing worth testing, and constructing a real `NetplaySession` over a fake
core and a fake transport would test `NetplaySession` instead — which
`core/test/lockstep.test.ts` already does. The default parameter is the same
seam `xr-session.ts` uses for `navigator` and `readAndKeep` uses for its
reader, and it makes TypeScript check at the default site that the real class
satisfies the interface.

- [ ] **Step 1: Write the failing test**

Create `core/test/lockstep-engine.test.ts`:

```ts
/**
 * The netplay boot sequence, without a DOM.
 *
 * `LockstepRoom.svelte` holds this as part of 1814 lines, so a VR shell that
 * wants the same sequence would have to copy it - and the next SRAM or
 * handshake fix would then reach only one of the two. `solo-engine.ts` is the
 * same extraction for solo play, and this is its netplay twin.
 *
 * What is under test is the ordering a copy gets wrong:
 *
 *   - the ROM is loaded before anything can run a frame;
 *   - the cartridge SRAM is loaded by the HOST ONLY, because the host's state
 *     is what both peers adopt and loading it on the guest would change one
 *     machine and not the other;
 *   - the SRAM is in place before the session exists, for the same reason;
 *   - nothing starts until the relay has confirmed the join, because a session
 *     started over an unjoined relay stalls on its first frame with no
 *     explanation;
 *   - and `stop()` writes the SRAM one last time, without which up to thirty
 *     seconds of progress dies with the session.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createLockstepEngine,
  type LockstepSessionLike
} from '../../frontend/src/lib/rooms/lockstep-engine.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import type { Transport } from '../../frontend/src/lib/znet/index.js';

/** Enough of `PsnesCore` for the engine: what it loads, runs and reports. */
function fakeCore(log: string[]) {
  const core = {
    fps: 60.0988,
    sampleRate: 32040,
    frame: 0,
    loadRom(bytes: Uint8Array) { log.push(`loadRom:${bytes.length}`); },
    loadSram(bytes: Uint8Array) { log.push(`loadSram:${bytes.length}`); },
    sram: () => new Uint8Array([7, 7, 7]),
    reset() { log.push('reset'); },
    runFrame() { log.push('runFrame'); },
    audio: () => new Int16Array(0),
    videoSurface: () => ({ data: new Uint8Array(0), width: 256, height: 224, stride: 512 })
  };
  return core as unknown as PsnesCore;
}

function fakeSession(log: string[]): LockstepSessionLike {
  return {
    coreReset: null,
    pump() {},
    tick: () => 'idle',
    start() { log.push('session.start'); },
    loadAuthoritativeState(state, reason) {
      log.push(`adopt:${state.length}:${reason}`);
      return true;
    }
  };
}

function harness(over: { isHost?: boolean; joinRelay?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const saved: Uint8Array[] = [];
  const options = {
    core: fakeCore(log),
    rom: new Uint8Array(1024),
    isHost: over.isHost ?? true,
    sram: {
      load: async () => { log.push('sram.load'); return new Uint8Array([1, 2]); },
      save: (bytes: Uint8Array) => { log.push('sram.save'); saved.push(bytes); }
    },
    audio: {
      start: async (rate: number) => { log.push(`audio.start:${rate}`); },
      push: () => {},
      flush: () => { log.push('audio.flush'); }
    },
    transport: {} as unknown as Transport,
    joinRelay: over.joinRelay ?? (async () => { log.push('joinRelay'); }),
    readLocalInput: () => 0,
    onEvent: () => {},
    onFrame: () => {},
    onError: () => {},
    // The seam: the ordering is what matters here, not NetplaySession, which
    // `core/test/lockstep.test.ts` already covers.
    makeSession: () => fakeSession(log)
  };
  return { options, log, saved };
}

test('the ROM, the audio and the relay all precede the session', async () => {
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);

  assert.deepEqual(log, [
    'loadRom:1024',
    'audio.start:32040',
    'sram.load',
    'loadSram:2',
    'joinRelay',
    'session.start'
  ]);
  await engine.stop();
});

test('only the host loads the cartridge SRAM', async () => {
  // The host's state is what both peers adopt. Loading SRAM on the guest
  // changes one machine and not the other, and lockstep diverges on frame one.
  const { options, log } = harness({ isHost: false });
  const engine = await createLockstepEngine(options);

  assert.ok(!log.includes('sram.load'), 'the guest asked for a save it must not apply');
  assert.ok(!log.some((line) => line.startsWith('loadSram')), 'and must not have applied one');
  assert.ok(log.includes('session.start'), 'the guest still boots');
  await engine.stop();
});

test('a relay that never confirms starts nothing', async () => {
  // A session over an unjoined relay stalls on its first frame with nothing
  // to explain why, which in a headset is a black screen.
  const { options, log } = harness({
    joinRelay: async () => { throw new Error('the server did not confirm'); }
  });

  await assert.rejects(() => createLockstepEngine(options), /did not confirm/);
  assert.ok(!log.includes('session.start'), 'a session was started over a dead relay');
});

test('stop writes the cartridge save one last time', async () => {
  // Without this, up to thirty seconds of progress dies with the session,
  // because the periodic timer was all there was.
  const { options, log, saved } = harness();
  const engine = await createLockstepEngine(options);
  const before = log.filter((line) => line === 'sram.save').length;

  await engine.stop();

  assert.equal(log.filter((line) => line === 'sram.save').length, before + 1);
  assert.deepEqual([...saved[saved.length - 1]], [7, 7, 7]);
});

test('the core reset is handed to the session', async () => {
  // NetplayCore does not require a reset, so the session leaves the hook null
  // unless it is given one. Ours has one.
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);

  assert.equal(typeof engine.session.coreReset, 'function');
  engine.session.coreReset!();
  assert.ok(log.includes('reset'));
  await engine.stop();
});

test('adopting a savestate reseeds the session and drops the stale audio', async () => {
  // The queued audio belongs to a timeline that no longer exists.
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);

  assert.equal(engine.adoptState(new Uint8Array([9, 9]), 'save "boss"'), true);
  const adopt = log.indexOf('adopt:2:save "boss"');
  const flush = log.indexOf('audio.flush');
  assert.ok(adopt >= 0, 'the session was not reseeded');
  assert.ok(flush > adopt, 'the stale audio outlived the timeline it belonged to');
  await engine.stop();
});
```

- [ ] **Step 2: Add the file to `test:ui` and run it**

Append ` core/test/lockstep-engine.test.ts` to the `test:ui` list.

Run: `bun run test:ui`
Expected: FAIL on the missing module, file count up by one.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/rooms/lockstep-engine.ts`:

```ts
/**
 * The netplay boot sequence, with the presentation as a port.
 *
 * `LockstepRoom.svelte` holds this inside 1814 lines of component. A VR shell
 * wanting the same sequence would have to copy it, and the next SRAM or
 * handshake fix would then reach only one of the two copies - which is the
 * argument `solo-engine.ts` was written from, and this is its netplay twin.
 *
 * What is deliberately NOT here: the core load, the ROM resolution, the
 * renderer and the input collector. The first two are one line each at the
 * call site, and the last two differ completely between the two
 * presentations - a canvas and a keyboard on a flat page, a curved screen and
 * `XRInputSource` in a headset.
 *
 * The transport is a parameter rather than built here, and that is not
 * fastidiousness: `SocketTransport` needs the socket, and
 * `webrtc-transport.ts` reaches `simple-peer` and `import.meta.env`, which the
 * node test suites cannot resolve. `LockstepRoom.svelte` imports it by path
 * for that exact reason.
 */

import { FrameGovernor } from '$lib/znet';
import { NetplaySession, normaliseRom, romCrc32 } from '$lib/znet';
import type { SessionEvent, Transport } from '$lib/znet';
import type { TickResult } from '$lib/znet/session';
import type { PsnesCore } from '$lib/znet/core';

/** Where a cartridge save comes from and goes. */
export interface SramPort {
	load(): Promise<Uint8Array | null>;
	save(bytes: Uint8Array): void;
}

/** The part of `AudioSink` this engine drives. `flush` matters here and not in
 * solo: a resync throws away a timeline, and the audio queued for it with it. */
export interface AudioPort {
	start(sampleRate: number): Promise<void>;
	push(samples: Int16Array): void;
	flush(): void;
}

/** The part of `NetplaySession` this engine drives, and nothing more. */
export interface LockstepSessionLike {
	pump(): void;
	tick(): TickResult;
	start(): void;
	coreReset: (() => void) | null;
	loadAuthoritativeState(state: Uint8Array, reason: string): boolean;
}

export interface LockstepEngineOptions {
	/** Already loaded by the caller: `await loadCore()`. */
	core: PsnesCore;
	/** Already resolved by the caller. In VR there is no file picker to fall
	 * back on, so the resolution cannot live behind this boundary. */
	rom: Uint8Array;
	isHost: boolean;
	sram: SramPort;
	audio: AudioPort;
	transport: Transport;
	/** Emits `znet:join` and resolves on `znet:joined`. Rejecting is correct
	 * and must not be swallowed - see the ordering test. */
	joinRelay(): Promise<void>;
	/** One mask: this machine's player. The other arrives over the transport,
	 * which is exactly the shape `vr/pad.ts`'s `readVrPad` produces. */
	readLocalInput(): number;
	onEvent(event: SessionEvent): void;
	onFrame(core: PsnesCore, frame: number): void;
	onError(err: unknown): void;
	onSlice?(ran: number, stalled: boolean): void;
	/** Left undefined so the host sizes it from the link it measures. A
	 * hardcoded guess gave one stall per frame once a link drifted. */
	inputDelay?: number;
	/** Where the governor schedules its next slice. Passed by the VR shell,
	 * because window rAF is not the display's clock once a headset presents. */
	schedule?(run: () => void): void;
	/** The session constructor. Defaulted, and a seam for the ordering test. */
	makeSession?(options: ConstructorParameters<typeof NetplaySession>[0]): LockstepSessionLike;
}

export interface LockstepEngine {
	session: LockstepSessionLike;
	governor: FrameGovernor;
	/** The host adopting a savestate: the guest receives it as an ordinary
	 * resync through the netplay protocol. */
	adoptState(state: Uint8Array, reason: string): boolean;
	stop(): Promise<void>;
}

/** How often the cartridge save is written while playing. `stop()` writes once
 * more, so this is the worst case for a crash, not for a clean exit. */
const SRAM_INTERVAL_MS = 30_000;

export async function createLockstepEngine(
	options: LockstepEngineOptions
): Promise<LockstepEngine> {
	const { core, rom, isHost, sram, audio, transport, readLocalInput, onEvent, onError } = options;

	const bytes = normaliseRom(rom);
	core.loadRom(bytes);

	await audio.start(Math.round(core.sampleRate));

	/*
	 * The host, and only the host.
	 *
	 * Battery saves are part of the emulated machine, so they must be in place
	 * before the session starts: the host's state is what both peers adopt, and
	 * loading SRAM afterwards - or on the guest - would change one machine and
	 * not the other. The guest inherits it inside that state.
	 */
	if (isHost) {
		const stored = await sram.load();
		if (stored && stored.length > 0) core.loadSram(stored);
	}

	// Before anything starts, and not caught: a session over an unjoined relay
	// stalls on its first frame with nothing anywhere to say why.
	await options.joinRelay();

	const make = options.makeSession ?? ((opts) => new NetplaySession(opts) as LockstepSessionLike);

	const session = make({
		core,
		transport,
		playerIndex: isHost ? 0 : 1,
		isHost,
		// Both peers must agree on the cartridge before a single frame runs.
		romCrc: romCrc32(bytes),
		// The machine's own cadence, not an assumption: a PAL cartridge runs at
		// 50.007 Hz, which changes both how many frames a round trip needs and
		// what one frame of delay costs the player.
		fps: core.fps || undefined,
		inputDelay: options.inputDelay || undefined,
		readLocalInput,
		onEvent,
		onFrame: (frame: number) => {
			try {
				options.onFrame(core, frame);
				audio.push(core.audio());
			} catch (err) {
				onError(err);
			}
		}
	} as ConstructorParameters<typeof NetplaySession>[0]);

	// The session declares this hook rather than calling `core.reset()` itself:
	// NetplayCore does not require a reset, so a core without one leaves it
	// null. Ours has one, so hand it over.
	session.coreReset = () => core.reset();

	const governor = new FrameGovernor(session, {
		fps: core.fps || 60.0988,
		onSlice: options.onSlice,
		schedule: options.schedule
	});

	const timer = setInterval(() => persist(), SRAM_INTERVAL_MS);

	function persist(): void {
		try {
			const saved = core.sram();
			if (saved && saved.length > 0) sram.save(saved);
		} catch (err) {
			onError(err);
		}
	}

	session.start();
	governor.start();

	return {
		session,
		governor,
		adoptState(state, reason) {
			const adopted = session.loadAuthoritativeState(state, reason);
			// After, not before: the queued audio belongs to a timeline that no
			// longer exists, and flushing first would only clear the old one a
			// frame early.
			if (adopted) audio.flush();
			return adopted;
		},
		async stop(): Promise<void> {
			governor.stop();
			clearInterval(timer);
			// Last, and unconditionally: without it the periodic timer is all
			// there was, so a clean exit loses up to SRAM_INTERVAL_MS of play.
			persist();
		}
	};
}
```

- [ ] **Step 4: Run the tests**

Run: `bun run test:ui`
Expected: PASS, the test count up by 6.

If `FrameGovernor`'s options do not accept `onSlice: undefined`, pass it only
when present rather than widening the governor's type — the governor is shared
with the flat path and the solo engine.

- [ ] **Step 5: Prove each rule can fail**

- `if (isHost)` around the SRAM load → removed
- `await options.joinRelay();` → moved after `session.start()`
- `persist();` in `stop()` → removed
- `session.coreReset = …` → removed
- `if (adopted) audio.flush();` → removed

- [ ] **Step 6: Typecheck and commit**

```bash
git add frontend/src/lib/rooms/lockstep-engine.ts core/test/lockstep-engine.test.ts package.json
git commit -m "Extract the lockstep boot sequence from its component"
```

---

### Task 6: The launch screen replaces the immediate launch, in solo

**Files:**
- Modify: `frontend/src/lib/rooms/my-room.ts`, `frontend/src/lib/components/VrShell.svelte`

**Interfaces:**
- Consumes: everything Tasks 1–4 produced.
- Produces: `repaintLaunch()`, `launchLabels()` and `entryFor(crc32)` inside `VrShell`, plus the `'screen'` branch of `activate` and the staging body of the `'library'` branch — both inline in `activate`, not functions. Task 7 replaces those two bodies in place.

- [ ] **Step 1: Declare the two fields the server already sends**

`RoomView` in `frontend/src/lib/rooms/my-room.ts` is a narrower view than
`Room` in `lib/types.ts`, and it omits two fields `toPublicRoom` does send.
Add them beside `gameTitle`:

```ts
	/** CRC32 of the room's ROM, which each player resolves against their own
	 * files. The room carries the CHOOSER's game id, so this is the only field
	 * that finds the same cartridge in my library. */
	gameCrc32?: string;
	/** The save this room will start on, staged through `room:choose-save`. */
	resumeSaveId?: string;
```

- [ ] **Step 2: Hold the launch screen's state**

In `VrShell.svelte`, beside the other panel state:

```ts
  /** The dump whose launch options the screen is showing, or null for the
   * checkerboard. */
  let launchFor: string | null = null;
  /** Solo only: no room exists yet to hold it. See the spec's D5. */
  let stagedSaveId: string | null = null;
```

- [ ] **Step 3: Paint it**

```ts
  function repaintLaunch(): void {
    if (!scene || launchFor === null) return;
    const options = launchOptions({
      library: $games,
      crc32: launchFor,
      room: $myRoom ?? null,
      me: $user?.id ?? '',
      openable: new Set(resolvable ?? []),
      stagedSaveId
    });
    // The dump left the library while its screen was up - a folder sync can do
    // that. Back to the test pattern rather than a half-drawn screen.
    if (!options) {
      launchFor = null;
      scene.screen.regions.length = 0;
      scene.screen.showTestPattern();
      return;
    }

    const labels = launchLabels();
    const regions = layoutLaunchPanel(options, labels);
    // Replaced in place: `scene.aimedAt` holds this same array.
    scene.screen.regions.length = 0;
    scene.screen.regions.push(...regions);
    scene.screen.paintPanel(LAUNCH_PANEL_SIZE, (ctx) =>
      drawLaunchPanel(ctx, options, regions, {
        labels,
        hoverId: hovered?.panel === 'screen' ? hovered.region.id : null
      })
    );
  }

  function launchLabels(): LaunchLabels {
    return {
      newGame: t($language, 'vrNewGame'),
      saveLockedByCreator: t($language, 'vrSaveLockedByCreator'),
      launch: t($language, 'vrLaunch'),
      port1: t($language, 'vrPort1'),
      port2: t($language, 'vrPort2'),
      waitingForFriend: t($language, 'vrWaitingForFriend'),
      friendReady: t($language, 'vrFriendReady'),
      romMissing: t($language, 'vrRomMissing'),
      alreadyPlaying: t($language, 'vrAlreadyPlaying'),
      noSeat: t($language, 'vrNoSeat')
    };
  }
```

- [ ] **Step 4: A click on the library opens the screen instead of launching**

In `activate`, the `target.panel === 'library'` branch currently calls
`launch(game)`. It now stages instead:

```ts
      if (game.crc32) {
        launchFor = game.crc32;
        stagedSaveId = null;
        launchNotice = null;
        repaintLibrary();
        repaintLaunch();
      }
```

- [ ] **Step 5: Dispatch the screen's own regions**

A new branch in `activate`, beside the `'library'` and `'profile'` ones:

```ts
    if (target.panel === 'screen') {
      const id = target.region.id;

      if (id === 'save:none' || id.startsWith('save:')) {
        const saveId = id === 'save:none' ? null : id.slice('save:'.length);
        // Solo stages it locally; a group stages it on the room so the friend
        // sees it. Task 7 adds the second half.
        stagedSaveId = saveId;
        repaintLaunch();
        return;
      }

      if (id === 'launch' && launchFor) {
        const game = entryFor(launchFor);
        if (game) void launch(game);
        return;
      }
      return;
    }
```

- [ ] **Step 6: Repaint on hover, and when the room changes**

In the hover loop that already reads `panel === 'library'`, add:

```ts
        if (panel === 'screen') repaintLaunch();
```

and, beside the existing `$:` statements:

```ts
  // The room decides half of what this screen shows - the friend's readiness,
  // the staged save, whether the game changed under us. Not the save itself:
  // that is resolved once at launch, never reactively, or a `room:updated`
  // would push it back down over a running game.
  $: if (launchFor && $myRoom) repaintLaunch();
```

- [ ] **Step 7: `launch` takes the entry, and resumes the staged save**

`launch` is `launch(gameId: string)` today and finds the entry itself, by id.
It becomes `launch(game)` and receives the entry already resolved — by CRC32,
which is the rule D4 states and which an id lookup cannot honour. It cannot
take a checksum alone either:
`createRoom({ gameId, gameTitle, autoStart: true })` needs the library entry,
and a crc32 is not one. So `launchFor` holds the checksum for the screen, and
the `'launch'` branch resolves the entry before calling:

```ts
  /** The library entry for a dump, by CRC32 - never by game id, for the reason
   * `launch-options.ts` gives at length. */
  function entryFor(crc32: string): (typeof $games)[number] | null {
    return $games.find((game) => game.crc32 === crc32) ?? null;
  }
```

After `createSoloEngine` resolves, and only when a save was staged:

```ts
        if (stagedSaveId) {
          const wanted = stagedSaveId;
          // Once. A reconnect must not rewind the game - the same rule the
          // flat path states about `resumeSaveId`.
          stagedSaveId = null;
          const sock = $socket;
          const onLoaded = (payload: { saveData?: string }) => {
            sock?.off('game:loaded', onLoaded);
            if (!payload?.saveData) return;
            try {
              core.loadState(fromBase64(payload.saveData));
            } catch (err) {
              logger.error('vr could not decode the save', err);
              launchNotice = t($language, 'vrLaunchFailed');
              repaintLibrary();
            }
          };
          sock?.on('game:loaded', onLoaded);
          sock?.emit('game:load', { roomId, saveId: wanted });
        }
```

Import `fromBase64` from `$lib/saves/base64`, beside the existing `toBase64`.

On a successful launch, `launchFor = null` and `scene.screen.regions.length = 0`
before the panels are hidden: the screen becomes a picture again, so it must
stop being a pointer target.

- [ ] **Step 8: Verify and commit**

Run from the root: `bun run test:ui`. From `frontend/`: `bun run check`, then
`bun run build`. Then confirm the dev container serves the changed modules —
`curl -s http://localhost:5173/src/lib/components/TopBar.svelte | grep -c …` is
the shape; the host build passing while the container served stale code has
happened on this project.

```bash
git add frontend/src/lib/rooms/my-room.ts frontend/src/lib/components/VrShell.svelte
git commit -m "Open a launch screen instead of launching on the first click"
```

---

### Task 7: The group path

**Files:**
- Modify: `frontend/src/lib/components/VrShell.svelte`

**Interfaces:**
- Consumes: `gameClick` from `$lib/rooms/game-click`, `chooseGameForGroup` from `$lib/rooms/actions`, and Task 6's `launchFor` / `repaintLaunch`.
- Produces: nothing new. This task adds branches to the functions Task 6 created.

- [ ] **Step 1: A click on the library asks `gameClick` first**

Replacing Task 6's Step 4 body:

```ts
      if (!game.crc32) return;
      const click = gameClick($myRoom);

      // `blocked` means the room is playing: the profile band carries the way
      // back into it, and there is nothing for this click to do.
      if (click.kind === 'blocked') {
        launchNotice = t($language, 'vrAlreadyPlaying');
        repaintLibrary();
        return;
      }

      launchFor = game.crc32;
      stagedSaveId = null;
      launchNotice = null;

      if (click.kind === 'choose-for-group') {
        // This is what opens the room, and it opens it for BOTH of us: the
        // server answers with `room:opened` to every member, which navigates
        // the friend to the room page. It does not navigate this player -
        // `+layout.svelte` returns early while `vrActive` is set, a guard
        // written to prevent an accident that turns out to be the mechanism.
        chooseGameForGroup(click.roomId, { id: game.id, title: game.title });
      }

      repaintLibrary();
      repaintLaunch();
```

- [ ] **Step 2: A save chosen in a group is staged on the room**

Replacing the save branch of Task 6's Step 5:

```ts
      if (id.startsWith('save:')) {
        const saveId = id === 'save:none' ? null : id.slice('save:'.length);
        const room = $myRoom;
        if (room && room.players.length >= 2) {
          // Staged on the room so the friend sees what they are joining. The
          // server refuses this from anyone but the room's creator, which is
          // why the layout gave these rows no regions in that case - so
          // reaching here at all means it will be accepted.
          $socket?.emit('room:choose-save', { roomId: room.id, saveId });
        } else {
          stagedSaveId = saveId;
        }
        repaintLaunch();
        return;
      }
```

- [ ] **Step 3: The ports**

```ts
      if (id === 'port:1' || id === 'port:2') {
        const room = $myRoom;
        if (!room) return;
        // One emit: `room:selectPort` sets `isReady` as well, so choosing a
        // controller is also declaring yourself ready.
        $socket?.emit('room:selectPort', { roomId: room.id, port: id === 'port:1' ? 1 : 2 });
        return;
      }
```

`repaintLaunch` is not called here: the room answers with `room:updated`, and
Task 6's reactive statement redraws from the room rather than from a guess about
what the server accepted.

- [ ] **Step 4: Launching in a group starts the room, it does not create one**

In the `'launch'` branch:

```ts
      if (id === 'launch' && launchFor) {
        const room = $myRoom;
        if (room && room.players.length >= 2) {
          // Any member may start: `game:start` asks only for membership, a
          // chosen game and one seated player. The engine is built when
          // `game:started` comes back, in Task 8 - not here, because the
          // friend may start it too.
          $socket?.emit('game:start', { roomId: room.id });
          return;
        }
        const game = entryFor(launchFor);
        if (game) void launch(game);
        return;
      }
```

- [ ] **Step 5: The friend's own choice opens this screen**

Beside the reactive statements:

```ts
  /*
   * The other way in.
   *
   * The friend can choose a game from their flat page, and then the room
   * carries it and this player never touched anything. It is also the only
   * path by which a game absent from THIS device can reach the launch screen -
   * the lectern only ever offers what `resolvableHere` returned - so it is the
   * path that earns the `rom-missing` refusal.
   */
  $: if ($myRoom?.gameCrc32 && $myRoom.gameCrc32 !== launchFor && $myRoom.status === 'waiting') {
    launchFor = $myRoom.gameCrc32;
    stagedSaveId = null;
    repaintLaunch();
  }
```

- [ ] **Step 6: Verify and commit**

```bash
git add frontend/src/lib/components/VrShell.svelte
git commit -m "Choose the game for the group from inside the headset"
```

---

### Task 8: Running the two-player game

**Files:**
- Modify: `frontend/src/lib/components/VrShell.svelte`

**Interfaces:**
- Consumes: `createLockstepEngine` from Task 5.
- Produces: nothing new.

- [ ] **Step 1: Boot lockstep on `game:started`**

The engine is built on the event rather than on the press, because either
player may have pressed. Beside the other socket listeners:

```ts
  function onGameStarted(): void {
    const room = $myRoom;
    if (!room || room.players.length < 2 || !room.gameCrc32) return;
    // A game already running here is the relaunch case, which `launch` guards.
    if (engine) return;
    void launchTogether(room.id, room.gameCrc32, room.hostId === $user?.id);
  }
```

- [ ] **Step 2: The boot itself**

Mirroring `launch`, with three differences: the transport, the relay, and the
pad. Its ROM resolution, its `resolvable` check, its `launching` guard and its
`finally` are the same shape and must be copied rather than reinvented.

```ts
  async function launchTogether(roomId: string, crc32: string, isHost: boolean): Promise<void> {
    if (launching) return;
    launching = true;
    try {
      const rom = await resolveQuietly(crc32, { requestPermission: false });
      if (!rom) {
        // The refusal the launch screen already predicted. Saying it twice is
        // better than a black screen.
        launchNotice = t($language, 'vrRomMissing');
        repaintLaunch();
        return;
      }

      const core = await loadCore();
      audio = new AudioSink();

      // By path, not through the barrel: it reaches `simple-peer` and
      // `import.meta.env`, exactly as `LockstepRoom.svelte` notes.
      const { ZnetWebRtcTransport } = await import('$lib/znet/webrtc-transport');
      const relay = new SocketTransport($socket as never, roomId);
      const transport = new UpgradingTransport(
        relay,
        new ZnetWebRtcTransport($socket as never, roomId, isHost)
      );

      engine = await createLockstepEngine({
        core,
        rom,
        isHost,
        transport,
        sram: {
          load: () => readRoomSram(roomId),
          save: (bytes) => $socket?.emit('game:saveSram', { roomId, sramData: toBase64(bytes) })
        },
        audio,
        joinRelay: () => joinRelay(roomId),
        // One mask, which is what `readVrPad` already produces - no `pad2: 0`
        // here, because the other pad arrives over the transport.
        readLocalInput: () =>
          scene && !scene.arePanelsVisible()
            ? readVrPad(scene.inputSources(), padScheme, sessionVisibility())
            : 0,
        onEvent: onSessionEvent,
        onFrame: (c) => scene?.screen.upload(c.videoSurface()),
        onError: (err) => logger.error('vr lockstep', err),
        schedule: scene.schedule
      });

      /*
       * The session may have died while the relay handshake was in flight.
       *
       * `createLockstepEngine` awaits the ROM, the audio device, the cartridge
       * save and the relay - and a headset put down at any of them runs
       * `onDestroy` -> `closeAnySession()`, which nulls `scene`, `engine` and
       * `audio`. The pending promise then resolves onto a corpse and, without
       * this, reassigns `engine`, starts a governor and arms a thirty-second
       * SRAM timer that nothing is left to stop. `scene` being null is the
       * signal, exactly as the solo path reads it (`VrShell.svelte:449-481`).
       */
      if (!scene) {
        void engine.stop();
        engine = null;
        giveUpRoom();
        void audio?.stop();
        audio = null;
        return;
      }

      await audio.resume();
      launchFor = null;
      scene.screen.regions.length = 0;
      scene?.panelsVisible(false);
      // The engine does not start its own governor - `solo-engine.ts` does not
      // either, and `SoloRoom.svelte:582` and `VrShell.svelte:509` are where
      // the flat and solo paths start theirs. Task 5's implementer found this
      // the hard way: starting it inside the engine reaches
      // `requestAnimationFrame` and cannot run under Bun at all.
      engine.governor.start();
      repaintProfile();
    } catch (err) {
      logger.error('vr lockstep failed to start', err);
      launchNotice = t($language, 'vrLaunchFailed');
      repaintLaunch();
      void engine?.stop();
      engine = null;
      void audio?.stop();
      audio = null;
    } finally {
      launching = false;
    }
  }
```

`engine` is now `SoloEngine | LockstepEngine | null`. Both expose `stop()`, and
nothing else in the component touches either — so widen the declared type and
let the compiler name any site that assumed the solo shape.

- [ ] **Step 3: The relay join**

```ts
  /** Emits `znet:join` and resolves on `znet:joined`, with the same ten-second
   * ceiling the flat path uses. */
  function joinRelay(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = $socket;
      if (!sock) return reject(new Error('Not connected to the server'));
      const timer = setTimeout(() => {
        sock.off('znet:joined', onJoined);
        reject(new Error('The server did not confirm the netplay session'));
      }, 10000);
      const onJoined = () => {
        clearTimeout(timer);
        sock.off('znet:joined', onJoined);
        resolve();
      };
      sock.on('znet:joined', onJoined);
      sock.emit('znet:join', { roomId });
    });
  }
```

- [ ] **Step 4: The six events**

```ts
  /** The whole session event surface: six cases, and none may be silent. */
  function onSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case 'state':
      case 'resync-start':
      case 'link-restored':
        logger.info('vr session', event);
        break;
      case 'desync':
      case 'link-lost':
        logger.warn('vr session', event);
        break;
      case 'error':
        logger.error('vr session', event);
        // Back to the screen that can explain itself, rather than a picture
        // that has stopped moving for no stated reason.
        launchNotice = t($language, 'vrLaunchFailed');
        void stopTogether();
        break;
    }
  }
```

Read `SessionEvent` in `frontend/src/lib/znet/session.ts:103` before writing
this switch. It is an **interface** whose `type` field enumerates **nine**
values - `state`, `desync`, `resync-start`, `resync-done`, `rtt`, `link-lost`,
`link-restored`, `error`, `peer-ready` - not the six this plan first claimed.
That number came from counting `case` labels in `LockstepRoom.svelte`'s
handler, which is a consumer and drops three of them silently.

And omitting the `default` does NOT make an unhandled member a type error: a
statement switch with no return is not exhaustiveness-checked. Write a
`default` that assigns the narrowed value to `never`, which does.

- [ ] **Step 5: The room is still given back**

`giveUpRoom()` exists and is called from the three paths that end a game. A
lockstep game ends the same ways, so it needs no new call — but verify by
reading, not by assuming, that `teardown()` reaches it on this path too. The
opposite mistake shipped once: a room left alive on the server and a friend
list showing the player as playing forever.

- [ ] **Step 6: Verify and commit**

Run from the root: `bun run test:ui`. From `frontend/`: `bun run check` then
`bun run build`. Confirm the container serves the changed modules.

```bash
git add frontend/src/lib/components/VrShell.svelte
git commit -m "Run the two-player game in the headset"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-09-04-vr-multijoueur-design.md` has a task:
D1 → Tasks 2, 3, 6. D2 → Task 4. D3 → Tasks 1, 2, 7. D4 → Task 1. D5 →
Tasks 6, 7. D6 → Tasks 5, 8. D7 → Tasks 1, 2, 8. The spec's §3 (the screen's
content) → Task 2; §4 (the engine) → Task 5; §5 (errors) → Tasks 2 and 8;
§6 (tests) → the test steps of Tasks 1, 2 and 5.

**Types checked against their sources.** `TickResult` is
`'ran' | 'stalled' | 'idle'` (`znet/session.ts:85`). `SaveSummary` is
`{ id, name, slotNumber, screenshot, createdAt, updatedAt }`
(`saves/api.ts:12`), and Task 1's `LaunchSave` takes the three fields it needs.
`Game` carries `saves` and an optional `crc32` (`stores/games.ts:3`).
`Room` carries `gameCrc32` and `resumeSaveId` (`lib/types.ts:48`) while
`RoomView` does not, which is why Task 6 adds them.
`fromBase64` is exported from `saves/base64.ts:28`.
`session.loadAuthoritativeState(bytes, reason)` returns a boolean
(`LockstepRoom.svelte:947`). `NetplaySession`, `FrameGovernor`,
`SocketTransport`, `UpgradingTransport`, `normaliseRom`, `romCrc32`,
`SessionEvent` and `Transport` are all in the barrel import list
`LockstepRoom.svelte` already uses.

**Two places where the implementer must read before writing**, named rather
than papered over: the `SessionEvent` union in Task 8 Step 4, and whether
`FrameGovernor`'s options accept an undefined `onSlice` in Task 5 Step 4.
Both are stated with what to do in either case.

**No component tests.** Tasks 3, 4, 6, 7 and 8 change `screen.ts`, `scene.ts`
and `VrShell.svelte`, none of which can run under Bun. That is why Tasks 1, 2
and 5 exist as separate pure modules holding every decision: what the screen
shows, how it is laid out, and the order the engine boots in. The wiring that
remains untested is dispatch and assignment. Three bugs came out of these
components in September, all of the same shape — a forgotten branch — so this
is a known and stated risk, not an oversight.
