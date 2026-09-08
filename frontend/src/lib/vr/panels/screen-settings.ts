/**
 * Où mettre l'écran, quelle taille lui donner, et s'il est courbe.
 *
 * Le modèle est dans `screen-shape.ts` - les crans, leurs bornes et pourquoi
 * elles sont là. Ce module ne fait que le montrer et rendre les régions qui le
 * font avancer d'un cran.
 *
 * Deux décisions valent d'être écrites.
 *
 * Un bouton de bout d'échelle est DESSINÉ mais n'a pas de région. Le dessiner
 * est nécessaire : sans lui, une paire « − + » devenue simple « − » se lit
 * comme un panneau à moitié chargé. Ne pas lui donner de région est ce qui
 * évite le pire des deux mondes dans un casque - un pointeur qui s'accroche,
 * un survol qui s'allume, et rien qui ne se passe, ce qui se lit comme une
 * panne plutôt que comme une limite. Il perd sa boîte à la place, et ne garde
 * que son signe en sable sombre - voir le commentaire qui raconte les deux
 * rendus qu'il a fallu pour arriver là.
 *
 * Le réglage s'applique tout de suite, sans bouton de validation, et c'est ce
 * qui rend le panneau utilisable : l'écran est juste derrière la tablette, donc
 * le joueur voit exactement ce qu'il règle pendant qu'il le règle. Un
 * « Appliquer » l'obligerait à comparer deux états dont un seul est visible.
 */

import { truncate, type PanelSize, type Region } from '../panel';
import { SMW, drawField, statusBox, chromeButton } from './chrome';
import {
  SCREEN_DISTANCES,
  SCREEN_ANGLES,
  SCREEN_HEIGHTS,
  shapeRungs,
  type ScreenShape
} from '../screen-shape';

export const SCREEN_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 46;

/*
 * Un bloc centré, pas collé à gauche.
 *
 * Les premiers chiffres posaient les rangées de 310 à 750 sur une toile de
 * 1024, ce qui laissait 274 px de vide à droite et rien à gauche : au rendu le
 * panneau penchait. Toutes les rangées finissent maintenant à 890, la colonne
 * des intitulés commence à 130, et les deux marges se valent. Vu sur un rendu,
 * pas déduit - c'est le seul moyen de voir un déséquilibre.
 */
const LABEL_X = 130;
const LABEL_W = 240;

const STEP_W = 100;
const ROW_H = 90;
const MINUS_X = 390;
const VALUE_X = 520;
const VALUE_W = 240;
const PLUS_X = 790;

/*
 * Quatre rangées de commandes plus la sortie, en 768 px.
 *
 * L'écart de 125 px pour des rangées de 90 laisse les cinq points de position
 * respirer entre deux rangées : ils sont posés 6 px sous leur rangée et font
 * 18 px, donc ils finissent 11 px avant la suivante.
 */
const DISTANCE_Y = 120;
const SIZE_Y = 245;
const HEIGHT_Y = 370;
const SHAPE_Y = 495;

/** Les cinq points sous la valeur, qui disent où on en est sur l'échelle. */
const DOT_SIZE = 18;
const DOT_GAP = 12;
const DOT_DROP = 6;

const FORM_W = 240;
const FLAT_X = MINUS_X;
const CURVED_X = 650;

const CLOSE_X = MINUS_X;
const CLOSE_W = 500;
const CLOSE_H = 88;
const CLOSE_Y = 615;

export interface ScreenPanelLabels {
  heading: string;
  distance: string;
  size: string;
  /** La hauteur, au-dessus ou en dessous du niveau des yeux. */
  height: string;
  shape: string;
  flat: string;
  curved: string;
  /** Remonte au menu d'options, pas au jeu. Voir `options.ts`. */
  close: string;
  /** La distance en clair. Une fonction et non une chaîne : la valeur vient de
   *  la forme, et un libellé figé mentirait sur ce que la manette vient de
   *  faire. Le format dépend de la locale (« 2,5 m » contre « 2.5 m »). */
  metres: (value: number) => string;
  degrees: (value: number) => string;
  /** En centimètres, signés : c'est un écart au niveau des yeux, pas une
   *  altitude, et « 0,2 m » se lit moins bien que « +20 cm ». */
  centimetres: (value: number) => string;
}

/**
 * Les régions, dont les quatre pas ne sont là que s'ils mènent quelque part.
 *
 * Pur et sans dessin, comme les autres panneaux : c'est ce qui permet au test
 * de vérifier qu'un bout d'échelle ne laisse pas de cible morte.
 */
export function layoutScreenPanel(shape: ScreenShape): Region[] {
  const rungs = shapeRungs(shape);
  const regions: Region[] = [];

  if (rungs.distance > 0) {
    regions.push({ id: 'nearer', x: MINUS_X, y: DISTANCE_Y, w: STEP_W, h: ROW_H });
  }
  if (rungs.distance < SCREEN_DISTANCES.length - 1) {
    regions.push({ id: 'farther', x: PLUS_X, y: DISTANCE_Y, w: STEP_W, h: ROW_H });
  }
  if (rungs.angle > 0) {
    regions.push({ id: 'smaller', x: MINUS_X, y: SIZE_Y, w: STEP_W, h: ROW_H });
  }
  if (rungs.angle < SCREEN_ANGLES.length - 1) {
    regions.push({ id: 'bigger', x: PLUS_X, y: SIZE_Y, w: STEP_W, h: ROW_H });
  }
  if (rungs.height > 0) {
    regions.push({ id: 'lower', x: MINUS_X, y: HEIGHT_Y, w: STEP_W, h: ROW_H });
  }
  if (rungs.height < SCREEN_HEIGHTS.length - 1) {
    regions.push({ id: 'higher', x: PLUS_X, y: HEIGHT_Y, w: STEP_W, h: ROW_H });
  }

  // Les deux formes restent visables, celle qui est active comprise : la paire
  // dit l'état, comme les deux langues du panneau des contrôles, et une moitié
  // qui disparaîtrait ferait sauter la mise en page à chaque bascule.
  regions.push({ id: 'flat', x: FLAT_X, y: SHAPE_Y, w: FORM_W, h: ROW_H });
  regions.push({ id: 'curved', x: CURVED_X, y: SHAPE_Y, w: FORM_W, h: ROW_H });

  regions.push({ id: 'close', x: CLOSE_X, y: CLOSE_Y, w: CLOSE_W, h: CLOSE_H });

  return regions;
}

/** Les points de position, centrés sur la boîte de valeur. */
function drawRungs(ctx: CanvasRenderingContext2D, y: number, count: number, at: number): void {
  const span = count * DOT_SIZE + (count - 1) * DOT_GAP;
  const left = VALUE_X + (VALUE_W - span) / 2;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = i === at ? SMW.accent : SMW.sandDark;
    ctx.fillRect(left + i * (DOT_SIZE + DOT_GAP), y, DOT_SIZE, DOT_SIZE);
  }
}

export function drawScreenPanel(
  ctx: CanvasRenderingContext2D,
  shape: ScreenShape,
  regions: readonly Region[],
  opts: { labels: ScreenPanelLabels; hoverId: string | null }
): void {
  const { width, height } = SCREEN_PANEL_SIZE;
  const byId = new Map(regions.map((r) => [r.id, r]));
  const { labels, hoverId } = opts;
  const rungs = shapeRungs(shape);

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  // Du verre : la tablette flotte devant l'écran, et ici plus qu'ailleurs -
  // c'est l'écran lui-même qu'on règle, il doit rester visible à travers.
  drawField(ctx, width, height, 'glass');

  statusBox(ctx, PAD - 14, 12, width - (PAD - 14) * 2, 68);
  ctx.fillStyle = SMW.ink;
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, labels.heading, width - PAD * 2), PAD + 8, TITLE_Y);

  const rows = [
    {
      y: DISTANCE_Y,
      label: labels.distance,
      value: labels.metres(shape.distance),
      minus: 'nearer',
      plus: 'farther',
      count: SCREEN_DISTANCES.length,
      at: rungs.distance
    },
    {
      y: SIZE_Y,
      label: labels.size,
      value: labels.degrees(shape.angle),
      minus: 'smaller',
      plus: 'bigger',
      count: SCREEN_ANGLES.length,
      at: rungs.angle
    },
    {
      y: HEIGHT_Y,
      label: labels.height,
      value: labels.centimetres(shape.height),
      minus: 'lower',
      plus: 'higher',
      count: SCREEN_HEIGHTS.length,
      at: rungs.height
    }
  ] as const;

  for (const row of rows) {
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, row.label, LABEL_W), LABEL_X, row.y + ROW_H / 2);

    /*
     * Les deux pas, dessinés depuis la mise en page quand elle les porte et
     * depuis les constantes sinon.
     *
     * C'est ce qui rend le bout d'échelle visible : le bouton est là, en ton
     * discret, mais il n'est pas dans `regions` - donc pas visable, et le
     * survol ne peut pas s'y allumer.
     */
    for (const [id, sign, x] of [
      [row.minus, '−', MINUS_X],
      [row.plus, '+', PLUS_X]
    ] as const) {
      const region = byId.get(id);
      if (region) {
        chromeButton(ctx, region, sign, 'loud', hoverId === id, 40);
        continue;
      }
      /*
       * Le signe seul, sans boîte : deux rendus pour y arriver.
       *
       * `chromeButton(..., 'quiet')` d'abord - écarté parce que le ton discret
       * est celui de « Retour » et de la boîte de valeur, donc un pas épuisé
       * se lisait comme un bouton ordinaire qu'on peut presser. Puis `slot()`,
       * le creux des vignettes de sauvegarde - écarté aussi : le sable est la
       * couleur la plus vive du chrome, et il tirait l'œil vers la seule
       * commande qui ne répond pas.
       *
       * Ce qui reste est ce qu'il fallait : la paire « − + » se voit encore
       * (elle ne se lit pas comme un panneau à moitié chargé), et un seul de
       * ses deux membres a l'air d'un bouton.
       */
      ctx.fillStyle = SMW.sandDark;
      ctx.font = '600 40px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sign, x + STEP_W / 2, row.y + ROW_H / 2);
    }

    statusBox(ctx, VALUE_X, row.y, VALUE_W, ROW_H);
    ctx.fillStyle = SMW.ink;
    ctx.font = '600 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.value, VALUE_X + VALUE_W / 2, row.y + ROW_H / 2);

    drawRungs(ctx, row.y + ROW_H + DOT_DROP, row.count, row.at);
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, labels.shape, LABEL_W), LABEL_X, SHAPE_Y + ROW_H / 2);

  for (const [id, label, active] of [
    ['flat', labels.flat, !shape.curved],
    ['curved', labels.curved, shape.curved]
  ] as const) {
    const region = byId.get(id);
    // Le marquage passe par le ton, donc par le fond : les deux états
    // dessinent les mêmes `fillText`, sinon c'est le libellé qui change de
    // sens. La même règle que les deux langues.
    if (region) chromeButton(ctx, region, label, active ? 'loud' : 'quiet', hoverId === id);
  }

  const close = byId.get('close');
  if (close) chromeButton(ctx, close, labels.close, 'quiet', hoverId === 'close');

  ctx.restore();
}
