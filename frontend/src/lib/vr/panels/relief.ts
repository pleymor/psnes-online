/**
 * How far apart the SNES layers stand, set from inside the headset.
 *
 * The model is `relief-preset.ts` - the ladders, their ends, the per-game
 * storage and why a distance belongs to a (layer, priority) slot rather than
 * to a layer. This module only shows it and produces the regions that walk it
 * one rung.
 *
 * Steps, not sliders, and `screen-shape.ts` gives the argument in full: the
 * pointer is a laser held at arm's length, so aiming at a button is decisive
 * where dragging a handle is not, and the ends of a ladder butt rather than
 * wrap. The desktop probe under `tools/vr-relief` does use sliders; it is
 * driven with a mouse resting on a desk, which is a different instrument.
 *
 * Three decisions are worth writing down.
 *
 * ONLY THE SLOTS THIS FRAME CONTAINS GET A ROW. The stack is ten planes and
 * ten rows do not fit a tablet at a size anyone can aim at, while a typical
 * frame is five or six of them. A row for a slot with no pixels would be a
 * control whose every press changes nothing visible, which in a headset is
 * indistinguishable from the setting not working. The caller reads the set out
 * of `slot-mask.ts`' `present` and passes it in, so this stays pure.
 *
 * A step at the end of its ladder is still DRAWN but gets no region, exactly
 * as `screen-settings.ts` does it, and its comment at the point of drawing
 * carries the two renders it took to settle the appearance. Drawing it keeps a
 * « − + » pair from reading as a half-loaded panel; withholding the region is
 * what stops the pointer snapping to a control that cannot answer.
 *
 * The change applies immediately, with no OK button. The picture is directly
 * behind the tablet, so the player sees the layers separate while they press;
 * an « Apply » would ask them to compare two states of which only one exists.
 */

import { truncate, type PanelSize, type Region } from '../panel';
import { SMW, drawField, statusBox, chromeButton } from './chrome';
import { VR_SLOT_KEYS, type VrSlotKey } from '../layer-map';
import {
  RELIEF_DISTANCES,
  RELIEF_SPACINGS,
  reliefRungs,
  type ReliefPreset
} from '../relief-preset';

export const RELIEF_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 46;

/*
 * A column of rows, and a second column only when one cannot hold them all.
 *
 * The worst case is real: mode 0 draws four backgrounds at two priorities
 * each, so a frame can light all ten slots, and with the strength row that is
 * eleven. The band left between the heading and the way out is 556 px, so
 * eleven rows down one column would be 50 px apiece - 2.1 degrees on this
 * tablet, under what a laser pointer held at arm's length lands on reliably
 * and well under the 76 px every other step on this panel gets. Six rows is
 * what one column holds at a size that can be aimed at, so past six the rows
 * wrap into a second column rather than shrinking.
 *
 * Both columns are the same width as the single one, so a row's internals -
 * where the minus sits, how wide the value box is - never depend on how many
 * slots the game happens to use. A layout whose geometry changed with the BG
 * mode would be a panel that rearranged itself between two games for reasons
 * the player cannot see.
 *
 * 474 and 24 leave 26 px either side, which is exactly where the heading's box
 * starts: a wider column would hang past the one edge the panel already has.
 */
const COL_W = 474;
const COL_GAP = 24;
const ROWS_PER_COL = 6;

/*
 * A row's parts, and the two type sizes that are smaller than the screen
 * panel's on purpose.
 *
 * Both numbers were measured in a browser rather than judged, and both were
 * wrong the first time. The longest row name is « BG1 derrière » - a slot is a
 * background plus which half of it - and at the screen panel's 28 px that is
 * 202 px against a 184 px column, so it came out « BG1 derrièr… » in exactly
 * the language where the two halves are hardest to tell apart. « 150 % » is
 * 96 px at 28 px against 86 px of usable box, so the strength truncated too.
 *
 * The screen panel can afford 28 and 32 px because it has four rows. This one
 * has up to eleven and no room to widen anything, so the type gives way
 * instead: 24 px of label holds the longest name with room over, and 26 px of
 * value holds « 150 % » in a 116 px box. Neither falls below the 24 px the
 * chrome buttons use everywhere else, so nothing here is smaller than what the
 * rest of the tablet already asks the player to read.
 */
const LABEL_W = 184;
const LABEL_FONT = '600 24px system-ui, sans-serif';
const STEP_W = 80;
const VALUE_W = 116;
const VALUE_FONT = '600 26px system-ui, sans-serif';
const MINUS_DX = 188;
const VALUE_DX = 274;
const PLUS_DX = 394;

/**
 * The band the rows are centred in, between the heading and the way out.
 *
 * Centred rather than hung from the top, which is what the first render was.
 * A game with four layers filled the top half and left 300 px of empty glass
 * above the Back button, and on a translucent panel that empty half is the
 * game showing through - so the panel read as a strip of controls that had
 * lost its bottom rather than as a short list. The worst case is unaffected:
 * eleven rows fill the band to within 9 px of it.
 */
const BAND_TOP = 92;
const BAND_BOTTOM = 648;

const ROW_H = 76;
/** 92 rather than 76: the 16 px left over is where the position dots sit. */
const ROW_PITCH = 92;

/**
 * The position dots, smaller than the screen panel's.
 *
 * That panel shows five rungs and can afford 18 px; the distance ladder has
 * eleven, and eleven at 18 px with 12 px between them is 318 px under a value
 * box of 116. They are a read-out and never a target - the pointer aims at the
 * « − » and the « + » - so shrinking them costs nothing but legibility, and at
 * 7 px they still read as a filled position in a row of empty ones.
 */
const DOT_SIZE = 7;
const DOT_GAP = 3;
const DOT_DROP = 4;

const CLOSE_W = 474;
const CLOSE_H = 88;
const CLOSE_Y = 656;
const CLOSE_X = (RELIEF_PANEL_SIZE.width - CLOSE_W) / 2;

export interface ReliefPanelState {
  /** What is currently set for this game. `relief-preset.ts` owns its shape. */
  preset: ReliefPreset;
  /**
   * The slots the current frame actually contains.
   *
   * Order and duplicates do not matter: the rows come out in `VR_SLOT_KEYS`
   * order whatever arrives here, so the panel reads back to front the way the
   * PPU composites and the way the picture in front of the player is stacked.
   */
  slots: readonly VrSlotKey[];
}

export interface ReliefPanelLabels {
  heading: string;
  /** The one multiplier over every slot at once. */
  strength: string;
  /** Back to the options menu, not to the game. See `options.ts`. */
  close: string;
  /**
   * A slot's name, as a person reads it.
   *
   * A function rather than ten strings because naming a slot mixes a hardware
   * label that is not translated (« BG1 ») with words that are (« backdrop »,
   * and which half of a background this is), and the join between them is a
   * locale question. The same boundary the formatters below are on.
   */
  slot: (key: VrSlotKey) => string;
  /**
   * A distance in centimetres. A function and not a string for
   * `screen-settings.ts`' reason: the value comes from the preset, a frozen
   * label would lie about what the last press did, and the decimal separator
   * is a locale question while this module is tested from Bun, which does not
   * resolve the translations' alias.
   */
  centimetres: (metres: number) => string;
  /** The strength, as a proportion. « 100 % » and « 100% » are both right, in
   *  different places. */
  percent: (multiplier: number) => string;
}

/** The rows this state produces, strength first, then the slots back to front. */
function rowsOf(state: ReliefPanelState): VrSlotKey[] {
  return VR_SLOT_KEYS.filter((key) => state.slots.includes(key));
}

/** Where row `index` starts, wrapping into the second column past the sixth. */
function rowOrigin(index: number, total: number): { x: number; y: number } {
  const columns = total > ROWS_PER_COL ? 2 : 1;
  const perColumn = columns === 2 ? Math.ceil(total / 2) : total;
  const left = (RELIEF_PANEL_SIZE.width - (COL_W * columns + COL_GAP * (columns - 1))) / 2;
  const column = Math.min(Math.floor(index / perColumn), columns - 1);

  // The dots hang below the last row, so they are part of what gets centred:
  // leaving them out would push the block 11 px high of centre.
  const tall = (perColumn - 1) * ROW_PITCH + ROW_H + DOT_DROP + DOT_SIZE;
  const top = BAND_TOP + Math.round((BAND_BOTTOM - BAND_TOP - tall) / 2);

  return {
    x: left + column * (COL_W + COL_GAP),
    y: top + (index - column * perColumn) * ROW_PITCH
  };
}

/**
 * The regions, with the ends of every ladder left out.
 *
 * Pure and drawing nothing, like the other panels: it is what lets a test see
 * that a butted ladder leaves no dead target behind.
 */
export function layoutReliefPanel(state: ReliefPanelState): Region[] {
  const rows = rowsOf(state);
  const rungs = reliefRungs(state.preset);
  const total = rows.length + 1;
  const regions: Region[] = [];

  /*
   * Every id is written out at its `id:` rather than passed through a helper.
   *
   * `vr-regions-handled.test.ts` reads these sources with a regular expression
   * to check that nothing draws a control the shell never handles, and it only
   * recognises an id written as a literal at the field itself - quoted, or a
   * template whose prefix ends at the colon. A helper taking the id as an
   * argument would hide all four of them from it, and the failure it guards
   * against is a button that is drawn, aimable, and does nothing - which only
   * a player in a headset discovers.
   */
  const strength = rowOrigin(0, total);
  if (rungs.spacing > 0) {
    regions.push({ id: 'spacing-less', x: strength.x + MINUS_DX, y: strength.y, w: STEP_W, h: ROW_H });
  }
  if (rungs.spacing < RELIEF_SPACINGS.length - 1) {
    regions.push({ id: 'spacing-more', x: strength.x + PLUS_DX, y: strength.y, w: STEP_W, h: ROW_H });
  }

  rows.forEach((key, row) => {
    const { x, y } = rowOrigin(row + 1, total);
    if (rungs.slots[key] > 0) {
      regions.push({ id: `slot-in:${key}`, x: x + MINUS_DX, y, w: STEP_W, h: ROW_H });
    }
    if (rungs.slots[key] < RELIEF_DISTANCES.length - 1) {
      regions.push({ id: `slot-out:${key}`, x: x + PLUS_DX, y, w: STEP_W, h: ROW_H });
    }
  });

  regions.push({ id: 'close', x: CLOSE_X, y: CLOSE_Y, w: CLOSE_W, h: CLOSE_H });

  return regions;
}

/**
 * The position dots, centred under the value box and sized to fit it.
 *
 * The size is derived rather than fixed because the ladder's length is not
 * this module's to know: it lives in `relief-preset.ts`, it has already grown
 * once, and a hard-coded dot size turns the next lengthening into a row of
 * dots wider than the box it belongs to - a cosmetic fault nothing tests and
 * nobody sees until a headset is on. Deriving it means the row fits by
 * construction, whatever the ladder becomes.
 *
 * The floor is 4 px. Below that a dot stops reading as a filled position in a
 * row of empty ones, which is the whole of what it has to say, and a ladder
 * long enough to hit the floor wants rethinking rather than shrinking.
 */
function drawRungs(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  count: number,
  at: number
): void {
  const size = Math.max(4, Math.min(DOT_SIZE, Math.floor((VALUE_W - (count - 1) * DOT_GAP) / count)));
  const span = count * size + (count - 1) * DOT_GAP;
  const left = x + (VALUE_W - span) / 2;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = i === at ? SMW.accent : SMW.sandDark;
    ctx.fillRect(left + i * (size + DOT_GAP), y, size, size);
  }
}

export function drawReliefPanel(
  ctx: CanvasRenderingContext2D,
  state: ReliefPanelState,
  regions: readonly Region[],
  opts: { labels: ReliefPanelLabels; hoverId: string | null }
): void {
  const { width, height } = RELIEF_PANEL_SIZE;
  const byId = new Map(regions.map((r) => [r.id, r]));
  const { labels, hoverId } = opts;
  const rungs = reliefRungs(state.preset);
  const rows = rowsOf(state);
  const total = rows.length + 1;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  // Glass, and here more than anywhere: what is being set is the picture
  // behind this tablet, and the whole point is to watch it separate.
  drawField(ctx, width, height, 'glass');

  statusBox(ctx, PAD - 14, 12, width - (PAD - 14) * 2, 68);
  ctx.fillStyle = SMW.ink;
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, labels.heading, width - PAD * 2), PAD + 8, TITLE_Y);

  /*
   * The strength first, above the slots it multiplies.
   *
   * Its own ladder holds a zero rung on purpose (`relief-preset.ts` says why):
   * it flattens the picture back to the 2D image in one press, which is the
   * only way to compare the relief against the game as it really looks without
   * leaving the panel.
   */
  const drawn = [
    {
      origin: rowOrigin(0, total),
      label: labels.strength,
      /*
       * The strength is shown as itself, and each slot below shows its OWN
       * rung rather than the rung times the strength. Showing the product
       * would be more literally true and would break the ladder: 0.15 m at
       * half strength reads « 8 cm », a number no press can produce, and the
       * next « + » would jump it to 9 - so the dots and the read-out would
       * stop describing the same scale.
       */
      value: labels.percent(RELIEF_SPACINGS[rungs.spacing]),
      minus: 'spacing-less',
      plus: 'spacing-more',
      count: RELIEF_SPACINGS.length,
      at: rungs.spacing
    },
    ...rows.map((key, row) => ({
      origin: rowOrigin(row + 1, total),
      label: labels.slot(key),
      value: labels.centimetres(RELIEF_DISTANCES[rungs.slots[key]]),
      minus: `slot-in:${key}`,
      plus: `slot-out:${key}`,
      count: RELIEF_DISTANCES.length,
      at: rungs.slots[key]
    }))
  ];

  for (const row of drawn) {
    const { x, y } = row.origin;

    ctx.fillStyle = '#ffffff';
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, row.label, LABEL_W), x, y + ROW_H / 2);

    for (const [id, sign, dx] of [
      [row.minus, '−', MINUS_DX],
      [row.plus, '+', PLUS_DX]
    ] as const) {
      const region = byId.get(id);
      if (region) {
        chromeButton(ctx, region, sign, 'loud', hoverId === id, 40);
        continue;
      }
      /*
       * The sign alone, no box. `screen-settings.ts` carries the two renders
       * that settled this: a quiet button reads as an ordinary pressable one,
       * and a sand slot pulls the eye toward the single control that cannot
       * answer. What is left shows the pair without offering the dead half.
       */
      ctx.fillStyle = SMW.sandDark;
      ctx.font = '600 40px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sign, x + dx + STEP_W / 2, y + ROW_H / 2);
    }

    statusBox(ctx, x + VALUE_DX, y, VALUE_W, ROW_H);
    ctx.fillStyle = SMW.ink;
    ctx.font = VALUE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      truncate(ctx, row.value, VALUE_W - 24),
      x + VALUE_DX + VALUE_W / 2,
      y + ROW_H / 2
    );

    drawRungs(ctx, x + VALUE_DX, y + ROW_H + DOT_DROP, row.count, row.at);
  }

  const close = byId.get('close');
  if (close) chromeButton(ctx, close, labels.close, 'quiet', hoverId === 'close');

  ctx.restore();
}
