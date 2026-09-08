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
import {
  VR_BUTTONS,
  fastForwardClaimed,
  type VrButton,
  type VrPadMap,
  type XrInput
} from '../pad-map';
import { drawPadArt, padRegions, PAD_ART_ASPECT } from './pad-art';
import { SMW, drawField, statusBox, chromeButton } from './chrome';

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
 * 552, et le chiffre a été descendu deux fois en regardant des rendus.
 *
 * La colonne de légende doit contenir le plus long libellé d'entrée expédié -
 * « Gauche — clic du stick » - ET le plus long nom de bouton - « SELECT » -
 * sans que l'un percute l'autre. Une légende tronquée est vide de sens :
 * elle n'existe que parce que ces noms ne tiennent pas sur un bouton de la
 * manette dessinée.
 *
 * Le test de largeur mesure à neuf pixels par caractère, ce qui est optimiste
 * pour du 20 px réel - il passait pendant que le rendu coupait. C'est le rendu
 * qui a tranché les deux fois, et la marge retenue est d'environ vingt pour
 * cent au-dessus de ce que le test exige.
 */
const ART_W = 552;
const ART_H = ART_W / PAD_ART_ASPECT;
const ART = { x: ART_X, y: ART_Y, w: ART_W, h: ART_H };

const LEGEND_X = ART_X + ART_W + 20;
const LEGEND_W = CONTROLS_PANEL_SIZE.width - PAD - LEGEND_X;
const LEGEND_Y = ART_Y;
const LEGEND_LINE_H = 34;
/** Où commence le nom de l'entrée sur une ligne de légende. */
/*
 * 118 et non 88 : « SELECT » en semi-gras 22 px percutait « Gauche — grip »
 * sur la même ligne. C'est le plus long des huit noms de boutons, donc c'est
 * lui qui décide de cette colonne.
 */
const LEGEND_INPUT_X = 118;

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
/*
 * Un seul préréglage, et il n'a pas de nom.
 *
 * Il y en avait deux - « fidèle aux lettres » et « confort du pouce » - avec
 * un schéma de manette sur chaque carte, parce que ce panneau était le seul
 * endroit qui montrait quel bouton Touch portait quel bouton SNES. Le dessin
 * le montre maintenant en entier et en permanence, donc la carte n'avait plus
 * rien à expliquer, et le second préréglage plus rien à départager : le joueur
 * remappe ce qu'il veut bouton par bouton.
 *
 * Ce qui reste est un retour au défaut, qui n'a pas besoin d'être nommé - on
 * ne le choisit pas, on y revient. `writePadMap` RETIRE la valeur stockée
 * quand la carte égale le défaut (`pad-map.ts:174`), donc « restaurer » est
 * littéralement « oublier ce qui était stocké ».
 */
const RESTORE_Y = BIND_ALL_Y + BTN_H + 16;

/*
 * Le rappel des entrées hors modèle : pleine largeur, sous les lignes.
 *
 * Dans la colonne des presets il avait 264px pour 342px de texte, et « Croix
 * directionnelle : les deux sticks » se terminait en « les deux s… ». Un
 * rappel tronqué est pire qu'absent : il attire l'œil sans rien apprendre.
 */
/**
 * Le bloc des entrées hors modèle, ancré par le HAUT.
 *
 * La troisième ligne est conditionnelle - elle nomme l'accéléré et disparaît
 * quand un bouton a réclamé son entrée - et c'est CE fait qui impose le sens
 * de l'ancrage. Ancré par le bas, le retrait de la troisième ligne pousserait
 * les deux premières de trente pixels vers le bas : le panneau se réagencerait
 * sous le regard du joueur pour un binding sans rapport. Ancré par le haut,
 * seule la ligne conditionnelle apparaît et disparaît.
 *
 * C'était 712 tant qu'il n'y avait que deux lignes. Remonté de trente pour que
 * la troisième tienne : 682 + 2 x 30 = 742, sous les 768 du panneau.
 */
const FIXED_TOP = 682;
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
const CLOSE_Y = RESTORE_Y;

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
  /** Le retour au défaut. Voir `RESTORE_Y`. */
  restoreDefaults: string;
  fixedDpad: string;
  fixedMenu: string;
  /** L'accéléré, tenu sur le clic du stick gauche. Voir `FIXED_TOP`. */
  fixedTurbo: string;
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
  regions.push({ id: 'restore-defaults', x: ART_X, y: RESTORE_Y, w: ART_W, h: BTN_H });

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
  // Du verre : ce panneau vit sur la tablette, devant l'écran de jeu. Voir
  // `chrome.ts` sur pourquoi le chrome garde ses cadres et change son fond.
  drawField(ctx, width, height, 'glass');

  statusBox(ctx, PAD - 14, 12, width - (PAD - 14) * 2, 68);
  ctx.fillStyle = SMW.ink;
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labels.heading, PAD + 8, 46);

  // Pleine largeur, et seulement pendant la capture. Voir `PROMPT_Y`.
  if (state.listeningFor) {
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillStyle = SMW.accent;
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
    ctx.fillStyle = listening ? SMW.accent : '#e8e8f0';
    ctx.fillText(labels.button[button], LEGEND_X, y);

    /*
     * Le glyphe dit QUELLE entrée on attend ; la bannière en haut dit quoi
     * faire. Deux états qui ne différeraient que par une couleur dessineraient
     * le même jeu de `fillText`, et le test ne pourrait pas les distinguer.
     */
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = listening ? SMW.accent : '#b8b8c8';
    ctx.fillText(
      listening
        ? '◀'
        : truncate(ctx, labels.input[state.map[button]], LEGEND_W - LEGEND_INPUT_X),
      LEGEND_X + LEGEND_INPUT_X,
      y
    );
  });

  const bindAll = byId.get('bind-all');
  if (bindAll) chromeButton(ctx, bindAll, labels.bindAll, 'loud', opts.hoverId === 'bind-all');

  const restore = byId.get('restore-defaults');
  if (restore) {
    chromeButton(ctx, restore, labels.restoreDefaults, 'quiet', opts.hoverId === 'restore-defaults');
  }
  const close = byId.get('close');
  if (close) chromeButton(ctx, close, labels.done, 'quiet', opts.hoverId === 'close');

  // Hors modèle, donc nommées : un joueur qui ne les voit nulle part les croit
  // mangées par le remap.
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = '#b8b8c8';
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
    // Le marquage passe par le ton du bouton, donc par son fond : les deux
    // états doivent dessiner les mêmes `fillText`.
    chromeButton(ctx, region, label, active ? 'loud' : 'quiet', opts.hoverId === id, 22);
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#6a6a78';
  ctx.font = '20px system-ui, sans-serif';
  const fixed = [labels.fixedDpad, labels.fixedMenu];
  // Nommé seulement tant qu'il existe : `fastForwardClaimed` est la même
  // question que `fastForwardHeld` pose avant de tenir le geste, donc le
  // panneau ne peut pas annoncer un raccourci que la carte a emporté.
  if (!fastForwardClaimed(state.map)) fixed.push(labels.fixedTurbo);
  fixed.forEach((line, index) => {
    ctx.fillText(truncate(ctx, line, fixedW), PAD, FIXED_TOP + index * FIXED_GAP);
  });

  ctx.restore();
}
