/**
 * Le menu principal des options, sur la tablette.
 *
 * Il existe parce que le bandeau n'a plus de créneau. Trois colonnes par
 * rangée est un plancher, pas un choix esthétique : passer de quatre à trois
 * avait fait remonter les cibles de 5,7 à 8 degrés, et le cadre du chrome
 * tronquait quatre libellés sur six à quatre colonnes. Ajouter une septième
 * case aurait donc coûté soit une rangée (des cibles de 5,5 degrés, sous ce
 * qui se vise confortablement), soit une colonne (des libellés coupés).
 *
 * Le bandeau garde donc les ACTIONS - recentrer, quitter, et les trois du jeu
 * en cours - et ce panneau prend les RÉGLAGES. C'est aussi, littéralement, le
 * « menu principal d'options » vers lequel les panneaux de réglage reviennent
 * quand on les ferme : leur bouton Retour remonte ici plutôt que de refermer
 * la tablette d'un coup.
 *
 * Deux entrées seulement, et c'est bien : chaque réglage à venir a une case
 * ici, là où le bandeau n'en avait plus. Le relief est la troisième, et elle a
 * ouvert la deuxième rangée sans rien coûter aux tuiles - voir `TILE_ROW`.
 */

import { truncate, type PanelSize, type Region } from '../panel';
import { SMW, drawField, statusBox, chromeButton } from './chrome';

export const OPTIONS_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 46;

/**
 * De grandes tuiles deux par rangée, hautes de 200 px.
 *
 * Généreuses parce qu'elles peuvent l'être : il y a trois entrées sur une
 * toile de 1024 x 768. Une tuile de 440 x 200 sur une tablette à 24 px par
 * degré fait 18 x 8 degrés - impossible à manquer au pointeur, ce qui est tout
 * ce qu'on demande à un menu qu'on traverse.
 *
 * La troisième entrée est passée à la ligne plutôt que d'élargir la rangée à
 * trois colonnes : trois tuiles de 298 px de large auraient fait rentrer la
 * grille dans la zone où le cadre du chrome tronque les libellés, ce que
 * l'en-tête raconte du bandeau. Une rangée de plus ne coûte que de la hauteur,
 * et il en restait.
 */
const TILE_W = 440;
const TILE_H = 200;
const TILE_GAP = 24;
const TILE_Y = 150;
/** Une rangée de plus, son écart compris. */
const TILE_ROW = TILE_H + TILE_GAP;
const TILE_X = (OPTIONS_PANEL_SIZE.width - (TILE_W * 2 + TILE_GAP)) / 2;

const CLOSE_W = 440;
const CLOSE_H = 88;
const CLOSE_Y = 616;
const CLOSE_X = (OPTIONS_PANEL_SIZE.width - CLOSE_W) / 2;

export interface OptionsLabels {
  heading: string;
  controls: string;
  screen: string;
  /** La profondeur entre les couches du jeu, par jeu. Voir `panels/relief.ts`. */
  relief: string;
  /** La sortie. Ici elle referme la tablette : c'est la racine. */
  close: string;
}

/** La place de la n-ième tuile, deux par rangée. La quatrième case attend. */
function tileAt(index: number): { x: number; y: number } {
  return {
    x: TILE_X + (index % 2) * (TILE_W + TILE_GAP),
    y: TILE_Y + Math.floor(index / 2) * TILE_ROW
  };
}

export function layoutOptionsPanel(): Region[] {
  // Aucun état : rien ici ne dépend de ce que fait le jeu. Le bandeau décide
  // déjà si la tablette peut s'ouvrir.
  //
  // Les identifiants sont écrits en toutes lettres plutôt que déroulés depuis
  // une liste : `vr-regions-handled.test.ts` lit ce fichier à l'expression
  // régulière, et une région montée dans une boucle lui serait invisible.
  const controls = tileAt(0);
  const screen = tileAt(1);
  const relief = tileAt(2);
  return [
    { id: 'controls', x: controls.x, y: controls.y, w: TILE_W, h: TILE_H },
    { id: 'screen', x: screen.x, y: screen.y, w: TILE_W, h: TILE_H },
    { id: 'relief', x: relief.x, y: relief.y, w: TILE_W, h: TILE_H },
    { id: 'close', x: CLOSE_X, y: CLOSE_Y, w: CLOSE_W, h: CLOSE_H }
  ];
}

export function drawOptionsPanel(
  ctx: CanvasRenderingContext2D,
  regions: readonly Region[],
  opts: { labels: OptionsLabels; hoverId: string | null }
): void {
  const { width, height } = OPTIONS_PANEL_SIZE;
  const byId = new Map(regions.map((r) => [r.id, r]));
  const { labels } = opts;

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  // Du verre : la tablette flotte devant l'écran de jeu, et la partie doit
  // rester visible à travers. Voir `chrome.ts`.
  drawField(ctx, width, height, 'glass');

  statusBox(ctx, PAD - 14, 12, width - (PAD - 14) * 2, 68);
  ctx.fillStyle = SMW.ink;
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, labels.heading, width - PAD * 2), PAD + 8, TITLE_Y);

  for (const [id, label] of [
    ['controls', labels.controls],
    ['screen', labels.screen],
    ['relief', labels.relief]
  ] as const) {
    const region = byId.get(id);
    // La police est plus grande que celle des boutons ordinaires : ces tuiles
    // sont le seul contenu du panneau, et 32 px sur une tuile de 200 de haut
    // reste très en dessous de ce que le cadre peut porter.
    if (region) chromeButton(ctx, region, label, 'loud', opts.hoverId === id, 32);
  }

  const close = byId.get('close');
  if (close) chromeButton(ctx, close, labels.close, 'quiet', opts.hoverId === 'close');

  ctx.restore();
}
