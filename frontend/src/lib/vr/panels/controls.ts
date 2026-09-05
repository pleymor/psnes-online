/**
 * Le remap, sur l'écran courbe.
 *
 * Sur l'écran plutôt que sur un pupitre pour la raison qui a déjà donné cette
 * surface à l'écran de lancement : c'est la seule droit devant, et les pupitres
 * sont à plus ou moins soixante degrés - un panneau entier y était passé
 * inaperçu au premier essai sur casque.
 *
 * Deux règles que la mise en page tient plutôt qu'elle ne les honore :
 *
 *   - Pendant une capture, AUCUNE région n'existe, mais les huit lignes sont
 *     toujours DESSINÉES. Tous les boutons sont capturables, donc la pression
 *     qui lie A serait aussi lue comme un clic sur la ligne visée ; et un
 *     panneau qui se viderait laisserait le joueur sans rien à quoi rapporter
 *     le bouton qu'il presse. Le seul recours est le clic du stick droit, qui
 *     est hors modèle et annule.
 *   - La ligne qui écoute porte un GLYPHE, et une bannière pleine largeur dit
 *     quoi faire. Ni l'un ni l'autre n'est un simple fond : deux états ne
 *     différant que par une couleur dessinent le même jeu de `fillText`, et le
 *     test « l'état est visible » n'aurait rien à comparer. La phrase est en
 *     bannière plutôt que dans la ligne parce qu'elle n'y tenait pas - voir
 *     `PROMPT_Y`.
 */

import type { PanelSize, Region } from '../panel';
import { VR_BUTTONS, type VrButton, type VrPadMap, type XrInput } from '../pad-map';

/** La surface de l'écran courbe, la même que l'écran de lancement. */
export const CONTROLS_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 56;

const ROW_X = PAD;
const ROW_Y = 112;
const ROW_W = 640;
const ROW_H = 64;
const ROW_GAP = 8;
/** Où commence la colonne de droite d'une ligne : le nom de l'entrée. */
const INPUT_X = 200;

/*
 * L'invite de capture est une BANNIÈRE pleine largeur, pas la colonne droite
 * de la ligne qui écoute.
 *
 * Dans la ligne elle avait 392px pour 468px de texte et se faisait tronquer -
 * or c'est la seule information qu'un joueur ne peut pas deviner : tous les
 * boutons étant capturables, rien d'autre ne lui dit que le clic du stick
 * droit annule. Une phrase coupée à « clic du stick d… » est précisément la
 * moitié qui compte.
 */
const PROMPT_Y = 88;

const PRESET_X = 720;
const PRESET_W = 264;
const PRESET_H = 72;
const PRESET_Y = 112;
const PRESET_GAP = 16;

/*
 * Le rappel des entrées hors modèle : pleine largeur, sous les lignes.
 *
 * Dans la colonne des presets il avait 264px pour 342px de texte, et « Croix
 * directionnelle : les deux sticks » se terminait en « les deux s… ». Un
 * rappel tronqué est pire qu'absent : il attire l'œil sans rien apprendre.
 */
const FIXED_Y = 712;
const FIXED_GAP = 30;

/*
 * The way out, under the two presets.
 *
 * The right stick click recalls the panels; it does not hand the screen back.
 * The profile lectern only offers "back to the game" while a game is running.
 * So without this button, a player who opened the remap panel with nothing
 * running had no route back to the launch options at all - the curved screen
 * kept the remap for the rest of the session.
 */
const DONE_Y = PRESET_Y + (PRESET_H + PRESET_GAP) * 2 + 24;
const DONE_H = 72;

export interface ControlsState {
  map: VrPadMap;
  /** Le bouton dont on attend la nouvelle entrée, ou null. */
  listeningFor: VrButton | null;
}

export interface ControlsLabels {
  heading: string;
  /** L'invite pendant la capture. Dit aussi comment annuler : c'est la seule
   *  information qu'un joueur ne peut deviner, tous les autres boutons étant
   *  capturables. */
  press: string;
  /** The way out. Without it the panel is a dead end - see `layoutControlsPanel`. */
  done: string;
  presetLetters: string;
  presetThumb: string;
  fixedDpad: string;
  fixedMenu: string;
  button: Record<VrButton, string>;
  input: Record<XrInput, string>;
}

/** Où tombe la ligne d'un bouton, région ou pas. */
function rowAt(index: number): Region {
  return {
    id: `bind:${VR_BUTTONS[index]}`,
    x: ROW_X,
    y: ROW_Y + index * (ROW_H + ROW_GAP),
    w: ROW_W,
    h: ROW_H
  };
}

export function layoutControlsPanel(state: ControlsState): Region[] {
  // Rien n'est cliquable pendant une capture. Voir l'en-tête.
  if (state.listeningFor) return [];

  const regions: Region[] = VR_BUTTONS.map((_, index) => rowAt(index));

  regions.push({ id: 'preset:letters', x: PRESET_X, y: PRESET_Y, w: PRESET_W, h: PRESET_H });
  regions.push({
    id: 'preset:thumb',
    x: PRESET_X,
    y: PRESET_Y + PRESET_H + PRESET_GAP,
    w: PRESET_W,
    h: PRESET_H
  });
  regions.push({ id: 'close', x: PRESET_X, y: DONE_Y, w: PRESET_W, h: DONE_H });

  return regions;
}

/** Cuts a string to fit `width` at the current font, with an ellipsis. */
function truncate(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

function drawPresetButton(
  ctx: CanvasRenderingContext2D,
  region: Region,
  label: string,
  hovered: boolean
): void {
  ctx.fillStyle = '#1c1c26';
  ctx.fillRect(region.x, region.y, region.w, region.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    truncate(ctx, label, region.w - 24),
    region.x + region.w / 2,
    region.y + region.h / 2
  );
  if (hovered) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
  }
}

export function drawControlsPanel(
  ctx: CanvasRenderingContext2D,
  state: ControlsState,
  regions: readonly Region[],
  opts: { labels: ControlsLabels; hoverId: string | null }
): void {
  const { width, height } = CONTROLS_PANEL_SIZE;
  const { labels } = opts;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101018';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD, TITLE_Y);

  // Pleine largeur, et seulement pendant la capture. Voir `PROMPT_Y`.
  if (state.listeningFor) {
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillStyle = '#7aa2ff';
    ctx.textAlign = 'left';
    ctx.fillText(truncate(ctx, labels.press, width - PAD * 2), PAD, PROMPT_Y);
  }

  const byId = new Map(regions.map((region) => [region.id, region]));

  // Dessinées depuis les boutons, pas depuis les régions : les lignes existent
  // pendant la capture, où il n'y a aucune région.
  VR_BUTTONS.forEach((button, index) => {
    const region = byId.get(`bind:${button}`) ?? rowAt(index);
    const listening = state.listeningFor === button;

    ctx.fillStyle = listening ? '#232a44' : '#1c1c26';
    ctx.fillRect(region.x, region.y, region.w, region.h);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const middle = region.y + region.h / 2;

    ctx.font = '600 24px system-ui, sans-serif';
    ctx.fillStyle = '#e8e8f0';
    ctx.fillText(labels.button[button], region.x + 16, middle);

    if (listening) {
      // Le glyphe dit QUELLE ligne écoute ; la bannière en haut dit quoi
      // faire. Deux états ne différant que par un fond dessinent le même jeu
      // de `fillText` - voir l'en-tête.
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#7aa2ff';
      ctx.fillText('◀', region.x + INPUT_X, middle);
    } else {
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#9a9aac';
      ctx.fillText(
        truncate(ctx, labels.input[state.map[button]], region.w - INPUT_X - 16),
        region.x + INPUT_X,
        middle
      );
    }

    if (opts.hoverId === `bind:${button}`) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
    }
  });

  const letters = byId.get('preset:letters');
  const thumb = byId.get('preset:thumb');
  if (letters) {
    drawPresetButton(ctx, letters, labels.presetLetters, opts.hoverId === 'preset:letters');
  }
  if (thumb) {
    drawPresetButton(ctx, thumb, labels.presetThumb, opts.hoverId === 'preset:thumb');
  }
  const close = byId.get('close');
  if (close) {
    drawPresetButton(ctx, close, labels.done, opts.hoverId === 'close');
  }

  // Hors modèle, donc nommées : un joueur qui ne les voit nulle part les croit
  // mangées par le remap.
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = '#79798a';
  ctx.textAlign = 'left';
  const fixedW = width - PAD * 2;
  ctx.fillText(truncate(ctx, labels.fixedDpad, fixedW), PAD, FIXED_Y);
  ctx.fillText(truncate(ctx, labels.fixedMenu, fixedW), PAD, FIXED_Y + FIXED_GAP);

  ctx.restore();
}
