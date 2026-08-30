/**
 * `fullscreen.ts` and `chrome-autohide.ts`, the two modules Task 12 lifted
 * out of LockstepRoom.svelte and SoloRoom.svelte.
 *
 * Neither module owns a DOM element or touches Svelte reactivity - both are
 * pure logic wrapped around a handful of browser calls, which is exactly what
 * a browser is the wrong tool for testing. A fake `document` (following the
 * same globalThis-swap pattern as solo.test.ts) and real short timers are
 * enough to exercise every branch, including the one thing no test in this
 * repo could otherwise reach: the deliberate/Escape distinction, which never
 * shows up as a difference in the DOM, only in which of two booleans a
 * callback receives.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createChromeAutohide } from '../../frontend/src/lib/rooms/chrome-autohide.js';
import { createFullscreen } from '../../frontend/src/lib/rooms/fullscreen.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------- chrome-autohide

const IDLE_MS = 30;
// Comfortably past IDLE_MS without making the suite slow.
const PAST_IDLE = IDLE_MS + 30;

function autohide() {
  const calls: boolean[] = [];
  const chrome = createChromeAutohide({ idleMs: IDLE_MS, onVisibility: (v) => calls.push(v) });
  return { chrome, calls };
}

test('reveal(true) shows immediately, then hides once the idle delay elapses', async () => {
  const { chrome, calls } = autohide();
  chrome.reveal(true);
  assert.deepEqual(calls, [true]);
  await wait(PAST_IDLE);
  assert.deepEqual(calls, [true, false]);
});

test('reveal(false) shows but never schedules a hide - out of fullscreen there is nothing to hide', async () => {
  const { chrome, calls } = autohide();
  chrome.reveal(false);
  assert.deepEqual(calls, [true]);
  await wait(PAST_IDLE);
  assert.deepEqual(calls, [true], 'no hide call should ever have fired');
});

test('hold() keeps the toolbar up past the idle delay; release() lets the countdown resume', async () => {
  const { chrome, calls } = autohide();
  chrome.hold(true);
  assert.deepEqual(calls, [true]);
  await wait(PAST_IDLE);
  assert.deepEqual(calls, [true], 'a held toolbar must not hide on its own');

  chrome.release(true);
  assert.deepEqual(calls, [true, true]);
  await wait(PAST_IDLE);
  assert.deepEqual(calls, [true, true, false]);
});

test('release(false) does not arm a hide - the caller passes fullscreen state through, the module never assumes it', async () => {
  // hold(active) has no observable effect of its own: held is set true right
  // before its reveal() call, and `held` alone already blocks the timer
  // regardless of `active`. It is release() where the passed-through state
  // actually matters, because `held` is false by the time it calls reveal().
  const { chrome, calls } = autohide();
  chrome.hold(true);
  calls.length = 0;

  chrome.release(false);
  assert.deepEqual(calls, [true]);
  await wait(PAST_IDLE);
  assert.deepEqual(
    calls,
    [true],
    'out of fullscreen there is nothing to hide - a hardcoded reveal(true) here would arm one anyway'
  );
});

test('reveal restarts the countdown instead of stacking a second timer', async () => {
  const { chrome, calls } = autohide();
  chrome.reveal(true);
  await wait(IDLE_MS / 2);
  chrome.reveal(true); // must clear and restart the countdown, not add a second one
  await wait(IDLE_MS / 2 + 10);
  // A stacked (uncleared) first timer would have fired here, roughly IDLE_MS
  // after the very first reveal() - hiding the toolbar while the mouse was
  // still moving, which is the bug this test exists to catch.
  assert.deepEqual(calls, [true, true], 'no hide yet - the countdown was restarted, not stacked');
  await wait(IDLE_MS / 2 + 15);
  assert.deepEqual(calls, [true, true, false], 'hides exactly once, from the restarted timer only');
});

test('stop() cancels a pending hide and clears the held state', async () => {
  const { chrome, calls } = autohide();
  chrome.reveal(true);
  chrome.stop();
  await wait(PAST_IDLE);
  assert.deepEqual(calls, [true], 'a torn-down module must not call back into a dead component');

  // stop() must also drop a hold, or a room torn down while a menu inside the
  // toolbar was open would leave the next reveal() pinned open forever.
  chrome.hold(true);
  chrome.stop();
  chrome.reveal(true);
  await wait(PAST_IDLE);
  assert.equal(calls.at(-1), false, 'held state must not survive stop()');
});

// ----------------------------------------------------------------- fullscreen

type Listener = () => void;

/** Enough of `Document` for `fullscreen.ts`: it reads one field and calls three methods. */
class FakeDocument {
  fullscreenElement: FakeElement | null = null;
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** The real browser fires this itself; the fake needs telling. */
  fire(type = 'fullscreenchange'): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  async exitFullscreen(): Promise<void> {
    this.fullscreenElement = null;
  }
}

/** Enough of `HTMLElement` for `fullscreen.ts`: it calls one method on it. */
class FakeElement {
  requestCount = 0;
  constructor(
    private doc: FakeDocument,
    private rejectWith: Error | null = null
  ) {}

  async requestFullscreen(): Promise<void> {
    this.requestCount++;
    if (this.rejectWith) throw this.rejectWith;
    this.doc.fullscreenElement = this;
  }
}

/**
 * Installs a fake `document` on globalThis for the duration of `run`, and
 * always restores whatever was there before - same pattern as solo.test.ts's
 * governor test, which fakes `document`, rAF and `performance` the same way.
 */
async function withFakeDocument(run: (doc: FakeDocument) => Promise<void> | void): Promise<void> {
  const doc = new FakeDocument();
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.document;
  g.document = doc;
  try {
    await run(doc);
  } finally {
    g.document = saved;
  }
}

test('a toggle() into fullscreen reports deliberate:true once the browser confirms it', () =>
  withFakeDocument(async (doc) => {
    const el = new FakeElement(doc);
    const calls: Array<[boolean, boolean]> = [];
    const fs = createFullscreen({
      element: () => el as unknown as HTMLElement,
      onChange: (active, deliberate) => calls.push([active, deliberate])
    });
    fs.attach();

    await fs.toggle();
    doc.fire();

    assert.deepEqual(calls, [[true, true]]);
  }));

test('a fullscreenchange with no preceding toggle() is Escape, and reports deliberate:false', () =>
  withFakeDocument(async (doc) => {
    const el = new FakeElement(doc);
    const calls: Array<[boolean, boolean]> = [];
    const fs = createFullscreen({
      element: () => el as unknown as HTMLElement,
      onChange: (active, deliberate) => calls.push([active, deliberate])
    });
    fs.attach();

    // The browser threw the page out of fullscreen on its own - Escape - and
    // already updated fullscreenElement before firing the event. Nothing
    // here ever called toggle(). This is the assertion that matters most: if
    // it regresses, Escape silently stops opening the pause menu.
    doc.fullscreenElement = null;
    doc.fire();

    assert.deepEqual(calls, [[false, false]]);
  }));

test('the deliberate flag is one-shot: an unrelated change right after a toggle() reports deliberate:false', () =>
  withFakeDocument(async (doc) => {
    const el = new FakeElement(doc);
    const calls: Array<[boolean, boolean]> = [];
    const fs = createFullscreen({
      element: () => el as unknown as HTMLElement,
      onChange: (active, deliberate) => calls.push([active, deliberate])
    });
    fs.attach();

    await fs.toggle(); // deliberately enters fullscreen
    doc.fire();
    assert.deepEqual(calls, [[true, true]]);

    // A second change follows with no new toggle() - Escape, right after a
    // deliberate entry. A sticky flag would report this as deliberate too and
    // the pause menu would never open.
    doc.fullscreenElement = null;
    doc.fire();

    assert.deepEqual(calls, [
      [true, true],
      [false, false]
    ]);
  }));

test('toggle() rejecting clears the deliberate flag instead of leaving it armed', () =>
  withFakeDocument(async (doc) => {
    const denial = new Error('denied');
    const el = new FakeElement(doc, denial);
    const calls: Array<[boolean, boolean]> = [];
    const fs = createFullscreen({
      element: () => el as unknown as HTMLElement,
      onChange: (active, deliberate) => calls.push([active, deliberate])
    });
    fs.attach();

    await assert.rejects(() => fs.toggle(), denial);

    // The refused request never changed anything. If some unrelated
    // fullscreenchange fires next, it must not be mistaken for the toggle
    // that just failed.
    doc.fire();

    assert.deepEqual(calls, [[false, false]]);
  }));

test('restore() does nothing already fullscreen, and arms the deliberate flag when not', () =>
  withFakeDocument(async (doc) => {
    const el = new FakeElement(doc);
    const calls: Array<[boolean, boolean]> = [];
    const fs = createFullscreen({
      element: () => el as unknown as HTMLElement,
      onChange: (active, deliberate) => calls.push([active, deliberate])
    });
    fs.attach();

    doc.fullscreenElement = el; // already fullscreen
    fs.restore();
    assert.equal(el.requestCount, 0, 'already fullscreen - nothing to restore');

    doc.fullscreenElement = null; // fell out of fullscreen (e.g. the pause menu opened)
    fs.restore();
    // restore() is fire-and-forget; give its promise chain a turn.
    await wait(0);
    assert.equal(el.requestCount, 1);

    doc.fire();
    assert.deepEqual(calls, [[true, true]], 'the restored fullscreen must be reported as deliberate');
  }));

test('element is read at call time, not captured - it may not exist yet when the module is built', () =>
  withFakeDocument(async (doc) => {
    let current: FakeElement | undefined;
    const el = new FakeElement(doc);
    const fs = createFullscreen({
      element: () => current as unknown as HTMLElement | undefined,
      onChange: () => {}
    });
    fs.attach();

    // Exactly like `stage` before the component has rendered anything.
    current = undefined;
    await fs.toggle();
    assert.equal(el.requestCount, 0, 'nothing to call requestFullscreen on yet');

    // The element exists by the time the room actually toggles fullscreen. A
    // getter captured once at construction, instead of called fresh here,
    // would still see undefined and this would stay 0.
    current = el;
    await fs.toggle();
    assert.equal(el.requestCount, 1, 'the getter must be re-read on every call');
  }));

test('detach() removes the listener - nothing fires after teardown', () =>
  withFakeDocument(async (doc) => {
    const el = new FakeElement(doc);
    const calls: Array<[boolean, boolean]> = [];
    const fs = createFullscreen({
      element: () => el as unknown as HTMLElement,
      onChange: (active, deliberate) => calls.push([active, deliberate])
    });
    fs.attach();
    assert.equal(doc.listenerCount('fullscreenchange'), 1);

    fs.detach();
    assert.equal(doc.listenerCount('fullscreenchange'), 0);

    doc.fullscreenElement = null;
    doc.fire();

    assert.deepEqual(calls, [], 'a callback firing after detach() would run against a dead component');
  }));
