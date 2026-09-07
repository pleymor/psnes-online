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

import { truncate, type PanelSize, type Region } from '../panel';
import { VR_BUTTONS, type VrButton, type VrPadMap, type XrInput } from '../pad-map';
import { drawPadArt, padRegions, PAD_ART_ASPECT } from './pad-art';

/** La surface de l'écran courbe, la même que l'écran de lancement. */
export const CONTROLS_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

/**
 * Le même canvas, sous le nom de la surface qui le porte.
 *
 * `layout.ts` a besoin de cette taille pour vérifier que la tablette a la
 * forme de son canvas, et il ne peut pas dépendre du panneau des contrôles en
 * particulier : c'est la tablette qui est mesurée, pas son contenu du jour. Le
 * lot 2 remplacera ce contenu par la manette dessinée sans toucher à la
 * surface.
 */
export const TABLET_PANEL_SIZE = CONTROLS_PANEL_SIZE;

const PAD = 40;
const TITLE_Y = 56;

/*
 * Deux colonnes : le dessin à gauche, la légende à droite.
 *
 * Le dessin remplace les huit lignes comme surface de visée - « le dessin est
 * la config », ce que `SnesPad.svelte` dit de son propre pad. La légende reste
 * parce qu'en VR elle n'est pas facultative : une entrée s'appelle « Droite —
 * gâchette », et il n'existe aucune forme en trois caractères comme le « B14 »
 * du hors-VR à écrire sur un bouton de 24 px. Inventer des abréviations aurait
 * été plus court et plus cryptique.
 */
const ART_X = PAD;
const ART_Y = 112;
/*
 * 596 et non 640 : la colonne de légende doit contenir le plus long libellé
 * d'entrée expédié - « Gauche — clic du stick » - en entier. Une légende
 * tronquée est vide de sens, puisqu'elle n'existe que parce que ces noms ne
 * tiennent pas sur un bouton de la manette dessinée. Le dessin prend ce qui
 * reste, et `vr-panel-controls.test.ts` mesure les deux.
 */
const ART_W = 596;
const ART_H = ART_W / PAD_ART_ASPECT;
const ART = { x: ART_X, y: ART_Y, w: ART_W, h: ART_H };

const LEGEND_X = ART_X + ART_W + 20;
const LEGEND_W = CONTROLS_PANEL_SIZE.width - PAD - LEGEND_X;
const LEGEND_Y = ART_Y;
const LEGEND_LINE_H = 34;
/** Où commence le nom de l'entrée sur une ligne de légende. */
const LEGEND_INPUT_X = 88;

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

/*
 * Les boutons, sous les deux colonnes.
 *
 * « Tout configurer » prend la largeur du dessin parce que c'est l'action qui
 * lui appartient : elle parcourt ses huit boutons dans l'ordre où on les voit.
 */
const BIND_ALL_Y = 400;
const BTN_H = 64;
const PRESET_Y = BIND_ALL_Y + BTN_H + 16;
const PRESET_W = (ART_W - 20) / 2;

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
const CLOSE_Y = PRESET_Y;

/*
 * La langue, arrivée du bandeau.
 *
 * `panels/profile.ts` mélangeait réglages et raccourcis ; il est devenu un
 * lanceur et ses réglages sont montés ici, sur le panneau qui a la place.
 *
 * Deux boutons plutôt qu'une bascule, pour la raison que ce panneau applique
 * déjà à ses presets : il y a exactement deux langues, et une bascule
 * obligerait le joueur à deviner laquelle est active.
 */
const LANG_Y = BIND_ALL_Y;
const LANG_GAP = 16;
const LANG_W = (LEGEND_W - LANG_GAP) / 2;

export interface ControlsState {
  map: VrPadMap;
  /** Le bouton dont on attend la nouvelle entrée, ou null. */
  listeningFor: VrButton | null;
  language: 'en' | 'fr';
}

export interface ControlsLabels {
  heading: string;
  /** L'invite pendant la capture. Dit aussi comment annuler : c'est la seule
   *  information qu'un joueur ne peut deviner, tous les autres boutons étant
   *  capturables. */
  press: string;
  /** The way out. Without it the panel is a dead end - see `layoutControlsPanel`. */
  done: string;
  /** Démarre la séquence : les huit boutons, dans l'ordre du dessin. */
  bindAll: string;
  presetLetters: string;
  presetThumb: string;
  fixedDpad: string;
  fixedMenu: string;
  langEn: string;
  langFr: string;
  button: Record<VrButton, string>;
  input: Record<XrInput, string>;
}

export function layoutControlsPanel(state: ControlsState): Region[] {
  // Rien n'est cliquable pendant une capture. Voir l'en-tête.
  if (state.listeningFor) return [];

  // Les huit `bind:` viennent du dessin maintenant, pas de huit lignes.
  const regions: Region[] = padRegions(ART);

  regions.push({ id: 'bind-all', x: ART_X, y: BIND_ALL_Y, w: ART_W, h: BTN_H });
  regions.push({ id: 'preset:letters', x: ART_X, y: PRESET_Y, w: PRESET_W, h: BTN_H });
  regions.push({
    id: 'preset:thumb',
    x: ART_X + PRESET_W + 20,
    y: PRESET_Y,
    w: PRESET_W,
    h: BTN_H
  });

  regions.push({ id: 'lang:en', x: LEGEND_X, y: LANG_Y, w: LANG_W, h: BTN_H });
  regions.push({
    id: 'lang:fr',
    x: LEGEND_X + LANG_W + LANG_GAP,
    y: LANG_Y,
    w: LANG_W,
    h: BTN_H
  });
  regions.push({ id: 'close', x: LEGEND_X, y: CLOSE_Y, w: LEGEND_W, h: BTN_H });

  return regions;
}

/** Cuts a string to fit `width` at the current font, with an ellipsis. */
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

  /*
   * Le dessin d'abord, la légende ensuite.
   *
   * Les deux sont dessinés depuis l'état et non depuis les régions, parce
   * qu'il n'y a aucune région pendant une capture - et c'est précisément
   * pendant une capture qu'il faut voir QUEL bouton attend.
   */
  drawPadArt(ctx, ART, {
    listeningFor: state.listeningFor,
    hovered: opts.hoverId?.startsWith('bind:')
      ? (opts.hoverId.slice('bind:'.length) as VrButton)
      : null
  });

  VR_BUTTONS.forEach((button, index) => {
    const y = LEGEND_Y + index * LEGEND_LINE_H + LEGEND_LINE_H / 2;
    const listening = state.listeningFor === button;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillStyle = listening ? '#7aa2ff' : '#e8e8f0';
    ctx.fillText(labels.button[button], LEGEND_X, y);

    /*
     * Le glyphe dit QUELLE entrée on attend ; la bannière en haut dit quoi
     * faire. Deux états qui ne différeraient que par une couleur dessineraient
     * le même jeu de `fillText`, et le test ne pourrait pas les distinguer.
     */
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = listening ? '#7aa2ff' : '#9a9aac';
    ctx.fillText(
      listening
        ? '◀'
        : truncate(ctx, labels.input[state.map[button]], LEGEND_W - LEGEND_INPUT_X),
      LEGEND_X + LEGEND_INPUT_X,
      y
    );
  });

  const bindAll = byId.get('bind-all');
  if (bindAll) {
    drawPresetButton(ctx, bindAll, labels.bindAll, opts.hoverId === 'bind-all');
  }

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
  for (const [id, label, active] of [
    ['lang:en', labels.langEn, state.language === 'en'],
    ['lang:fr', labels.langFr, state.language === 'fr']
  ] as const) {
    const region = byId.get(id);
    if (!region) continue;
    // Le marquage est un fond, pas un texte : les deux états doivent dessiner
    // les mêmes `fillText`, sinon c'est le libellé qui change de sens.
    ctx.fillStyle = active ? '#2f3a5c' : '#1c1c26';
    ctx.fillRect(region.x, region.y, region.w, region.h);
    ctx.fillStyle = active ? '#ffffff' : '#9a9aac';
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      truncate(ctx, label, region.w - 16),
      region.x + region.w / 2,
      region.y + region.h / 2
    );
    if (opts.hoverId === id) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
    }
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#6a6a78';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillText(truncate(ctx, labels.fixedDpad, fixedW), PAD, FIXED_Y);
  ctx.fillText(truncate(ctx, labels.fixedMenu, fixedW), PAD, FIXED_Y + FIXED_GAP);

  ctx.restore();
}
