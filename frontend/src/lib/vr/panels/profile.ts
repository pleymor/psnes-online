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
// 220, not 240: at PROFILE_PANEL_SIZE.width the two cards plus the 16px gap
// between them must clear the language buttons on the right, and 240 ran
// the second card 24px into `lang:en` (caught by the no-overlap test).
const CARD_W = 220;
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
    // A glyph, not just the border colour: two presets whose only difference
    // was a stroke colour would draw the identical set of fillText calls
    // regardless of which is active, and "the two presets draw different
    // mappings" would have nothing to tell them apart by.
    ctx.fillStyle = '#7aa2ff';
    ctx.textAlign = 'right';
    ctx.fillText('●', region.x + region.w - 12, region.y + 22);
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
