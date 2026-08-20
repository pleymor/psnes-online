# Solo on znet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run solo play on the `znet` stack, so it gains the shaders, save thumbnails, pause menu and display toolbar that were only ever built for lockstep, and loses the inherited "LATENCE" panel.

**Architecture:** Widen `FrameGovernor`'s dependency from the concrete `NetplaySession` to a two-method `TickSource` interface. Add a `SoloSession` that implements it with no network, no handshake and no input delay — small enough to be fully unit-tested against the existing `FakeCore`. Then a `SoloRoom.svelte` that composes the same znet primitives as `LockstepRoom` minus everything peer-related, and route the room page's single-player branch to it.

**Tech Stack:** TypeScript, SvelteKit 4 (Svelte 4 reactivity rules apply), `node --import tsx --test` for unit tests, the existing `FakeCore` test double.

**Spec:** `docs/superpowers/specs/2026-08-20-solo-on-znet-design.md` — read it before Task 1. The plan argues from the spec; where they disagree, the spec wins.

## Global Constraints

- **`FrameGovernor` stays the only timer owner in this stack.** `SoloSession` must contain no `requestAnimationFrame`, `setTimeout`, `setInterval`, `performance.now` or `Date.now`. The renderer must not drive timing either — that rule carries over from the WebGL work and still applies with one player, because a renderer that influenced pacing would make the game depend on the graphics card.
- **Widening the governor's dependency changes no existing behaviour.** `NetplaySession` already has both methods with the right signatures; it only gains an `implements` clause. Any behavioural change to lockstep is a defect.
- **`SoloSession.tick()` always returns `'ran'`.** Never `'stalled'` (nothing waits on anyone) and never `'idle'`. This invariant is what makes the class trivially testable, and it is tested explicitly rather than assumed.
- **`SoloSession` keeps its own frame counter**, exactly as `NetplaySession` does (`session.ts:490-491`). It does not read or write `core.frame`.
- **`readLocalInput()` returns a pad pair**, `{ pad1: number; pad2: number }`, not a single mask — so a second local controller can be added later without changing the class's shape. `SoloRoom` fills `pad1` from the `InputCollector` and `pad2` with `0`.
- **Battery saves are preserved.** Load with `game:loadSram` / `game:sramLoaded`, persist with `game:saveSram` every **30000 ms**, matching `LockstepRoom.svelte:534`. No server change.
- **Slow motion and the speed indicator are deliberately dropped.** Turbo stays — `FrameGovernor.setTurbo` already exists.
- **Nothing is deleted in this plan.** `ClientEmulator`, `P2PRoom`, `DualClientEmulator` and the emulator module all stay. Their removal is a separate, later piece of work that depends on this one.
- **Tabs, not spaces**, in `frontend/src/lib/znet/*.ts`. Two spaces in `core/test/` and in `.svelte` files.
- **No new runtime dependencies.**
- **A new test file must be added to the `test:ui` script** in the root `package.json`. That script lists its files explicitly, so an unlisted test file silently never runs.
- Measured baseline at the branch point: **194 tests passing** (37 netplay / 11 core / 80 ui / 66 backend), `npm run check --workspace frontend` reporting **0 errors, 19 warnings in 10 files**. `node` is not on the default PATH; prefix commands with `export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/src/lib/znet/solo.ts` | `SoloSession` — advance the core one frame from local input. No network, no timers. The whole of the migration's logic. |
| `frontend/src/lib/components/SoloRoom.svelte` | Compose core, renderer, governor, input, audio, saves and chrome for one player. Wiring only; no logic that could live in `solo.ts`. |
| `core/test/solo.test.ts` | Unit tests for `SoloSession` and for the governor accepting a non-`NetplaySession`. |
| `docs/superpowers/verification/2026-08-20-solo-on-znet.md` | What was verified and what still needs a human. |

**Modified:**

| File | Change |
|---|---|
| `frontend/src/lib/znet/session.ts` | Add the `TickSource` interface; `NetplaySession implements` it. |
| `frontend/src/lib/znet/governor.ts` | Depend on `TickSource` instead of `NetplaySession`. |
| `frontend/src/lib/znet/index.ts` | Export `SoloSession`, `SoloOptions`, `TickSource`. |
| `frontend/src/routes/room/[id]/+page.svelte` | Render `SoloRoom` for the single-player branch. |
| `package.json` | Add `core/test/solo.test.ts` to `test:ui`. |

**Task order and why:** the interface first, because everything consumes it and widening it is the only change to existing code. Then `SoloSession`, which is pure and fully testable. Then a `SoloRoom` that boots and plays, routed immediately so it can actually be exercised. Then its chrome. Then verification.

---

## Task 1: Widen the governor's dependency

**Files:**
- Modify: `frontend/src/lib/znet/session.ts` (add the interface near `TickResult`, around line 60; add `implements` to the class declaration)
- Modify: `frontend/src/lib/znet/governor.ts:10` and `:26`
- Modify: `frontend/src/lib/znet/index.ts`
- Create: `core/test/solo.test.ts` (the governor test; `SoloSession` tests join it in Task 2)
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface TickSource { pump(): void; tick(): TickResult }`, exported from `session.ts` and re-exported from the barrel.

### Why this is the only change to existing code

`FrameGovernor` calls exactly two methods on its session — `session.pump()` at `governor.ts:142` and `session.tick()` at `governor.ts:154` — while importing and declaring the concrete `NetplaySession` (957 lines). Nothing else about the session is used. Narrowing the declared dependency to what is actually called is what lets a second implementation exist.

- [ ] **Step 1: Write the failing test**

Create `core/test/solo.test.ts`:

```ts
/**
 * Solo play on the znet stack.
 *
 * The point of these tests is the boundary, not the arithmetic. FrameGovernor
 * is the only timer owner in this stack, and it used to name the concrete
 * 957-line NetplaySession while calling exactly two of its methods. Everything
 * here checks that the narrower contract is real rather than merely declared.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameGovernor } from '../../frontend/src/lib/znet/governor.js';
import type { TickSource } from '../../frontend/src/lib/znet/session.js';

/** Records what the governor asked of it. No timers, no core. */
class RecordingSource implements TickSource {
  pumps = 0;
  ticks = 0;
  constructor(private results: Array<'ran' | 'stalled' | 'idle'> = []) {}

  pump(): void {
    this.pumps++;
  }

  tick(): 'ran' | 'stalled' | 'idle' {
    this.ticks++;
    return this.results.shift() ?? 'ran';
  }
}

test('the governor accepts any TickSource, not only a NetplaySession', () => {
  const source = new RecordingSource();

  // Constructing is the whole assertion: before TickSource existed this did
  // not type-check, and a runtime-only widening would leave the compiler
  // still demanding a NetplaySession.
  const governor = new FrameGovernor(source, { fps: 60 });

  assert.equal(governor.isRunning, false, 'a fresh governor has not started');
});

test('the governor reads its session through the two-method contract only', () => {
  const source = new RecordingSource();
  const governor = new FrameGovernor(source, { fps: 60 });

  // Both methods exist on the narrow interface, so a governor that reached for
  // anything else would fail to compile against RecordingSource.
  assert.equal(typeof source.pump, 'function');
  assert.equal(typeof source.tick, 'function');
  assert.equal(governor.isRunning, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/solo.test.ts
```

Expected: FAIL. The import of `TickSource` cannot resolve — `SyntaxError` or a type-only import error from tsx. That is the correct first failure; do not proceed until you have seen it.

Note: `tsx` strips types rather than checking them, so a *type* error alone would not fail this test at runtime. The real gate on the widening is `npm run check --workspace frontend` in Step 5, which does check. Both are required; neither replaces the other.

- [ ] **Step 3: Add the interface**

In `frontend/src/lib/znet/session.ts`, immediately after the `TickResult` type (line 60):

```ts
/**
 * What FrameGovernor needs from a session, and nothing more.
 *
 * The governor is the only timer owner in this stack, and of a session it
 * calls exactly these two methods. Naming them separately from
 * NetplaySession is what lets solo play reuse the governor without dragging
 * in a handshake, an input delay and a resync path that mean nothing with
 * one player.
 */
export interface TickSource {
	/** Cheap out-of-band work: retries, probes. Called once per slice. */
	pump(): void;
	/** Advance at most one frame. */
	tick(): TickResult;
}
```

Then declare it on the class. Find `export class NetplaySession {` and change it to:

```ts
export class NetplaySession implements TickSource {
```

- [ ] **Step 4: Point the governor at the interface**

In `frontend/src/lib/znet/governor.ts`, replace line 10:

```ts
import type { TickSource } from './session.js';
```

and line 26:

```ts
	private session: TickSource;
```

Then the constructor's parameter — find `constructor(session: NetplaySession, options: GovernorOptions = {})` and change the type to `TickSource`. Update the file's own doc comment, whose first line reads "Real-time driver for a NetplaySession":

```ts
/**
 * Real-time driver for a TickSource.
 *
 * The session itself is timer-free on purpose; this is the only place that
 * knows about wall-clock time, which keeps the netcode testable. Its job is
 * narrow: decide how many `tick()` calls a given slice of real time deserves,
 * and never let an emulator run away from the clock.
 *
 * It works for netplay and for solo alike: both are just something that can be
 * ticked.
 */
```

- [ ] **Step 5: Export it and verify both gates**

In `frontend/src/lib/znet/index.ts`, add `TickSource` to the existing type export from `./session.js` — the line currently listing `NetplayCore`, `SessionEvent`, `SessionOptions`, `SessionState`, `SessionStats`, `TickResult`. Match on content; add `TickSource` to that list.

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/solo.test.ts
npm run check --workspace frontend 2>&1 | tail -3
```

Expected: the test PASSES (2 tests), and `svelte-check` reports **0 errors** — which is the real proof the widening type-checks, since tsx does not check types.

- [ ] **Step 6: Prove the widening is real by breaking it on purpose**

A declared interface that the governor does not actually depend on would pass everything above. Verify it bites:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
# Temporarily put the concrete type back
sed -i 's/private session: TickSource;/private session: NetplaySession;/' frontend/src/lib/znet/governor.ts
npm run check --workspace frontend 2>&1 | tail -5
```

Expected: **errors now**, because `governor.ts` no longer imports `NetplaySession` and `RecordingSource` is not one. Then restore:

```bash
sed -i 's/private session: NetplaySession;/private session: TickSource;/' frontend/src/lib/znet/governor.ts
npm run check --workspace frontend 2>&1 | tail -3
```

Expected: back to 0 errors. Report both outputs — if the first command produced no error, the widening is decorative and you must say so rather than proceed.

- [ ] **Step 7: Register the test file and run everything**

Append `core/test/solo.test.ts` to the `test:ui` script in `package.json`. That script lists its files explicitly, so an unlisted file never runs. Then:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all 2>&1 | grep -E "^# (tests|pass|fail)"
npm run test:ui 2>&1 | grep -c "TickSource\|governor accepts"
```

Expected: all suites pass with the ui group up by 2 (82), and the second command returns non-zero, proving the new file is in the run.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/znet/session.ts frontend/src/lib/znet/governor.ts frontend/src/lib/znet/index.ts core/test/solo.test.ts package.json
git commit -m "Let the governor drive anything tickable, not just a netplay session"
```

---

## Task 2: The solo session

**Files:**
- Create: `frontend/src/lib/znet/solo.ts`
- Modify: `frontend/src/lib/znet/index.ts`
- Modify: `core/test/solo.test.ts` (append)

**Interfaces:**
- Consumes: `TickSource`, `TickResult`, `NetplayCore` from `./session.js` (Task 1).
- Produces:
  - `interface SoloPads { pad1: number; pad2: number }`
  - `interface SoloOptions { core: NetplayCore; readLocalInput(): SoloPads; onFrame?(frame: number): void }`
  - `class SoloSession implements TickSource` with `tick()`, `pump()`, and a `currentFrame` getter.

### What this class is for

`NetplaySession` is 957 lines because two machines must stay byte-identical: a handshake, an input delay, a pad buffer per player, periodic checksums, desync detection, savestate resync. None of that means anything with one player. Routing solo through it by faking a peer would keep every cost and every failure mode and buy nothing.

So this class is interesting for what it lacks. What remains is: read the pads, run one frame, count it, notify.

- [ ] **Step 1: Write the failing tests**

Append to `core/test/solo.test.ts`:

```ts
import { SoloSession } from '../../frontend/src/lib/znet/solo.js';
import { FakeCore } from './fake-core.js';

test('a tick advances the machine by exactly one frame', () => {
  const core = new FakeCore();
  const session = new SoloSession({ core, readLocalInput: () => ({ pad1: 0, pad2: 0 }) });

  assert.equal(session.currentFrame, 0);
  session.tick();

  assert.equal(session.currentFrame, 1);
});

test('tick always reports that it ran - nothing waits on anyone in solo', () => {
  const core = new FakeCore();
  const session = new SoloSession({ core, readLocalInput: () => ({ pad1: 0, pad2: 0 }) });

  for (let i = 0; i < 10; i++) {
    assert.equal(session.tick(), 'ran', `tick ${i} must run; solo has nothing to stall on`);
  }
});

test('the pads read for a frame are the pads the core receives', () => {
  // FakeCore is deliberately input-sensitive and history-sensitive, so equal
  // final state after the same pad sequence is a real assertion: a pad dropped,
  // duplicated or applied a frame late leaves a different fingerprint.
  const viaSession = new FakeCore(0xfeed);
  const direct = new FakeCore(0xfeed);

  const pads = [
    { pad1: 0x0010, pad2: 0 },
    { pad1: 0x0080, pad2: 0 },
    { pad1: 0x0000, pad2: 0 },
    { pad1: 0x00c0, pad2: 0 }
  ];
  let i = 0;
  const session = new SoloSession({ core: viaSession, readLocalInput: () => pads[i++] });

  for (let n = 0; n < pads.length; n++) session.tick();
  for (const p of pads) direct.runFrame(p.pad1, p.pad2);

  assert.deepEqual(
    Array.from(viaSession.saveState()),
    Array.from(direct.saveState()),
    'the session must add nothing of its own to what the core sees'
  );
});

test('a second pad is passed through, so local co-op stays possible later', () => {
  const withP2 = new FakeCore(0xabcd);
  const withoutP2 = new FakeCore(0xabcd);

  const session = new SoloSession({
    core: withP2,
    readLocalInput: () => ({ pad1: 0x0010, pad2: 0x0020 })
  });
  session.tick();
  withoutP2.runFrame(0x0010, 0);

  assert.notDeepEqual(
    Array.from(withP2.saveState()),
    Array.from(withoutP2.saveState()),
    'pad2 must reach the core, or the pair in the signature is decoration'
  );
});

test('onFrame is called once per tick, with the frame that just finished', () => {
  const core = new FakeCore();
  const seen: number[] = [];
  const session = new SoloSession({
    core,
    readLocalInput: () => ({ pad1: 0, pad2: 0 }),
    onFrame: (frame) => seen.push(frame)
  });

  session.tick();
  session.tick();
  session.tick();

  assert.deepEqual(seen, [1, 2, 3]);
});

test('a session with no onFrame still runs', () => {
  const core = new FakeCore();
  const session = new SoloSession({ core, readLocalInput: () => ({ pad1: 0, pad2: 0 }) });

  assert.equal(session.tick(), 'ran');
});

test('pump does nothing observable - there is no peer to chase', () => {
  const core = new FakeCore();
  const before = Array.from(core.saveState());
  const session = new SoloSession({ core, readLocalInput: () => ({ pad1: 0, pad2: 0 }) });

  session.pump();
  session.pump();

  assert.equal(session.currentFrame, 0, 'pump must not advance the machine');
  assert.deepEqual(Array.from(core.saveState()), before, 'nor touch its state');
});

test('the input reader is called once per tick, not more', () => {
  // A reader called twice would poll the gamepad twice for one frame, which is
  // how an input gets silently applied to the wrong frame.
  const core = new FakeCore();
  let reads = 0;
  const session = new SoloSession({
    core,
    readLocalInput: () => {
      reads++;
      return { pad1: 0, pad2: 0 };
    }
  });

  session.tick();
  session.tick();

  assert.equal(reads, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/solo.test.ts
```

Expected: the two Task 1 tests still PASS; the eight new ones FAIL with `Cannot find module '.../znet/solo.js'`.

- [ ] **Step 3: Write the session**

Create `frontend/src/lib/znet/solo.ts`. Tabs for indentation.

```ts
/**
 * Solo play on the lockstep stack.
 *
 * This exists so that one player gets the same core, renderer, input and
 * audio path as two players do - and so that everything built for lockstep
 * (shaders, save thumbnails, the pause menu, the display toolbar) works in
 * solo without being built twice.
 *
 * It is interesting for what it does NOT have. NetplaySession is long because
 * two machines have to stay byte-identical: a handshake, a fixed input delay,
 * a pad buffer per player, periodic checksums, desync detection, savestate
 * resync. With one player none of that means anything, and routing solo
 * through it by inventing a peer would keep every cost and every failure mode
 * while buying nothing.
 *
 * Like NetplaySession, it owns no timers. FrameGovernor decides when a frame
 * should run; this only runs it.
 */

import type { NetplayCore, TickResult, TickSource } from './session.js';

/**
 * Both controller ports for one frame.
 *
 * A pair rather than a single mask, even though `pad2` is always 0 today: the
 * SNES has two ports, RetroArch's own config maps a second physical gamepad
 * to player 2, and whether the old solo path actually supported couch co-op is
 * not something this repo can test. Keeping the pair means adding a second
 * controller later changes a caller, not this class.
 */
export interface SoloPads {
	pad1: number;
	pad2: number;
}

export interface SoloOptions {
	core: NetplayCore;
	/** Called exactly once per frame, immediately before the frame runs. */
	readLocalInput(): SoloPads;
	/** Called after a frame has run, with the new frame count. */
	onFrame?(frame: number): void;
}

export class SoloSession implements TickSource {
	private core: NetplayCore;
	private readLocalInput: () => SoloPads;
	private onFrame: (frame: number) => void;

	/**
	 * Our own count, not the core's.
	 *
	 * NetplaySession does the same: the core's frame number is the emulated
	 * machine's business, and a savestate load moves it. This counts frames
	 * this session has run.
	 */
	private frame = 0;

	constructor(options: SoloOptions) {
		this.core = options.core;
		this.readLocalInput = options.readLocalInput;
		this.onFrame = options.onFrame ?? (() => {});
	}

	get currentFrame(): number {
		return this.frame;
	}

	/**
	 * Nothing to do.
	 *
	 * The governor calls this once per slice so a netplay session can retry
	 * handshakes and send round-trip probes. There is no one to talk to here.
	 */
	pump(): void {}

	/**
	 * Runs exactly one frame.
	 *
	 * Always 'ran'. A solo session cannot stall, because stalling means waiting
	 * for a pad that has not arrived and every pad here is already in hand.
	 */
	tick(): TickResult {
		const pads = this.readLocalInput();
		this.core.runFrame(pads.pad1, pads.pad2);
		this.frame++;
		this.onFrame(this.frame);
		return 'ran';
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/solo.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Export it, and check the timing constraint**

In `frontend/src/lib/znet/index.ts`, add after the `FrameGovernor` export block:

```ts
export { SoloSession } from './solo.js';
export type { SoloOptions, SoloPads } from './solo.js';
```

Then:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
grep -nE "requestAnimationFrame|setTimeout|setInterval|performance\.now|Date\.now" frontend/src/lib/znet/solo.ts
npm run check --workspace frontend 2>&1 | tail -3
npm run test:all 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: the grep returns **nothing** — a solo session that acquired a clock would be the one defect in this file that matters. 0 errors, and the ui group up to 90.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/znet/solo.ts frontend/src/lib/znet/index.ts core/test/solo.test.ts
git commit -m "Run one player on the lockstep core, without inventing a second"
```

---

## Task 3: A solo room that boots and plays

**Files:**
- Create: `frontend/src/lib/components/SoloRoom.svelte`
- Modify: `frontend/src/routes/room/[id]/+page.svelte` (the render branch around line 322-338, and its import block)

**Interfaces:**
- Consumes: `SoloSession`, `SoloOptions`, `SoloPads` (Task 2); `FrameGovernor`, `InputCollector`, `AudioSink`, `CanvasRenderer`, `WebglRenderer`, `loadShaderPreset`, `PsnesCore`, `loadCore`, `DEFAULT_DISPLAY`, `type DisplayOptions`, `type Renderer`, `type GamepadSource` — all from `$lib/znet`; `remember`, `resolveQuietly` from `$lib/roms/provider`; `LocateRom` and `VALID_SHADER_IDS` from the components directory.
- Produces: the `SoloRoom` component, taking `roomId`, `gameId`, `gameCrc32`, `gameTitle`, `keyConfig`.

### Why route it in this task rather than later

A component nothing renders cannot be exercised. Routing it here means this task's deliverable is a solo game that actually plays on the new stack, which is something a reviewer can judge. The chrome comes next.

### The two-canvas rule carries over

A `<canvas>` binds exactly one context type for its whole life: once it has produced a `2d` context, `getContext('webgl2')` returns `null` forever. So both canvases are declared in the markup and one is hidden — never one element reused, and never an element replaced at runtime, because `bind:this` leaves Svelte holding its own reference for directives and cleanup.

### The Svelte 4 reactivity rule carries over

Svelte 4 tracks dependencies syntactically and **does not trace into function bodies**. A dependency that appears only inside a called function is never tracked and the block silently stops re-running. Every reactive block must read its dependencies directly.

- [ ] **Step 1: Create the component**

Create `frontend/src/lib/components/SoloRoom.svelte`:

```svelte
<script lang="ts">
  /**
   * Solo play on the znet stack.
   *
   * The same primitives as LockstepRoom, minus everything about a peer: no
   * relay, no transport, no session handshake, no input delay, no resync. What
   * is left is a governor ticking a SoloSession, a renderer, audio, input, and
   * the same save and display chrome the lockstep room has.
   *
   * Solo used to run ClientEmulator on the RetroArch stack, which is why it
   * showed a "LATENCE" panel built for comparing streaming against dual, and
   * why it had none of the toolbar the lockstep room grew.
   */
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import LocateRom from './LocateRom.svelte';
  import { remember, resolveQuietly } from '$lib/roms/provider';
  import { VALID_SHADER_IDS } from './ShaderSelector.svelte';
  import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from '$lib/znet';
  import {
    AudioSink,
    CanvasRenderer,
    WebglRenderer,
    loadShaderPreset,
    FrameGovernor,
    InputCollector,
    SoloSession,
    type GamepadSource,
    PsnesCore,
    loadCore,
    normaliseRom
  } from '$lib/znet';

  export let roomId: string;
  export let gameId: string;
  export let gameCrc32: string | null = null;
  export let gameTitle: string = '';
  export let keyConfig: KeyConfig;

  const logger = createLogger('SoloRoom');

  /**
   * One canvas per context type.
   *
   * A canvas that has produced a webgl2 context can never produce a 2d one, so
   * switching renderers means switching elements. Both live in the markup and
   * one is hidden, which keeps Svelte the owner of both.
   */
  let canvas2d: HTMLCanvasElement;
  let canvasGl: HTMLCanvasElement;
  let usingGl = false;

  let core: PsnesCore | null = null;
  let renderer: Renderer | null = null;
  let audio: AudioSink | null = null;
  let collector: InputCollector | null = null;
  let session: SoloSession | null = null;
  let governor: FrameGovernor | null = null;

  let phase: 'booting' | 'playing' | 'error' = 'booting';
  let statusText = 'Loading emulator core…';
  let errorText = '';
  let needsAudioGesture = false;
  let romPrompt: ((bytes: Uint8Array) => void) | null = null;
  let loadedRom: Uint8Array | null = null;

  let display: DisplayOptions = { ...DEFAULT_DISPLAY };
  let shaderNotice: string | null = null;
  let shaderSwapToken = 0;
  let gamepadSource: GamepadSource = 'auto';

  const gamepadKey = 'psnes-gamepad-source';

  $: activeCanvas = usingGl ? canvasGl : canvas2d;
  $: if (renderer && display) renderer.setOptions(display);
  $: if (collector && keyConfig) collector.setKeyConfig(keyConfig);

  function shaderLabel(id: string): string {
    if (!id) return 'No shader';
    return id.split('/').pop() as string;
  }

  /** Drops back to the 2D renderer on its own canvas. Always succeeds. */
  function useCanvasRenderer(): void {
    renderer?.dispose();
    usingGl = false;
    // The button reads display.shader and nothing else, so leaving it set
    // would keep advertising a shader that is not running. The stored
    // preference is left alone: it is the player's choice, retried next boot.
    display = { ...display, shader: '' };
    renderer = new CanvasRenderer(canvas2d);
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  /**
   * Switches the renderer to run `shaderId`, or keeps 2D and says why.
   *
   * Every failure lands on a working 2D renderer plus a notice. The player is
   * never left looking at a black canvas wondering whether the game crashed.
   */
  async function applyShader(shaderId: string): Promise<void> {
    const token = ++shaderSwapToken;
    shaderNotice = null;

    if (!shaderId) {
      useCanvasRenderer();
      return;
    }

    const loaded = await loadShaderPreset(shaderId);
    if (token !== shaderSwapToken) return;

    if (!loaded.ok) {
      logger.warn('shader unavailable', { shaderId, reason: loaded.reason });
      shaderNotice = 'That shader could not be loaded; showing raw pixels.';
      useCanvasRenderer();
      return;
    }

    // The second dispose on the failure path below is safe: both renderers
    // guard every deletion and null what they delete.
    renderer?.dispose();

    const webgl = WebglRenderer.create(canvasGl, loaded.preset);
    if (!webgl) {
      logger.warn('webgl2 unavailable or the shader would not compile', { shaderId });
      shaderNotice = 'Shaders need WebGL2, which this browser did not provide.';
      useCanvasRenderer();
      return;
    }

    usingGl = true;
    renderer = webgl;
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  async function cycleShader(): Promise<void> {
    const next =
      VALID_SHADER_IDS[(VALID_SHADER_IDS.indexOf(display.shader) + 1) % VALID_SHADER_IDS.length];
    display = { ...display, shader: next };
    if (next) localStorage.setItem('psnes-shader', next);
    else localStorage.removeItem('psnes-shader');
    await applyShader(next);
  }

  /** Falls back to 2D if the GL context died mid-game. One boolean per slice. */
  function checkRendererHealth(): void {
    if (renderer instanceof WebglRenderer && renderer.unusable) {
      logger.warn('webgl context lost, falling back to 2D');
      shaderNotice = 'Hardware shaders stopped working; showing raw pixels.';
      useCanvasRenderer();
    }
  }

  /** Finds the ROM locally, then asks the player. There is no host to ask. */
  async function obtainRom(): Promise<Uint8Array> {
    if (!gameCrc32) {
      throw new Error('This room predates local ROMs; re-add the game to your library.');
    }

    const found = await resolveQuietly(gameCrc32);
    if (found) {
      logger.info(`Loaded the ROM from this machine (${found.byteLength} bytes)`, {
        crc32: gameCrc32
      });
      return found;
    }

    logger.info('No local copy found; asking the player', { crc32: gameCrc32 });
    statusText = 'Waiting for you to locate the ROM…';
    return new Promise<Uint8Array>((resolve) => {
      romPrompt = (bytes) => {
        romPrompt = null;
        statusText = 'Loading the ROM…';
        remember(bytes);
        resolve(bytes);
      };
    });
  }

  async function boot() {
    try {
      setLogLabels({ roomId, player: 'solo' });

      statusText = 'Loading emulator core…';
      core = await loadCore();

      statusText = 'Locating the ROM…';
      loadedRom = await obtainRom();
      core.loadRom(normaliseRom(loadedRom));

      const storedShader = localStorage.getItem('psnes-shader') || '';
      if (storedShader && !VALID_SHADER_IDS.includes(storedShader)) {
        localStorage.removeItem('psnes-shader');
      } else if (storedShader) {
        display = { ...display, shader: storedShader };
      }

      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      audio = new AudioSink();
      await audio.start(Math.round(core.sampleRate));
      needsAudioGesture = true;

      const saved = localStorage.getItem(gamepadKey);
      if (saved) gamepadSource = saved === 'auto' || saved === 'off' ? saved : Number(saved);
      collector = new InputCollector(keyConfig, gamepadSource);
      collector.attach();

      session = new SoloSession({
        core,
        // pad2 stays 0: znet reads a single local source today. The pair is in
        // the signature so a second controller changes this line and nothing
        // else.
        readLocalInput: () => ({ pad1: collector!.read(), pad2: 0 }),
        onFrame: () => {
          renderer!.draw(core!);
          audio!.push(core!.audio());
        }
      });

      governor = new FrameGovernor(session, {
        fps: core.fps || 60.0988,
        onSlice: () => checkRendererHealth()
      });
      governor.start();

      phase = 'playing';
      statusText = '';

      // After the session is running, so a slow CDN cannot delay the picture.
      if (display.shader) void applyShader(display.shader);
    } catch (err) {
      logger.error('Solo boot failed', err);
      errorText = err instanceof Error ? err.message : String(err);
      phase = 'error';
    }
  }

  async function startAudio() {
    needsAudioGesture = false;
    await audio?.resume();
  }

  function teardown() {
    governor?.stop();
    governor = null;
    session = null;
    collector?.detach();
    collector = null;
    void audio?.stop();
    audio = null;
    renderer?.dispose();
    renderer = null;
    core?.dispose();
    core = null;
  }

  onMount(() => {
    void boot();
  });

  onDestroy(() => {
    teardown();
  });
</script>

<div class="solo">
  <div class="screen">
    <canvas bind:this={canvas2d} class:inactive={usingGl} width="256" height="224"></canvas>
    <canvas bind:this={canvasGl} class:inactive={!usingGl} width="256" height="224"></canvas>

    {#if shaderNotice}
      <p class="shader-notice">{shaderNotice}</p>
    {/if}

    {#if phase !== 'playing'}
      <div class="overlay">
        {#if phase === 'error'}
          <p class="error">{errorText}</p>
        {:else}
          <p>{statusText}</p>
        {/if}
      </div>
    {/if}

    {#if needsAudioGesture}
      <button class="audio-gesture" on:click={startAudio}>Click for sound</button>
    {/if}
  </div>

  <div class="toolbar">
    <button
      class="action"
      class:on={display.shader !== ''}
      on:click={cycleShader}
      title="Shader"
    >{shaderLabel(display.shader)}</button>
  </div>
</div>

{#if romPrompt}
  <LocateRom checksum={gameCrc32 ?? ''} title={gameTitle} on:found={(e) => romPrompt?.(e.detail)} />
{/if}

<style>
  .solo {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .screen {
    position: relative;
    aspect-ratio: 4 / 3;
    background: #000;
  }

  canvas {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    display: block;
  }

  canvas.inactive {
    display: none;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
  }

  .error {
    color: #f87171;
    max-width: 32rem;
    text-align: center;
  }

  .shader-notice {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
    padding: 0.35rem 0.6rem;
    background: rgba(0, 0, 0, 0.6);
    color: #e0b040;
    font-size: 0.8rem;
    text-align: center;
  }

  .audio-gesture {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.5rem 1rem;
    border-radius: 6px;
    border: none;
    background: #667eea;
    color: #fff;
    cursor: pointer;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .action {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .action.on {
    background: #3a4a5a;
    border-color: #667eea;
  }
</style>
```

- [ ] **Step 2: Route the single-player branch to it**

In `frontend/src/routes/room/[id]/+page.svelte`, add to the import block (next to the existing `LockstepRoom` import):

```ts
  import SoloRoom from '$lib/components/SoloRoom.svelte';
```

Then find the render branch — it currently reads:

```svelte
    {#if activeEmulationMode === EmulationMode.LOCKSTEP}
```

and add a single-player branch **before** it, so solo never reaches either of the old components:

```svelte
    {#if activeEmulationMode === EmulationMode.SINGLE}
      <!-- Solo runs on the znet stack too now, so it gets the same core,
           renderer, shaders and save chrome the lockstep room has. -->
      <SoloRoom {roomId} gameId={room.gameId} gameCrc32={room.gameCrc32} gameTitle={room.gameTitle} {keyConfig} />
    {:else if activeEmulationMode === EmulationMode.LOCKSTEP}
```

Leave the `{:else}` P2PRoom branch exactly as it is — dual and streaming still go there.

- [ ] **Step 3: Verify it type-checks and nothing regressed**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -5
npm run test:all 2>&1 | grep -E "^# (tests|pass|fail)"
grep -nE "requestAnimationFrame|setTimeout|setInterval" frontend/src/lib/components/SoloRoom.svelte
```

Expected: **0 errors** (the warning count may rise, since this adds CSS), all tests still passing, and the grep returning nothing — `SoloRoom` composes a governor, it does not become one.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/SoloRoom.svelte frontend/src/routes/room/\[id\]/+page.svelte
git commit -m "Play solo on the same stack as lockstep"
```

---

## Task 4: The chrome solo was missing

**Files:**
- Modify: `frontend/src/lib/components/SoloRoom.svelte`

**Interfaces:**
- Consumes: everything from Task 3, plus `PauseMenu`, `LoadSavesMenu`, `SaveGameMenu` from the components directory.
- Produces: nothing for later tasks.

### What this adds and why it is a separate task

Task 3's deliverable is "solo plays on znet". This one is "solo has what lockstep has": the display toolbar, fullscreen, the two save menus with thumbnails, the pause menu, and battery-save persistence. A reviewer can meaningfully approve one and reject the other.

Battery saves are the important item. That is the *in-game* save — the one the player makes from the cartridge's own menu — and losing it would be a serious regression.

- [ ] **Step 1: Add the save adapter, SRAM persistence and the menus**

In `SoloRoom.svelte`'s script, add these imports next to the existing component imports:

```ts
  import PauseMenu from './PauseMenu.svelte';
  import LoadSavesMenu from './LoadSavesMenu.svelte';
  import SaveGameMenu from './SaveGameMenu.svelte';
```

Add state next to the other `let` declarations:

```ts
  let showPauseMenu = false;
  let showLoadMenu = false;
  let showSaveMenu = false;
  let isFullscreen = false;
  let sramTimer: ReturnType<typeof setInterval> | null = null;
  let container: HTMLDivElement;
```

Add the save adapter as a reactive statement, next to the existing ones:

```ts
  /**
   * What the save menus need: a state to store, and the canvas to photograph.
   *
   * `getCanvas` reads `activeCanvas` at call time, so a shader swap between
   * opening the menu and pressing the button still photographs what is on
   * screen.
   */
  $: saveAdapter = core
    ? { saveState: async () => core!.saveState(), getCanvas: () => activeCanvas }
    : null;
```

Add the battery-save functions:

```ts
  /**
   * Loads the battery save before the first frame runs.
   *
   * This is the in-game save - what the player writes from the cartridge's own
   * menu - so it is part of the emulated machine and has to be in place before
   * emulation starts.
   */
  function loadSram(): Promise<void> {
    return new Promise((resolve) => {
      const sock = $socket;
      if (!sock || !core) return resolve();

      const done = (data: { sramData: string | null }) => {
        sock.off('game:sramLoaded', done);
        try {
          if (data.sramData) {
            const binary = atob(data.sramData);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            core!.loadSram(bytes);
            logger.info('Battery save restored', { bytes: bytes.length });
          }
        } catch (err) {
          logger.error('Could not restore the battery save', err);
        }
        resolve();
      };

      sock.on('game:sramLoaded', done);
      sock.emit('game:loadSram', { roomId });
      // Never block the boot on a server that does not answer.
      setTimeout(() => {
        sock.off('game:sramLoaded', done);
        resolve();
      }, 5000);
    });
  }

  function persistSram(): void {
    if (!core || !$socket) return;
    const sram = core.sram();
    if (sram.length === 0) return;
    let binary = '';
    for (let i = 0; i < sram.length; i++) binary += String.fromCharCode(sram[i]);
    $socket.emit('game:saveSram', { roomId, sramData: btoa(binary) });
  }
```

In `boot()`, call `await loadSram();` immediately after `core.loadRom(...)` and before the renderer is built, and start the timer right after `governor.start()`:

```ts
      sramTimer = setInterval(persistSram, 30000);
```

In `teardown()`, before the rest:

```ts
    if (sramTimer) clearInterval(sramTimer);
    sramTimer = null;
    persistSram();
```

- [ ] **Step 2: Add fullscreen and the rest of the toolbar**

Add to the script:

```ts
  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container?.requestFullscreen();
    } catch (err) {
      logger.error('Could not toggle fullscreen', err);
    }
  }

  function onFullscreenChange(): void {
    isFullscreen = document.fullscreenElement !== null;
  }
```

Register and unregister it in `onMount` / `teardown`:

```ts
    document.addEventListener('fullscreenchange', onFullscreenChange);
```

```ts
    document.removeEventListener('fullscreenchange', onFullscreenChange);
```

Bind the container in the markup — change `<div class="solo">` to:

```svelte
<div class="solo" bind:this={container}>
```

And replace the whole `.toolbar` block with:

```svelte
  <div class="toolbar">
    <button class="action" class:on={isFullscreen} on:click={toggleFullscreen} title="Alt+Enter"
      >⛶ {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button
    >
    <button
      class="action"
      class:on={display.scanlines}
      disabled={usingGl}
      title={usingGl ? 'The shader owns the picture while one is active' : undefined}
      on:click={() => (display = { ...display, scanlines: !display.scanlines })}
    >Scanlines</button>
    <button
      class="action"
      on:click={() => (display = { ...display, pixelPerfect: !display.pixelPerfect })}
    >{display.pixelPerfect ? 'Sharp' : 'Smooth'}</button>
    <button
      class="action"
      on:click={() =>
        (display = { ...display, aspect: display.aspect === 'original' ? 'stretch' : 'original' })}
    >{display.aspect === 'original' ? 'Fit' : 'Stretch'}</button>
    <button
      class="action"
      class:on={display.shader !== ''}
      on:click={cycleShader}
      title="Shader"
    >{shaderLabel(display.shader)}</button>
    <button class="action" on:click={() => (showLoadMenu = true)}>Load game</button>
    <button class="action" on:click={() => (showSaveMenu = true)}>Save game</button>
  </div>
```

- [ ] **Step 3: Add the menus to the markup**

After the `{#if romPrompt}` block:

```svelte
{#if showLoadMenu}
  <LoadSavesMenu
    {roomId}
    {gameId}
    on:close={() => (showLoadMenu = false)}
  />
{/if}

{#if showSaveMenu}
  <SaveGameMenu
    {roomId}
    {gameId}
    emulator={saveAdapter}
    on:close={() => (showSaveMenu = false)}
  />
{/if}

{#if showPauseMenu}
  <PauseMenu
    {roomId}
    {gameId}
    {keyConfig}
    emulator={saveAdapter}
    restoreFullscreen={isFullscreen}
    on:close={() => (showPauseMenu = false)}
  />
{/if}
```

Add the disabled-button style next to `.action.on`:

```css
  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }
```

- [ ] **Step 4: Verify against the menus' real props**

The three menu components' props were read from source when this plan was written: `PauseMenu` takes `roomId`, `gameId`, `keyConfig`, `emulator`, `restoreFullscreen`; `LoadSavesMenu` takes `roomId`, `gameId`; `SaveGameMenu` takes `roomId`, `gameId`, `emulator`. Confirm they still match before trusting the markup above:

```bash
grep -n "export let" frontend/src/lib/components/PauseMenu.svelte frontend/src/lib/components/LoadSavesMenu.svelte frontend/src/lib/components/SaveGameMenu.svelte
```

If a prop has been added or renamed since, adjust the markup to what the component actually declares and say so in your report — do not pass a prop that does not exist.

- [ ] **Step 5: Verify it type-checks and the suite is green**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -5
npm run test:all 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: 0 errors, all tests passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/SoloRoom.svelte
git commit -m "Give solo the saves, the toolbar and the battery persistence it lacked"
```

---

## Task 5: Verification

**Files:**
- Create: `docs/superpowers/verification/2026-08-20-solo-on-znet.md`

**Interfaces:** consumes everything from Tasks 1-4.

### Why this is a task

`SoloSession` is fully unit-tested. `SoloRoom.svelte` is not testable here — no WebGL context under Node, no browser harness that loads a ROM — so this is the compensating control, and its output is a written record separating what was checked from what was not.

- [ ] **Step 1: Record what is mechanically verified**

Run and capture, verbatim:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all 2>&1 | grep -E "^# (tests|pass|fail)"
npm run check --workspace frontend 2>&1 | tail -3
npm run build --workspace frontend 2>&1 | tail -3
grep -nE "requestAnimationFrame|setTimeout|setInterval|performance\.now|Date\.now" frontend/src/lib/znet/solo.ts
```

The last one must return nothing.

Then the bundle check, which is stronger than a source grep because minification strips comments — it proves what ships rather than what the source says:

```bash
grep -rl "SoloSession\|solo" frontend/build/_app/immutable/ 2>/dev/null | wc -l
```

- [ ] **Step 2: Walk the browser checklist**

Open a room alone so it resolves to single-player, and check each:

- The game plays at full speed, with sound.
- **No "LATENCE" panel.** That was the report that started this work.
- The toolbar is present: fullscreen, scanlines, sharp/smooth, fit/stretch, shader, load, save.
- Cycling the shader works, and the fallback notice appears when a shader cannot load.
- Scanlines are disabled while a shader is active, and work without one.
- Saving produces a thumbnail; loading restores the state.
- **The battery save survives.** Save inside a game from its own menu, leave the room, come back, and confirm the in-game save is still there. This is the regression that would matter most.
- Turbo still works if it is wired to a key.
- **Two physical gamepads.** Plug in two and check whether the *old* solo path drove player 2 — run a room in the old dual mode or check out the previous commit if needed. This is the open question the spec refuses to settle from code: if the old path supported couch co-op, this migration lost it, and that must be written down rather than discovered later.

- [ ] **Step 3: Write and commit the record**

Create `docs/superpowers/verification/2026-08-20-solo-on-znet.md` with: the captured command output, the checklist with each item's outcome, the gamepad finding stated either way, and anything observed but not fixed.

```bash
git add docs/superpowers/verification/2026-08-20-solo-on-znet.md
git commit -m "Record what solo-on-znet was checked for, and what it still owes"
```

---

## Self-Review

**1. Spec coverage.** Walked each spec section against the plan:

| Spec section | Task |
|---|---|
| Why (the LATENCE panel, the missing toolbar) | Task 3 (no panel), Task 4 (toolbar), Task 5 (both confirmed) |
| Solo is a room with one player | Task 3 Step 2, the render branch |
| The contract, measured — `TickSource` | Task 1 |
| The solo session, and what it lacks | Task 2 |
| The component | Tasks 3 and 4 |
| Battery saves preserved, 30000 ms | Task 4 Step 1 |
| Turbo kept | inherited from `FrameGovernor`; Task 5 checks it |
| Slow motion and speed indicator dropped | honoured by omission; no task adds them |
| The open two-gamepad risk, pad pair in the signature | Task 2 (`SoloPads`, and the test that pad2 reaches the core), Task 5 Step 2 |
| Data flow | Task 3 (`onFrame` pushes to renderer and audio) |
| Error handling: no ROM, core fails, WebGL fails | Task 3 (`obtainRom`, the try/catch, `applyShader`) |
| Testable: `SoloSession` | Task 2, 8 tests |
| Testable: the governor takes both | Task 1, 2 tests plus the deliberate-break check |
| Not testable: the component | Task 5 |
| No mid-game mode switch | honoured by omission |
| Nothing deleted | honoured by omission; Task 3 Step 2 keeps the P2PRoom branch |

No gaps found.

**2. Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries its code. Task 5 is prose because its deliverable is an observation, and each item names the exact thing to check.

**3. Type consistency.** Checked the names crossing task boundaries:

- `TickSource` — defined Task 1 in `session.ts`, consumed by `governor.ts` in the same task and implemented by `SoloSession` in Task 2. Both methods' signatures match `NetplaySession`'s existing ones.
- `SoloPads` / `SoloOptions` — defined Task 2, consumed Task 3's `readLocalInput: () => ({ pad1: collector!.read(), pad2: 0 })`. Field names match.
- `SoloSession` — `tick()`, `pump()`, `currentFrame`. Task 3 constructs it with `core`, `readLocalInput`, `onFrame`; all three are in `SoloOptions`.
- `onFrame(frame: number)` — Task 2 passes the post-increment count; Task 3's handler ignores the argument, which is what `LockstepRoom` does too.
- `Renderer`, `DisplayOptions`, `WebglRenderer.create`, `.unusable`, `dispose()` — all from the WebGL work already on `main`. Note `unusable`, not `lost`: the field was renamed during that branch's final review, and Task 3's `checkRendererHealth` uses the new name.
- `saveAdapter` — Task 4 defines it and passes it as the `emulator` prop, which is what `LockstepRoom` does.

One inconsistency found and fixed while checking: an earlier draft of Task 3 called `renderer.lost`, the pre-rename name. Corrected to `unusable`.

## Risks recorded, not solved

- **`SoloRoom` and `LockstepRoom` now duplicate a lot**: the two-canvas setup, `applyShader`, `useCanvasRenderer`, `checkRendererHealth`, `cycleShader`, the display toolbar. That duplication is deliberate for now — extracting it would mean refactoring a 1358-line component that works, and doing that in the same change as a migration would make both harder to review. It is the obvious follow-up once solo is proven, and it will be cheaper after the old stack is deleted.
- **`loadSram`'s 5-second timeout is new.** `LockstepRoom` gates SRAM loading on being the host and has no timeout; solo has no host, so a server that never answers `game:loadSram` would hang the boot. The timeout is the fix, and it means a very slow server can start a game without its battery save rather than not starting at all. That trade is deliberate.
- **The room page's mode latch is untouched.** A room that starts solo and gains a player still behaves as it does today. Whether that should become a live transition is explicitly out of scope.
- **`SoloRoom` calls `collector.detach()` in teardown; `LockstepRoom` does not.** That is deliberate, and it is worth stating so nobody "fixes" the difference by copying the older component. `InputCollector.attach()` registers keydown and keyup handlers on `window` (`input.ts:115`), and `LockstepRoom` calls `attach()` at line 464 with no matching `detach()` anywhere — so its keyboard listeners outlive the room. This plan does not fix that, because it is a pre-existing defect in a component this work does not otherwise touch, and fixing it here would smuggle an unrelated change into a migration. It is reported separately.
