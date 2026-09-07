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
  LIBRARY_PANEL_SIZE,
  COVER_H,
  COVER_INSET
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
  const images: unknown[][] = [];
  const ctx = {
    texts,
    calls,
    images,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
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
    drawImage(...args: unknown[]) { calls.push('drawImage'); images.push(args); },
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 10 }; }
  };
  return ctx as unknown as CanvasRenderingContext2D &
    { texts: string[]; calls: string[]; images: unknown[][] };
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

/*
 * The two things that were wrong with every cover in the headset.
 *
 * The tile's cover slot is 216 x 150 - landscape - and box art is almost always
 * portrait, so passing the slot's own width and height to `drawImage` squashed
 * the art by about a third. And the browser's default downscale quality skips
 * source pixels rather than averaging them, which bakes aliasing into the
 * canvas BEFORE three ever sees it: the covers then shimmer with every small
 * movement of the head, and no amount of texture filtering downstream can
 * recover detail that the 2D context already threw away.
 */

/** Box art proportions: taller than it is wide, like almost every SNES cover. */
const PORTRAIT_COVER = { naturalWidth: 350, naturalHeight: 500 } as unknown as CanvasImageSource;

test('a cover is drawn in its own proportions, not stretched to the slot', () => {
  const state = { games: games(1), ownedTotal: 1, scroll: 0 };
  const ctx = recordingContext();
  drawLibraryPanel(ctx, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers: new Map([['g0', PORTRAIT_COVER]])
  });

  const [args] = ctx.images;
  assert.ok(args, 'the cover should have been drawn at all');
  const [, , , w, h] = args as [unknown, number, number, number, number];
  // `COVER_INSET` de chaque côté : le cadre du logement n'est pas de la place
  // pour la jaquette, il EST le style.
  const inner = COVER_H - COVER_INSET * 2;
  assert.equal(h, inner, 'the slot constrains the tall axis');
  assert.equal(w, 350 * (inner / 500), 'the source ratio - not the slot width, which is the squash');
  assert.ok(
    Math.abs(w / h - 350 / 500) < 1e-9,
    'the drawn rectangle must carry the source aspect ratio'
  );
});

test('the cover is centred in the slack rather than pinned left', () => {
  const state = { games: games(1), ownedTotal: 1, scroll: 0 };
  const ctx = recordingContext();
  const regions = layoutLibraryPanel(state);
  drawLibraryPanel(ctx, state, regions, {
    labels: LABELS, hoverId: null, covers: new Map([['g0', PORTRAIT_COVER]])
  });

  const tile = regions.find((r) => r.id === 'game:g0');
  assert.ok(tile);
  const [x] = (ctx.images[0] as [unknown, number]).slice(1) as [number];
  const drawnW = 350 * ((COVER_H - COVER_INSET * 2) / 500);
  assert.equal(x, tile.x + COVER_INSET + (tile.w - COVER_INSET * 2 - drawnW) / 2);
});

test('covers are downscaled with the good filter, not the default one', () => {
  const state = { games: games(1), ownedTotal: 1, scroll: 0 };
  const ctx = recordingContext();
  drawLibraryPanel(ctx, state, layoutLibraryPanel(state), {
    labels: LABELS, hoverId: null, covers: new Map([['g0', PORTRAIT_COVER]])
  });

  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(
    ctx.imageSmoothingQuality,
    'high',
    'the default skips source pixels, which bakes shimmer into the canvas'
  );
});

/*
 * How many games fit, which is the constraint that chose `COVER_H`.
 *
 * The covers were too small, and the free lever was the slot's height rather
 * than the column count: two columns would widen the tile without making a
 * PORTRAIT cover any bigger, because height is what binds it. So `COVER_H`
 * went to the largest value that still leaves two rows under the header -
 * 520 usable pixels over (COVER_H + TITLE_H + GAP) - which is 212. One pixel
 * more and the grid silently drops to a single row of three, and the player
 * loses half their library to a scroll they did not need before.
 *
 * That is what this test is for. It is not about the number; it is about the
 * number never being raised without noticing the cost.
 */
test('the enlarged covers still leave six games visible', () => {
  const state = { games: games(30), ownedTotal: 30, scroll: 0 };
  const tiles = layoutLibraryPanel(state).filter((r) => r.id.startsWith('game:'));
  assert.equal(tiles.length, 6, 'three columns, two rows');
});

test('a portrait cover is limited by the slot height, not its width', () => {
  // If this ever inverts, `COVER_H` has outgrown the tile and the covers stop
  // getting bigger however much taller the slot is made.
  const state = { games: games(1), ownedTotal: 1, scroll: 0 };
  const tile = layoutLibraryPanel(state).find((r) => r.id === 'game:g0');
  assert.ok(tile);
  assert.ok(350 * ((COVER_H - COVER_INSET * 2) / 500) <= tile.w, 'a 0.7 cover no longer fits the tile width');
});
