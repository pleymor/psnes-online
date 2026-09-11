/**
 * The relief panel: one row per layer the frame actually has, and no more.
 *
 * Three rules carry this file.
 *
 * A slot with no pixels this frame gets NO row. The stack is ten planes and
 * ten rows do not fit a tablet at a size a laser pointer lands on, while a
 * real frame is five or six. A row for an absent slot would be a control whose
 * every press changes nothing visible, which inside a headset is
 * indistinguishable from the setting being broken.
 *
 * A step at the end of its ladder has no REGION but keeps its drawing. The
 * button must still be seen - a « − + » pair reduced to « + » reads as a
 * half-loaded panel - and it must not be aimable, because a pointer that
 * snaps to a control that cannot answer reads as a fault rather than a limit.
 *
 * Every value drawn comes from the preset. A panel writing « 15 cm » in the
 * source would pass every layout test while lying to the player about what
 * their last press did.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  RELIEF_PANEL_SIZE,
  layoutReliefPanel,
  drawReliefPanel,
  type ReliefPanelLabels,
  type ReliefPanelState
} from '../../frontend/src/lib/vr/panels/relief.js';
import {
  DEFAULT_RELIEF,
  RELIEF_DISTANCES,
  RELIEF_SPACINGS,
  type ReliefPreset
} from '../../frontend/src/lib/vr/relief-preset.js';
import { VR_SLOT_KEYS, type VrSlotKey } from '../../frontend/src/lib/vr/layer-map.js';

/** The slot's own key as its label: distinctive, so a stray row is visible. */
const LABELS: ReliefPanelLabels = {
  heading: 'Relief',
  strength: 'Intensité',
  close: 'Retour',
  slot: (key: VrSlotKey) => key,
  centimetres: (metres: number) => `${Math.round(metres * 100)} cm`,
  percent: (multiplier: number) => `${Math.round(multiplier * 100)} %`
};

function preset(
  over: Partial<Record<VrSlotKey, number>> = {},
  spacing = DEFAULT_RELIEF.spacing
): ReliefPreset {
  return { spacing, slots: { ...DEFAULT_RELIEF.slots, ...over } };
}

/** The same recording 2D context the other panel tests use. */
function fakeCtx() {
  const texts: string[] = [];
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    canvas: { width: 0, height: 0 },
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, fill() {}, stroke() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    clearRect() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h }); },
    strokeRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; },
    set fillStyle(_v: unknown) {}, set strokeStyle(_v: unknown) {},
    set lineWidth(_v: unknown) {}, set font(_v: unknown) {},
    set textAlign(_v: unknown) {}, set textBaseline(_v: unknown) {},
    set imageSmoothingEnabled(_v: unknown) {}, set imageSmoothingQuality(_v: unknown) {}
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts, rects };
}

function draw(state: ReliefPanelState, hoverId: string | null = null) {
  const { ctx, texts, rects } = fakeCtx();
  drawReliefPanel(ctx, state, layoutReliefPanel(state), { labels: LABELS, hoverId });
  return { texts, rects, joined: texts.join('\n') };
}

const ids = (state: ReliefPanelState) => layoutReliefPanel(state).map((r) => r.id);

const ALL: ReliefPanelState = { preset: DEFAULT_RELIEF, slots: VR_SLOT_KEYS };

test('a slot the frame does not contain gets no row at all', () => {
  const state: ReliefPanelState = {
    preset: DEFAULT_RELIEF,
    slots: ['backdrop', 'bg1.lo', 'sprite']
  };

  const list = ids(state);
  assert.ok(list.includes('slot-out:bg1.lo'), 'a present slot must be steppable');
  for (const absent of ['bg2.lo', 'bg2.hi', 'bg3.lo', 'bg3.hi', 'bg4.lo', 'bg4.hi', 'bg1.hi']) {
    assert.ok(!list.some((id) => id.endsWith(`:${absent}`)), `${absent} got a region`);
  }

  // And no row is drawn for it either: a label with no control is worse than
  // no row, because it says the game has a layer the panel will not move.
  const drawn = draw(state).joined;
  assert.ok(drawn.includes('bg1.lo'));
  assert.ok(!drawn.includes('bg2.lo'), 'an absent slot was still labelled');
});

test('the strength row is there even when the frame has no layers to speak of', () => {
  // One flat plane is what a core with no layer plane gives, and the strength
  // is still the knob that says so. Losing it would leave a panel with a Back
  // button on it and nothing else.
  const list = ids({ preset: DEFAULT_RELIEF, slots: ['backdrop'] });
  assert.ok(list.includes('spacing-less'));
  assert.ok(list.includes('spacing-more'));
  assert.ok(list.includes('close'));
});

test('the order of the rows is the order the picture is stacked in', () => {
  // Whatever order the caller hands them over in, and duplicates included:
  // the panel reads back to front like the PPU composites, so the row above
  // is always the layer behind.
  const shuffled: ReliefPanelState = {
    preset: DEFAULT_RELIEF,
    slots: ['sprite', 'bg1.lo', 'backdrop', 'sprite']
  };
  const rows = ids(shuffled).filter((id) => id.startsWith('slot-out:'));
  assert.deepEqual(rows, ['slot-out:backdrop', 'slot-out:bg1.lo', 'slot-out:sprite']);
});

test('the end of a ladder takes away the region and leaves the button drawn', () => {
  const floor: ReliefPanelState = { preset: preset({ backdrop: 0 }), slots: ['backdrop'] };
  const middle: ReliefPanelState = { preset: preset({ backdrop: 0.05 }), slots: ['backdrop'] };

  assert.ok(!ids(floor).includes('slot-in:backdrop'), 'there is nothing below the back plane');
  assert.ok(ids(floor).includes('slot-out:backdrop'));

  const top: ReliefPanelState = {
    preset: preset({ backdrop: RELIEF_DISTANCES[RELIEF_DISTANCES.length - 1] }),
    slots: ['backdrop']
  };
  assert.ok(!ids(top).includes('slot-out:backdrop'));
  assert.ok(ids(top).includes('slot-in:backdrop'));

  /*
   * Still drawn, and this is the assertion that pins it.
   *
   * The sign is written either way, so counting « − » proves nothing. What
   * changes is the box around it: `chromeButton` frames it with three
   * rectangles and the exhausted step draws the sign alone. Same signs, fewer
   * rectangles.
   */
  const signs = (state: ReliefPanelState) => draw(state).texts.filter((text) => text === '−').length;
  assert.equal(signs(floor), signs(middle), 'the pair stopped looking like a pair');
  assert.ok(
    draw(floor).rects.length < draw(middle).rects.length,
    'the exhausted step kept its box'
  );
});

test('the strength ladder butts at both ends too', () => {
  const off: ReliefPanelState = { preset: preset({}, RELIEF_SPACINGS[0]), slots: ['backdrop'] };
  assert.ok(!ids(off).includes('spacing-less'));
  assert.ok(ids(off).includes('spacing-more'));

  const full: ReliefPanelState = {
    preset: preset({}, RELIEF_SPACINGS[RELIEF_SPACINGS.length - 1]),
    slots: ['backdrop']
  };
  assert.ok(!ids(full).includes('spacing-more'));
  assert.ok(ids(full).includes('spacing-less'));
});

test('no two regions share an id', () => {
  // One pair of buttons per slot means the id carries the slot key. A template
  // that dropped it would give ten rows the same two ids, and the press would
  // land on whichever row `hit()` reached first.
  const list = ids(ALL);
  assert.equal(new Set(list).size, list.length, `duplicate id in ${list.join(', ')}`);
});

test('the values drawn are the ones in the preset', () => {
  const state: ReliefPanelState = {
    preset: preset({ 'bg1.lo': 0.26, sprite: 0.02 }, 0.5),
    slots: ['bg1.lo', 'sprite']
  };
  const drawn = draw(state).joined;
  assert.ok(drawn.includes('26 cm'), `the distance is missing: ${drawn}`);
  assert.ok(drawn.includes('2 cm'));
  assert.ok(drawn.includes('50 %'), 'the strength is missing');
  assert.ok(!drawn.includes('18 cm'), 'a hard-coded default is being drawn');
});

test('a row reads its own rung, not the rung times the strength', () => {
  /*
   * Half strength over 15 cm is 7.5 cm, a number no press can produce: the
   * next « + » would land on 18 cm and the dots would stop describing the same
   * scale as the read-out. The strength has its own row, right above, and that
   * is where the multiplication is stated.
   */
  const state: ReliefPanelState = { preset: preset({ 'bg1.lo': 0.15 }, 0.5), slots: ['bg1.lo'] };
  const drawn = draw(state).joined;
  assert.ok(drawn.includes('15 cm'));
  assert.ok(!drawn.includes('8 cm') && !drawn.includes('7 cm'), 'the product reached the row');
});

test('the heading, every row and the way out are drawn', () => {
  const drawn = draw(ALL).joined;
  for (const label of [LABELS.heading, LABELS.strength, LABELS.close, ...VR_SLOT_KEYS]) {
    assert.ok(drawn.includes(label), `${label} is not drawn`);
  }
});

test('the worst case still fits the tablet', () => {
  /*
   * Mode 0 draws four backgrounds at two priorities each, so all ten slots can
   * be present at once - eleven rows with the strength. That is the case the
   * second column exists for, and a row falling off the bottom of the canvas
   * would be a layer nobody can reach with no error anywhere.
   */
  assert.deepEqual(RELIEF_PANEL_SIZE, { width: 1024, height: 768 });
  for (const count of [1, 5, 6, 7, 10]) {
    const state: ReliefPanelState = { preset: DEFAULT_RELIEF, slots: VR_SLOT_KEYS.slice(0, count) };
    for (const r of layoutReliefPanel(state)) {
      assert.ok(r.x >= 0 && r.y >= 0, `${r.id} runs off the top or the left at ${count} slots`);
      assert.ok(r.x + r.w <= RELIEF_PANEL_SIZE.width, `${r.id} runs off the right at ${count}`);
      assert.ok(r.y + r.h <= RELIEF_PANEL_SIZE.height, `${r.id} runs off the bottom at ${count}`);
    }
  }
});

test('no two regions overlap, at any number of rows', () => {
  for (const count of [1, 5, 6, 7, 10]) {
    const regions = layoutReliefPanel({
      preset: DEFAULT_RELIEF,
      slots: VR_SLOT_KEYS.slice(0, count)
    });
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i];
        const b = regions[j];
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} and ${b.id} overlap at ${count} slots`);
      }
    }
  }
});

test('every target is big enough to be aimed at', () => {
  // The tablet is 1.12 m wide for 1024 px at 1.5 m, so about 24 px per degree.
  // An 80 x 76 step is 3.3 x 3.2 degrees, which a laser held at arm's length
  // lands on. This is the number the second column exists to protect.
  for (const region of layoutReliefPanel(ALL)) {
    assert.ok(region.w >= 80 && region.h >= 76, `${region.id} is ${region.w}x${region.h}`);
  }
});
