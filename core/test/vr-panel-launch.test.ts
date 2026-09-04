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

// Beyond the brief's own fixtures: every save-list test above used two
// saves, so the cap could be deleted entirely and nothing above would
// notice. This is the arrangement that exercises it.
test('the save list is capped, not merely offered', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    name: `Save ${i}`,
    slotNumber: i + 1
  }));
  const o = options({ saves: many });
  const ids = layoutLaunchPanel(o, LABELS)
    .map((r) => r.id)
    .filter((id) => id.startsWith('save:'));
  // save:none plus at most 5 of the 8 saves.
  assert.ok(ids.length <= 6, `the list did not cap: ${ids.length} save regions`);
  assert.ok(!ids.includes('save:s7'), 'an eighth save was offered past the cap');

  const drawn = draw(o).texts.join('\n');
  assert.ok(!drawn.includes('Save 7'), 'a capped save was drawn anyway');
});

// The friend line was only ever checked for the pseudo, never for which of
// the two state words it carries - so "always say waiting" would have
// passed every test above.
test('the friend line says ready only when the friend is ready', () => {
  const waiting = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: false } })
  ).texts.join('\n');
  assert.ok(waiting.includes(LABELS.waitingForFriend), 'not-ready must say waiting');
  assert.ok(!waiting.includes(LABELS.friendReady), 'not-ready must not also claim ready');

  const ready = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(ready.includes(LABELS.friendReady), 'ready must say ready');
  assert.ok(!ready.includes(LABELS.waitingForFriend), 'ready must not also claim waiting');
});

// No test above ever passed a hoverId, so the outline block could be
// deleted outright and nothing would notice.
test('a hovered region draws an outline that an unhovered one does not', () => {
  const o = options();
  const regions = layoutLaunchPanel(o, LABELS);
  const unhovered = draw(o, null).calls.filter((c) => c === 'strokeRect').length;
  const hovered = draw(o, 'launch').calls.filter((c) => c === 'strokeRect').length;
  assert.ok(regions.some((r) => r.id === 'launch'), 'fixture needs a launch region to hover');
  assert.ok(hovered > unhovered, 'hovering drew no extra outline');
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
