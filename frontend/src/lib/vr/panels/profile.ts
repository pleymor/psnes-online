/**
 * The low band: who you are, and the way to everything else.
 *
 * It was a settings surface - two preset cards with controller diagrams, a
 * language pair, and four rows naming the mappings no preset changes. It is a
 * launcher now, and everything it stopped showing is somewhere better rather
 * than gone. That distinction is the whole of what made the removal
 * defensible, so it is written down here:
 *
 * The four fixed rows existed for a real reason. START sits on the right grip,
 * the one button nobody thinks to squeeze, and a whole hardware test session
 * went into concluding the controls were dead when they were merely
 * unlabelled. `panels/controls.ts` now names it better than this band ever
 * did: it draws all eight buttons against the human name of the input each one
 * CURRENTLY carries, so START names its grip from the real map instead of from
 * a static picture of a default. The two mappings that belong to no button -
 * the d-pad on the sticks, the system menu - have their own lines there too.
 *
 * The preset cards went the same way and for the same reason. Their diagram
 * was a compressed preview of two defaults, built for a panel that had no
 * per-button rows; the remap panel's eight rows are that diagram in full. The
 * language pair went with them because it is a setting, and settings now live
 * on the panel that has room for them.
 *
 * One small thing fell out of that. This band's `remap` label was
 * "deliberately NOT `controls`, which titles the fixed-map strip on this same
 * panel: one word naming both a heading and a button identifies neither." The
 * strip is gone, so the button can have the obvious word back.
 *
 * The quit region exists in every state and that is not a nicety. The Quest's
 * menu button is reserved by the system and delivers nothing to the page, so
 * there is no hardware button this app can read for "leave" - this region is
 * the only exit it can offer, and a state without it is a state somebody is
 * stuck in. It is also laid out FIRST, so that gaining the two in-game regions
 * cannot move it: a button that shifts under the pointer at the moment it is
 * most wanted is not the same button.
 *
 * What is deliberately absent: the ROM source (there is no file picker in an
 * immersive session), the portable config (files), and account deletion (a
 * destructive action behind a confirmation). Save management is absent too,
 * for now, and for a different reason - it wants a panel of its own that does
 * not exist yet, and a button that opens nothing is worse than no button.
 */

import { truncate, type PanelSize, type Region } from '../panel';

export const PROFILE_PANEL_SIZE: PanelSize = { width: 900, height: 300 };

const PAD = 20;
/** The identity's column, which the buttons start clear of. */
const IDENTITY_W = 200;

const BTN_H = 72;
const BTN_GAP = 20;

/*
 * Four columns rather than three, which is what made room for saving and
 * loading without a third row.
 *
 * 147px on a 900px canvas across the band's 39.6 degrees is about 6.5 degrees
 * of view per button - a large target by any measure a headset cares about, so
 * the narrowing costs nothing in aim. `vr-layout.test.ts` is what keeps that
 * angular figure honest.
 */
const COLUMNS_N = 4;
const FIRST_X = PAD + IDENTITY_W + 10;
const BTN_W = Math.floor(
  (PROFILE_PANEL_SIZE.width - PAD - FIRST_X - BTN_GAP * (COLUMNS_N - 1)) / COLUMNS_N
);
const COLUMNS = Array.from({ length: COLUMNS_N }, (_, i) => FIRST_X + i * (BTN_W + BTN_GAP));
/** Two rows, centred in what is left of the band's height. */
const ROWS = [0, 1].map(
  (i) => (PROFILE_PANEL_SIZE.height - (BTN_H * 2 + BTN_GAP)) / 2 + i * (BTN_H + BTN_GAP)
);

function slot(column: number, row: number): Omit<Region, 'id'> {
  return { x: COLUMNS[column], y: ROWS[row], w: BTN_W, h: BTN_H };
}

export interface ProfileState {
  pseudo: string;
  /** Whether a game is running behind the panels. */
  playing: boolean;
  /**
   * The newest thing the app has to say, or null.
   *
   * It exists because `notifications.show` draws DOM toasts, and a headset
   * presenting an immersive session cannot see one. Without this, pressing
   * Save produced no confirmation at all - which is indistinguishable from a
   * button that does nothing. `VrShell` mirrors the notification store here,
   * so anything raised during a session lands somewhere visible.
   */
  notice: string | null;
}

export interface ProfileLabels {
  /** Opens the rebinding panel on the curved screen. */
  controls: string;
  /** Opens the saves screen on the tablet. */
  saves: string;
  /** Puts the room back in front of the player. See `vr/anchor.ts`. */
  recenter: string;
  quit: string;
  resume: string;
  /** Ends the GAME, not the session. */
  stopGame: string;
}

export function layoutProfilePanel(state: ProfileState): Region[] {
  // The exit first, so its rectangle is decided before anything conditional
  // can shift it - see the header.
  /*
   * The exit first, and twice as wide as anything else.
   *
   * First so its rectangle is decided before anything conditional can shift it
   * - see the header. Wide because it is the only way out this app has, so it
   * should be the easiest thing on the band to hit; the four-column grid left
   * a slot spare beside it and there is nothing better to spend it on. It also
   * happens to be what lets the label stay "Leave VR" instead of being
   * shortened to fit, which for the one region a stuck player needs to read is
   * the right way round.
   */
  const regions: Region[] = [
    { id: 'quit', ...slot(2, 0), w: BTN_W * 2 + BTN_GAP },
    { id: 'controls', ...slot(0, 0) },
    { id: 'recenter', ...slot(1, 0) }
  ];

  if (state.playing) {
    /*
     * Un bouton pour les sauvegardes, là où il y en avait deux.
     *
     * Sauvegarder et Charger agissaient sur un emplacement rapide unique. Le
     * panneau de la tablette liste, crée et charge n'importe laquelle, donc un
     * seul bouton l'ouvre - et l'emplacement libéré reste vide plutôt que
     * d'être rempli pour être rempli.
     */
    regions.push({ id: 'saves', ...slot(0, 1) });
    regions.push({ id: 'resume', ...slot(2, 1) });
    regions.push({ id: 'stop', ...slot(3, 1) });
  }

  return regions;
}

/**
 * One button.
 *
 * Truncated rather than left to run: a long translation used to spill out of
 * its button onto whatever sat beside it, on a curved texture with no layout
 * engine to complain - and on this band the neighbour can be the exit.
 */
function drawButton(
  ctx: CanvasRenderingContext2D,
  region: Region,
  label: string,
  tone: 'quiet' | 'warn',
  hovered: boolean
): void {
  ctx.fillStyle = tone === 'warn' ? '#3a2230' : '#22222e';
  ctx.fillRect(region.x, region.y, region.w, region.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    truncate(ctx, label, region.w - 20),
    region.x + region.w / 2,
    region.y + region.h / 2
  );
  if (hovered) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(region.x - 4, region.y - 4, region.w + 8, region.h + 8);
  }
}

export function drawProfilePanel(
  ctx: CanvasRenderingContext2D,
  state: ProfileState,
  regions: readonly Region[],
  opts: { labels: ProfileLabels; hoverId: string | null }
): void {
  const { width, height } = PROFILE_PANEL_SIZE;
  const { labels } = opts;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#14141c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, state.pseudo, IDENTITY_W - PAD), PAD, height / 2);

  const label: Record<string, string> = {
    quit: labels.quit,
    controls: labels.controls,
    recenter: labels.recenter,
    saves: labels.saves,
    resume: labels.resume,
    stop: labels.stopGame
  };
  // Leaving the session and ending the game are the two that cannot be undone
  // by pressing again, so they are the two that read as consequential.
  const warn = new Set(['quit', 'stop']);

  for (const region of regions) {
    drawButton(
      ctx,
      region,
      label[region.id] ?? region.id,
      warn.has(region.id) ? 'warn' : 'quiet',
      opts.hoverId === region.id
    );
  }

  // Below the second row, and only when there is something to say: an empty
  // line drawn every frame would read as a message that failed to load.
  if (state.notice) {
    ctx.fillStyle = '#c8d4ff';
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, state.notice, width - PAD * 2), width / 2, height - PAD - 10);
  }

  ctx.restore();
}
