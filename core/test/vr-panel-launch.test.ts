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
  // The shipped English, not a placeholder: two tests below measure this
  // string, and a short stand-in would pass a width check the real wording
  // could fail - which is exactly how the banner came to run into the friend
  // line.
  saveLockedByCreator: 'Your friend chooses where this starts.',
  launch: 'Launch',
  port1: 'Player 1',
  port2: 'Player 2',
  waitingForFriend: 'Waiting for your friend',
  friendReady: 'Ready',
  friendAway: 'Away',
  romMissing: 'This game is not on this device. Launch it once outside VR.',
  alreadyPlaying: 'This room is already playing.',
  noSeat: 'Somebody has to take a controller first.',
  friendAwayBlocked: 'A player is away. Wait for them to come back before starting.'
};

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

const SAVES = [
  { id: 's1', primary: 'Before the boss', secondary: '03/09/2026 18:44', slotNumber: 1, screenshot: SHOT },
  { id: 's2', primary: 'Chapter two', secondary: '02/09/2026 09:12', slotNumber: 2, screenshot: SHOT }
];

/** A stand-in for a loaded `HTMLImageElement`; the painter only draws it. */
const IMAGE = { width: 320, height: 240 } as unknown as CanvasImageSource;

function options(over: Partial<LaunchOptions> = {}): LaunchOptions {
  return {
    game: { id: 'mine', title: 'Super Mario World', crc32: 'aaaa1111' },
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
  const placed: Array<{ text: string; x: number; y: number }> = [];
  const images: Array<{ x: number; y: number; w: number; h: number }> = [];
  return {
    texts,
    calls,
    placed,
    images,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    drawImage(_img: unknown, x: number, y: number, w: number, h: number) {
      calls.push('drawImage');
      images.push({ x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      texts.push(text);
      placed.push({ text, x, y });
    },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    placed: Array<{ text: string; x: number; y: number }>;
    images: Array<{ x: number; y: number; w: number; h: number }>;
  };
}

function draw(
  o: LaunchOptions,
  hoverId: string | null = null,
  pictures: {
    covers?: Map<string, CanvasImageSource>;
    shots?: Map<string, CanvasImageSource>;
  } = {}
) {
  const ctx = recordingContext();
  drawLaunchPanel(ctx, o, layoutLaunchPanel(o, LABELS), {
    labels: LABELS,
    hoverId,
    covers: pictures.covers ?? new Map(),
    shots: pictures.shots ?? new Map()
  });
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
    ['no-seat', LABELS.noSeat],
    ['friend-away', LABELS.friendAwayBlocked]
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

test('no arrangement puts a region off the panel or on top of another', () => {
  /*
   * Every arrangement, not one of them - and that is the correction.
   *
   * This test used to build a single fixture with two saves, where nothing
   * could collide. With four saves or more the fifth and sixth rows reached
   * y 584..708 and overlapped a launch button centred at x 312..712: two
   * hit-testable regions on top of each other, on a curved texture with no
   * layout engine to notice, and the test read as guarding it. The button now
   * lives outside the save column entirely, so no row count can reach it -
   * but the fixture is what let the bug in, so the fixture is what changed.
   */
  const counts = [0, 1, 2, 5, 8];
  const friends = [null, { pseudo: 'Bob', online: true, port: null, isReady: false }] as const;
  const blocks = [null, 'no-seat'] as const;

  for (const count of counts) {
    for (const friend of friends) {
      for (const blocked of blocks) {
        for (const mayChooseSave of [true, false]) {
          const o = options({
            saves: Array.from({ length: count }, (_, i) => ({
              id: `s${i}`,
              primary: `Save ${i}`,
              secondary: '01/09/2026 20:30',
              slotNumber: i + 1,
              screenshot: SHOT
            })),
            friend,
            blocked,
            mayChooseSave
          });
          const regions = layoutLaunchPanel(o, LABELS);
          const where = `saves=${count} friend=${!!friend} blocked=${blocked} may=${mayChooseSave}`;

          for (const r of regions) {
            assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off-panel (${where})`);
            assert.ok(
              r.x + r.w <= LAUNCH_PANEL_SIZE.width,
              `${r.id} runs off the right (${where})`
            );
            assert.ok(
              r.y + r.h <= LAUNCH_PANEL_SIZE.height,
              `${r.id} runs off the bottom (${where})`
            );
          }
          for (let i = 0; i < regions.length; i++) {
            for (let j = i + 1; j < regions.length; j++) {
              const a = regions[i];
              const b = regions[j];
              const apart =
                a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
              assert.ok(apart, `${a.id} overlaps ${b.id} (${where})`);
            }
          }
        }
      }
    }
  }
});

test('the locked-save banner stays clear of the friend line', () => {
  /*
   * Text, not regions, so the overlap test above cannot see it - and this is
   * the one case the banner exists for: a guest who cannot pick the save,
   * looking at a room their friend occupies. At full panel width the banner
   * ran to x 589 while "Bob — Ready" starts at 560.
   */
  const ctx = draw(
    options({
      mayChooseSave: false,
      friend: { pseudo: 'Bob', online: true, port: 2, isReady: true }
    })
  );
  const banner = ctx.placed.find((p) => p.text === LABELS.saveLockedByCreator);
  const friendLine = ctx.placed.find((p) => p.text.includes('Bob'));

  assert.ok(banner && friendLine, 'both lines must be drawn in this state');
  // The fixture's own metric, as the other width tests use.
  assert.ok(
    banner.x + banner.text.length * 9 <= friendLine.x,
    `the banner reaches ${banner.x + banner.text.length * 9}px, the friend line starts at ${friendLine.x}px`
  );
});

test('the save list is capped, not merely offered', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    primary: `Save ${i}`,
    secondary: null,
    slotNumber: i + 1,
    screenshot: null
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

// `FriendState.online` was computed and never drawn: a friend who closed
// their tab kept their port and `isReady`, so the line above would have kept
// reading "Ready" with nobody there to have pressed anything.
test('the friend line says away when the friend is offline, whatever their port says', () => {
  const awayButReady = draw(
    options({ friend: { pseudo: 'Bob', online: false, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(awayButReady.includes(LABELS.friendAway), 'offline must say away');
  assert.ok(!awayButReady.includes(LABELS.friendReady), 'a stale "ready" must not survive the friend leaving');
  assert.ok(!awayButReady.includes(LABELS.waitingForFriend), 'nor a stale "waiting"');

  const present = draw(
    options({ friend: { pseudo: 'Bob', online: true, port: 2, isReady: true } })
  ).texts.join('\n');
  assert.ok(!present.includes(LABELS.friendAway), 'online must not also claim away');
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

test('a banner too long for its column is cut to it, not to the panel', () => {
  /*
   * The shipped wording fits 470px whole, so the test above passes whatever
   * the truncation bound is - it guards the outcome, not the rule. A future
   * translation is what the bound exists for, and this is what pins it: a
   * label that must be cut, and a column it must be cut to.
   */
  const long = { ...LABELS, saveLockedByCreator: 'X'.repeat(200) };
  const o = options({
    mayChooseSave: false,
    friend: { pseudo: 'Bob', online: true, port: 2, isReady: true }
  });
  const ctx = recordingContext();
  drawLaunchPanel(ctx, o, layoutLaunchPanel(o, long), {
    labels: long,
    hoverId: null,
    covers: new Map(),
    shots: new Map()
  });

  const banner = ctx.placed.find((p) => p.text.startsWith('X'));
  const friendLine = ctx.placed.find((p) => p.text.includes('Bob'));
  assert.ok(banner && friendLine, 'both lines must be drawn in this state');
  assert.ok(
    banner.x + banner.text.length * 9 <= friendLine.x,
    `a long banner reached ${banner.x + banner.text.length * 9}px, past the friend line at ${friendLine.x}px`
  );
});

test('a long save name is truncated rather than run into the ports', () => {
  const o = options({
    saves: [
      {
        id: 's1',
        primary: 'A'.repeat(200),
        secondary: '03/09/2026 18:44',
        slotNumber: 1,
        screenshot: SHOT
      }
    ],
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

/*
 * The pictures, and why they were absent rather than broken.
 *
 * This panel shipped drawing a grey rectangle where the cover belongs, with a
 * comment saying a real one would mean handing this module the same `covers`
 * map and the same per-URL CORS handling `VrShell` already has. It would not:
 * `VrShell` resolves CORS at LOAD time and a tainting image never enters the
 * map at all, so what reaches here is always safe to draw. The map is now
 * simply passed, and the placeholder stays underneath for a game with no art.
 *
 * Save thumbnails are `data:` URLs and cannot taint anything, so they had no
 * excuse in the first place.
 */

test('the cover is drawn when it has loaded, and the placeholder when it has not', () => {
  const withArt = draw(options(), null, { covers: new Map([['mine', IMAGE]]) });
  assert.ok(withArt.calls.includes('drawImage'), 'the cover never reached the canvas');

  const without = draw(options());
  assert.ok(
    !without.images.some((i) => i.y < 264),
    'nothing should be drawn in the cover box before the image loads'
  );
});

test('the cover is looked up by game id, not by title', () => {
  // `VrShell` keys `covers` by `game.id`. A lookup by anything else finds
  // nothing and silently falls back to the placeholder - the exact failure
  // this whole change exists to end.
  const wrongKey = draw(options(), null, { covers: new Map([['Super Mario World', IMAGE]]) });
  assert.ok(!wrongKey.calls.includes('drawImage'), 'the cover was found under the wrong key');
});

test('each save row draws its thumbnail and both of its lines', () => {
  const ctx = draw(options(), null, {
    shots: new Map([
      ['s1', IMAGE],
      ['s2', IMAGE]
    ])
  });

  const drawn = ctx.texts.join('\n');
  assert.ok(drawn.includes('Before the boss'), 'the name is missing');
  assert.ok(drawn.includes('03/09/2026 18:44'), 'the moment is missing');
  assert.equal(ctx.images.length, 2, 'one thumbnail per save that has one');
});

test('a save with no thumbnail still draws its lines', () => {
  const ctx = draw(
    options({
      saves: [{ id: 's1', primary: 'Before the boss', secondary: null, slotNumber: 1, screenshot: null }]
    })
  );
  assert.ok(ctx.texts.join('\n').includes('Before the boss'));
  assert.equal(ctx.images.length, 0);
});

test('"start fresh" has no thumbnail, because there is nothing to depict', () => {
  const ctx = draw(options({ saves: [] }), null, { shots: new Map([['none', IMAGE]]) });
  assert.ok(ctx.texts.join('\n').includes(LABELS.newGame));
  assert.equal(ctx.images.length, 0, 'a new game was given a picture of something');
});

test('a thumbnail stays inside the row it belongs to', () => {
  /*
   * Geometry, not appearance. A thumbnail that overflows its row lands on the
   * neighbouring row's text on a curved texture with no layout engine to
   * notice - the same class of bug as the launch button that used to cross
   * the save column, which no test saw because no fixture built the case.
   */
  const regions = layoutLaunchPanel(options(), LABELS);
  const ctx = draw(options(), null, {
    shots: new Map([
      ['s1', IMAGE],
      ['s2', IMAGE]
    ])
  });

  for (const image of ctx.images) {
    const row = regions.find(
      (r) => r.id.startsWith('save:') && image.y >= r.y && image.y < r.y + r.h
    );
    assert.ok(row, `a thumbnail at y=${image.y} belongs to no row`);
    assert.ok(
      image.x >= row.x && image.x + image.w <= row.x + row.w,
      `the thumbnail runs out of ${row.id} horizontally`
    );
    assert.ok(
      image.y + image.h <= row.y + row.h,
      `the thumbnail runs out of ${row.id} vertically`
    );
  }
});

test('a row s text clears its thumbnail instead of being drawn over it', () => {
  const ctx = draw(options(), null, {
    shots: new Map([
      ['s1', IMAGE],
      ['s2', IMAGE]
    ])
  });

  const name = ctx.placed.find((p) => p.text === 'Before the boss');
  const shot = ctx.images[0];
  assert.ok(name && shot, 'both must be drawn in this state');
  assert.ok(
    name.x >= shot.x + shot.w,
    `the name starts at ${name.x}px, over a thumbnail ending at ${shot.x + shot.w}px`
  );
});
