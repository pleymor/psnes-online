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
import { SoloSession } from '../../frontend/src/lib/znet/solo.js';
import { FakeCore } from './fake-core.js';

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

test('the governor drives a TickSource through pump and tick', () => {
  const source = new RecordingSource();

  // FrameGovernor reaches for browser globals: document.hidden decides
  // whether it schedules on rAF or in a worker, and rAF hands it its slice.
  // Capturing the callback rather than letting it fire makes the slice
  // deterministic - the point is what the governor calls, not when.
  let slice: (() => void) | null = null;
  const g = globalThis as unknown as Record<string, unknown>;
  const savedDocument = g.document;
  const savedRaf = g.requestAnimationFrame;
  const savedCancel = g.cancelAnimationFrame;

  g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  g.requestAnimationFrame = (cb: () => void) => {
    slice = cb;
    return 1;
  };
  g.cancelAnimationFrame = () => {};

  try {
    const governor = new FrameGovernor(source, { fps: 60 });
    governor.start();

    assert.equal(governor.isRunning, true, 'start() must arm the governor');
    assert.equal(typeof slice, 'function', 'the governor must have scheduled a slice');

    slice!();

    // pump runs unconditionally, once per slice, so it is the reliable signal.
    assert.ok(source.pumps >= 1, 'the governor must pump its source every slice');

    governor.stop();
    assert.equal(governor.isRunning, false);
  } finally {
    g.document = savedDocument;
    g.requestAnimationFrame = savedRaf;
    g.cancelAnimationFrame = savedCancel;
  }
});

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
