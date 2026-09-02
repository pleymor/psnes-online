# Meta Quest VR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Quest player enters an immersive session from the library, sees their games on a nearby panel, picks one, and plays it on a large curved screen with the two Touch controllers.

**Architecture:** three.js owns the scene and the WebXR plumbing; every panel is drawn to an offscreen 2D canvas and hit-tested through the `uv` a raycast returns, which keeps all layout in pure functions. The emulator is unchanged: `videoSurface()` uploads straight into a texture, and `FrameGovernor` gains an injectable scheduler so the XR frame loop drives slices without a second timer competing for the clock.

**Tech Stack:** SvelteKit 4 + Svelte 4, TypeScript strict, Bun (test and build), three.js, WebXR (`immersive-vr`).

**Spec:** `docs/superpowers/specs/2026-09-02-vr-meta-quest-design.md`

## Global Constraints

- **Runtime is Bun, never npm or node.** Tests run with `bun test`, scripts with `bun run`.
- **Frontend tests live in `core/test/*.test.ts`**, never beside the source. Imports reach the source as `../../frontend/src/lib/<path>.js` — with a `.js` extension even though the file is `.ts`.
- **Test style is `import { test } from 'bun:test'` plus `import assert from 'node:assert/strict'`.** Not `expect`. See `core/test/input-devices.test.ts` for the canonical shape.
- **Every new test file MUST be added by hand to the `test:ui` script list in the root `package.json`.** A file absent from that list never runs. Commit `cec4257` ("Run the three test files nobody was running") exists because this was missed.
- **Every new module and test file opens with a doc comment that says WHY**, in the register of `znet/devices.ts` and `rooms/renderer-surface.ts`: the rule being upheld and the failure it prevents, not a restatement of the code. English.
- **Anything a browser provides is a parameter, never a global reach.** `shader-preference.ts:10` states the rule: "Takes its storage rather than reaching for `localStorage`, so it can be tested without a browser."
- **`three` is the only new runtime dependency permitted.** No UI library, no `html2canvas`, no Babylon.
- **No user-agent sniffing anywhere.** Capability detection only.
- **TypeScript `strict: true`.** `bun run check` (in `frontend/`) must pass at every commit.
- **The shader is forced to `''` in VR, and the stored preference is left untouched** — the pattern `renderer-surface.ts:44` already describes.
- Commit subjects are imperative sentences in English, in the voice of the existing log ("Rescan the ROM folder from the library"). Docs and specs are French; code comments are English.

## Two refinements to the spec, decided here

**1. `solo-engine` is narrower than the spec's signature.** The spec listed `controls` and `applySources()` on the engine, which would put `InputCollector` inside it. `InputCollector.attach()` calls `window.addEventListener`, so an engine that builds one cannot be tested under Bun — and more importantly, the two presentations genuinely differ here: `SoloRoom` reads keyboard + pads + touch, `VrShell` reads `XRInputSource`. Input therefore stays with the caller and the engine takes a `readPads` function. What remains shared is the fiddly part: ROM load, SRAM (initial read, the 30 s timer, the final write), audio start, session, governor, and teardown ordering.

**2. `FrameGovernor` needs an injectable scheduler (Task 2), which the spec did not name.** The spec correctly observed that `schedule()` (`governor.ts:139`) already picks between rAF and a worker timer, but `requestAnimationFrame` is hardcoded there and `schedule()` is private. `window.requestAnimationFrame` is not the display's clock once a headset is presenting, and the WebXR spec permits a user agent to throttle it freely — so relying on it would be a bet. One optional option field, defaulting to today's behaviour, resolves it.

---

### Task 1: Extract `solo-engine.ts` from `SoloRoom.boot()`

Lands before any VR code, verified by the solo game that already works.

**Files:**
- Create: `frontend/src/lib/rooms/solo-engine.ts`
- Modify: `frontend/src/lib/components/SoloRoom.svelte:463-583` (`boot`), `:784` (`teardown`), `:455` (`persistSram`), `:561` (the SRAM timer)
- Test: `core/test/solo-engine.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `PsnesCore` (`znet/core.ts`), `SoloSession` (`znet/solo.ts`), `FrameGovernor` (`znet/governor.ts`), `normaliseRom` (`znet/index.ts`).
- Produces:
  ```ts
  export interface SramPort { load(): Promise<Uint8Array | null>; save(bytes: Uint8Array): void }
  export interface AudioPort { start(sampleRate: number): Promise<void>; push(samples: Int16Array): void }
  export interface SoloEngineOptions {
    core: PsnesCore;
    rom: Uint8Array;
    sram: SramPort;
    audio: AudioPort;
    readPads: () => { pad1: number; pad2: number };
    onFrame: (core: PsnesCore, frame: number) => void;
    onError: (err: unknown) => void;
    /** Forwarded to FrameGovernor. Omitted on the flat path. See Task 2. */
    schedule?: (run: () => void) => void;
  }
  export interface SoloEngine {
    session: SoloSession;
    governor: FrameGovernor;
    stop(): Promise<void>;
  }
  export function createSoloEngine(options: SoloEngineOptions): Promise<SoloEngine>;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/solo-engine.test.ts`:

```ts
/**
 * The solo boot sequence, without a DOM.
 *
 * `SoloRoom.boot()` held this as 120 lines of component script, so a VR shell
 * that wanted the same sequence had to copy it - and the next SRAM fix would
 * then have reached only one of the two copies. What is under test is the
 * ordering that a copy gets wrong: the ROM is loaded before the session exists,
 * the stored SRAM is applied before the first frame runs, and `stop()` writes
 * the SRAM one last time. Without that final write, up to 30 seconds of
 * progress dies with the session, because the periodic timer is all there was.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSoloEngine } from '../../frontend/src/lib/rooms/solo-engine.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';

/** Enough of `PsnesCore` for the engine: what it loads, runs and reports. */
function fakeCore() {
  const calls: string[] = [];
  let frame = 0;
  const core = {
    fps: 60.0988,
    sampleRate: 32040,
    frame: 0,
    loadRom(bytes: Uint8Array) { calls.push(`loadRom:${bytes.length}`); },
    loadSram(bytes: Uint8Array) { calls.push(`loadSram:${bytes.length}`); },
    // `core.sram()`, not `saveSram()` - see `rooms/sram.ts`'s `SramCore`.
    sram: () => new Uint8Array([7, 7, 7]),
    runFrame() { frame++; core.frame = frame; calls.push('runFrame'); },
    audio: () => new Int16Array(0),
    videoSurface: () => ({ data: new Uint8Array(0), width: 256, height: 224, stride: 512 })
  };
  return { core: core as unknown as PsnesCore, calls };
}

function fakePorts() {
  const saved: Uint8Array[] = [];
  const started: number[] = [];
  return {
    saved,
    started,
    sram: { load: async () => new Uint8Array([1, 2]), save: (b: Uint8Array) => void saved.push(b) },
    audio: { start: async (rate: number) => void started.push(rate), push: () => {} }
  };
}

test('the ROM is loaded, then the stored SRAM, before any frame runs', async () => {
  const { core, calls } = fakeCore();
  const ports = fakePorts();
  const engine = await createSoloEngine({
    core,
    rom: new Uint8Array(1024),
    sram: ports.sram,
    audio: ports.audio,
    readPads: () => ({ pad1: 0, pad2: 0 }),
    onFrame: () => {},
    onError: (e) => assert.fail(String(e))
  });

  assert.deepEqual(
    calls.filter((c) => c !== 'runFrame'),
    ['loadRom:1024', 'loadSram:2'],
    'a ROM applied after the SRAM would discard the save'
  );
  assert.deepEqual(ports.started, [32040], 'audio starts at the core\'s rate, not a guess');
  await engine.stop();
});

test('stop() writes the SRAM one last time', async () => {
  const { core } = fakeCore();
  const ports = fakePorts();
  const engine = await createSoloEngine({
    core,
    rom: new Uint8Array(8),
    sram: ports.sram,
    audio: ports.audio,
    readPads: () => ({ pad1: 0, pad2: 0 }),
    onFrame: () => {},
    onError: (e) => assert.fail(String(e))
  });

  assert.equal(ports.saved.length, 0, 'nothing is written before the session ends');
  await engine.stop();
  assert.equal(ports.saved.length, 1, 'the last 30 seconds must not die with the session');
  assert.deepEqual([...ports.saved[0]], [7, 7, 7]);
});

test('onFrame receives the core and a rising frame number', async () => {
  const { core } = fakeCore();
  const ports = fakePorts();
  const seen: number[] = [];
  const engine = await createSoloEngine({
    core,
    rom: new Uint8Array(8),
    sram: ports.sram,
    audio: ports.audio,
    readPads: () => ({ pad1: 0, pad2: 0 }),
    onFrame: (c, frame) => { assert.equal(c, core); seen.push(frame); },
    onError: (e) => assert.fail(String(e))
  });

  engine.session.tick();
  engine.session.tick();
  assert.deepEqual(seen, [1, 2], 'the presentation port is the only thing the engine tells');
  await engine.stop();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/solo-engine.test.ts`
Expected: FAIL — `Cannot find module '.../rooms/solo-engine.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/rooms/solo-engine.ts`:

```ts
/**
 * The solo boot sequence, with the presentation as a port.
 *
 * This was 120 lines inside `SoloRoom.boot()`. A VR shell needs the same
 * sequence with a different picture, and copying it would guarantee that the
 * next SRAM or teardown fix reaches only one of the two.
 *
 * What is deliberately NOT here: the core load, the ROM resolution and the
 * input collectors. The first two are one line each at the call site; the third
 * differs completely between the two presentations - keyboard, pads and a touch
 * pad on a flat screen, `XRInputSource` in a headset - and `InputCollector`
 * reaches `window`, which would make this untestable for no gain.
 *
 * Everything a browser provides arrives as a parameter, for the reason
 * `stores/shader-preference.ts:10` gives: so it can be tested without one.
 */

import { FrameGovernor } from '$lib/znet/governor';
import { SoloSession } from '$lib/znet/solo';
import { normaliseRom } from '$lib/znet';
import type { PsnesCore } from '$lib/znet/core';

/** Where a cartridge save comes from and goes. Room- and socket-shaped at the
 * call site; the engine only needs the two verbs. */
export interface SramPort {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): void;
}

/** The part of `AudioSink` the engine drives. */
export interface AudioPort {
  start(sampleRate: number): Promise<void>;
  push(samples: Int16Array): void;
}

export interface SoloEngineOptions {
  /** Already loaded by the caller: `await loadCore()`. */
  core: PsnesCore;
  /** Already resolved by the caller. In VR there is no file picker to fall back
   * on, so the resolution cannot live behind this boundary. */
  rom: Uint8Array;
  sram: SramPort;
  audio: AudioPort;
  readPads: () => { pad1: number; pad2: number };
  /** The only thing the engine tells anyone. `SoloRoom` draws; `VrShell`
   * uploads a texture. */
  onFrame: (core: PsnesCore, frame: number) => void;
  onError: (err: unknown) => void;
  /**
   * Where the governor schedules its next slice, when it must not be window
   * rAF.
   *
   * Omitted on the flat path, which keeps today's behaviour. Passed by the VR
   * shell, because window rAF is not the display's clock once a headset is
   * presenting - see `znet/governor.ts`'s note on this option. Without this
   * field the injectable scheduler could never reach the emulator, since the
   * governor is constructed in here and nowhere else.
   */
  schedule?: (run: () => void) => void;
}

export interface SoloEngine {
  session: SoloSession;
  governor: FrameGovernor;
  stop(): Promise<void>;
}

/** How often the cartridge save is written while playing. `stop()` writes once
 * more, so this interval is the worst case for a crash, not for a clean exit. */
const SRAM_INTERVAL_MS = 30_000;

export async function createSoloEngine(options: SoloEngineOptions): Promise<SoloEngine> {
  const { core, rom, sram, audio, readPads, onFrame, onError } = options;

  // Order matters and is the thing a copy gets wrong: a ROM loaded after the
  // SRAM discards the save, and a session that exists before the ROM would run
  // a frame on an empty machine.
  core.loadRom(normaliseRom(rom));

  const stored = await sram.load();
  if (stored && stored.length > 0) core.loadSram(stored);

  await audio.start(Math.round(core.sampleRate));

  const session = new SoloSession({
    core,
    readLocalInput: readPads,
    onFrame: (frame) => {
      try {
        onFrame(core, frame);
        audio.push(core.audio());
      } catch (err) {
        onError(err);
      }
    }
  });

  const governor = new FrameGovernor(session, {
    fps: core.fps || 60.0988,
    // Solo has no peer to freeze by pausing, which is the reason
    // `SoloRoom.svelte:552` gives for the same value.
    keepRunningWhenHidden: false,
    // Undefined on the flat path, which leaves the governor on rAF exactly as
    // before. Spread rather than assigned so `exactOptionalPropertyTypes`
    // cannot object to an explicit undefined.
    ...(options.schedule ? { schedule: options.schedule } : {})
  });

  const timer = setInterval(() => persist(), SRAM_INTERVAL_MS);

  function persist(): void {
    try {
      // `core.sram()` (`znet/core.ts:259`), not `saveSram` - that name belongs
      // to savestates. An empty array means the cartridge has no battery,
      // which `rooms/sram.ts` is the module that knows.
      const bytes = core.sram();
      if (bytes && bytes.length > 0) sram.save(bytes);
    } catch (err) {
      onError(err);
    }
  }

  async function stop(): Promise<void> {
    governor.stop();
    clearInterval(timer);
    // Last, and unconditionally: without it the periodic timer is all there
    // was, so a clean exit loses up to SRAM_INTERVAL_MS of play.
    persist();
  }

  return { session, governor, stop };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/solo-engine.test.ts`
Expected: PASS, 3 tests.

Note: `governor.start()` is deliberately NOT called by the engine — the caller starts it once its picture is ready, which is what lets the test tick the session by hand.

- [ ] **Step 5: Rewire `SoloRoom.svelte` onto the engine**

In `boot()`, replace the block from `renderer = new CanvasRenderer(canvas2d)` through `governor.start()` with a call to `createSoloEngine`, keeping the collectors, `applySources`, `matchWatch`, the socket wiring and the shader application exactly where they are:

```ts
      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      audio = new AudioSink();
      // Constructed here, not in the engine: `needsAudioGesture` is a piece of
      // this screen's state and the engine has no screen.
      assignments = loadAssignments(localStorage);
      const pads = connectedPads();
      const sources = resolveSources(assignments, pads);
      showTouchPad = touchPadWanted(pads.length);

      collector1 = new InputCollector(controls.p1, sources.p1);
      collector1.attach();
      collector1.setTouchPad(touchPad);
      collector2 = new InputCollector(controls.p2, sources.p2);
      collector2.attach();

      window.addEventListener('gamepadconnected', applySources);
      window.addEventListener('gamepaddisconnected', applySources);

      matchWatch = createMatchWatch();

      engine = await createSoloEngine({
        core,
        rom: loadedRom,
        sram: {
          load: () => readStoredSram(),   // the body loadSram() had
          save: (bytes) => sendSram(bytes) // the body persistSram() had
        },
        audio,
        readPads: () => ({
          pad1: collector1!.read(),
          pad2: allowLocalPlayer2 && isPlayerActive(assignments.p2) ? collector2!.read() : 0
        }),
        onFrame: (c, frame) => {
          renderer!.draw(c);
          matchWatch?.observe(frame);
        },
        onError: (err) => logger.error('solo engine', err)
      });
      session = engine.session;
      governor = engine.governor;
      needsAudioGesture = audio.needsGesture;
      governor.start();
```

Three deletions and one reshaping:

- `core.loadRom(normaliseRom(loadedRom))` goes — the engine does it.
- `sramTimer` and its `setInterval` go — the engine owns the schedule. `teardown()` calls `await engine?.stop()` in place of `governor?.stop()` plus `clearInterval(sramTimer)`.
- **`loadSram()` is reshaped.** Today (`SoloRoom.svelte:345`) it resolves `Promise<void>` and applies the bytes to the core itself. The port needs the bytes instead, so it becomes `readStoredSram(): Promise<Uint8Array | null>`: the same socket round trip and the same `SRAM_UNAVAILABLE_NOTICE` / `SRAM_DECODE_ERROR_NOTICE` handling, but it `resolve(decodeSram(data.sramData))` rather than calling `core.loadSram`. The engine applies it, which is what puts the ordering under test.
- **`persistSram()` keeps its guards and loses its encoding.** It becomes `sendSram(bytes: Uint8Array)`: `if (!sramLoaded) return;` and the `$socket` check stay; `encodeSram(core)` becomes `toBase64(bytes)` (`saves/base64.ts`), since the engine has already read `core.sram()` and refused an empty one.

- [ ] **Step 6: Verify nothing regressed**

Run: `bun run test:ui && bun run test:netplay && cd frontend && bun run check`
Expected: PASS throughout. `test:ui` should report one more file than before once Step 7 lands.

Then play a solo game by hand and confirm: the picture appears, sound plays, a cartridge save survives a quit and a relaunch.

- [ ] **Step 7: Register the test file and commit**

Add `core/test/solo-engine.test.ts` to the `test:ui` list in `package.json`, then:

```bash
git add package.json core/test/solo-engine.test.ts frontend/src/lib/rooms/solo-engine.ts frontend/src/lib/components/SoloRoom.svelte
git commit -m "Lift the solo boot sequence out of SoloRoom

A VR shell needs the same sequence with a different picture, and a copy is
how the next SRAM fix reaches only one of them. The input collectors stay
behind: the two presentations genuinely differ there, and InputCollector
reaches window, which would cost the engine its tests for nothing."
```

---

### Task 2: Give `FrameGovernor` an injectable scheduler

The one change to netcode-adjacent code. It lands alone, verified by the full netplay suite, before any VR module exists.

**Files:**
- Modify: `frontend/src/lib/znet/governor.ts:15-35` (`GovernorOptions`), `:139-146` (`schedule`)
- Create: `frontend/src/lib/vr/frame-pump.ts`
- Test: `core/test/frame-pump.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Produces:
  ```ts
  // GovernorOptions gains:
  schedule?: (run: () => void) => void;

  // vr/frame-pump.ts
  export interface FramePump {
    schedule: (run: () => void) => void;
    pump: () => void;
  }
  export function createFramePump(): FramePump;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/frame-pump.test.ts`:

```ts
/**
 * Who gets to schedule a governor slice.
 *
 * `FrameGovernor` is the only timer owner in the znet stack, and it hardcoded
 * `requestAnimationFrame`. That is not the display's clock once a headset is
 * presenting - the WebXR spec lets a user agent throttle window rAF freely -
 * so an immersive session driven by it would be a bet on browser behaviour.
 *
 * The governor keeps its one-slice-at-a-time contract: it asks for exactly one
 * callback and asks again from inside the slice. `FramePump` is the adapter
 * that lets three.js's continuous animation loop satisfy that contract, and the
 * property under test is that a frame with no slice pending does nothing rather
 * than running the previous slice twice.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createFramePump } from '../../frontend/src/lib/vr/frame-pump.js';
import { FrameGovernor } from '../../frontend/src/lib/znet/governor.js';
import type { TickSource } from '../../frontend/src/lib/znet/session.js';

class Counting implements TickSource {
  pumps = 0;
  ticks = 0;
  pump(): void { this.pumps++; }
  tick(): 'ran' | 'stalled' | 'idle' { this.ticks++; return 'ran'; }
}

test('a pump with nothing scheduled does nothing', () => {
  const pump = createFramePump();
  pump.pump();
  pump.pump();
  // No throw, and no stale callback replayed - that is the whole assertion.
  let ran = 0;
  pump.schedule(() => ran++);
  pump.pump();
  assert.equal(ran, 1);
  pump.pump();
  assert.equal(ran, 1, 'one schedule is one run, however many frames arrive');
});

test('the governor takes its slices from the pump instead of rAF', () => {
  const pump = createFramePump();
  const source = new Counting();

  // No document and no rAF: if the governor still reached for either, this
  // would throw rather than quietly pass.
  const g = globalThis as unknown as Record<string, unknown>;
  const savedDocument = g.document;
  const savedRaf = g.requestAnimationFrame;
  delete g.document;
  delete g.requestAnimationFrame;
  try {
    const governor = new FrameGovernor(source, { fps: 60, schedule: pump.schedule });
    governor.start();
    assert.equal(source.pumps, 0, 'start() schedules a slice, it does not run one');

    pump.pump();
    assert.equal(source.pumps, 1, 'the slice ran when the XR frame arrived');

    pump.pump();
    assert.equal(source.pumps, 2, 'and it rescheduled itself from inside the slice');

    governor.stop();
    pump.pump();
    assert.equal(source.pumps, 2, 'a stopped governor ignores a frame already in flight');
  } finally {
    if (savedDocument === undefined) delete g.document; else g.document = savedDocument;
    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/frame-pump.test.ts`
Expected: FAIL — `Cannot find module '.../vr/frame-pump.js'`

- [ ] **Step 3: Write `frame-pump.ts`**

`frontend/src/lib/vr/frame-pump.ts`:

```ts
/**
 * The adapter between three.js's animation loop and FrameGovernor's contract.
 *
 * The governor asks for exactly one callback at a time and asks again from
 * inside the slice it just ran. three.js's `setAnimationLoop` is the opposite
 * shape: one callback, invoked every XR frame forever. This holds the pending
 * slice and hands it over once, so a frame that arrives with nothing scheduled
 * does nothing instead of replaying the previous slice - which would run the
 * emulator at the headset's refresh rate rather than the SNES's.
 *
 * Pure on purpose: no three, no XR, no clock. It is the seam that makes the
 * governor's new option testable under Bun.
 */

export interface FramePump {
  /** Handed to `GovernorOptions.schedule`. */
  schedule: (run: () => void) => void;
  /** Called once per XR frame from the animation loop. */
  pump: () => void;
}

export function createFramePump(): FramePump {
  let pending: (() => void) | null = null;
  return {
    schedule: (run) => { pending = run; },
    pump: () => {
      const run = pending;
      // Cleared before running: the slice reschedules from inside itself, and
      // clearing afterwards would throw that new callback away.
      pending = null;
      run?.();
    }
  };
}
```

- [ ] **Step 4: Add the option to `governor.ts`**

In `GovernorOptions` (after `keepRunningWhenHidden`):

```ts
	/**
	 * Where the next slice is scheduled while the tab is visible.
	 *
	 * Defaults to `requestAnimationFrame`, which is what every caller wanted
	 * until an immersive XR session turned up: window rAF is not the display's
	 * clock once a headset is presenting, and the WebXR spec lets a user agent
	 * throttle it freely. `vr/frame-pump.ts` is what goes here.
	 *
	 * It returns nothing, because cancellation does not go through it:
	 * `stop()` sets `running` false and `slice()` returns immediately when it
	 * is. A scheduler therefore never needs a handle to cancel.
	 */
	schedule?: (run: () => void) => void;
```

Store it in the constructor as `private scheduler: ((run: () => void) => void) | null = options.schedule ?? null;` and change `schedule()`:

```ts
	private schedule(): void {
		if (typeof document !== 'undefined' && document.hidden && this.keepRunningWhenHidden) {
			this.startWorker();
			return;
		}
		if (this.scheduler) {
			this.scheduler(() => this.slice());
			return;
		}
		this.handle = requestAnimationFrame(() => this.slice());
	}
```

`stop()` and `reschedule()` need no change: `this.handle` stays null on the scheduler path, `cancelAnimationFrame(null)` is never reached because both guard on `this.handle !== null`, and `running = false` is what actually stops a slice in flight.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test core/test/frame-pump.test.ts && bun run test:netplay && bun run test:core`
Expected: PASS throughout. The netplay and core suites are the real gate here — they exercise the governor's default path, which must be untouched.

- [ ] **Step 6: Register the test file and commit**

Add `core/test/frame-pump.test.ts` to `test:ui`, then:

```bash
git add package.json core/test/frame-pump.test.ts frontend/src/lib/vr/frame-pump.ts frontend/src/lib/znet/governor.ts
git commit -m "Let something other than window rAF schedule a governor slice

window rAF is not the display's clock once a headset is presenting, and the
spec lets a user agent throttle it freely. One optional option, defaulting
to today's behaviour, plus the adapter that turns three.js's continuous loop
back into the governor's one-slice-at-a-time contract."
```

---

### Task 3: `vr/support.ts` and `vr/entry.ts` — the door

**Files:**
- Create: `frontend/src/lib/vr/support.ts`, `frontend/src/lib/vr/entry.ts`
- Test: `core/test/vr-support.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Produces:
  ```ts
  // support.ts
  export interface XrCapableNavigator { xr?: { isSessionSupported(mode: string): Promise<boolean> } }
  export function vrAvailable(nav?: XrCapableNavigator | undefined): Promise<boolean>;
  // entry.ts
  export const vrRequested: Writable<boolean>;
  export const vrActive: Writable<boolean>;
  export function requestVr(): void;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-support.test.ts`:

```ts
/**
 * Whether the button exists at all.
 *
 * The issue asked to "detect a Meta Quest user". Sniffing the user agent for
 * `OculusBrowser` would answer a question the browser answers better and would
 * rot on Meta's next release, so the door is capability only:
 * `isSessionSupported('immersive-vr')`. That also says yes on a PC with a
 * tethered headset, which is deliberate - the assumption "two controllers and
 * nothing else" only has to hold *inside* the session.
 *
 * Every failure is a false, never a throw: `isSessionSupported` rejects with a
 * SecurityError when a permissions policy blocks XR, and a library page that
 * exploded over an absent headset would be a worse bug than a missing button.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { vrAvailable } from '../../frontend/src/lib/vr/support.js';

test('no navigator at all is simply no VR', async () => {
  assert.equal(await vrAvailable(undefined), false);
});

test('a browser without navigator.xr is no VR', async () => {
  assert.equal(await vrAvailable({}), false);
});

test('a headset that answers yes opens the door', async () => {
  const asked: string[] = [];
  const nav = {
    xr: { isSessionSupported: async (mode: string) => { asked.push(mode); return true; } }
  };
  assert.equal(await vrAvailable(nav), true);
  assert.deepEqual(asked, ['immersive-vr'], 'inline-vr is not what this feature is');
});

test('a headset that answers no closes it', async () => {
  const nav = { xr: { isSessionSupported: async () => false } };
  assert.equal(await vrAvailable(nav), false);
});

test('a rejection is a false, not a throw', async () => {
  const nav = {
    xr: { isSessionSupported: async () => { throw new DOMException('blocked', 'SecurityError'); } }
  };
  assert.equal(await vrAvailable(nav), false, 'a permissions policy must not break the library page');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-support.test.ts`
Expected: FAIL — `Cannot find module '.../vr/support.js'`

- [ ] **Step 3: Write both modules**

`frontend/src/lib/vr/support.ts`:

```ts
/**
 * The one question about the headset that the browser can answer honestly.
 *
 * No user-agent sniffing: `OculusBrowser` in a UA string is a fact about a
 * release, not about a capability, and it rots. `isSessionSupported` is the
 * capability itself.
 *
 * It says yes on a PC with a tethered headset too. That is intended: such a
 * player sees the button, and pressing it gives them the same experience a
 * Quest player gets, because the inputs arrive through `XRInputSource` whatever
 * the hardware. Their flat-screen settings sit untouched behind it.
 *
 * Takes its navigator, for the reason `znet/devices.ts:73` takes its own.
 */

export interface XrCapableNavigator {
  xr?: { isSessionSupported(mode: string): Promise<boolean> };
}

export async function vrAvailable(
  nav: XrCapableNavigator | undefined = globalThis.navigator as XrCapableNavigator | undefined
): Promise<boolean> {
  if (!nav?.xr?.isSessionSupported) return false;
  try {
    return await nav.xr.isSessionSupported('immersive-vr');
  } catch {
    // A permissions policy can reject this. A missing button is a far better
    // outcome than a library page that throws over an absent headset.
    return false;
  }
}
```

`frontend/src/lib/vr/entry.ts`:

```ts
/**
 * The two bits of state the top bar and the shell share.
 *
 * The button lives in `TopBar` and the scene lives in `VrShell`, mounted in the
 * layout - they cannot call each other, so they meet here. The same shape as
 * `rooms/room-intent.ts`: a store and a verb, no logic.
 *
 * `vrActive` is read by more than the shell: `+layout.svelte`'s `room:opened`
 * handler consults it before navigating, because a `goto` under an immersive
 * session would mount a second emulator behind it.
 */

import { writable } from 'svelte/store';

/** Set by the button, cleared by the shell once it has acted. */
export const vrRequested = writable(false);

/** True from `requestSession` resolving until `sessionend`. */
export const vrActive = writable(false);

export function requestVr(): void {
  vrRequested.set(true);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-support.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-support.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-support.test.ts frontend/src/lib/vr/support.ts frontend/src/lib/vr/entry.ts
git commit -m "Ask the browser whether it has a headset, not the user agent"
```

---

### Task 4: `vr/pad-scheme.ts` — the stored preset

**Files:**
- Create: `frontend/src/lib/vr/pad-scheme.ts`
- Test: `core/test/vr-pad-scheme.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `PreferenceStorage` from `stores/shader-preference.ts`.
- Produces:
  ```ts
  export type VrPadScheme = 'letters' | 'thumb';
  export const VR_PAD_KEY = 'psnes-vr-pad';
  export function readPadScheme(storage: PreferenceStorage): VrPadScheme;
  export function writePadScheme(storage: PreferenceStorage, scheme: VrPadScheme): void;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-pad-scheme.test.ts`:

```ts
/**
 * Which of the two Touch presets a player chose.
 *
 * The SNES has four action buttons in a diamond under one thumb; the Touch
 * controllers have four in two vertical pairs, one per hand. There is no
 * natural correspondence, so there are two presets, and `letters` is the
 * default because "press B" naming the button marked B surprises nobody.
 *
 * The storage rules are `shader-preference.ts`'s, for its reasons: an unknown
 * value is purged on read rather than returned, and the key is removed rather
 * than emptied so no reader has to treat '' and absent as the same thing.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  readPadScheme,
  writePadScheme,
  VR_PAD_KEY
} from '../../frontend/src/lib/vr/pad-scheme.js';

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    seen: () => [...map.entries()]
  };
}

test('an untouched machine gets the letters preset', () => {
  assert.equal(readPadScheme(fakeStorage()), 'letters');
});

test('a stored preset comes back', () => {
  assert.equal(readPadScheme(fakeStorage({ [VR_PAD_KEY]: 'thumb' })), 'thumb');
});

test('an unknown value is purged rather than returned', () => {
  const storage = fakeStorage({ [VR_PAD_KEY]: 'southpaw' });
  assert.equal(readPadScheme(storage), 'letters');
  assert.deepEqual(storage.seen(), [], 'a value no reader accepts is worse than no value');
});

test('writing the default removes the key rather than storing it', () => {
  const storage = fakeStorage({ [VR_PAD_KEY]: 'thumb' });
  writePadScheme(storage, 'letters');
  assert.deepEqual(storage.seen(), [], 'absent and default must be one state, not two');
  assert.equal(readPadScheme(storage), 'letters');
});

test('writing the non-default stores it', () => {
  const storage = fakeStorage();
  writePadScheme(storage, 'thumb');
  assert.deepEqual(storage.seen(), [[VR_PAD_KEY, 'thumb']]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-pad-scheme.test.ts`
Expected: FAIL — `Cannot find module '.../vr/pad-scheme.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/pad-scheme.ts`:

```ts
/**
 * Which Touch preset drives the four SNES action buttons.
 *
 * The issue said not to offer controls settings at all. Choosing between two
 * presets is not rebinding button by button: nobody has to build a mapping, but
 * a player whose thumb lands on the wrong button can fix it in one click. That
 * is the whole of the rectification.
 *
 * The storage discipline is `stores/shader-preference.ts`'s, quoted there:
 * "Removing rather than storing an empty string means no reader has to treat ''
 * and absent as the same thing - which is exactly the sort of equivalence one
 * of four readers eventually forgets."
 *
 * localStorage rather than the account, for v1: no schema change and no
 * migration for a setting that exists in one mode. The honest cost is two
 * headsets, two settings.
 */

import type { PreferenceStorage } from '$lib/stores/shader-preference';

export type VrPadScheme = 'letters' | 'thumb';

export const VR_PAD_KEY = 'psnes-vr-pad';

/** The one a player gets without asking. */
const DEFAULT_SCHEME: VrPadScheme = 'letters';

const SCHEMES: readonly VrPadScheme[] = ['letters', 'thumb'];

function isScheme(value: string): value is VrPadScheme {
  return (SCHEMES as readonly string[]).includes(value);
}

export function readPadScheme(storage: PreferenceStorage): VrPadScheme {
  const stored = storage.getItem(VR_PAD_KEY);
  if (!stored) return DEFAULT_SCHEME;
  if (!isScheme(stored)) {
    storage.removeItem(VR_PAD_KEY);
    return DEFAULT_SCHEME;
  }
  return stored;
}

export function writePadScheme(storage: PreferenceStorage, scheme: VrPadScheme): void {
  if (scheme === DEFAULT_SCHEME) {
    storage.removeItem(VR_PAD_KEY);
    return;
  }
  if (!isScheme(scheme)) return;
  storage.setItem(VR_PAD_KEY, scheme);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-pad-scheme.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-pad-scheme.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-pad-scheme.test.ts frontend/src/lib/vr/pad-scheme.ts
git commit -m "Store which of the two Touch presets a player picked"
```

---

### Task 5: `vr/pad.ts` — two controllers into a 12-bit mask

**Files:**
- Create: `frontend/src/lib/vr/pad.ts`
- Test: `core/test/vr-pad.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `PAD`, `PadMask` (`znet/protocol.ts:31`); `VrPadScheme` (Task 4).
- Produces:
  ```ts
  export interface PadLikeSource { handedness: string; gamepad?: { buttons: readonly { pressed: boolean }[]; axes: readonly number[] } | null }
  export const XR_AXIS_THRESHOLD = 0.5;
  export function readVrPad(sources: Iterable<PadLikeSource>, scheme: VrPadScheme, visibility: string): PadMask;
  export function menuPressed(sources: Iterable<PadLikeSource>): boolean;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-pad.test.ts`:

```ts
/**
 * Two Touch controllers read as one SNES pad.
 *
 * Two traps, both silent if got wrong.
 *
 * The first is `xr-standard` versus `standard`. A Touch thumbstick reports on
 * `axes[2]`/`axes[3]`; the first two axes belong to a touchpad these
 * controllers do not have. `controls/binding.ts:71-75`'s `STANDARD_PAD` steers
 * on axes 0 and 1 (`PadAxis1Minus` for up, `PadAxis0Minus` for left), so
 * reusing that table would yield a dead d-pad with no error and no
 * warning - which is exactly why this module has its own table and shares no
 * codes with `InputCollector`.
 *
 * The second is `visible-blurred`. When the Quest system menu opens, the XR
 * animation loop keeps firing but input stops being delivered. A button held at
 * that instant would stay held forever and the character would run right on its
 * own. This returns a zero mask instead - the same reasoning as
 * `InputCollector.onBlur = () => this.held.clear()` (`znet/input.ts:66`).
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readVrPad, menuPressed, XR_AXIS_THRESHOLD } from '../../frontend/src/lib/vr/pad.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

/** An `XRInputSource`-shaped controller. `xr-standard` button order:
 *  0 trigger, 1 squeeze, 2 touchpad (absent), 3 thumbstick press,
 *  4 lower face button (A / X), 5 upper face button (B / Y). */
function controller(handedness: 'left' | 'right', opts: {
  buttons?: number[];
  stick?: [number, number];
} = {}) {
  const pressed = new Set(opts.buttons ?? []);
  const [x, y] = opts.stick ?? [0, 0];
  return {
    handedness,
    gamepad: {
      buttons: Array.from({ length: 6 }, (_, i) => ({ pressed: pressed.has(i) })),
      axes: [0, 0, x, y]
    }
  };
}

test('nothing pressed is a zero mask', () => {
  assert.equal(readVrPad([controller('left'), controller('right')], 'letters', 'visible'), 0);
});

test('letters: what is written on the controller is what the game names', () => {
  const mask = readVrPad(
    [controller('left', { buttons: [4, 5] }), controller('right', { buttons: [4, 5] })],
    'letters',
    'visible'
  );
  // left lower = X -> SNES X, left upper = Y -> SNES Y,
  // right lower = A -> SNES A, right upper = B -> SNES B
  assert.equal(mask, PAD.X | PAD.Y | PAD.A | PAD.B);
});

test('letters puts the Mario jump on the upper right button', () => {
  const upperRight = readVrPad([controller('right', { buttons: [5] })], 'letters', 'visible');
  assert.equal(upperRight, PAD.B, 'SNES B is the bottom of the diamond but the top of the hand');
});

test('thumb: the jump moves to where the thumb already rests', () => {
  const lowerRight = readVrPad([controller('right', { buttons: [4] })], 'thumb', 'visible');
  assert.equal(lowerRight, PAD.B, 'Quest A carries SNES B under the thumb');

  const upperRight = readVrPad([controller('right', { buttons: [5] })], 'thumb', 'visible');
  assert.equal(upperRight, PAD.A);

  const lowerLeft = readVrPad([controller('left', { buttons: [4] })], 'thumb', 'visible');
  assert.equal(lowerLeft, PAD.Y, 'Quest X carries SNES Y - run, held constantly');

  const upperLeft = readVrPad([controller('left', { buttons: [5] })], 'thumb', 'visible');
  assert.equal(upperLeft, PAD.X);
});

test('the preset touches only the four face buttons', () => {
  const shoulders = [
    controller('left', { buttons: [0, 1] }),
    controller('right', { buttons: [0, 1] })
  ];
  const expected = PAD.L | PAD.SELECT | PAD.R | PAD.START;
  assert.equal(readVrPad(shoulders, 'letters', 'visible'), expected);
  assert.equal(readVrPad(shoulders, 'thumb', 'visible'), expected, 'shoulders and Start are not a preference');
});

test('the d-pad comes off axes 2 and 3, never 0 and 1', () => {
  const dead = readVrPad([controller('left', { stick: [-1, -1] })], 'letters', 'visible');
  assert.notEqual(dead, 0, 'a stick read on axes 0/1 would report nothing here');
  assert.equal(dead, PAD.LEFT | PAD.UP);

  assert.equal(
    readVrPad([controller('left', { stick: [1, 1] })], 'letters', 'visible'),
    PAD.RIGHT | PAD.DOWN
  );
});

test('the stick has to be pushed past the threshold to count', () => {
  const under = XR_AXIS_THRESHOLD - 0.01;
  assert.equal(readVrPad([controller('left', { stick: [under, 0] })], 'letters', 'visible'), 0);
  const over = XR_AXIS_THRESHOLD + 0.01;
  assert.equal(readVrPad([controller('left', { stick: [over, 0] })], 'letters', 'visible'), PAD.RIGHT);
});

test('only the left stick steers', () => {
  assert.equal(readVrPad([controller('right', { stick: [-1, 0] })], 'letters', 'visible'), 0);
});

test('a blurred session reads as nothing held', () => {
  const held = [controller('right', { buttons: [4, 5] }), controller('left', { stick: [1, 0] })];
  assert.equal(readVrPad(held, 'letters', 'visible'), PAD.A | PAD.B | PAD.RIGHT);
  assert.equal(readVrPad(held, 'letters', 'visible-blurred'), 0, 'the system menu must not weld a button down');
  assert.equal(readVrPad(held, 'letters', 'hidden'), 0);
});

test('a controller with no gamepad is skipped rather than fatal', () => {
  const sources = [
    { handedness: 'right', gamepad: null },
    { handedness: 'none' },
    controller('left', { buttons: [0] })
  ];
  assert.equal(readVrPad(sources, 'letters', 'visible'), PAD.L);
});

test('the right thumbstick click is the way back to the panels', () => {
  assert.equal(menuPressed([controller('right', { buttons: [3] })]), true);
  assert.equal(menuPressed([controller('left', { buttons: [3] })]), false, 'the left click is Select-adjacent, not the menu');
  assert.equal(menuPressed([controller('right', { buttons: [4] })]), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-pad.test.ts`
Expected: FAIL — `Cannot find module '.../vr/pad.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/pad.ts`:

```ts
/**
 * Two Touch controllers, one 12-bit SNES mask.
 *
 * It produces exactly what `InputCollector.read()` produces and shares none of
 * its codes, on purpose. `controls/binding.ts`'s `STANDARD_PAD` speaks the
 * `standard` gamepad mapping, where the left stick is axes 0 and 1. A Touch
 * controller speaks `xr-standard`, where axes 0 and 1 belong to a touchpad it
 * does not have and the stick is on 2 and 3. Reusing that table gives a dead
 * d-pad with no error and no warning, so the two tables stay apart.
 *
 * Pure, and it reaches for nothing: the sources and the session's visibility
 * both arrive as arguments. That is what lets both presets and the
 * blurred-session rule be tested under Bun.
 */

import { PAD, type PadMask } from '$lib/znet/protocol';
import type { VrPadScheme } from './pad-scheme';

/** The part of `XRInputSource` this reads. */
export interface PadLikeSource {
  handedness: string;
  gamepad?: {
    buttons: readonly { pressed: boolean }[];
    axes: readonly number[];
  } | null;
}

/** The same value `znet/input.ts:31` uses, so a stick feels the same in both
 * modes. */
export const XR_AXIS_THRESHOLD = 0.5;

/* `xr-standard` button indices. Named because `buttons[5]` at a call site is
 * how the two face buttons end up swapped by someone counting from the wrong
 * end. */
const TRIGGER = 0;
const SQUEEZE = 1;
const STICK_CLICK = 3;
const FACE_LOWER = 4;
const FACE_UPPER = 5;

/** The thumbstick, and the reason this module exists. */
const STICK_X = 2;
const STICK_Y = 3;

/**
 * The four action buttons, per preset: [upper, lower] of each hand.
 *
 * The SNES diamond (X top, Y left, A right, B bottom) has to fold onto two
 * vertical pairs, and no folding is free. `letters` keeps the printed letter
 * honest. `thumb` puts SNES B (jump) and SNES Y (run) on the two lower buttons,
 * where the thumbs already rest.
 */
const FACE: Record<VrPadScheme, { left: [number, number]; right: [number, number] }> = {
  letters: { left: [PAD.Y, PAD.X], right: [PAD.B, PAD.A] },
  thumb: { left: [PAD.X, PAD.Y], right: [PAD.A, PAD.B] }
};

function held(source: PadLikeSource, index: number): boolean {
  return source.gamepad?.buttons[index]?.pressed === true;
}

export function readVrPad(
  sources: Iterable<PadLikeSource>,
  scheme: VrPadScheme,
  visibility: string
): PadMask {
  // The system menu leaves the animation loop running and stops delivering
  // input. A button held at that moment would stay held for the rest of the
  // session.
  if (visibility !== 'visible') return 0;

  let mask = 0;
  const face = FACE[scheme];

  for (const source of sources) {
    if (!source.gamepad) continue;

    if (source.handedness === 'left') {
      if (held(source, FACE_UPPER)) mask |= face.left[0];
      if (held(source, FACE_LOWER)) mask |= face.left[1];
      if (held(source, TRIGGER)) mask |= PAD.L;
      if (held(source, SQUEEZE)) mask |= PAD.SELECT;

      // Only the left stick steers: a d-pad on both hands would fight itself
      // the moment a player rested a thumb on the right one.
      const x = source.gamepad.axes[STICK_X] ?? 0;
      const y = source.gamepad.axes[STICK_Y] ?? 0;
      if (x <= -XR_AXIS_THRESHOLD) mask |= PAD.LEFT;
      if (x >= XR_AXIS_THRESHOLD) mask |= PAD.RIGHT;
      if (y <= -XR_AXIS_THRESHOLD) mask |= PAD.UP;
      if (y >= XR_AXIS_THRESHOLD) mask |= PAD.DOWN;
    } else if (source.handedness === 'right') {
      if (held(source, FACE_UPPER)) mask |= face.right[0];
      if (held(source, FACE_LOWER)) mask |= face.right[1];
      if (held(source, TRIGGER)) mask |= PAD.R;
      if (held(source, SQUEEZE)) mask |= PAD.START;
    }
  }

  return mask;
}

/**
 * The right thumbstick click, which is the only way out.
 *
 * The Quest's menu button is reserved by the system and delivers nothing to the
 * page, so there is no hardware button available for "leave". This recalls the
 * panels, and the profile band carries the exit.
 */
export function menuPressed(sources: Iterable<PadLikeSource>): boolean {
  for (const source of sources) {
    if (source.handedness === 'right' && held(source, STICK_CLICK)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-pad.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-pad.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-pad.test.ts frontend/src/lib/vr/pad.ts
git commit -m "Read two Touch controllers as one SNES pad

Its own code table, sharing none with InputCollector: a Touch thumbstick is
on axes 2 and 3 under xr-standard, and STANDARD_PAD codes axes 0 and 1, so
the shared table would have produced a dead d-pad with no error at all.
A blurred session reads as nothing held, or the system menu welds down
whatever was pressed when it opened."
```

---

### Task 6: `vr/layout.ts` — where everything sits

Every distance and angle in the scene lives here, pure and three-free, so it can be tuned at the headset without touching anything that draws.

**Files:**
- Create: `frontend/src/lib/vr/layout.ts`
- Test: `core/test/vr-layout.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `PixelAspect`, `aspectRatioOf` (`znet/fit.ts:27`).
- Produces:
  ```ts
  export interface Placement {
    position: [number, number, number];
    /** Radians, [pitch, yaw, 0]. */
    rotation: [number, number, number];
    /** Metres. */
    width: number;
    height: number;
  }
  export interface ScreenPlacement {
    radius: number;
    /** Radians of arc the cylinder segment covers. */
    arc: number;
    height: number;
    centerY: number;
  }
  export interface SceneLayout {
    screen: ScreenPlacement;
    library: Placement;
    friends: Placement;
    profile: Placement;
  }
  export const DEFAULT_EYE_HEIGHT = 1.6;
  export function sceneLayout(aspect: PixelAspect, eyeHeight?: number): SceneLayout;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-layout.test.ts`:

```ts
/**
 * Where the screen and the three panels sit, and why it is a pure function.
 *
 * None of these numbers will be right first time - they are reasoned starting
 * points, not measurements, and the only way to settle them is a headset on a
 * head. Keeping them in one module with no three.js import is what makes
 * tuning them a one-file change instead of a hunt through scene code.
 *
 * What the tests pin is not the numbers but the relationships that make the
 * "cockpit" layout the thing that was chosen: the panels are nearer than the
 * screen (legibility follows angular distance, which is what ruled out putting
 * all three on one 3 m arc), they are below eye level, and they are exact
 * mirrors. Break any of those and it is a different design.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sceneLayout,
  DEFAULT_EYE_HEIGHT
} from '../../frontend/src/lib/vr/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('layout.ts imports nothing from three', () => {
  // The whole point of this module is that it is tunable and testable without
  // a renderer. A stray `import * as THREE` here would take both away, and it
  // is the sort of import that arrives while adding "just one Vector3".
  const source = readFileSync(
    path.resolve(here, '..', '..', 'frontend', 'src', 'lib', 'vr', 'layout.ts'),
    'utf8'
  );
  assert.equal(/from ['"]three['"]/.test(source), false, 'layout.ts must stay three-free');
});

test('the screen is a wide arc at arm-and-then-some length', () => {
  const { screen } = sceneLayout('crt');
  assert.equal(screen.radius, 2.5);
  assert.ok(screen.arc > 0.9 && screen.arc < 1.2, 'about 60 degrees of arc, in radians');
  assert.equal(screen.centerY, DEFAULT_EYE_HEIGHT, 'the picture is at eye level, not above it');
});

test('the screen takes its shape from the aspect preference', () => {
  const crt = sceneLayout('crt').screen;
  const square = sceneLayout('square').screen;

  // Arc length is the screen's width; the height follows the ratio the player
  // chose, so 'crt' is the 4:3 the games were composed for.
  const crtWidth = crt.radius * crt.arc;
  const squareWidth = square.radius * square.arc;
  assert.ok(Math.abs(crtWidth / crt.height - 4 / 3) < 1e-9);
  assert.ok(Math.abs(squareWidth / square.height - 8 / 7) < 1e-9);
  assert.ok(crt.height < square.height, '4:3 is a shorter picture than 8:7 at one width');
});

test('the panels are nearer than the screen, which is the whole of the choice', () => {
  const { screen, library, friends, profile } = sceneLayout('crt');
  for (const [name, panel] of [['library', library], ['friends', friends], ['profile', profile]] as const) {
    const [x, , z] = panel.position;
    const distance = Math.hypot(x, z);
    assert.ok(
      distance < screen.radius,
      `${name} must be nearer than the screen: legibility follows angular distance`
    );
  }
});

test('the panels sit below eye level, to be found by looking down', () => {
  const eye = 1.75;
  const { library, friends, profile } = sceneLayout('crt', eye);
  assert.ok(library.position[1] < eye);
  assert.ok(friends.position[1] < eye);
  assert.ok(profile.position[1] < library.position[1], 'the band is the lowest: it is used least');
});

test('the two lecterns are exact mirrors', () => {
  const { library, friends } = sceneLayout('crt');
  // A tolerance rather than equality: these come out of Math.sin and Math.cos,
  // whose exact sign symmetry is not something the language guarantees. A
  // picometre of asymmetry is not a layout bug; a centimetre would be, and
  // this still catches that.
  const mirrors = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

  mirrors(library.position[0], -friends.position[0], 'library left, friends right');
  mirrors(library.position[1], friends.position[1], 'same height');
  mirrors(library.position[2], friends.position[2], 'same depth');
  mirrors(library.rotation[1], -friends.rotation[1], 'each yaws inward by the same amount');
  mirrors(library.rotation[0], friends.rotation[0], 'both pitch back identically');
  assert.equal(library.width, friends.width);
  assert.equal(library.height, friends.height);
});

test('everything is in front of the player', () => {
  const layout = sceneLayout('crt');
  for (const panel of [layout.library, layout.friends, layout.profile]) {
    assert.ok(panel.position[2] < 0, 'three.js looks down -Z; a positive z is behind the head');
  }
});

test('the lecterns pitch back so a lowered panel faces raised eyes', () => {
  const { library } = sceneLayout('crt');
  assert.ok(library.rotation[0] < 0, 'a negative pitch tips the top away and the face upward');
  assert.ok(Math.abs(library.rotation[0]) > 0.5, 'and by a real amount, not a token degree');
});

test('a headset that gives no floor still gets a sane scene', () => {
  const assumed = sceneLayout('crt');
  const explicit = sceneLayout('crt', DEFAULT_EYE_HEIGHT);
  assert.deepEqual(assumed, explicit, "the 'local' fallback must not be a special case elsewhere");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-layout.test.ts`
Expected: FAIL — `Cannot find module '.../vr/layout.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/layout.ts`:

```ts
/**
 * Every distance and angle in the VR scene, in one three-free module.
 *
 * None of these numbers is measured. They are reasoned starting points, and the
 * only way to settle them is to put a headset on: that is precisely why they
 * live apart from anything that draws, so tuning them is a one-file change.
 *
 * The layout is the "cockpit" of the three that were considered. The screen is
 * a wide arc at 2.5 m; the two lecterns are much nearer, lower, and yawed
 * inward. That nearness is the entire reason this shape won - legibility
 * follows angular distance, not panel size, so a cover grid on a 3 m arc is
 * unreadable however large the panel is.
 *
 * Coordinates are three.js's: the player stands at the origin looking down -Z,
 * +X to their right, +Y up.
 */

import { aspectRatioOf, type PixelAspect } from '$lib/znet/fit';

export interface Placement {
  position: [number, number, number];
  /** Radians, `[pitch, yaw, 0]`. Negative pitch tips the top away from the
   * player, turning a lowered panel's face up toward the eyes. */
  rotation: [number, number, number];
  /** Metres. */
  width: number;
  height: number;
}

export interface ScreenPlacement {
  radius: number;
  /** Radians of arc the cylinder segment covers. */
  arc: number;
  height: number;
  centerY: number;
}

export interface SceneLayout {
  screen: ScreenPlacement;
  library: Placement;
  friends: Placement;
  profile: Placement;
}

/** Used when the headset refuses `local-floor` and there is no real floor to
 * measure from. A guess is better than a scene on the ground. */
export const DEFAULT_EYE_HEIGHT = 1.6;

const SCREEN_RADIUS = 2.5;
/** 60 degrees. Wide enough to fill the view, narrow enough that the edges are
 * not behind the player's cheekbones. */
const SCREEN_ARC = Math.PI / 3;

const LECTERN_DISTANCE = 1.2;
/** 60 degrees off centre: peripheral, so it is not in the way, but reachable by
 * a glance rather than a turn of the whole body. */
const LECTERN_AZIMUTH = Math.PI / 3;
/** How far below the eyes the lecterns hang. */
const LECTERN_DROP = 0.45;
/** 40 degrees, tipped back so a lowered panel faces raised eyes. */
const LECTERN_PITCH = -(Math.PI * 40) / 180;
const LECTERN_WIDTH = 0.7;
const LECTERN_HEIGHT = 0.5;

const BAND_DISTANCE = 1.0;
const BAND_DROP = 0.75;
const BAND_PITCH = -(Math.PI * 55) / 180;
const BAND_WIDTH = 0.9;
const BAND_HEIGHT = 0.3;

/**
 * A lectern at `azimuth`, facing the player.
 *
 * The yaw is the negative of the azimuth: a plane's normal starts at +Z, and
 * rotating by -azimuth about Y turns it back toward the origin. Getting the
 * sign wrong here shows the player the back of an invisible panel, which reads
 * as "the panel did not load".
 */
function lectern(azimuth: number, eyeHeight: number): Placement {
  return {
    position: [
      LECTERN_DISTANCE * Math.sin(azimuth),
      eyeHeight - LECTERN_DROP,
      -LECTERN_DISTANCE * Math.cos(azimuth)
    ],
    rotation: [LECTERN_PITCH, -azimuth, 0],
    width: LECTERN_WIDTH,
    height: LECTERN_HEIGHT
  };
}

export function sceneLayout(
  aspect: PixelAspect,
  eyeHeight: number = DEFAULT_EYE_HEIGHT
): SceneLayout {
  // Arc length is the screen's width, so the height is what the player's
  // aspect choice actually decides.
  const screenWidth = SCREEN_RADIUS * SCREEN_ARC;

  return {
    screen: {
      radius: SCREEN_RADIUS,
      arc: SCREEN_ARC,
      height: screenWidth / aspectRatioOf(aspect),
      centerY: eyeHeight
    },
    library: lectern(-LECTERN_AZIMUTH, eyeHeight),
    friends: lectern(LECTERN_AZIMUTH, eyeHeight),
    profile: {
      position: [0, eyeHeight - BAND_DROP, -BAND_DISTANCE],
      rotation: [BAND_PITCH, 0, 0],
      width: BAND_WIDTH,
      height: BAND_HEIGHT
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-layout.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-layout.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-layout.test.ts frontend/src/lib/vr/layout.ts
git commit -m "Put every VR distance and angle in one three-free module

None of these numbers is measured, which is exactly why they live apart from
anything that draws: settling them needs a headset, and that should be a
one-file change. The tests pin the relationships rather than the values -
panels nearer than the screen, below eye level, exact mirrors - because those
are what make this the cockpit layout rather than a different design."
```

---

### Task 7: `vr/panel.ts` — the bridge between a raycast and a canvas

The seam the spec's testing strategy rests on. It owns no canvas and no texture: it is only the coordinate model, which is what makes every panel's layout a pure function.

**Files:**
- Create: `frontend/src/lib/vr/panel.ts`
- Test: `core/test/vr-panel.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Produces:
  ```ts
  export interface Region { id: string; x: number; y: number; w: number; h: number }
  export interface PanelSize { width: number; height: number }
  export interface Uv { x: number; y: number }
  export function uvToCanvas(uv: Uv, size: PanelSize): { x: number; y: number };
  export function hit(regions: readonly Region[], uv: Uv, size: PanelSize): Region | null;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-panel.test.ts`:

```ts
/**
 * Turning a raycast hit into a button press.
 *
 * There is no DOM in an immersive session, so a panel is a canvas drawn by hand
 * and a list of rectangles. All the pointing reduces to this: three.js hands
 * back a `uv` on the mesh, and this says which rectangle that is.
 *
 * The one trap is the v axis, and it is the same trap `znet/webgl-renderer.ts`
 * spends a paragraph on: a plane's uv has v = 0 at the BOTTOM, while a canvas
 * has y = 0 at the TOP. So v is flipped exactly once, here. Get it wrong and
 * every click lands on the button vertically opposite the one being pointed at
 * - which looks like a random mis-click rather than an inverted axis, and is
 * therefore very hard to spot from a headset.
 *
 * Keeping this pure is the whole reason panel layout is testable at all: no
 * canvas, no texture, no three. Those belong to `scene.ts`.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { hit, uvToCanvas, type Region } from '../../frontend/src/lib/vr/panel.js';

const SIZE = { width: 800, height: 400 };

test('v is flipped exactly once, from GL bottom-up to canvas top-down', () => {
  assert.deepEqual(uvToCanvas({ x: 0, y: 1 }, SIZE), { x: 0, y: 0 }, 'uv top is canvas top');
  assert.deepEqual(uvToCanvas({ x: 0, y: 0 }, SIZE), { x: 0, y: 400 }, 'uv bottom is canvas bottom');
  assert.deepEqual(uvToCanvas({ x: 1, y: 0.5 }, SIZE), { x: 800, y: 200 });
});

const REGIONS: Region[] = [
  { id: 'first', x: 0, y: 0, w: 100, h: 50 },
  { id: 'second', x: 0, y: 60, w: 100, h: 50 },
  { id: 'wide', x: 200, y: 0, w: 400, h: 400 }
];

test('a point inside a rectangle finds it', () => {
  // Canvas y = 25 is uv v = 1 - 25/400.
  const found = hit(REGIONS, { x: 50 / 800, y: 1 - 25 / 400 }, SIZE);
  assert.equal(found?.id, 'first');
});

test('the flip is not cosmetic: the wrong sign hits the wrong button', () => {
  // Aim at 'second', whose canvas band is y 60..110.
  const uv = { x: 50 / 800, y: 1 - 85 / 400 };
  assert.equal(hit(REGIONS, uv, SIZE)?.id, 'second');
  // The same v read without flipping lands at canvas y 315, which is inside
  // nothing here - so a broken flip shows up as a dead panel, not as a
  // plausible-looking wrong answer.
  const unflipped = { x: 50 / 800, y: 85 / 400 };
  assert.equal(hit(REGIONS, unflipped, SIZE), null);
});

test('the gap between two rectangles is nothing at all', () => {
  const found = hit(REGIONS, { x: 50 / 800, y: 1 - 55 / 400 }, SIZE);
  assert.equal(found, null, 'a click in a margin must not fall through to a neighbour');
});

test('edges belong to the rectangle, inclusively on the near side', () => {
  assert.equal(hit(REGIONS, { x: 0, y: 1 }, SIZE)?.id, 'first', 'the top-left corner is inside');
  // Canvas y = 50 is 'first''s bottom edge and 'second' does not start until 60.
  assert.equal(hit(REGIONS, { x: 0, y: 1 - 50 / 400 }, SIZE)?.id, 'first');
  // One pixel past it is outside.
  assert.equal(hit(REGIONS, { x: 0, y: 1 - 50.5 / 400 }, SIZE), null);
});

test('the first matching rectangle wins, so order is the z-order', () => {
  const overlapping: Region[] = [
    { id: 'on-top', x: 0, y: 0, w: 100, h: 100 },
    { id: 'beneath', x: 0, y: 0, w: 800, h: 400 }
  ];
  assert.equal(hit(overlapping, { x: 0.01, y: 0.99 }, SIZE)?.id, 'on-top');
  assert.equal(hit(overlapping, { x: 0.9, y: 0.1 }, SIZE)?.id, 'beneath');
});

test('a uv outside the mesh hits nothing rather than clamping', () => {
  assert.equal(hit(REGIONS, { x: -0.1, y: 0.5 }, SIZE), null);
  assert.equal(hit(REGIONS, { x: 1.1, y: 0.5 }, SIZE), null);
  assert.equal(hit(REGIONS, { x: 0.5, y: 1.2 }, SIZE), null);
});

test('an empty region list is simply no hit', () => {
  assert.equal(hit([], { x: 0.5, y: 0.5 }, SIZE), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-panel.test.ts`
Expected: FAIL — `Cannot find module '.../vr/panel.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/panel.ts`:

```ts
/**
 * The coordinate model every VR panel shares.
 *
 * A panel is a canvas drawn by hand plus a list of rectangles, because an
 * immersive session has no DOM to reuse. Pointing at one reduces entirely to
 * this module: three.js reports a `uv` on the mesh, and this says which
 * rectangle it is.
 *
 * It owns no canvas, no texture and no three import, and that is the point.
 * Panel layout is therefore a pure function returning `Region[]`, testable
 * under Bun; only the `fillText` calls that consume those regions are not.
 * `scene.ts` owns the canvases and the textures.
 */

export interface Region {
  /** What the panel's click handler switches on. Stable across redraws. */
  id: string;
  /** Canvas pixels, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface Uv {
  x: number;
  y: number;
}

/**
 * A mesh `uv` in canvas pixels.
 *
 * The v flip is the only interesting line in this file, and it is the same
 * reversal `znet/webgl-renderer.ts` reasons about at length: a plane's uv has
 * v = 0 at the bottom, a canvas has y = 0 at the top, so the axis is reversed
 * exactly once - here, and nowhere else.
 */
export function uvToCanvas(uv: Uv, size: PanelSize): { x: number; y: number } {
  return { x: uv.x * size.width, y: (1 - uv.y) * size.height };
}

/**
 * Which region a raycast landed on, or null.
 *
 * A uv outside the unit square returns null rather than being clamped: a ray
 * that missed the mesh must not be reported as a press on its nearest edge.
 *
 * The first match wins, so the caller's array order is its z-order.
 */
export function hit(
  regions: readonly Region[],
  uv: Uv,
  size: PanelSize
): Region | null {
  if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;

  const { x, y } = uvToCanvas(uv, size);
  for (const region of regions) {
    if (
      x >= region.x &&
      x <= region.x + region.w &&
      y >= region.y &&
      y <= region.y + region.h
    ) {
      return region;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-panel.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-panel.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-panel.test.ts frontend/src/lib/vr/panel.ts
git commit -m "Turn a raycast uv into a canvas rectangle

The seam the whole VR test strategy rests on: no canvas, no texture, no
three, so every panel's layout can be a pure function. The v flip is the one
line that matters - uv has v=0 at the bottom, a canvas has y=0 at the top -
and a broken flip makes every press land on the button vertically opposite,
which from inside a headset reads as a random mis-click."
```

---

### Task 8: three.js, and `vr/xr-session.ts` — opening and closing a session

**Files:**
- Modify: `frontend/package.json` (dependencies)
- Create: `frontend/src/lib/vr/xr-session.ts`
- Test: `core/test/vr-xr-session.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Produces:
  ```ts
  export type SpaceType = 'local-floor' | 'local';
  export interface XrSessionLike {
    visibilityState: string;
    requestReferenceSpace(type: string): Promise<unknown>;
    addEventListener(type: string, fn: () => void): void;
    end(): Promise<void>;
  }
  export interface XrEntryNavigator {
    xr?: { requestSession(mode: string, init?: unknown): Promise<XrSessionLike> };
  }
  export interface VrSession {
    session: XrSessionLike;
    referenceSpace: unknown;
    spaceType: SpaceType;
    end(): Promise<void>;
  }
  export function openVrSession(
    onEnd: () => void,
    nav?: XrEntryNavigator
  ): Promise<VrSession>;
  ```

- [ ] **Step 1: Add three.js**

```bash
cd frontend && bun add three @types/three
```

Record the resolved version in the commit message. `@types/three` normally pulls `@types/webxr`, which is what makes `navigator.xr` typecheck; if `bun run check` still cannot find `XRSession`, add `@types/webxr` explicitly as a devDependency.

Verify nothing else moved:

```bash
cd frontend && bun run check && bun run build
```

Expected: both PASS. `bun pm untrusted` at the repo root must report nothing new — the root `package.json`'s `trustedDependencies` note explains why that field is load-bearing.

- [ ] **Step 2: Write the failing test**

`core/test/vr-xr-session.test.ts`:

```ts
/**
 * Opening and closing an immersive session.
 *
 * Two rules, both learned from what goes wrong without them.
 *
 * `local-floor` is asked for as an OPTIONAL feature, then requested as a
 * reference space with `local` as the fallback. Asking for it as a *required*
 * feature would make `requestSession` itself reject on a headset that cannot
 * offer a floor, which turns a cosmetic degradation - a scene positioned from
 * an assumed eye height - into "VR does not work on your device".
 *
 * And `onEnd` fires exactly once. The system menu ending a session, the player
 * pressing quit, and the headset being put down all arrive as the same `end`
 * event, and `end()` raises it too. A second call would stop an engine that has
 * already stopped and write the SRAM twice.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { openVrSession } from '../../frontend/src/lib/vr/xr-session.js';

function fakeSession(opts: { spaces?: string[] } = {}) {
  const allowed = new Set(opts.spaces ?? ['local-floor', 'local']);
  const listeners: Array<() => void> = [];
  const asked: string[] = [];
  let ended = 0;
  const session = {
    visibilityState: 'visible',
    asked,
    async requestReferenceSpace(type: string) {
      asked.push(type);
      if (!allowed.has(type)) throw new DOMException('unsupported', 'NotSupportedError');
      return { type };
    },
    addEventListener(_type: string, fn: () => void) { listeners.push(fn); },
    async end() { ended++; for (const fn of [...listeners]) fn(); },
    fireEnd() { for (const fn of [...listeners]) fn(); },
    get endCalls() { return ended; }
  };
  return session;
}

function fakeNavigator(session: ReturnType<typeof fakeSession>) {
  const inits: unknown[] = [];
  return {
    inits,
    xr: {
      async requestSession(mode: string, init?: unknown) {
        assert.equal(mode, 'immersive-vr');
        inits.push(init);
        return session;
      }
    }
  };
}

test('local-floor is optional, never required', async () => {
  const session = fakeSession();
  const nav = fakeNavigator(session);
  const vr = await openVrSession(() => {}, nav);

  const init = nav.inits[0] as { requiredFeatures?: string[]; optionalFeatures?: string[] };
  assert.deepEqual(init.optionalFeatures, ['local-floor']);
  assert.ok(
    !init.requiredFeatures?.includes('local-floor'),
    'requiring it turns a cosmetic degradation into a device that cannot do VR at all'
  );
  assert.equal(vr.spaceType, 'local-floor');
  await vr.end();
});

test('a headset with no floor falls back to local and says so', async () => {
  const session = fakeSession({ spaces: ['local'] });
  const vr = await openVrSession(() => {}, fakeNavigator(session));

  assert.deepEqual(session.asked, ['local-floor', 'local'], 'the good one is tried first');
  assert.equal(vr.spaceType, 'local', 'the scene needs to know it is guessing the eye height');
  await vr.end();
});

test('the system ending the session calls onEnd once', async () => {
  const session = fakeSession();
  let ends = 0;
  await openVrSession(() => ends++, fakeNavigator(session));

  session.fireEnd();
  assert.equal(ends, 1);
  session.fireEnd();
  assert.equal(ends, 1, 'a second end event must not stop an engine twice');
});

test('quitting from inside also calls onEnd exactly once', async () => {
  const session = fakeSession();
  let ends = 0;
  const vr = await openVrSession(() => ends++, fakeNavigator(session));

  await vr.end();
  assert.equal(ends, 1, 'end() raises the event too - the two paths must not both count');
  await vr.end();
  assert.equal(ends, 1, 'and calling it again is harmless');
});

test('a refused session is reported to the caller, not swallowed', async () => {
  const nav = {
    xr: {
      async requestSession() { throw new DOMException('denied', 'NotAllowedError'); }
    }
  };
  await assert.rejects(
    () => openVrSession(() => {}, nav),
    /denied/,
    'the button stays and a notice explains why; that needs the error'
  );
});

test('a browser with no xr at all rejects rather than hanging', async () => {
  await assert.rejects(() => openVrSession(() => {}, {}), /WebXR/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test core/test/vr-xr-session.test.ts`
Expected: FAIL — `Cannot find module '.../vr/xr-session.js'`

- [ ] **Step 4: Write the implementation**

`frontend/src/lib/vr/xr-session.ts`:

```ts
/**
 * The life of one immersive session, and nothing about its contents.
 *
 * `local-floor` is an OPTIONAL feature here, not a required one. Required, it
 * would make `requestSession` reject outright on a headset that cannot report a
 * floor - turning a cosmetic degradation, a scene placed from an assumed eye
 * height, into "VR does not work on your device". So the session is asked for
 * plainly and the reference space is where the fallback happens.
 *
 * `onEnd` fires exactly once, whatever ended the session. The system menu, the
 * quit button and a headset set down on the table all arrive as the same `end`
 * event, and `end()` raises it as well. Two calls would stop an already-stopped
 * engine and write the cartridge save twice.
 *
 * Its navigator is a parameter for the reason the rest of this codebase's
 * device code gives: so it can be tested without one.
 */

export type SpaceType = 'local-floor' | 'local';

/** The part of `XRSession` this module touches. three.js gets the real thing. */
export interface XrSessionLike {
  visibilityState: string;
  requestReferenceSpace(type: string): Promise<unknown>;
  addEventListener(type: string, fn: () => void): void;
  end(): Promise<void>;
}

export interface XrEntryNavigator {
  xr?: { requestSession(mode: string, init?: unknown): Promise<XrSessionLike> };
}

export interface VrSession {
  session: XrSessionLike;
  referenceSpace: unknown;
  /** `'local'` tells the scene it is guessing the eye height rather than
   * measuring from a real floor. */
  spaceType: SpaceType;
  end(): Promise<void>;
}

export async function openVrSession(
  onEnd: () => void,
  nav: XrEntryNavigator | undefined = globalThis.navigator as XrEntryNavigator | undefined
): Promise<VrSession> {
  if (!nav?.xr?.requestSession) {
    throw new Error('WebXR is not available in this browser');
  }

  // Optional, not required - see the header. A rejection here is a real
  // refusal (permission, no device, a session already running) and belongs to
  // the caller, which keeps its button and explains itself.
  const session = await nav.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor']
  });

  let spaceType: SpaceType = 'local-floor';
  let referenceSpace: unknown;
  try {
    referenceSpace = await session.requestReferenceSpace('local-floor');
  } catch {
    referenceSpace = await session.requestReferenceSpace('local');
    spaceType = 'local';
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onEnd();
  };
  session.addEventListener('end', finish);

  return {
    session,
    referenceSpace,
    spaceType,
    end: async () => {
      if (finished) return;
      // `end()` raises the event, which runs `finish`. Nothing else to do.
      await session.end();
    }
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test core/test/vr-xr-session.test.ts && cd frontend && bun run check`
Expected: PASS, 6 tests, and a clean typecheck.

- [ ] **Step 6: Register the test file and commit**

```bash
# add core/test/vr-xr-session.test.ts to the test:ui list in package.json first
git add package.json frontend/package.json bun.lock core/test/vr-xr-session.test.ts frontend/src/lib/vr/xr-session.ts
git commit -m "Open and close one immersive session

three.js <version> arrives with this. local-floor is an optional feature and
the reference space is where the fallback lives: required, it would make
requestSession reject on a headset with no floor, turning an assumed eye
height into a device that cannot do VR. And onEnd fires once however the
session ended, or a quit both raises the event and runs the handler, and the
cartridge save gets written twice."
```

---

### Task 9: `vr/screen-geometry.ts` — the curved screen, and the stride trick

The screen is the one mesh built by hand rather than taken from three's primitives, and the reason is the SNES frame buffer's padding.

`videoSurface()` (`znet/core.ts:189`) is a zero-copy view whose `stride` is fixed at 512 pixels whatever the visible width is — usually 256, so half of every row is padding. `videoFrame()` repacks it tightly, at the cost of a full copy every frame. Neither is what a `DataTexture` wants.

The trick: upload the **padded** buffer as a `stride × height` texture, and generate the mesh's `u` coordinates over `[0, width / stride]` so only the real pixels are ever sampled. Zero copy, no `UNPACK_ROW_LENGTH`, no custom GL — and it is a pure function.

**Files:**
- Create: `frontend/src/lib/vr/screen-geometry.ts`
- Test: `core/test/vr-screen-geometry.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Produces:
  ```ts
  export interface CurvedScreenSpec {
    radius: number;
    /** Radians. */
    arc: number;
    height: number;
    /** Horizontal subdivisions. */
    segments?: number;
    /** The right edge of the sampled region, from `visibleU`. */
    uMax: number;
  }
  export interface ScreenGeometry {
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array;
  }
  export function visibleU(width: number, stride: number): number;
  export function curvedScreenGeometry(spec: CurvedScreenSpec): ScreenGeometry;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-screen-geometry.test.ts`:

```ts
/**
 * The curved screen, and why it is not a CylinderGeometry.
 *
 * `videoSurface()` is a zero-copy view into wasm memory whose stride is fixed
 * at 512 pixels however wide the picture is - so at the usual 256, half of
 * every row is padding. `videoFrame()` repacks it tightly and pays a full copy
 * per frame for the privilege.
 *
 * This takes neither trade: the padded buffer is uploaded as a stride-wide
 * texture and the mesh's u coordinates stop at width/stride, so the padding is
 * simply never sampled. That means generating uvs, which means generating the
 * mesh, which is why this module exists - and it makes the whole thing a pure
 * function that Bun can check.
 *
 * The winding is worth a test of its own. Facing the wrong way shows an
 * invisible screen, which from inside a headset is indistinguishable from a
 * game that failed to boot.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  curvedScreenGeometry,
  visibleU
} from '../../frontend/src/lib/vr/screen-geometry.js';

const SPEC = { radius: 2.5, arc: Math.PI / 3, height: 1.2, segments: 8, uMax: 0.5 };

test('the sampled width is the visible fraction of the padded buffer', () => {
  assert.equal(visibleU(256, 512), 0.5, 'the usual case: half of every row is padding');
  assert.equal(visibleU(512, 512), 1, 'a full-width mode samples everything');
  assert.equal(visibleU(240, 512), 240 / 512);
});

test('a nonsense stride samples the whole texture rather than dividing by zero', () => {
  assert.equal(visibleU(256, 0), 1);
  assert.equal(visibleU(0, 512), 1, 'a zero width would sample nothing at all - show everything');
});

test('the mesh is two rows of columns, stitched into quads', () => {
  const { positions, uvs, indices } = curvedScreenGeometry(SPEC);
  assert.equal(positions.length, (8 + 1) * 2 * 3, 'nine columns, two rows, xyz each');
  assert.equal(uvs.length, (8 + 1) * 2 * 2);
  assert.equal(indices.length, 8 * 6, 'two triangles per quad');
});

test('every vertex is exactly on the cylinder', () => {
  const { positions } = curvedScreenGeometry(SPEC);
  for (let i = 0; i < positions.length; i += 3) {
    const distance = Math.hypot(positions[i], positions[i + 2]);
    assert.ok(
      Math.abs(distance - SPEC.radius) < 1e-6,
      `vertex ${i / 3} sits at ${distance}, not on a ${SPEC.radius} m radius`
    );
  }
});

test('the arc is centred on straight ahead', () => {
  const { positions } = curvedScreenGeometry(SPEC);
  const half = SPEC.arc / 2;

  // First column, bottom row.
  assert.ok(Math.abs(positions[0] - SPEC.radius * Math.sin(-half)) < 1e-6);
  assert.ok(positions[0] < 0, 'the arc starts on the player\'s left');

  // Last column, bottom row.
  const last = (8 * 2) * 3;
  assert.ok(Math.abs(positions[last] - SPEC.radius * Math.sin(half)) < 1e-6);
  assert.ok(positions[last] > 0, 'and ends on their right');
});

/**
 * A tolerance, because `positions` is a Float32Array and the expectations are
 * float64 literals.
 *
 * `SPEC.height / 2` is 0.6, which binary32 cannot hold exactly - it comes back
 * as -0.6000000238418579, 2.4e-8 away. `assert.equal` there can never pass, for
 * any correct implementation, and an earlier version of this test spent two
 * agent runs proving that. 1e-6 is thousands of times larger than the storage
 * error and still tens of thousands of times smaller than any geometry bug,
 * which would be centimetres.
 */
const NEAR = 1e-6;
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < NEAR, `${what}: ${actual} vs ${expected}`);

test('the screen is centred vertically on its own origin', () => {
  const { positions } = curvedScreenGeometry(SPEC);
  const ys: number[] = [];
  for (let i = 1; i < positions.length; i += 3) ys.push(positions[i]);
  near(Math.min(...ys), -SPEC.height / 2, 'bottom row');
  near(Math.max(...ys), SPEC.height / 2, 'top row - layout.ts places it, the mesh does not');
});

test('u stops at uMax, so the padding is never sampled', () => {
  const { uvs } = curvedScreenGeometry(SPEC);
  const us: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < uvs.length; i += 2) { us.push(uvs[i]); vs.push(uvs[i + 1]); }

  assert.equal(Math.min(...us), 0);
  assert.equal(Math.max(...us), 0.5, 'sampling past this shows 256 columns of stale memory');
  assert.equal(Math.min(...vs), 0);
  assert.equal(Math.max(...vs), 1);
});

test('the bottom row carries v = 0 and the top row v = 1', () => {
  const { positions, uvs } = curvedScreenGeometry(SPEC);
  // Vertex 0 is the first column's bottom, vertex 1 its top.
  near(positions[1], -SPEC.height / 2, "vertex 0 is column 0's bottom");
  assert.equal(uvs[1], 0);
  near(positions[4], SPEC.height / 2, "vertex 1 is column 0's top");
  assert.equal(uvs[3], 1);
});

test('the front face is the one the player is standing in front of', () => {
  const { positions, indices } = curvedScreenGeometry({ ...SPEC, segments: 2 });
  const at = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];

  const [a, b, c] = [at(indices[0]), at(indices[1]), at(indices[2])];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  // Cross product, which is the face normal for three's default CCW winding.
  const nz = ab[0] * ac[1] - ab[1] * ac[0];

  assert.ok(
    nz > 0,
    'the normal must have a +Z component: the player is at the origin looking down -Z, ' +
      'and a screen wound the other way is invisible - which reads as a game that never booted'
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-screen-geometry.test.ts`
Expected: FAIL — `Cannot find module '.../vr/screen-geometry.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/screen-geometry.ts`:

```ts
/**
 * The curved screen's mesh, generated rather than taken from three.
 *
 * The reason is the frame buffer's padding. `videoSurface()` is a zero-copy
 * view whose stride is fixed at 512 pixels however wide the picture actually
 * is, so at the usual 256 half of every row is memory nobody should see.
 * `videoFrame()` repacks it tightly and pays a whole copy per frame.
 *
 * Neither is necessary. Upload the padded buffer as a stride-wide texture, and
 * generate u coordinates that stop at `width / stride`: the padding is never
 * sampled, there is no copy, and no custom GL state is needed. Generating uvs
 * means generating the mesh - hence this module, and hence the pleasant
 * side-effect that all of it is a pure function.
 *
 * Coordinates are three.js's, as in `layout.ts`: origin at the player, looking
 * down -Z. The mesh is centred on its own origin vertically; `layout.ts` says
 * where it goes.
 */

export interface CurvedScreenSpec {
  radius: number;
  /** Radians. */
  arc: number;
  height: number;
  /** Horizontal subdivisions. Enough that the curve does not facet visibly;
   * 48 is comfortable at 2.5 m. */
  segments?: number;
  /** The right edge of the sampled region. From `visibleU`. */
  uMax: number;
}

export interface ScreenGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

const DEFAULT_SEGMENTS = 48;

/**
 * The fraction of a padded row that is real picture.
 *
 * Degenerate inputs sample everything rather than nothing: a zero here would
 * make the screen a single column of pixels, which looks like a rendering bug
 * with no obvious cause, whereas showing the padding at least looks like
 * padding.
 */
export function visibleU(width: number, stride: number): number {
  if (!(stride > 0) || !(width > 0)) return 1;
  return Math.min(width / stride, 1);
}

export function curvedScreenGeometry(spec: CurvedScreenSpec): ScreenGeometry {
  const segments = spec.segments ?? DEFAULT_SEGMENTS;
  const columns = segments + 1;
  const half = spec.arc / 2;
  const top = spec.height / 2;

  const positions = new Float32Array(columns * 2 * 3);
  const uvs = new Float32Array(columns * 2 * 2);
  const indices = new Uint16Array(segments * 6);

  for (let i = 0; i < columns; i++) {
    const t = i / segments;
    const angle = -half + spec.arc * t;
    const x = spec.radius * Math.sin(angle);
    const z = -spec.radius * Math.cos(angle);
    const u = spec.uMax * t;

    // Vertex 2i is this column's bottom, 2i+1 its top.
    const bottom = (i * 2) * 3;
    positions[bottom] = x;
    positions[bottom + 1] = -top;
    positions[bottom + 2] = z;
    positions[bottom + 3] = x;
    positions[bottom + 4] = top;
    positions[bottom + 5] = z;

    const uv = (i * 2) * 2;
    uvs[uv] = u;
    uvs[uv + 1] = 0;
    uvs[uv + 2] = u;
    uvs[uv + 3] = 1;
  }

  /*
   * Winding, and why it gets its own comment.
   *
   * The player is at the origin looking down -Z, so their right is +X and up is
   * +Y. Bottom-left, then bottom-right, then top-left is counter-clockwise from
   * where they stand, which is three's default front face. Reversed, the screen
   * is invisible - and an invisible screen inside a headset is
   * indistinguishable from a game that failed to boot, so this is a bug that
   * costs an hour to diagnose and a character to fix.
   */
  for (let i = 0; i < segments; i++) {
    const bl = i * 2;
    const tl = bl + 1;
    const br = bl + 2;
    const tr = bl + 3;
    const o = i * 6;
    indices[o] = bl;
    indices[o + 1] = br;
    indices[o + 2] = tl;
    indices[o + 3] = br;
    indices[o + 4] = tr;
    indices[o + 5] = tl;
  }

  return { positions, uvs, indices };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-screen-geometry.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-screen-geometry.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-screen-geometry.test.ts frontend/src/lib/vr/screen-geometry.ts
git commit -m "Generate the curved screen so the frame buffer's padding is free

videoSurface() has a fixed 512-pixel stride whatever the picture's width, so
at 256 half of every row is padding; videoFrame() repacks it and pays a copy
per frame. Uploading the padded buffer and stopping u at width/stride costs
neither. Generating uvs means generating the mesh, which has the happy
side-effect of making the whole screen a pure function."
```

---

### Task 10: The first milestone — enter VR and look at the curved screen

The deliverable is a player pressing a button in the top bar, arriving in an immersive session, and seeing a test pattern on a large curved screen at the right distance, shape and height. No emulator yet: settling the geometry before the emulator is involved is what makes a bad number diagnosable.

This is the first task whose verification is a headset rather than a test. The three pure modules it consumes are already covered; what is left is wiring, and wiring is what hands and eyes check.

**Files:**
- Create: `frontend/src/lib/vr/screen.ts`, `frontend/src/lib/vr/scene.ts`, `frontend/src/lib/components/VrShell.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte:80-93` (the `.right` block), `frontend/src/routes/+layout.svelte:150` (beside `InvitationCard`)
- Modify: `frontend/src/lib/i18n/translations.ts` (three keys)

**Interfaces:**
- Consumes: `sceneLayout` (Task 6), `curvedScreenGeometry`/`visibleU` (Task 9), `createFramePump` (Task 2), `openVrSession` (Task 8), `vrAvailable` (Task 3), `vrRequested`/`vrActive` (Task 3).
- Produces:
  ```ts
  // screen.ts
  export interface VrScreen {
    mesh: import('three').Mesh;
    upload(surface: VideoSurface): void;
    showTestPattern(): void;
    dispose(): void;
  }
  export function createVrScreen(placement: ScreenPlacement): VrScreen;

  // scene.ts
  export interface VrScene {
    screen: VrScreen;
    /** Registered as GovernorOptions.schedule. */
    schedule: (run: () => void) => void;
    /** Called every XR frame, before the render. */
    onFrame: (fn: () => void) => void;
    attach(session: XRSession, spaceType: SpaceType): Promise<void>;
    dispose(): void;
  }
  export function createVrScene(opts: {
    aspect: PixelAspect;
    eyeHeight?: number;
    onContextLost: () => void;
  }): VrScene;
  ```

- [ ] **Step 1: Write `vr/screen.ts`**

```ts
/**
 * The curved screen, and the one upload per frame that feeds it.
 *
 * The texture is `stride` pixels wide, not `width`: the mesh's u stops at
 * `width / stride` (see `screen-geometry.ts`), so the padded half of every row
 * is uploaded and never sampled. That trades a little VRAM for no per-frame
 * copy at all, which is the right way round - `videoFrame()`'s repack is
 * 230 KB of memmove sixty times a second.
 *
 * Nothing here drives anything. `scene.ts` renders when the XR loop says so
 * and `FrameGovernor` decides when a frame exists, which is the rule
 * `znet/webgl-renderer.ts:8` states in capitals for the flat path.
 */

import * as THREE from 'three';
import { curvedScreenGeometry, visibleU } from './screen-geometry';
import type { ScreenPlacement } from './layout';
import type { VideoSurface } from '$lib/znet/core';

export interface VrScreen {
  mesh: THREE.Mesh;
  upload(surface: VideoSurface): void;
  showTestPattern(): void;
  dispose(): void;
}

export function createVrScreen(placement: ScreenPlacement): VrScreen {
  const material = new THREE.MeshBasicMaterial({
    // The SNES palette is already the picture; three's tone mapping would
    // crush it toward grey.
    toneMapped: false
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.position.set(0, placement.centerY, 0);

  let texture: THREE.DataTexture | null = null;
  /** Rebuilt only when the picture's shape changes - a mode switch, not a
   * frame. */
  let builtFor = { width: -1, height: -1, stride: -1 };

  function rebuild(width: number, height: number, stride: number): void {
    mesh.geometry.dispose();
    const { positions, uvs, indices } = curvedScreenGeometry({
      radius: placement.radius,
      arc: placement.arc,
      height: placement.height,
      uMax: visibleU(width, stride)
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    mesh.geometry = geometry;

    texture?.dispose();
    texture = new THREE.DataTexture(
      new Uint8Array(stride * height * 4),
      stride,
      height,
      THREE.RGBAFormat
    );
    // Nearest both ways: this is a 256-wide picture on a two-metre screen, and
    // smoothing it is the opposite of what anyone came for. No mipmaps either
    // - the screen never recedes, so they would be generated and never read.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The core's first row is the top of the frame; a DataTexture's is the
    // bottom. Flipping here is the same single reversal `webgl-renderer.ts`
    // does with its two quads.
    texture.flipY = true;
    material.map = texture;
    material.needsUpdate = true;

    builtFor = { width, height, stride };
  }

  return {
    mesh,

    upload(surface: VideoSurface): void {
      if (
        surface.width !== builtFor.width ||
        surface.height !== builtFor.height ||
        surface.stride !== builtFor.stride
      ) {
        rebuild(surface.width, surface.height, surface.stride);
      }
      /*
       * The view is handed to the texture rather than copied into it, which is
       * the whole point of `videoSurface()`. Its header warns the view "is only
       * valid until the next core call - anything that can grow the heap
       * invalidates it. Upload it and forget it." That is satisfied here: the
       * assignment and the upload both happen inside this frame, before the
       * core runs again.
       */
      texture!.image.data = surface.data as unknown as Uint8Array;
      texture!.needsUpdate = true;
    },

    /**
     * A picture with no emulator behind it.
     *
     * It exists so the geometry, distance, height and aspect can be judged
     * before a ROM is involved. A screen that is too low is obvious against a
     * grid and invisible against Super Mario World.
     */
    showTestPattern(): void {
      const width = 256;
      const height = 224;
      const stride = 512;
      rebuild(width, height, stride);
      const data = texture!.image.data as Uint8Array;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < stride; x++) {
          const i = (y * stride + x) * 4;
          const inPadding = x >= width;
          const cell = ((x >> 4) + (y >> 4)) & 1;
          // The padding is filled magenta on purpose: if any of it is visible,
          // uMax is wrong, and it will be unmistakable rather than subtle.
          data[i] = inPadding ? 255 : cell ? 220 : 30;
          data[i + 1] = inPadding ? 0 : cell ? 220 : 30;
          data[i + 2] = inPadding ? 255 : cell ? 220 : 30;
          data[i + 3] = 255;
        }
      }
      texture!.needsUpdate = true;
    },

    dispose(): void {
      mesh.geometry.dispose();
      texture?.dispose();
      material.dispose();
    }
  };
}
```

- [ ] **Step 2: Write `vr/scene.ts`**

```ts
/**
 * The three.js side of the immersive session: what exists, and when it draws.
 *
 * It owns the renderer, the scene, the screen and the frame pump, and it owns
 * exactly one policy: the XR animation loop pumps the governor and then
 * renders. It never decides that a frame exists - `FrameGovernor` does, through
 * the pump - which is what keeps the emulator running at 60.0988 Hz on a 72 or
 * 90 Hz display.
 *
 * A small redundancy is deliberate: `xr-session.ts` already probed for
 * `local-floor` and three requests its own reference space here. The probe is
 * what tells `layout.ts` whether the floor is real or assumed, and three gives
 * no usable answer to that question - so the space is asked for twice and the
 * answer is used once.
 */

import * as THREE from 'three';
import { createFramePump } from './frame-pump';
import { createVrScreen, type VrScreen } from './screen';
import { sceneLayout, type SceneLayout } from './layout';
import type { SpaceType } from './xr-session';
import type { PixelAspect } from '$lib/znet/fit';

export interface VrScene {
  screen: VrScreen;
  layout: SceneLayout;
  scene: THREE.Scene;
  /** Handed to `GovernorOptions.schedule`. */
  schedule: (run: () => void) => void;
  /** Runs every XR frame, before the render. */
  onFrame: (fn: () => void) => void;
  attach(session: XRSession, spaceType: SpaceType): Promise<void>;
  dispose(): void;
}

export function createVrScene(opts: {
  aspect: PixelAspect;
  eyeHeight?: number;
  onContextLost: () => void;
}): VrScene {
  const layout = sceneLayout(opts.aspect, opts.eyeHeight);

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.xr.enabled = true;

  // The flat path falls back to a 2D canvas when the context dies
  // (`renderer-surface.ts`). There is no fallback in here, so the only honest
  // move is to end the session and say so, rather than leave somebody inside a
  // black world wondering whether the game crashed.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    opts.onContextLost();
  });

  const scene = new THREE.Scene();
  // Every material is unlit MeshBasicMaterial, so there are no lights. The
  // background is near-black rather than black: a faint gradient gives the eye
  // something to fix on and stops the screen looking like it floats in a void.
  scene.background = new THREE.Color(0x0a0a12);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);

  const screen = createVrScreen(layout.screen);
  scene.add(screen.mesh);

  const pump = createFramePump();
  const perFrame: Array<() => void> = [];

  return {
    screen,
    layout,
    scene,
    schedule: pump.schedule,
    onFrame: (fn) => void perFrame.push(fn),

    async attach(session: XRSession, spaceType: SpaceType): Promise<void> {
      renderer.xr.setReferenceSpaceType(spaceType);
      await renderer.xr.setSession(session);
      renderer.setAnimationLoop(() => {
        // Order matters: the governor may run a frame, and the render should
        // show that frame rather than the previous one.
        pump.pump();
        for (const fn of perFrame) fn();
        renderer.render(scene, camera);
      });
    },

    dispose(): void {
      renderer.setAnimationLoop(null);
      screen.dispose();
      renderer.dispose();
    }
  };
}
```

- [ ] **Step 3: Write `components/VrShell.svelte`**

```svelte
<script lang="ts">
  /**
   * The immersive session, mounted once in the layout.
   *
   * It lives beside `InvitationCard` for the reason that component's note at
   * `+layout.svelte:130` gives - the layout is the only place that is on screen
   * whatever the player is doing - and for a second reason of its own: it sits
   * above the `<slot />`, so a navigation underneath cannot unmount it.
   *
   * There is exactly one way out. The quit button, the Quest's system menu and
   * a headset put down on the table all arrive as `sessionend`, and
   * `xr-session.ts` guarantees the handler runs once.
   */
  import { onDestroy } from 'svelte';
  import { vrRequested, vrActive } from '$lib/vr/entry';
  import { openVrSession, type VrSession } from '$lib/vr/xr-session';
  import { createVrScene, type VrScene } from '$lib/vr/scene';
  import { readAspectPreference } from '$lib/stores/aspect-preference';
  import { notifications } from '$lib/services/notification';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('VrShell');

  let session: VrSession | null = null;
  let scene: VrScene | null = null;

  async function enter(): Promise<void> {
    if (session) return;
    try {
      scene = createVrScene({
        aspect: readAspectPreference(localStorage),
        onContextLost: () => {
          logger.warn('the XR webgl context was lost');
          // `show(message, type)` — the store has no `.error()` helper
          // (`services/notification.ts:16`), and a 6 s duration because this
          // one lands on the flat page the player has just been dropped onto.
          notifications.show(t($language, 'vrContextLost'), 'error', 6000);
          void leave();
        }
      });

      session = await openVrSession(() => {
        // The single exit. Not `leave()`: the session is already over, and
        // asking it to end again would be the second call this guards against.
        teardown();
      });

      await scene.attach(session.session as unknown as XRSession, session.spaceType);
      // Until a game is launched, this is what the screen carries - and what
      // makes a wrong distance or height obvious.
      scene.screen.showTestPattern();
      vrActive.set(true);
    } catch (err) {
      logger.error('entering VR failed', err);
      notifications.show(t($language, 'vrUnavailable'), 'error', 6000);
      /*
       * `leave()`, not `teardown()`, and the difference is a player trapped in
       * the dark.
       *
       * If `openVrSession` resolved and `scene.attach` then threw - and it can,
       * because three's `setSession` awaits `gl.makeXRCompatible()` on a
       * renderer this code does not construct with `xrCompatible: true` - the
       * XRSession is still open in the browser. `teardown()` alone would null
       * our references and forget it, leaving somebody inside a black immersive
       * session with a disposed renderer, no code path left that would ever end
       * it, and a flat-page button they cannot reach because the headset is on
       * their face. Recovery costs an app restart and there is no console in
       * there to explain why.
       */
      void leave();
    }
  }

  async function leave(): Promise<void> {
    await session?.end();
    // `end()` raises `sessionend`, which runs `teardown`. Nothing more here -
    // and if no session was ever opened, this is a safe no-op that still
    // reaches `teardown` through the caller.
  }

  /**
   * Drops every reference. Assumes the session is ALREADY OVER.
   *
   * That precondition is the whole subtlety: this is safe from
   * `openVrSession`'s `onEnd` (the session ended, which is why we were
   * called) and from `onDestroy` on an ordinary Svelte teardown, but calling
   * it while a session is still live abandons that session rather than ending
   * it. Anything that might still hold an open session must go through
   * `leave()` instead.
   */
  function teardown(): void {
    scene?.dispose();
    scene = null;
    session = null;
    vrActive.set(false);
    vrRequested.set(false);
  }

  // The button sets the store; this is the one place that acts on it.
  $: if ($vrRequested && !session) void enter();

  onDestroy(teardown);
</script>

<!-- Nothing is rendered: the whole surface of this component is the headset.
     The renderer's canvas is detached on purpose - it is never displayed on the
     flat page, and inserting it would leave a black rectangle behind the app. -->
```

- [ ] **Step 4: Add the button to `TopBar.svelte`**

In the script:

```ts
  import { onMount } from 'svelte';
  import { vrAvailable } from '$lib/vr/support';
  import { requestVr } from '$lib/vr/entry';

  /** Undefined until asked, so the button does not flash in and out on load. */
  let headsetHere: boolean | undefined;
  onMount(async () => { headsetHere = await vrAvailable(); });
```

In the `.right` block, before the friends button:

```svelte
    {#if headsetHere}
      <!-- Capability, never a user agent: this button appears on a Quest and
           on a PC with a headset plugged in, and the "two controllers and
           nothing else" assumption only has to hold inside the session. -->
      <button class="bar-button" on:click={requestVr}>
        {t($language, 'enterVr')}
      </button>
    {/if}
```

- [ ] **Step 5: Mount the shell and add the three i18n keys**

In `+layout.svelte`, after `<InvitationCard />`:

```svelte
<!-- Above the <slot />, so a navigation underneath cannot unmount a running
     session. See the component's own header. -->
<VrShell />
```

with `import VrShell from '$lib/components/VrShell.svelte';` beside the other component imports.

In `i18n/translations.ts`, add to every locale, matching the surrounding style:

- `enterVr` — en: `"Enter VR"`, fr: `"Passer en VR"`
- `vrUnavailable` — en: `"VR could not start. Another app may be using the headset."`, fr: `"La VR n'a pas pu démarrer. Une autre application utilise peut-être le casque."`
- `vrContextLost` — en: `"VR stopped: the graphics context was lost."`, fr: `"La VR s'est arrêtée : le contexte graphique a été perdu."`

- [ ] **Step 6: Verify by hand, in a headset**

```bash
bun run test:ui && cd frontend && bun run check && bun run build
```

Then, on a Quest, over HTTPS (WebXR requires a secure context — the dev server must be reached by hostname with TLS, not `http://` on an IP):

1. Sign in. The "Passer en VR" button is present in the top bar.
2. Press it. The headset enters an immersive session.
3. The checkerboard is centred straight ahead, filling a comfortable arc, its middle at eye height. **No magenta anywhere** — magenta means `uMax` is wrong and the frame buffer's padding is being sampled.
4. Look down. Nothing yet — the lecterns arrive in Task 12.
5. Open the Quest system menu and close it. The scene is still there.
6. Exit through the system menu. The flat page is intact, and the button still works a second time.

Record the distance, height and arc you would actually want. They go into `layout.ts` and nowhere else.

On a desktop browser with no headset, confirm the button is absent and nothing in the console complains.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/vr/screen.ts frontend/src/lib/vr/scene.ts frontend/src/lib/components/VrShell.svelte frontend/src/lib/components/TopBar.svelte frontend/src/routes/+layout.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Enter VR and put a test pattern on the curved screen

No emulator yet, deliberately: a screen at the wrong height is obvious
against a checkerboard and invisible against Super Mario World, so the
geometry gets settled before a ROM is in the picture. The padding is filled
magenta for the same reason - if uMax is wrong it is unmistakable instead of
subtle.

The shell is mounted in the layout, above the slot, so a navigation
underneath cannot unmount a running session."
```

---

### Task 11: `vr/pointer.ts` — press semantics, without three

The pointing itself is a raycast, which belongs to the scene. What belongs here is the part that is easy to get wrong and easy to test: when a press counts.

**Files:**
- Create: `frontend/src/lib/vr/pointer.ts`
- Test: `core/test/vr-pointer.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `Region` (Task 7).
- Produces:
  ```ts
  export interface PointerTarget { panel: string; region: Region }
  export interface PointerTick { hover: PointerTarget | null; activated: PointerTarget | null }
  export interface Pointer { update(target: PointerTarget | null, pressed: boolean): PointerTick }
  export function createPointer(): Pointer;
  export function sameTarget(a: PointerTarget | null, b: PointerTarget | null): boolean;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-pointer.test.ts`:

```ts
/**
 * When a controller press counts as a click.
 *
 * This runs at the headset's refresh rate, so the naive version - "the trigger
 * is down and something is under the ray, therefore activate" - launches the
 * same game seventy-two times a second. Edge detection is the whole feature.
 *
 * The press edge is what activates, not the release. That is the VR
 * convention and it is also the honest one: there is no cursor to slip off a
 * button with, so waiting for a release only adds latency to something the
 * player has already committed to.
 *
 * The other rule is that hover is reported every tick while activation is
 * reported once, because the two are consumed differently: hover redraws a
 * panel, activation launches a game.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createPointer, sameTarget } from '../../frontend/src/lib/vr/pointer.js';
import type { Region } from '../../frontend/src/lib/vr/panel.js';

const PLAY: Region = { id: 'game:abc', x: 0, y: 0, w: 10, h: 10 };
const QUIT: Region = { id: 'quit', x: 20, y: 0, w: 10, h: 10 };
const onLibrary = { panel: 'library', region: PLAY };
const onProfile = { panel: 'profile', region: QUIT };

test('a press with nothing under the ray activates nothing', () => {
  const pointer = createPointer();
  assert.deepEqual(pointer.update(null, true), { hover: null, activated: null });
});

test('a press on a region activates it exactly once', () => {
  const pointer = createPointer();
  const down = pointer.update(onLibrary, true);
  assert.equal(down.activated?.region.id, 'game:abc');

  // Seventy-one more frames of the same held trigger.
  for (let i = 0; i < 71; i++) {
    assert.equal(pointer.update(onLibrary, true).activated, null, 'a held trigger is one click');
  }
});

test('releasing and pressing again is a second click', () => {
  const pointer = createPointer();
  assert.ok(pointer.update(onLibrary, true).activated);
  assert.equal(pointer.update(onLibrary, false).activated, null);
  assert.ok(pointer.update(onLibrary, true).activated, 'a deliberate second press must work');
});

test('hover is reported every tick, activation only on the edge', () => {
  const pointer = createPointer();
  const idle = pointer.update(onLibrary, false);
  assert.equal(idle.hover?.region.id, 'game:abc');
  assert.equal(idle.activated, null);

  const pressed = pointer.update(onLibrary, true);
  assert.equal(pressed.hover?.region.id, 'game:abc');
  assert.ok(pressed.activated);
});

test('moving the ray off a panel clears the hover', () => {
  const pointer = createPointer();
  pointer.update(onLibrary, false);
  assert.equal(pointer.update(null, false).hover, null);
});

test('a trigger held from empty space onto a button does not fire', () => {
  const pointer = createPointer();
  // Down over nothing...
  assert.equal(pointer.update(null, true).activated, null);
  // ...then dragged onto a button while still held. Nothing should launch: the
  // player pressed before they were aiming at anything.
  assert.equal(
    pointer.update(onLibrary, true).activated,
    null,
    'the edge already passed; sliding onto a button is not a press on it'
  );
});

test('the trigger has to be released before another panel can be clicked', () => {
  const pointer = createPointer();
  assert.ok(pointer.update(onLibrary, true).activated);
  assert.equal(
    pointer.update(onProfile, true).activated,
    null,
    'one press is one click, wherever the hand wanders'
  );
  pointer.update(onProfile, false);
  assert.equal(pointer.update(onProfile, true).activated?.region.id, 'quit');
});

test('sameTarget compares panel and region, not object identity', () => {
  assert.ok(sameTarget(onLibrary, { panel: 'library', region: { ...PLAY } }));
  assert.ok(!sameTarget(onLibrary, { panel: 'friends', region: PLAY }), 'the same id on two panels is two targets');
  assert.ok(!sameTarget(onLibrary, onProfile));
  assert.ok(sameTarget(null, null));
  assert.ok(!sameTarget(null, onLibrary));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-pointer.test.ts`
Expected: FAIL — `Cannot find module '.../vr/pointer.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/pointer.ts`:

```ts
/**
 * When a controller press counts as a click.
 *
 * The raycast belongs to `scene.ts`, which has the meshes. What is here is the
 * part that runs at the headset's refresh rate and is therefore easy to get
 * catastrophically wrong: without edge detection, "trigger down over a game"
 * launches that game seventy-two times a second.
 *
 * The press edge activates, not the release. There is no cursor to slip off a
 * button with in here, so waiting for a release would only add latency to
 * something the player has already decided.
 *
 * Pure: no three, no XR, no clock, so all of the above is checkable under Bun.
 */

import type { Region } from './panel';

export interface PointerTarget {
  /** Which panel the region belongs to. The same region id can exist on two. */
  panel: string;
  region: Region;
}

export interface PointerTick {
  /** Every tick, for redrawing. */
  hover: PointerTarget | null;
  /** Once per press. */
  activated: PointerTarget | null;
}

export interface Pointer {
  update(target: PointerTarget | null, pressed: boolean): PointerTick;
}

export function sameTarget(a: PointerTarget | null, b: PointerTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.panel === b.panel && a.region.id === b.region.id;
}

export function createPointer(): Pointer {
  let wasPressed = false;

  return {
    update(target, pressed) {
      const edge = pressed && !wasPressed;
      wasPressed = pressed;
      return {
        hover: target,
        // Only on the edge, and only if the ray was already on something when
        // it happened. A trigger pressed over empty space and then dragged
        // onto a button is not a press on that button.
        activated: edge && target ? target : null
      };
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-pointer.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-pointer.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-pointer.test.ts frontend/src/lib/vr/pointer.ts
git commit -m "Make a controller press count once

This runs at the headset's refresh rate, so 'trigger down over a game'
without edge detection launches that game seventy-two times a second. The
press edge activates rather than the release: there is no cursor to slip off
a button with, so waiting would only add latency to a decision already made."
```

---

### Task 12: `vr/panels/library.ts` — the left lectern

Two functions and one rule. The layout is pure and returns regions; the drawing consumes them. The rule is the one `roms/device-library.ts:8` calls "le seul endroit où l'écran cesse de mentir": there are **two** different empty libraries and confusing them tells a player with two hundred games that they have none.

**Files:**
- Create: `frontend/src/lib/vr/panels/library.ts`
- Test: `core/test/vr-panel-library.test.ts`
- Modify: `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `Region`, `PanelSize` (Task 7); `Game` (`stores/games.ts:3`).
- Produces:
  ```ts
  export type LibraryEmptiness = 'has-games' | 'library-empty' | 'none-on-this-device';
  export interface LibraryState {
    /** Already filtered by `deviceLibrary()`. */
    games: Game[];
    /** How many the account owns, for the "none here" message. */
    ownedTotal: number;
    /** First visible row. */
    scroll: number;
  }
  export interface LibraryLabels {
    heading: string;
    emptyLibrary: string;
    emptyLibraryHint: string;
    noneHere: string;
    noneHereHint: string;
  }
  export const LIBRARY_PANEL_SIZE: PanelSize;
  export function libraryEmptiness(state: LibraryState): LibraryEmptiness;
  export function libraryRows(state: LibraryState): number;
  export function clampScroll(scroll: number, rows: number): number;
  export function layoutLibraryPanel(state: LibraryState): Region[];
  export function drawLibraryPanel(
    ctx: CanvasRenderingContext2D,
    state: LibraryState,
    regions: readonly Region[],
    opts: { labels: LibraryLabels; hoverId: string | null; covers: Map<string, CanvasImageSource> }
  ): void;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-panel-library.test.ts`:

```ts
/**
 * The library lectern.
 *
 * The rule worth testing is not the grid arithmetic, it is the one
 * `roms/device-library.ts:8` states: this is the only place the screen stops
 * lying about what this machine can open. There are TWO empty libraries - an
 * account with no games at all, and an account with two hundred whose bytes are
 * on a different machine - and `+page.svelte:496` already keeps them apart on
 * the flat screen. Saying "your library is empty" to the second player is the
 * exact lie the filter exists to prevent, and in a headset it is worse: there
 * is no file picker to rescue them with, so the message has to send them out of
 * the session.
 *
 * The rest is scroll clamping, which matters because there is no scrollbar to
 * show a player they have reached the end.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  layoutLibraryPanel,
  drawLibraryPanel,
  libraryEmptiness,
  libraryRows,
  clampScroll,
  LIBRARY_PANEL_SIZE
} from '../../frontend/src/lib/vr/panels/library.js';
import type { Game } from '../../frontend/src/lib/stores/games.js';

function games(count: number): Game[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `g${i}`,
    title: `Game ${i}`,
    uploadedAt: '2026-01-01',
    saves: []
  })) as Game[];
}

const LABELS = {
  heading: 'Library',
  emptyLibrary: 'Your library is empty',
  emptyLibraryHint: 'Add games from the browser',
  noneHere: 'None of your 200 games are on this headset',
  noneHereHint: 'Leave VR, add them, come back'
};

/** Records what was drawn. Enough of a 2D context for this module. */
function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  const ctx = {
    texts,
    calls,
    canvas: { width: LIBRARY_PANEL_SIZE.width, height: LIBRARY_PANEL_SIZE.height },
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    clearRect() { calls.push('clearRect'); },
    fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
    drawImage() { calls.push('drawImage'); },
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 10 }; }
  };
  return ctx as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

test('an account with nothing is told its library is empty', () => {
  const state = { games: [], ownedTotal: 0, scroll: 0 };
  assert.equal(libraryEmptiness(state), 'library-empty');

  const ctx = recordingContext();
  drawLibraryPanel(ctx, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers: new Map()
  });
  const shown = (ctx as unknown as { texts: string[] }).texts.join(' | ');
  assert.ok(shown.includes(LABELS.emptyLibrary));
  assert.ok(!shown.includes(LABELS.noneHere));
});

test('an account with games elsewhere is told THAT, not that it is empty', () => {
  const state = { games: [], ownedTotal: 200, scroll: 0 };
  assert.equal(libraryEmptiness(state), 'none-on-this-device');

  const ctx = recordingContext();
  drawLibraryPanel(ctx, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers: new Map()
  });
  const shown = (ctx as unknown as { texts: string[] }).texts.join(' | ');
  assert.ok(shown.includes(LABELS.noneHere), 'the count is the whole point of this message');
  assert.ok(
    !shown.includes(LABELS.emptyLibrary),
    'telling someone with 200 games that they have none is the lie this filter exists to stop'
  );
  assert.ok(shown.includes(LABELS.noneHereHint), 'and in a headset they must be sent out of it');
});

test('an empty panel offers nothing to click', () => {
  const regions = layoutLibraryPanel({ games: [], ownedTotal: 0, scroll: 0 });
  assert.deepEqual(regions.filter((r) => r.id.startsWith('game:')), []);
});

test('each visible game gets one region carrying its id', () => {
  const state = { games: games(4), ownedTotal: 4, scroll: 0 };
  const ids = layoutLibraryPanel(state)
    .filter((r) => r.id.startsWith('game:'))
    .map((r) => r.id);
  assert.deepEqual(ids, ['game:g0', 'game:g1', 'game:g2', 'game:g3']);
});

test('every region stays inside the panel', () => {
  const state = { games: games(30), ownedTotal: 30, scroll: 0 };
  for (const r of layoutLibraryPanel(state)) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off-panel`);
    assert.ok(r.x + r.w <= LIBRARY_PANEL_SIZE.width, `${r.id} runs off the right edge`);
    assert.ok(r.y + r.h <= LIBRARY_PANEL_SIZE.height, `${r.id} runs off the bottom`);
  }
});

test('regions do not overlap, so no click is ambiguous', () => {
  /*
   * Both scroll states, and that is the point rather than thoroughness for its
   * own sake. `scroll: 0` has no up arrow, so a layout where the up arrow sits
   * on top of a game tile passes this test while being broken - and because
   * `hit()` returns the first match, the tile would silently swallow every
   * press on the arrow.
   */
  for (const scroll of [0, 1, 3]) {
    const regions = layoutLibraryPanel({ games: games(30), ownedTotal: 30, scroll });
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `at scroll ${scroll}, ${a.id} overlaps ${b.id}`);
      }
    }
  }
});

test('scrolling changes which games are on the panel', () => {
  const all = games(24);
  const first = layoutLibraryPanel({ games: all, ownedTotal: 24, scroll: 0 })
    .filter((r) => r.id.startsWith('game:'));
  const later = layoutLibraryPanel({ games: all, ownedTotal: 24, scroll: 1 })
    .filter((r) => r.id.startsWith('game:'));

  assert.ok(first.length > 0);
  assert.notDeepEqual(first.map((r) => r.id), later.map((r) => r.id));
  assert.equal(
    later[0].y,
    first[0].y,
    'a scrolled row is drawn at the same place; it is the contents that move'
  );
});

test('scroll cannot go before the first row or past the last', () => {
  const rows = libraryRows({ games: games(24), ownedTotal: 24, scroll: 0 });
  assert.ok(rows > 1);
  assert.equal(clampScroll(-5, rows), 0);
  assert.equal(clampScroll(0, rows), 0);
  assert.equal(clampScroll(999, rows), rows - 1, 'there is no scrollbar to show the end');
  assert.equal(clampScroll(0, 0), 0, 'an empty library has nowhere to scroll');
});

test('the scroll buttons exist only when there is somewhere to go', () => {
  const short = layoutLibraryPanel({ games: games(3), ownedTotal: 3, scroll: 0 }).map((r) => r.id);
  assert.ok(!short.includes('scroll:down'), 'a dead button is worse than no button');
  assert.ok(!short.includes('scroll:up'));

  const long = layoutLibraryPanel({ games: games(30), ownedTotal: 30, scroll: 0 }).map((r) => r.id);
  assert.ok(long.includes('scroll:down'));
  assert.ok(!long.includes('scroll:up'), 'nothing above the first row');

  const scrolled = layoutLibraryPanel({ games: games(30), ownedTotal: 30, scroll: 1 }).map((r) => r.id);
  assert.ok(scrolled.includes('scroll:up'));
});

test('a game with no cover is drawn from its title rather than skipped', () => {
  const state = { games: games(2), ownedTotal: 2, scroll: 0 };
  const ctx = recordingContext();
  drawLibraryPanel(ctx, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers: new Map()
  });
  const texts = (ctx as unknown as { texts: string[] }).texts;
  assert.ok(texts.includes('Game 0'));
  assert.ok(texts.includes('Game 1'));
  assert.equal((ctx as unknown as { calls: string[] }).calls.includes('drawImage'), false);
});

test('a cover that has loaded is drawn', () => {
  const state = { games: games(1), ownedTotal: 1, scroll: 0 };
  const ctx = recordingContext();
  const covers = new Map([['g0', {} as CanvasImageSource]]);
  drawLibraryPanel(ctx, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers
  });
  assert.ok((ctx as unknown as { calls: string[] }).calls.includes('drawImage'));
});

test('the hovered tile is outlined', () => {
  const state = { games: games(2), ownedTotal: 2, scroll: 0 };
  const plain = recordingContext();
  drawLibraryPanel(plain, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers: new Map()
  });
  const hovered = recordingContext();
  drawLibraryPanel(hovered, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: 'game:g0', covers: new Map()
  });

  const strokes = (c: typeof plain) => (c as unknown as { calls: string[] }).calls
    .filter((k) => k === 'strokeRect').length;
  assert.ok(strokes(hovered) > strokes(plain), 'a player needs to see what they are pointing at');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-panel-library.test.ts`
Expected: FAIL — `Cannot find module '.../vr/panels/library.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/panels/library.ts`:

```ts
/**
 * The left lectern: which games this headset can actually open.
 *
 * The list is already filtered by `deviceLibrary()` before it arrives, so the
 * only rule this module carries is the consequence of that filter: there are
 * TWO empty libraries and they must not share a message. "Your library is
 * empty" said to someone who owns two hundred games is precisely the lie
 * `roms/device-library.ts` exists to prevent, and `+page.svelte:496` already
 * keeps the two apart on the flat screen.
 *
 * In a headset the second message needs one more sentence than it does on the
 * flat page: there is no file picker in an immersive session, so the only
 * useful instruction is to leave, add the games, and come back.
 *
 * Layout is pure and returns regions; drawing consumes them. That split is what
 * `panel.ts` exists for, and it is why everything above is checkable under Bun.
 */

import type { PanelSize, Region } from '../panel';
import type { Game } from '$lib/stores/games';

/** Canvas pixels. Mapped onto the 0.7 x 0.5 m lectern `layout.ts` places. */
export const LIBRARY_PANEL_SIZE: PanelSize = { width: 800, height: 600 };

const PAD = 24;
const HEADER = 56;
const COLUMNS = 3;
const GAP = 16;
const SCROLL_W = 56;
/*
 * The scroll buttons get a gutter of their own rather than floating over the
 * grid's right-hand column.
 *
 * They used to share that space, and `hit()` returns the first match - so the
 * tile drawn underneath swallowed every press on the up arrow. It is the kind
 * of overlap a no-overlap test misses if it only ever exercises the unscrolled
 * state, where the up arrow does not exist yet.
 */
const GUTTER = SCROLL_W + GAP;
const TILE_W = Math.floor(
  (LIBRARY_PANEL_SIZE.width - PAD * 2 - GUTTER - GAP * (COLUMNS - 1)) / COLUMNS
);
const COVER_H = 150;
const TITLE_H = 32;
const TILE_H = COVER_H + TITLE_H;

/** Rows that fit under the header. */
const VISIBLE_ROWS = Math.floor((LIBRARY_PANEL_SIZE.height - HEADER - PAD) / (TILE_H + GAP));

export type LibraryEmptiness = 'has-games' | 'library-empty' | 'none-on-this-device';

export interface LibraryState {
  /** Already filtered by `deviceLibrary()`. */
  games: Game[];
  /** What the account owns, which is what makes the second message true. */
  ownedTotal: number;
  /** Index of the first visible row. */
  scroll: number;
}

export interface LibraryLabels {
  heading: string;
  emptyLibrary: string;
  emptyLibraryHint: string;
  /** Already interpolated with the count by the caller. */
  noneHere: string;
  noneHereHint: string;
}

export function libraryEmptiness(state: LibraryState): LibraryEmptiness {
  if (state.games.length > 0) return 'has-games';
  return state.ownedTotal > 0 ? 'none-on-this-device' : 'library-empty';
}

/** How many rows the whole list needs. */
export function libraryRows(state: LibraryState): number {
  return Math.ceil(state.games.length / COLUMNS);
}

/**
 * A scroll offset that exists.
 *
 * Clamped rather than wrapped: there is no scrollbar in here to show a player
 * they have reached the end, so jumping back to the top would read as the list
 * having reloaded itself.
 */
export function clampScroll(scroll: number, rows: number): number {
  if (rows <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(scroll), rows - 1));
}

export function layoutLibraryPanel(state: LibraryState): Region[] {
  if (libraryEmptiness(state) !== 'has-games') return [];

  const rows = libraryRows(state);
  const scroll = clampScroll(state.scroll, rows);
  const regions: Region[] = [];

  for (let row = 0; row < VISIBLE_ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const index = (scroll + row) * COLUMNS + column;
      const game = state.games[index];
      if (!game) continue;
      regions.push({
        id: `game:${game.id}`,
        x: PAD + column * (TILE_W + GAP),
        y: HEADER + row * (TILE_H + GAP),
        w: TILE_W,
        h: TILE_H
      });
    }
  }

  // Only where they lead somewhere: a button that does nothing is worse than
  // an absent one, because it invites the press that proves it is broken.
  // `right` is inside the reserved gutter, so these can never overlap a tile.
  const right = LIBRARY_PANEL_SIZE.width - PAD - SCROLL_W;
  if (scroll > 0) {
    regions.push({ id: 'scroll:up', x: right, y: HEADER, w: SCROLL_W, h: SCROLL_W });
  }
  if (scroll + VISIBLE_ROWS < rows) {
    regions.push({
      id: 'scroll:down',
      x: right,
      y: LIBRARY_PANEL_SIZE.height - PAD - SCROLL_W,
      w: SCROLL_W,
      h: SCROLL_W
    });
  }

  return regions;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

export function drawLibraryPanel(
  ctx: CanvasRenderingContext2D,
  state: LibraryState,
  regions: readonly Region[],
  opts: {
    labels: LibraryLabels;
    hoverId: string | null;
    /** Keyed by game id. Absent until the image has loaded. */
    covers: Map<string, CanvasImageSource>;
  }
): void {
  const { width, height } = LIBRARY_PANEL_SIZE;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.labels.heading, PAD, HEADER / 2);

  const emptiness = libraryEmptiness(state);
  if (emptiness !== 'has-games') {
    const heading =
      emptiness === 'library-empty' ? opts.labels.emptyLibrary : opts.labels.noneHere;
    const hint =
      emptiness === 'library-empty' ? opts.labels.emptyLibraryHint : opts.labels.noneHereHint;

    ctx.textAlign = 'center';
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(heading, width / 2, height / 2 - 20);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(hint, width / 2, height / 2 + 20);
    ctx.restore();
    return;
  }

  const byId = new Map(state.games.map((game) => [`game:${game.id}`, game]));

  for (const region of regions) {
    if (region.id === 'scroll:up' || region.id === 'scroll:down') {
      ctx.fillStyle = opts.hoverId === region.id ? '#3a3a52' : '#22222e';
      ctx.fillRect(region.x, region.y, region.w, region.h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        region.id === 'scroll:up' ? '▲' : '▼',
        region.x + region.w / 2,
        region.y + region.h / 2
      );
      continue;
    }

    const game = byId.get(region.id);
    if (!game) continue;

    ctx.fillStyle = '#1e1e2a';
    ctx.fillRect(region.x, region.y, region.w, COVER_H);

    const cover = opts.covers.get(game.id);
    if (cover) {
      ctx.drawImage(cover, region.x, region.y, region.w, COVER_H);
    }

    // The title is drawn whether or not the cover loaded: an unidentified game
    // is still a game the player owns, and a blank tile is unlaunchable in
    // practice because nobody presses what they cannot read.
    ctx.fillStyle = '#ffffff';
    ctx.font = '18px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      truncate(ctx, game.title, region.w - 8),
      region.x + 4,
      region.y + COVER_H + TITLE_H / 2
    );

    if (opts.hoverId === region.id) {
      ctx.strokeStyle = '#7aa2ff';
      ctx.lineWidth = 4;
      ctx.strokeRect(region.x - 2, region.y - 2, region.w + 4, TILE_H + 4);
    }
  }

  ctx.restore();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test core/test/vr-panel-library.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Register the test file and commit**

```bash
# add core/test/vr-panel-library.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-panel-library.test.ts frontend/src/lib/vr/panels/library.ts
git commit -m "Draw the library lectern, keeping the two empty libraries apart

The grid arithmetic is not the interesting part. 'Your library is empty' said
to someone who owns two hundred games is the exact lie deviceLibrary() exists
to prevent, and the flat page already keeps the two messages apart. In a
headset the second one needs a sentence more: there is no file picker in an
immersive session, so the only useful instruction is to leave and come back."
```

---

### Task 13: Panels in the scene — a lectern you can point at

Milestone: the library lectern hangs below and to the left, the controller casts a visible ray, a tile lights up under it, and the trigger scrolls. Nothing launches yet.

**Files:**
- Create: `frontend/src/lib/vr/panel-mesh.ts`
- Modify: `frontend/src/lib/vr/scene.ts` (panels and the raycast), `frontend/src/lib/components/VrShell.svelte` (the per-frame loop)

**Interfaces:**
- Consumes: `Placement` (Task 6), `Region`/`PanelSize`/`hit` (Task 7), `createPointer`/`PointerTarget`/`sameTarget` (Task 11), `layoutLibraryPanel`/`drawLibraryPanel`/`LIBRARY_PANEL_SIZE`/`clampScroll`/`libraryRows` (Task 12).
- Produces:
  ```ts
  // panel-mesh.ts
  export interface PanelMesh {
    id: string;
    mesh: import('three').Mesh;
    size: PanelSize;
    ctx: CanvasRenderingContext2D;
    regions: Region[];
    /** Redraw through this, so the texture upload is never forgotten. */
    paint(draw: (ctx: CanvasRenderingContext2D) => void): void;
    dispose(): void;
  }
  export function createPanelMesh(id: string, placement: Placement, size: PanelSize): PanelMesh;

  // scene.ts gains
  addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh;
  panelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  aimedAt(): PointerTarget | null;
  triggerDown(): boolean;
  inputSources(): Iterable<XRInputSource>;
  ```

- [ ] **Step 1: Write `vr/panel-mesh.ts`**

```ts
/**
 * One panel: a canvas, its texture, and the quad it lives on.
 *
 * Redrawing goes through `paint`, which marks the texture dirty afterwards.
 * That is not ceremony - a forgotten `needsUpdate` produces a panel that is
 * correct in memory and stale on the player's face, which is the single most
 * confusing bug this shape can have. Making the upload part of the call means
 * it cannot be skipped.
 *
 * A panel redraws only when its data or its hover changes, never per frame.
 * Three panels re-rasterised at 72 Hz would cost more than the emulator does.
 */

import * as THREE from 'three';
import type { Placement } from './layout';
import type { PanelSize, Region } from './panel';

export interface PanelMesh {
  id: string;
  mesh: THREE.Mesh;
  size: PanelSize;
  ctx: CanvasRenderingContext2D;
  /** Replaced whenever the layout is recomputed. `scene.raycast` reads it. */
  regions: Region[];
  paint(draw: (ctx: CanvasRenderingContext2D) => void): void;
  dispose(): void;
}

export function createPanelMesh(
  id: string,
  placement: Placement,
  size: PanelSize
): PanelMesh {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`no 2d context for the ${id} panel`);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Linear here, unlike the screen: this is text and box art, not a 256-wide
  // pixel picture, and nearest-neighbour text at an angle is unreadable.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false
  });

  // PlaneGeometry's own uv has v = 0 at the bottom, which is exactly what
  // `panel.hit()` expects and flips. Do not "fix" it here.
  const geometry = new THREE.PlaneGeometry(placement.width, placement.height);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...placement.position);
  mesh.rotation.set(...placement.rotation);

  return {
    id,
    mesh,
    size,
    ctx,
    regions: [],
    paint(draw) {
      draw(ctx);
      texture.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    }
  };
}
```

- [ ] **Step 2: Add panels, controllers and the raycast to `scene.ts`**

Add these imports and, inside `createVrScene`, this block before the `return`:

```ts
import { createPanelMesh, type PanelMesh } from './panel-mesh';
import { hit } from './panel';
import type { PointerTarget } from './pointer';
import type { Placement, PanelSize } from './layout';
```

```ts
  const panels: PanelMesh[] = [];
  const panelGroup = new THREE.Group();
  scene.add(panelGroup);

  /**
   * The two controllers as scene objects, with a ray drawn down each.
   *
   * The ray is not decoration. Without it a player has no idea where they are
   * pointing until something highlights, and nothing highlights until they are
   * already on it - so aiming becomes a search.
   */
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -2)
  ]);
  const rayMaterial = new THREE.LineBasicMaterial({ color: 0x7aa2ff, transparent: true, opacity: 0.6 });
  const controllers = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index);
    controller.add(new THREE.Line(rayGeometry, rayMaterial));
    scene.add(controller);
    return controller;
  });

  // Reused every frame rather than allocated: this runs at the headset's
  // refresh rate, and a GC pause is audible as an audio glitch.
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();

  /** Whichever hand is aiming at a panel, right first. */
  function aimedAt(): PointerTarget | null {
    if (!panelGroup.visible) return null;

    for (const controller of controllers) {
      origin.setFromMatrixPosition(controller.matrixWorld);
      /*
       * A controller points down its own -Z, the same convention the camera
       * uses. The WORLD quaternion, not the local one: they are identical
       * today because these are direct children of the scene, which is exactly
       * why the local one would keep working right up until somebody puts the
       * controllers in a group and the rays start pointing somewhere else.
       */
      controller.getWorldQuaternion(worldQuaternion);
      direction.set(0, 0, -1).applyQuaternion(worldQuaternion).normalize();
      raycaster.set(origin, direction);

      const meshes = panels.map((panel) => panel.mesh);
      const [first] = raycaster.intersectObjects(meshes, false);
      if (!first?.uv) continue;

      const panel = panels.find((candidate) => candidate.mesh === first.object);
      if (!panel) continue;

      const region = hit(panel.regions, { x: first.uv.x, y: first.uv.y }, panel.size);
      if (region) return { panel: panel.id, region };
    }
    return null;
  }

  function triggerDown(): boolean {
    const session = renderer.xr.getSession();
    if (!session) return false;
    for (const source of session.inputSources) {
      if (source.gamepad?.buttons[0]?.pressed) return true;
    }
    return false;
  }
```

**Extend the `VrScene` interface too, not only the object.** Under `strict` every consumer in Tasks 14-16 reads these through the declared type, so an object that merely happens to carry them does not typecheck. Add to `interface VrScene`:

```ts
  addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh;
  panelsVisible(visible: boolean): void;
  arePanelsVisible(): boolean;
  aimedAt(): PointerTarget | null;
  triggerDown(): boolean;
  inputSources(): Iterable<XRInputSource>;
```

Then extend the returned object with:

```ts
    addPanel(id: string, placement: Placement, size: PanelSize): PanelMesh {
      const panel = createPanelMesh(id, placement, size);
      panels.push(panel);
      panelGroup.add(panel.mesh);
      return panel;
    },
    panelsVisible: (visible: boolean) => void (panelGroup.visible = visible),
    arePanelsVisible: () => panelGroup.visible,
    aimedAt,
    triggerDown,
    inputSources: () => renderer.xr.getSession()?.inputSources ?? [],
```

and add `for (const panel of panels) panel.dispose();` plus `rayGeometry.dispose(); rayMaterial.dispose();` to `dispose()`.

- [ ] **Step 3: Drive it from `VrShell.svelte`**

Add to the script:

```ts
  import { createPointer, sameTarget, type PointerTarget } from '$lib/vr/pointer';
  import {
    LIBRARY_PANEL_SIZE, layoutLibraryPanel, drawLibraryPanel,
    libraryRows, clampScroll, type LibraryState
  } from '$lib/vr/panels/library';
  import { menuPressed } from '$lib/vr/pad';
  import { games } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere } from '$lib/roms/provider';
  import type { PanelMesh } from '$lib/vr/panel-mesh';

  const pointer = createPointer();
  let library: PanelMesh | null = null;
  let libraryState: LibraryState = { games: [], ownedTotal: 0, scroll: 0 };
  let hovered: PointerTarget | null = null;
  /** Read once on entry: the picker that would change it does not exist in
   *  here, so it cannot change during a session. */
  let resolvable: string[] = [];

  function repaintLibrary(): void {
    if (!library) return;
    library.regions = layoutLibraryPanel(libraryState);
    const regions = library.regions;
    library.paint((ctx) =>
      drawLibraryPanel(ctx, libraryState, regions, {
        labels: {
          heading: t($language, 'library'),
          emptyLibrary: t($language, 'emptyLibrary'),
          emptyLibraryHint: t($language, 'vrAddGamesFlat'),
          noneHere: t($language, 'noneOnThisDevice', { count: libraryState.ownedTotal }),
          noneHereHint: t($language, 'vrAddGamesFlat')
        },
        hoverId: hovered?.panel === 'library' ? hovered.region.id : null,
        covers
      })
    );
  }

  /** Covers are same-origin behind the session cookie (`api/covers.ts:9`), so
   *  they load with no crossOrigin attribute - setting one would break the
   *  cookie AND taint the canvas, and a tainted canvas cannot become a WebGL
   *  texture at all. */
  const covers = new Map<string, CanvasImageSource>();
  function loadCovers(list: typeof $games): void {
    for (const game of list) {
      if (!game.coverUrl || covers.has(game.id)) continue;
      const image = new Image();
      image.onload = () => { covers.set(game.id, image); repaintLibrary(); };
      image.src = game.coverUrl;
    }
  }

  function activate(target: PointerTarget): void {
    if (target.panel !== 'library') return;
    if (target.region.id === 'scroll:up' || target.region.id === 'scroll:down') {
      const step = target.region.id === 'scroll:down' ? 1 : -1;
      libraryState = {
        ...libraryState,
        scroll: clampScroll(libraryState.scroll + step, libraryRows(libraryState))
      };
      repaintLibrary();
      return;
    }
    // Launching arrives in the next task.
  }

  function frame(): void {
    if (!scene) return;

    if (menuPressed(scene.inputSources())) scene.panelsVisible(true);

    /*
     * The panels and the game never read the controllers at the same time.
     * The trigger is the pointer while the panels are up and SNES R while they
     * are down, and letting both read it would make a scroll press jump in
     * Super Mario World.
     */
    if (!scene.arePanelsVisible()) return;

    const tick = pointer.update(scene.aimedAt(), scene.triggerDown());
    if (!sameTarget(tick.hover, hovered)) {
      hovered = tick.hover;
      repaintLibrary();
    }
    if (tick.activated) activate(tick.activated);
  }
```

In `enter()`, after `scene.screen.showTestPattern()`:

```ts
      library = scene.addPanel('library', scene.layout.library, LIBRARY_PANEL_SIZE);
      resolvable = await resolvableHere();
      libraryState = {
        games: deviceLibrary($games, resolvable),
        ownedTotal: $games.length,
        scroll: 0
      };
      loadCovers(libraryState.games);
      repaintLibrary();
      scene.onFrame(frame);
```

In `teardown()`, add `library = null; covers.clear(); hovered = null;`.

Add the i18n key `vrAddGamesFlat` — en: `"Leave VR, add your games in the browser, then come back."`, fr: `"Quitte la VR, ajoute tes jeux depuis le navigateur, puis reviens."`

- [ ] **Step 4: Verify by hand, in a headset**

```bash
bun run test:ui && cd frontend && bun run check && bun run build
```

Then on the Quest:

1. Enter VR. The checkerboard is where Task 10 left it.
2. Look down and left. The library lectern is there, readable without leaning.
3. A blue ray comes out of each controller.
4. Point at a tile. It gains a blue outline. Point away. The outline goes.
5. With more than six games, the ▼ button exists; press it once and the grid advances by one row, not two. At the last row, ▼ is gone.
6. With an account whose games are all on another machine, the panel says so **with the count**, and tells you to leave VR — not "your library is empty".
7. Hold the trigger down on a tile. It highlights once and does not repeat.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/panel-mesh.ts frontend/src/lib/vr/scene.ts frontend/src/lib/components/VrShell.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Hang the library lectern in the scene and point at it

Redrawing goes through paint(), which marks the texture dirty itself: a
forgotten needsUpdate gives a panel that is right in memory and stale on the
player's face, and that is the worst bug this shape can have. Panels repaint
on a data or hover change, never per frame.

The ray is drawn because without it aiming is a search - nothing highlights
until you are already on it. And the panels and the game never read the
controllers at once, or a scroll press makes Mario jump."
```

---

### Task 14: The playable milestone — launch a game from the lectern

Press a tile, the panels fade, the game appears on the curved screen and the Touch controllers play it.

**Files:**
- Modify: `frontend/src/lib/rooms/actions.ts:25` (export `createRoom`), `frontend/src/routes/+layout.svelte:47` (the `room:opened` guard), `frontend/src/lib/components/VrShell.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts` (two keys)

**Interfaces:**
- Consumes: `createSoloEngine` (Task 1), `readVrPad`/`menuPressed` (Task 5), `readPadScheme` (Task 4), `loadCore` (`znet/loader.ts`), `AudioSink` (`znet/output.ts`), `resolveQuietly` (`roms/provider.ts:96`), `toBase64`/`decodeSram`.
- Produces: `export function createRoom(...)` — the same function, now visible.

- [ ] **Step 1: Export `createRoom` and guard the navigation**

In `rooms/actions.ts`, change `function createRoom(` to `export function createRoom(` and add to its doc comment:

```ts
/**
 * …
 * Exported because the VR shell needs the room without the navigation.
 * `launchSolo` is `createRoom` plus a `goto`, and that `goto` under an
 * immersive session would mount `SoloRoom.svelte` behind it: a second core, a
 * second AudioContext, a second governor, and two writers racing on one room's
 * cartridge save.
 */
```

In `+layout.svelte`, add `import { vrActive } from '$lib/vr/entry';` and guard the handler:

```ts
  function handleRoomOpened({ roomId, reason }: { roomId: string; reason?: string }) {
    if (!roomId) return;
    /*
     * Not while a headset is presenting.
     *
     * A solo launch from VR cannot reach here - `room:opened` is emitted by
     * `room:choose-game` (`websocket/room-handlers.ts:237`), not by
     * `room:create`. But `openRoomForMembers` addresses every member of the
     * room, "both members go, including the one who just chose", so a player
     * who joined a group before putting the headset on would be navigated by
     * their partner's choice - mounting a whole second emulator underneath a
     * session they are still playing in.
     */
    if (get(vrActive)) return;
    const query = reason === 'invitation' ? '?from=invitation' : '';
    void goto(`/room/${roomId}${query}`);
  }
```

with `import { get } from 'svelte/store';` if it is not already imported.

- [ ] **Step 2: Launch from `VrShell.svelte`**

Add to the script:

```ts
  import { loadCore } from '$lib/znet';
  import { AudioSink } from '$lib/znet';
  import { createSoloEngine, type SoloEngine } from '$lib/rooms/solo-engine';
  import { createRoom } from '$lib/rooms/actions';
  import { resolveQuietly } from '$lib/roms/provider';
  import { readVrPad } from '$lib/vr/pad';
  import { readPadScheme } from '$lib/vr/pad-scheme';
  import { decodeSram } from '$lib/rooms/sram';
  import { toBase64 } from '$lib/saves/base64';
  import { socket } from '$lib/api/socket';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import type { PsnesCore } from '$lib/znet/core';

  let engine: SoloEngine | null = null;
  let core: PsnesCore | null = null;
  let audio: AudioSink | null = null;
  let needsAudioGesture = false;
  /** Shown on the lectern when a launch could not read the file. */
  let launchNotice: string | null = null;
  $: padScheme = readPadScheme(localStorage);

  async function launch(gameId: string): Promise<void> {
    const game = libraryState.games.find((candidate) => candidate.id === gameId);
    if (!game?.crc32) return;

    /*
     * `resolveQuietly`, never the picker.
     *
     * `resolvable` was read when the session opened, but a folder handle can
     * lose its permission between then and now. On the flat screen
     * `obtainRom()` answers that by opening `LocateRom`; in here there is no
     * modal to open, so the failure has to be a line on the panel. The game
     * stays in the grid: it exists, it just could not be read this time.
     */
    const rom = await resolveQuietly(game.crc32);
    if (!rom) {
      launchNotice = t($language, 'vrRomUnreadable');
      repaintLibrary();
      return;
    }

    const roomId = await createRoom({ gameId: game.id, gameTitle: game.title, autoStart: true });
    if (!roomId) {
      launchNotice = t($language, 'vrLaunchFailed');
      repaintLibrary();
      return;
    }
    setLogLabels({ roomId, player: 'vr' });

    core = await loadCore();
    audio = new AudioSink();

    engine = await createSoloEngine({
      core,
      rom,
      sram: {
        load: () => readRoomSram(roomId),
        save: (bytes) => $socket?.emit('game:saveSram', { roomId, sramData: toBase64(bytes) })
      },
      audio,
      readPads: () => ({
        // Zero while the panels are up: the trigger is the pointer then, and
        // both readers on one button is a scroll press that jumps in game.
        pad1: scene && !scene.arePanelsVisible()
          ? readVrPad(scene.inputSources(), padScheme, sessionVisibility())
          : 0,
        pad2: 0
      }),
      onFrame: (c) => scene?.screen.upload(c.videoSurface()),
      onError: (err) => logger.error('vr engine', err)
    });

    // `needsGesture` is a question, not an assumption - `output.ts:199` records
    // what happened to the caller who assumed otherwise. An XR `select` may or
    // may not count as user activation, so the in-world prompt is the designed
    // answer rather than a hope.
    needsAudioGesture = audio.needsGesture;

    scene?.panelsVisible(false);
    engine.governor.start();
  }

  /** The session's own visibility, which is what `readVrPad` gates on. */
  function sessionVisibility(): string {
    return (session?.session.visibilityState as string) ?? 'hidden';
  }

  function readRoomSram(roomId: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const sock = $socket;
      if (!sock) return resolve(null);
      const timer = setTimeout(() => { sock.off('game:sramLoaded', done); resolve(null); }, 5000);
      function done(data: { sramData: string | null }) {
        sock!.off('game:sramLoaded', done);
        clearTimeout(timer);
        try {
          resolve(data.sramData ? decodeSram(data.sramData) : null);
        } catch {
          // A save that will not decode is not a save. Starting fresh beats
          // refusing to start.
          resolve(null);
        }
      }
      sock.on('game:sramLoaded', done);
      sock.emit('game:loadSram', { roomId });
    });
  }
```

In `activate()`, replace the launching comment:

```ts
    if (target.region.id.startsWith('game:')) {
      launchNotice = null;
      // The gesture that got us here is an XR select, which is as close to a
      // user gesture as this session will ever get - so resume here, where a
      // browser that counts it will let the sound through with no prompt.
      void audio?.resume();
      void launch(target.region.id.slice('game:'.length));
    }
```

Pass `launchNotice` into `drawLibraryPanel`'s `labels.noneHereHint` slot? No — add it as its own draw concern: extend `repaintLibrary` to draw the notice over the header when set:

```ts
    if (launchNotice) {
      library.paint((ctx) => {
        ctx.save();
        ctx.fillStyle = '#7a2222';
        ctx.fillRect(0, 0, LIBRARY_PANEL_SIZE.width, 40);
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(launchNotice, LIBRARY_PANEL_SIZE.width / 2, 20);
        ctx.restore();
      });
    }
```

In `frame()`, before the `arePanelsVisible` return, add the audio prompt handling:

```ts
    // A player who has to press once for sound presses the trigger, which is
    // also SNES R - so the prompt keeps the panels up until it is answered,
    // and answering it is the same select that dismisses it.
    if (needsAudioGesture && scene.triggerDown()) {
      void audio?.resume();
      needsAudioGesture = audio?.needsGesture ?? false;
    }
```

In `teardown()`, add `await engine?.stop()` — teardown becomes `async` and `onDestroy` calls `void teardown()`:

```ts
  async function teardown(): Promise<void> {
    await engine?.stop();
    engine = null;
    core = null;
    audio = null;
    needsAudioGesture = false;
    scene?.dispose();
    scene = null;
    session = null;
    library = null;
    covers.clear();
    hovered = null;
    launchNotice = null;
    vrActive.set(false);
    vrRequested.set(false);
  }
```

Add the i18n keys:

- `vrRomUnreadable` — en: `"That file could not be read. Check the folder permission from the browser."`, fr: `"Ce fichier n'a pas pu être lu. Vérifie l'autorisation du dossier depuis le navigateur."`
- `vrLaunchFailed` — en: `"The game could not be started."`, fr: `"Le jeu n'a pas pu démarrer."`

- [ ] **Step 3: Verify by hand, in a headset**

```bash
bun run test:ui && bun run test:netplay && cd frontend && bun run check && bun run build
```

Then on the Quest, with at least one playable ROM already added from the flat browser:

1. Enter VR, look at the lectern, press a tile. The panels vanish and the game appears on the curved screen.
2. Sound plays. If a "press for sound" state occurs, one trigger press fixes it and does not also press R in the game.
3. **The controls:** left stick moves in all eight directions; the two right face buttons and the two left ones act; the triggers are L and R; the grips are Start and Select.
4. Click the right thumbstick. The lectern comes back and the game keeps running behind it. While it is up, the trigger scrolls and **does not** press R.
5. Open the Quest system menu mid-game and close it. Nothing is stuck down — the character is not still running right.
6. Exit VR. Re-enter, launch the same game: a cartridge save made before the exit is there.
7. **The second-emulator check:** from a second browser, have a friend in your group choose a game while you are in VR. You must stay in VR, and the flat page underneath must not have navigated.
8. Revoke the ROM folder's permission in the flat browser, then enter VR and press that tile. A red line appears on the lectern and the game stays in the grid.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/rooms/actions.ts frontend/src/routes/+layout.svelte frontend/src/lib/components/VrShell.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Play a game from the VR lectern

createRoom is exported so the shell can have the room without the goto that
launchSolo bundles with it: that navigation under an immersive session would
mount SoloRoom underneath, giving two cores, two AudioContexts and two
writers racing on one room's cartridge save.

room:opened is guarded for a case the shell cannot cause itself - a partner
choosing a game addresses every member of the room, so a player who joined a
group before putting the headset on would be navigated out from under their
own session.

The ROM is resolved with resolveQuietly and a failure is a line on the panel:
there is no LocateRom to open in here, and the game has not stopped existing
just because the folder permission lapsed."
```

---

### Task 15: `vr/panels/friends.ts` — the right lectern

A read-only shopfront, and honest about it. Inviting opens a room, a room leads to lockstep, and lockstep is out of this version; adding a friend needs a pseudonym typed, and there is no keyboard in an immersive session. What is left is presence — who is online and who is playing — which is a reason to come back, and it costs almost nothing because the data already arrives.

**Files:**
- Create: `frontend/src/lib/vr/panels/friends.ts`
- Test: `core/test/vr-panel-friends.test.ts`
- Modify: `frontend/src/lib/components/VrShell.svelte`, `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `Region`, `PanelSize` (Task 7).
- Produces:
  ```ts
  export interface FriendRow { id: string; pseudo: string; online: boolean; playing: string | null }
  export interface FriendsLabels { heading: string; online: string; offline: string; nobody: string; readOnly: string }
  export const FRIENDS_PANEL_SIZE: PanelSize;
  export const FRIENDS_VISIBLE_ROWS: number;
  export function friendRows(
    friends: readonly { friend: { id: string; pseudo: string } }[],
    online: ReadonlyMap<string, boolean>,
    playingByUserId: ReadonlyMap<string, string>
  ): FriendRow[];
  export function layoutFriendsPanel(rows: readonly FriendRow[]): Region[];
  export function drawFriendsPanel(
    ctx: CanvasRenderingContext2D,
    rows: readonly FriendRow[],
    regions: readonly Region[],
    labels: FriendsLabels
  ): void;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-panel-friends.test.ts`:

```ts
/**
 * The friends lectern.
 *
 * It does nothing on purpose, and the tests are mostly about that: no region is
 * clickable, because every action a friends list normally offers is unavailable
 * in here. Inviting opens a room and a room leads to lockstep, which this
 * version does not do; adding a friend needs a pseudonym typed, and there is no
 * keyboard in an immersive session. A panel full of buttons that refuse would
 * be worse than a panel with none.
 *
 * What it does have to get right is the ordering. Presence is the only reason
 * this panel exists, so the people who are here come first - a friends list
 * that buries the two online friends under forty offline ones has thrown away
 * its whole value.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  friendRows,
  layoutFriendsPanel,
  drawFriendsPanel,
  FRIENDS_PANEL_SIZE,
  FRIENDS_VISIBLE_ROWS
} from '../../frontend/src/lib/vr/panels/friends.js';

const LABELS = {
  heading: 'Friends',
  online: 'online',
  offline: 'offline',
  nobody: 'No friends yet',
  readOnly: 'Invitations are not available in VR yet'
};

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  return {
    texts,
    calls,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() {}, beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

const FRIENDS = [
  { friend: { id: 'u1', pseudo: 'Ada' } },
  { friend: { id: 'u2', pseudo: 'Bo' } },
  { friend: { id: 'u3', pseudo: 'Cy' } }
];

test('the people who are here come first', () => {
  const online = new Map([['u1', false], ['u2', true], ['u3', false]]);
  const rows = friendRows(FRIENDS, online, new Map());
  assert.deepEqual(rows.map((r) => r.pseudo), ['Bo', 'Ada', 'Cy']);
  assert.equal(rows[0].online, true);
});

test('offline friends keep their own order behind them', () => {
  const rows = friendRows(FRIENDS, new Map(), new Map());
  assert.deepEqual(rows.map((r) => r.pseudo), ['Ada', 'Bo', 'Cy'], 'a stable sort, not a shuffle');
});

test('an unknown user id is offline, not a crash', () => {
  const rows = friendRows(FRIENDS, new Map([['nobody', true]]), new Map());
  assert.equal(rows.every((r) => !r.online), true);
});

test('what a friend is playing travels with them', () => {
  const rows = friendRows(
    FRIENDS,
    new Map([['u1', true]]),
    new Map([['u1', 'Super Metroid']])
  );
  assert.equal(rows[0].playing, 'Super Metroid');
  assert.equal(rows[1].playing, null);
});

test('nothing on this panel is clickable', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map());
  assert.deepEqual(
    layoutFriendsPanel(rows),
    [],
    'every action a friends list offers is unavailable in here; buttons that refuse are worse than none'
  );
});

test('a long list is cut to what fits rather than drawn off the panel', () => {
  const many = Array.from({ length: FRIENDS_VISIBLE_ROWS + 10 }, (_, i) => ({
    friend: { id: `u${i}`, pseudo: `Friend ${i}` }
  }));
  const rows = friendRows(many, new Map(), new Map());
  assert.equal(rows.length, FRIENDS_VISIBLE_ROWS, 'there is no scroll here, so the list is capped');
});

test('an empty list says so instead of drawing nothing', () => {
  const ctx = recordingContext();
  drawFriendsPanel(ctx, [], [], LABELS);
  const shown = (ctx as unknown as { texts: string[] }).texts.join(' | ');
  assert.ok(shown.includes(LABELS.nobody), 'a blank panel reads as a panel that failed to load');
});

test('the panel admits it is read-only', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map());
  const ctx = recordingContext();
  drawFriendsPanel(ctx, rows, [], LABELS);
  const shown = (ctx as unknown as { texts: string[] }).texts.join(' | ');
  assert.ok(shown.includes('Ada'));
  assert.ok(
    shown.includes(LABELS.readOnly),
    'a player who cannot find the invite button deserves to be told there is not one'
  );
});

test('a friend in a game shows the game, not just a dot', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map([['u1', 'Zelda']]));
  const ctx = recordingContext();
  drawFriendsPanel(ctx, rows, [], LABELS);
  assert.ok((ctx as unknown as { texts: string[] }).texts.join(' | ').includes('Zelda'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-panel-friends.test.ts`
Expected: FAIL — `Cannot find module '.../vr/panels/friends.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/panels/friends.ts`:

```ts
/**
 * The friends lectern: presence, and nothing else.
 *
 * Every action a friends list normally offers is out of reach in here.
 * Inviting opens a room and a room leads to lockstep, which this version does
 * not do. Adding a friend needs a pseudonym typed, and an immersive session has
 * no keyboard. Removing one is a management gesture and belongs on the flat
 * page with the rest of them.
 *
 * So this panel is a shopfront, and it says so rather than leaving somebody
 * hunting for an invite button that does not exist. Seeing who is online is a
 * reason to come back, and the data already arrives over the socket, so it is
 * nearly free.
 *
 * Presence is the entire point, which is why the sort puts the people who are
 * here first: a list that buries two online friends under forty offline ones
 * has discarded its own value.
 */

import type { PanelSize, Region } from '../panel';

export const FRIENDS_PANEL_SIZE: PanelSize = { width: 800, height: 600 };

const PAD = 24;
const HEADER = 56;
const ROW_H = 56;
const FOOTER = 44;

/** No scrolling here - there is nothing to press, so a cap is honest. */
export const FRIENDS_VISIBLE_ROWS = Math.floor(
  (FRIENDS_PANEL_SIZE.height - HEADER - FOOTER - PAD) / ROW_H
);

export interface FriendRow {
  id: string;
  pseudo: string;
  online: boolean;
  /** The game's title, when they are in one. */
  playing: string | null;
}

export interface FriendsLabels {
  heading: string;
  online: string;
  offline: string;
  nobody: string;
  readOnly: string;
}

export function friendRows(
  friends: readonly { friend: { id: string; pseudo: string } }[],
  online: ReadonlyMap<string, boolean>,
  playingByUserId: ReadonlyMap<string, string>
): FriendRow[] {
  const rows = friends.map((entry) => ({
    id: entry.friend.id,
    pseudo: entry.friend.pseudo,
    // An id the presence map has never heard of is offline. It is what a
    // freshly opened socket looks like before `friends:online` arrives, and
    // guessing "online" there would show everyone as present for a second.
    online: online.get(entry.friend.id) === true,
    playing: playingByUserId.get(entry.friend.id) ?? null
  }));

  // A stable partition, not a comparator: Array.prototype.sort is stable in
  // every engine this runs on, but saying it in two filters means nobody has
  // to remember that.
  return [...rows.filter((r) => r.online), ...rows.filter((r) => !r.online)].slice(
    0,
    FRIENDS_VISIBLE_ROWS
  );
}

/** Deliberately empty. See the header. */
export function layoutFriendsPanel(_rows: readonly FriendRow[]): Region[] {
  return [];
}

export function drawFriendsPanel(
  ctx: CanvasRenderingContext2D,
  rows: readonly FriendRow[],
  _regions: readonly Region[],
  labels: FriendsLabels
): void {
  const { width, height } = FRIENDS_PANEL_SIZE;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD, HEADER / 2);

  if (rows.length === 0) {
    // A blank panel reads as one that failed to load.
    ctx.textAlign = 'center';
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#a0a0b0';
    ctx.fillText(labels.nobody, width / 2, height / 2);
    ctx.restore();
    return;
  }

  rows.forEach((row, index) => {
    const y = HEADER + index * ROW_H + ROW_H / 2;

    ctx.beginPath();
    ctx.fillStyle = row.online ? '#3ddc84' : '#4a4a58';
    ctx.arc(PAD + 8, y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = row.online ? '#ffffff' : '#8a8a98';
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(row.pseudo, PAD + 30, y);

    // The game rather than a bare dot: "online" tells you nothing you would
    // act on, "playing Zelda" is the thing worth looking over for.
    ctx.fillStyle = '#8a8a98';
    ctx.font = '18px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      row.playing ?? (row.online ? labels.online : labels.offline),
      width - PAD,
      y
    );
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = '#6a6a78';
  ctx.font = 'italic 17px system-ui, sans-serif';
  ctx.fillText(labels.readOnly, width / 2, height - FOOTER / 2);

  ctx.restore();
}
```

- [ ] **Step 4: Mount it in `VrShell.svelte`**

```ts
  import {
    FRIENDS_PANEL_SIZE, friendRows, layoutFriendsPanel, drawFriendsPanel
  } from '$lib/vr/panels/friends';
  import { activeRooms } from '$lib/rooms/my-room';

  let friendsPanel: PanelMesh | null = null;
  let friendEntries: Array<{ friend: { id: string; pseudo: string } }> = [];
  let onlineFriends = new Map<string, boolean>();

  /** Who is in a running game, from the rooms the socket already publishes -
   *  the same source `TopBar` hands `FriendsList`. */
  $: playingByUserId = new Map(
    $activeRooms
      .filter((room) => room.status === 'playing')
      .flatMap((room) => room.players.map((p) => [p.userId, room.gameTitle ?? ''] as const))
  );

  function repaintFriends(): void {
    if (!friendsPanel) return;
    const rows = friendRows(friendEntries, onlineFriends, playingByUserId);
    friendsPanel.regions = layoutFriendsPanel(rows);
    friendsPanel.paint((ctx) =>
      drawFriendsPanel(ctx, rows, [], {
        heading: t($language, 'friends'),
        online: t($language, 'online'),
        offline: t($language, 'offline'),
        nobody: t($language, 'vrNoFriends'),
        readOnly: t($language, 'vrFriendsReadOnly')
      })
    );
  }
```

In `enter()`, after the library panel:

```ts
      friendsPanel = scene.addPanel('friends', scene.layout.friends, FRIENDS_PANEL_SIZE);
      try {
        const res = await fetch('/api/friends', { credentials: 'include' });
        if (res.ok) friendEntries = await res.json();
      } catch (err) {
        // A shopfront that failed to load is a shopfront that says "no
        // friends yet". Nothing here is worth ending a session over.
        logger.warn('friends could not be loaded for VR', err);
      }
      $socket?.on('friends:online', (list: Array<{ id: string; online: boolean }>) => {
        onlineFriends = new Map(list.map((f) => [f.id, f.online]));
        repaintFriends();
      });
      $socket?.on('friend:statusChanged', ({ userId, online }: { userId: string; online: boolean }) => {
        onlineFriends.set(userId, online);
        repaintFriends();
      });
      $socket?.emit('friends:getOnlineStatus');
      repaintFriends();
```

In `teardown()`, add:

```ts
    $socket?.off('friends:online');
    $socket?.off('friend:statusChanged');
    friendsPanel = null;
    friendEntries = [];
    onlineFriends = new Map();
```

All three event names are verified: `friends:getOnlineStatus` is what the client emits (`FriendsList.svelte:94`) and what the server listens for (`backend/src/websocket/index.ts:160`); `friends:online` and `friend:statusChanged` are the replies (`:81`, `:88`).

Add the i18n keys `vrNoFriends` (en `"No friends yet"`, fr `"Pas encore d'amis"`) and `vrFriendsReadOnly` (en `"Invitations are not available in VR yet"`, fr `"Les invitations ne sont pas encore disponibles en VR"`). `friends`, `online` and `offline` already exist in both locales — reuse them.

- [ ] **Step 5: Verify**

```bash
bun test core/test/vr-panel-friends.test.ts && bun run test:ui && cd frontend && bun run check
```

Then in the headset: look down and right. Online friends are at the top with a green dot; anyone in a game shows the game's title. The footer says invitations are not available yet. Have a friend sign in while you are looking at it — the panel updates without leaving VR.

- [ ] **Step 6: Register the test file and commit**

```bash
# add core/test/vr-panel-friends.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-panel-friends.test.ts frontend/src/lib/vr/panels/friends.ts frontend/src/lib/components/VrShell.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Show who is online on the right lectern, and admit it does nothing

Every action a friends list offers is out of reach here: inviting opens a
room and a room leads to lockstep, adding a friend needs a keyboard. So the
panel is a shopfront that says so, rather than leaving somebody hunting for
an invite button that does not exist.

Presence is the whole point, so the sort puts the people who are here first -
a list that buries two online friends under forty offline ones has thrown
away its own value - and a friend in a game shows the game rather than a dot."
```

---

### Task 16: `vr/panels/profile.ts` — the low band, and the only setting in VR

The last surface. It carries identity, the two-preset controller switch, the language toggle (there are exactly two — `stores/language.ts:9`), and the only way out of the session that is not the Quest's own menu.

The controller diagram is drawn beside each preset. That is not decoration: the honest objection to the `thumb` preset is that the printed letters stop matching, and showing the mapping at the moment of choosing is the answer to it. The canvas is already being drawn, so it costs almost nothing.

**Files:**
- Create: `frontend/src/lib/vr/panels/profile.ts`
- Test: `core/test/vr-panel-profile.test.ts`
- Modify: `frontend/src/lib/components/VrShell.svelte`, `package.json` (`test:ui` list)

**Interfaces:**
- Consumes: `Region`, `PanelSize` (Task 7); `VrPadScheme` (Task 4).
- Produces:
  ```ts
  export interface ProfileState { pseudo: string; scheme: VrPadScheme; language: 'en' | 'fr'; playing: boolean }
  export interface ProfileLabels {
    letters: string; thumb: string; quit: string; resume: string; controls: string;
  }
  export const PROFILE_PANEL_SIZE: PanelSize;
  export function layoutProfilePanel(state: ProfileState): Region[];
  export function drawProfilePanel(
    ctx: CanvasRenderingContext2D,
    state: ProfileState,
    regions: readonly Region[],
    opts: { labels: ProfileLabels; hoverId: string | null }
  ): void;
  ```

- [ ] **Step 1: Write the failing test**

`core/test/vr-panel-profile.test.ts`:

```ts
/**
 * The profile band.
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 * The quit region always exists. The Quest's menu button is reserved by the
 * system and delivers nothing to the page, so there is no hardware button
 * available for "leave" - this region is the only exit the app itself can
 * offer, and a state that omits it is a state a player is trapped in.
 *
 * And the preset switch draws the mapping. The honest objection to `thumb` is
 * that the letters stop matching what the game says; showing which Quest button
 * carries which SNES button, at the moment of choosing, is the answer to it. A
 * bare pair of labels would not be.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  layoutProfilePanel,
  drawProfilePanel,
  PROFILE_PANEL_SIZE
} from '../../frontend/src/lib/vr/panels/profile.js';

const LABELS = {
  letters: 'Letters',
  thumb: 'Thumb',
  quit: 'Leave VR',
  resume: 'Back to the game',
  controls: 'Controls'
};

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  return {
    texts,
    calls,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

const IDLE = { pseudo: 'Ada', scheme: 'letters' as const, language: 'fr' as const, playing: false };

test('the exit exists in every state, because nothing else can offer one', () => {
  for (const playing of [false, true]) {
    for (const scheme of ['letters', 'thumb'] as const) {
      const ids = layoutProfilePanel({ ...IDLE, scheme, playing }).map((r) => r.id);
      assert.ok(
        ids.includes('quit'),
        `no way out with playing=${playing} scheme=${scheme}; the Quest menu button gives the page nothing`
      );
    }
  }
});

test('both presets are always offered, including the active one', () => {
  const ids = layoutProfilePanel(IDLE).map((r) => r.id);
  assert.ok(ids.includes('scheme:letters'));
  assert.ok(ids.includes('scheme:thumb'), 'switching back has to be possible too');
});

test('both languages are offered - there are exactly two', () => {
  const ids = layoutProfilePanel(IDLE).map((r) => r.id);
  assert.ok(ids.includes('lang:en'));
  assert.ok(ids.includes('lang:fr'));
});

test('going back to the game is offered only when there is one', () => {
  assert.ok(!layoutProfilePanel(IDLE).map((r) => r.id).includes('resume'));
  assert.ok(
    layoutProfilePanel({ ...IDLE, playing: true }).map((r) => r.id).includes('resume'),
    'the stick click also does this, but a player who has not found that needs a button'
  );
});

test('every region stays on the band and none overlap', () => {
  const regions = layoutProfilePanel({ ...IDLE, playing: true });
  for (const r of regions) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off-panel`);
    assert.ok(r.x + r.w <= PROFILE_PANEL_SIZE.width, `${r.id} runs off the right`);
    assert.ok(r.y + r.h <= PROFILE_PANEL_SIZE.height, `${r.id} runs off the bottom`);
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

test('the pseudonym is shown, because this is the identity panel', () => {
  const ctx = recordingContext();
  drawProfilePanel(ctx, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  assert.ok((ctx as unknown as { texts: string[] }).texts.includes('Ada'));
});

test('the preset switch draws the mapping, not just a label', () => {
  const ctx = recordingContext();
  drawProfilePanel(ctx, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  const shown = (ctx as unknown as { texts: string[] }).texts;

  // Under `letters`, Quest A carries SNES A; under `thumb` it carries SNES B.
  // Whichever preset is active, the diagram has to say which is which, or the
  // "the letters lie" objection has no answer on screen.
  assert.ok(shown.some((t) => t.includes('A')), 'the Quest letters appear');
  assert.ok(
    shown.filter((t) => /^[ABXY]/.test(t)).length >= 4,
    'all four action buttons are accounted for'
  );
});

test('the two presets draw different mappings', () => {
  const letters = recordingContext();
  drawProfilePanel(letters, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  const thumb = recordingContext();
  const thumbState = { ...IDLE, scheme: 'thumb' as const };
  drawProfilePanel(thumb, thumbState, layoutProfilePanel(thumbState), {
    labels: LABELS, hoverId: null
  });

  assert.notDeepEqual(
    (letters as unknown as { texts: string[] }).texts,
    (thumb as unknown as { texts: string[] }).texts,
    'if both presets draw the same thing, the diagram is decoration'
  );
});

test('the active preset is marked, so a player can see what they have', () => {
  const plain = recordingContext();
  drawProfilePanel(plain, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  const hovered = recordingContext();
  drawProfilePanel(hovered, IDLE, layoutProfilePanel(IDLE), {
    labels: LABELS, hoverId: 'scheme:thumb'
  });
  const strokes = (c: typeof plain) =>
    (c as unknown as { calls: string[] }).calls.filter((k) => k === 'strokeRect').length;
  assert.ok(strokes(hovered) > strokes(plain));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test core/test/vr-panel-profile.test.ts`
Expected: FAIL — `Cannot find module '.../vr/panels/profile.js'`

- [ ] **Step 3: Write the implementation**

`frontend/src/lib/vr/panels/profile.ts`:

```ts
/**
 * The low band: who you are, one setting, and the only way out.
 *
 * The quit region exists in every state and that is not a nicety. The Quest's
 * menu button is reserved by the system and delivers nothing to the page, so
 * there is no hardware button this app can read for "leave" - this region is
 * the only exit it can offer, and a state without it is a state somebody is
 * stuck in.
 *
 * The controller diagram beside each preset is the answer to the honest
 * objection against `thumb`: that the printed letters stop matching what the
 * game asks for. Showing which Quest button carries which SNES button, at the
 * moment of choosing, is what makes that a trade rather than a trick. The
 * canvas is already being drawn, so it is nearly free - which is exactly why
 * the spec chose to do it here rather than in a help page nobody opens.
 *
 * What is deliberately absent: the ROM source (there is no file picker in an
 * immersive session), the portable config (files), account deletion (a
 * destructive action behind a confirmation), and per-button rebinding (the
 * issue's own line, and the presets are the whole of the rectification).
 */

import type { PanelSize, Region } from '../panel';
import type { VrPadScheme } from '../pad-scheme';

export const PROFILE_PANEL_SIZE: PanelSize = { width: 900, height: 300 };

const PAD = 20;
const IDENTITY_W = 200;
const CARD_W = 240;
const CARD_H = 150;
const CARD_Y = 60;
const SMALL_W = 90;
const SMALL_H = 48;

export interface ProfileState {
  pseudo: string;
  scheme: VrPadScheme;
  language: 'en' | 'fr';
  /** Whether a game is running behind the panels. */
  playing: boolean;
}

export interface ProfileLabels {
  letters: string;
  thumb: string;
  quit: string;
  resume: string;
  controls: string;
}

/** What each preset puts on the four Touch face buttons, for the diagram.
 * The single source of truth for the mapping itself is `vr/pad.ts`; this is
 * its picture, and the test that the two presets draw differently is what
 * keeps the picture from drifting into fiction. */
const DIAGRAM: Record<VrPadScheme, Array<[string, string]>> = {
  // [what is printed on the Touch, what the SNES calls it]
  letters: [['Y', 'Y'], ['X', 'X'], ['B', 'B'], ['A', 'A']],
  thumb: [['Y', 'X'], ['X', 'Y'], ['B', 'A'], ['A', 'B']]
};

export function layoutProfilePanel(state: ProfileState): Region[] {
  const regions: Region[] = [];
  const left = PAD + IDENTITY_W;

  regions.push({ id: 'scheme:letters', x: left, y: CARD_Y, w: CARD_W, h: CARD_H });
  regions.push({ id: 'scheme:thumb', x: left + CARD_W + 16, y: CARD_Y, w: CARD_W, h: CARD_H });

  const right = PROFILE_PANEL_SIZE.width - PAD - SMALL_W;
  regions.push({ id: 'lang:en', x: right - SMALL_W - 8, y: CARD_Y, w: SMALL_W, h: SMALL_H });
  regions.push({ id: 'lang:fr', x: right, y: CARD_Y, w: SMALL_W, h: SMALL_H });

  // Always. See the header.
  regions.push({
    id: 'quit',
    x: right - SMALL_W - 8,
    y: CARD_Y + SMALL_H + 12,
    w: SMALL_W * 2 + 8,
    h: SMALL_H
  });

  if (state.playing) {
    // The right stick click does this too, but a player who has not
    // discovered that is otherwise looking at their game through a menu.
    regions.push({
      id: 'resume',
      x: right - SMALL_W - 8,
      y: CARD_Y + (SMALL_H + 12) * 2,
      w: SMALL_W * 2 + 8,
      h: SMALL_H
    });
  }

  return regions;
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  region: Region,
  title: string,
  rows: Array<[string, string]>,
  active: boolean,
  hovered: boolean
): void {
  ctx.fillStyle = active ? '#232a44' : '#1c1c26';
  ctx.fillRect(region.x, region.y, region.w, region.h);

  ctx.fillStyle = active ? '#ffffff' : '#a0a0b0';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, region.x + 12, region.y + 22);

  ctx.font = '17px system-ui, sans-serif';
  rows.forEach(([touch, snes], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    ctx.fillStyle = active ? '#d8d8e8' : '#7a7a88';
    ctx.fillText(
      `${touch} → ${snes}`,
      region.x + 12 + column * 110,
      region.y + 60 + row * 34
    );
  });

  if (active) {
    ctx.strokeStyle = '#7aa2ff';
    ctx.lineWidth = 3;
    ctx.strokeRect(region.x, region.y, region.w, region.h);
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
  ctx.font = '18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, region.x + region.w / 2, region.y + region.h / 2);
  if (hovered) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
  }
}

export function drawProfilePanel(
  ctx: CanvasRenderingContext2D,
  state: ProfileState,
  regions: readonly Region[],
  opts: { labels: ProfileLabels; hoverId: string | null }
): void {
  const { width, height } = PROFILE_PANEL_SIZE;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.pseudo, PAD, 44);

  ctx.fillStyle = '#8a8a98';
  ctx.font = '17px system-ui, sans-serif';
  ctx.fillText(opts.labels.controls, PAD + IDENTITY_W, 34);

  for (const region of regions) {
    const hovered = opts.hoverId === region.id;
    switch (region.id) {
      case 'scheme:letters':
        drawCard(ctx, region, opts.labels.letters, DIAGRAM.letters, state.scheme === 'letters', hovered);
        break;
      case 'scheme:thumb':
        drawCard(ctx, region, opts.labels.thumb, DIAGRAM.thumb, state.scheme === 'thumb', hovered);
        break;
      case 'lang:en':
        drawButton(ctx, region, 'EN', state.language === 'en', hovered);
        break;
      case 'lang:fr':
        drawButton(ctx, region, 'FR', state.language === 'fr', hovered);
        break;
      case 'quit':
        drawButton(ctx, region, opts.labels.quit, false, hovered);
        break;
      case 'resume':
        drawButton(ctx, region, opts.labels.resume, false, hovered);
        break;
    }
  }

  ctx.restore();
}
```

- [ ] **Step 4: Mount and wire it in `VrShell.svelte`**

```ts
  import {
    PROFILE_PANEL_SIZE, layoutProfilePanel, drawProfilePanel
  } from '$lib/vr/panels/profile';
  import { writePadScheme } from '$lib/vr/pad-scheme';
  import { user } from '$lib/stores/user';

  let profilePanel: PanelMesh | null = null;

  function repaintProfile(): void {
    if (!profilePanel) return;
    const state = {
      pseudo: $user?.pseudo ?? '',
      scheme: padScheme,
      language: $language,
      playing: engine !== null
    };
    profilePanel.regions = layoutProfilePanel(state);
    const regions = profilePanel.regions;
    profilePanel.paint((ctx) =>
      drawProfilePanel(ctx, state, regions, {
        labels: {
          letters: t($language, 'vrPresetLetters'),
          thumb: t($language, 'vrPresetThumb'),
          quit: t($language, 'vrQuit'),
          resume: t($language, 'vrResume'),
          controls: t($language, 'controls')
        },
        hoverId: hovered?.panel === 'profile' ? hovered.region.id : null
      })
    );
  }
```

Extend `activate()` with a `profile` branch:

```ts
    if (target.panel === 'profile') {
      const id = target.region.id;
      if (id === 'quit') { void leave(); return; }
      if (id === 'resume') { scene?.panelsVisible(false); return; }
      if (id === 'scheme:letters' || id === 'scheme:thumb') {
        const next = id === 'scheme:thumb' ? 'thumb' : 'letters';
        writePadScheme(localStorage, next);
        // Read back rather than assumed: `readPadScheme` is the only thing
        // that decides, and a preset written and not stored (the default is
        // removed, not stored) must still read back correctly.
        padScheme = readPadScheme(localStorage);
        repaintProfile();
        return;
      }
      if (id === 'lang:en' || id === 'lang:fr') {
        language.set(id === 'lang:en' ? 'en' : 'fr');
        // Every panel carries text.
        repaintLibrary();
        repaintFriends();
        repaintProfile();
        return;
      }
    }
```

Make `$: padScheme = readPadScheme(localStorage);` a plain `let padScheme = readPadScheme(localStorage);` initialised in `enter()` — a reactive statement would recompute it and undo the assignment above.

Extend the hover branch in `frame()` so all three panels repaint:

```ts
    if (!sameTarget(tick.hover, hovered)) {
      const before = hovered;
      hovered = tick.hover;
      // Only the panels whose hover actually changed.
      for (const panel of new Set([before?.panel, hovered?.panel])) {
        if (panel === 'library') repaintLibrary();
        if (panel === 'friends') repaintFriends();
        if (panel === 'profile') repaintProfile();
      }
    }
```

In `enter()`, add the panel and paint it; in `teardown()`, `profilePanel = null;`. After a successful `launch()`, call `repaintProfile()` so `resume` appears.

Add the i18n keys:

- `vrPresetLetters` — en `"Letters match"`, fr `"Fidèle aux lettres"`
- `vrPresetThumb` — en `"Thumb comfort"`, fr `"Confort du pouce"`
- `vrQuit` — en `"Leave VR"`, fr `"Quitter la VR"`
- `vrResume` — en `"Back to the game"`, fr `"Retour au jeu"`


- [ ] **Step 5: Verify the whole thing**

```bash
bun run test:all && cd frontend && bun run check && bun run build
```

Then, in the headset, the full pass:

1. Enter VR from the top bar. Screen, two lecterns and the low band are all where they should be.
2. Launch a game. Panels vanish, game plays.
3. Click the right stick. Panels return, game still running.
4. Look down at the band. Your pseudonym is there, and both presets show their mapping.
5. Press "Confort du pouce". The card becomes active. Go back to the game: **the jump is now on the lower right button.** Come back and press "Fidèle aux lettres": it moves back to the upper one.
6. Switch the language. All three panels change.
7. Press "Retour au jeu". Panels vanish.
8. Bring them back, press "Quitter la VR". You are on the flat page, the game has stopped, and the cartridge save is written — re-launch it and confirm.
9. Exit and re-enter. The preset you chose survived.

- [ ] **Step 6: Register the test file and commit**

```bash
# add core/test/vr-panel-profile.test.ts to the test:ui list in package.json first
git add package.json core/test/vr-panel-profile.test.ts frontend/src/lib/vr/panels/profile.ts frontend/src/lib/components/VrShell.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Add the profile band, the preset switch, and the way out

The quit region exists in every state because nothing else can offer one:
the Quest's menu button is reserved by the system and gives the page nothing,
so a state without this region is a state somebody is stuck in.

The controller diagram is drawn beside each preset rather than hidden in a
help page, because the honest objection to the thumb preset is that the
printed letters stop matching - and showing the mapping while choosing is
what makes that a trade instead of a trick."
```

---

## Self-review

**Spec coverage.** Walked the spec section by section.

| Spec section | Task |
|---|---|
| The two-decision preamble (image ready, cadence solved) | 2, 9 |
| `solo-engine` extraction | 1 |
| Module table (`support`, `entry`, `xr-session`, `layout`, `scene`, `screen`, `panel`, `panels/*`, `pointer`, `pad`, `pad-scheme`, `VrShell`) | 3–16 |
| `TopBar` button, shell in the layout | 10 |
| Scene distances, aspect, shader forced off | 6, 10 |
| Both presets, `xr-standard` axes, no exit button | 5, 16 |
| Preset in `localStorage`, switch in the VR profile only | 4, 16 |
| Library panel, two empties, covers same-origin | 12, 13 |
| Friends read-only | 15 |
| Profile band contents | 16 |
| SRAM free, savestates out | 1, 14 |
| Launch without navigating, the `room:opened` guard | 14 |
| `visible-blurred`, `sessionend`, `resolveQuietly`, audio gesture, context lost | 5, 8, 14, 10 |
| Pure-function testing seam, `test:ui` registration | every task |

Two gaps found and closed while checking: **`frame-pump.ts` and `panel-mesh.ts` are not in the spec's module table** (they are consequences of decisions the spec made but did not name — the injectable scheduler, and canvas/texture ownership). They are recorded in "Two refinements to the spec" and in Task 13's header rather than left as surprises.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the code. Two places name a value the executor must fill from reality rather than from this document, and both say so explicitly: the resolved `three` version in Task 8's commit message, and the `friends:getOnline` event name in Task 15 Step 4, which must be confirmed against `FriendsList.svelte:93`.

**Type consistency.** Checked the names that cross tasks:

- `SramPort.save(bytes: Uint8Array)` — Task 1 defines, Task 14 supplies (`toBase64` then emit). Consistent.
- `core.sram()`, not `saveSram()` — corrected in Task 1 after reading `rooms/sram.ts`; `saveSram` is not a method on `PsnesCore` at all.
- `GovernorOptions.schedule` / `FramePump.schedule` — same signature `(run: () => void) => void`, Tasks 2 and 10.
- `Region`/`PanelSize` — defined in Task 7, consumed identically in 11, 12, 13, 15, 16.
- `PointerTarget { panel, region }` — Task 11 defines; Tasks 13–16 all switch on `target.panel` and `target.region.id`.
- `readVrPad(sources, scheme, visibility)` — Task 5 defines, Task 14 calls with all three.
- `VrPadScheme` values `'letters' | 'thumb'` — identical in Tasks 4, 5, 16, including the `DIAGRAM` table.
- `layoutXPanel` / `drawXPanel` naming — uniform across the three panels.
- `paint(draw)` — Task 13 defines; 13, 15, 16 all redraw through it.

**API names verified against the source, not from memory.** `readAspectPreference`, `notifications`, `loadCore`, `AudioSink`, `resolvableHere`, `deviceLibrary`, `toBase64`, `decodeSram`, `setLogLabels`, `resolveQuietly` all exist where this plan imports them from, and `loadCore`/`AudioSink` are both re-exported by the `$lib/znet` barrel. Two errors were found this way and fixed:

- **`core.saveSram()` does not exist.** The method is `core.sram()` (`znet/core.ts:259`), and `saveSram` is not on `PsnesCore` at all — `saveState` is, and it is savestates, not battery saves. Task 1's implementation and its fake core both said the wrong one.
- **`notifications.error()` does not exist.** The store offers `show(message, type, duration)` (`services/notification.ts:16`) and nothing else. Task 10 called a helper that was never written.

The seven i18n keys this plan reuses — `library`, `emptyLibrary`, `noneOnThisDevice`, `friends`, `online`, `offline`, `controls` — were each confirmed present in both locales, which removed two "add it if missing" hedges that were no longer true.
