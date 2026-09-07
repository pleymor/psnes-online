/**
 * Le chrome Super Mario World, partagé par tous les panneaux.
 *
 * La direction a été choisie sur maquettes rendues plutôt que décrite : la
 * boîte de statut bleu nuit à contour noir et liseré blanc du HUD de la carte
 * du monde, les jaquettes dans des logements sable, le tout sur le tileset
 * d'herbe. Deux autres lectures ont été écartées à la même occasion - le
 * plastique du boîtier, et la carte du monde elle-même, qui perdait la
 * jaquette comme moyen de reconnaître un jeu et n'aurait pas tenu à quarante.
 *
 * C'est un habillage : la grille, le défilement et les régions ne changent
 * pas. Les panneaux restent purs, et ce module ne fait que dessiner.
 *
 * Les épaisseurs sont le seul endroit où une maquette mène en bateau. Vue à
 * cent pour cent sur un moniteur, un contour de 3 px est franc ; dans le
 * casque, 1120 px couvrent 40 degrés, donc il ne reste que trois pixels
 * d'affichage. Ce style repose entièrement sur ses contours - sans eux il ne
 * reste que des rectangles colorés - d'où `EDGE` et `LINER` ci-dessous, et le
 * test qui les borne en degrés plutôt qu'en pixels.
 */

import { truncate, type Region } from '../panel';

/**
 * La palette de la carte du monde.
 *
 * Le couple contour presque noir / liseré presque blanc est ce qui fait lire
 * une boîte SMW ; l'adoucir suffit à perdre le style, et un test le vérifie.
 */
export const SMW = {
  grass: '#58b038',
  grassDark: '#3c8c20',
  grassLite: '#88d858',
  water: '#38a8f8',
  sand: '#f8d878',
  sandDark: '#c89838',
  /** Le bleu nuit du HUD, qui porte du texte blanc. */
  box: '#282878',
  boxLite: '#5858c8',
  ink: '#ffffff',
  outline: '#101010',
  /** Le jaune des compteurs. */
  accent: '#f8f800',
  /** Le rouge des niveaux terminés, pour ce qui est consommé ou destructif. */
  warn: '#f83800',
  /** Le texte sur un fond clair. */
  dark: '#282828'
} as const;

/**
 * L'épaisseur des contours, en pixels de canvas.
 *
 * 5 plutôt que 3 : à 25 pixels par degré un contour de 3 px ne fait que trois
 * pixels d'affichage, et c'est précisément ce sur quoi ce style repose.
 */
export const EDGE = 5;
/** Le liseré clair entre le contour et le fond. Plus fin, mais pas invisible. */
export const LINER = 4;

/** Ce qu'une épaisseur de canvas devient dans le casque. */
export function edgeDegrees(pixels: number, pixelsPerDegree: number): number {
  return pixels / pixelsPerDegree;
}

/**
 * Le fond d'un panneau : l'herbe, ou du verre.
 *
 * Le chrome SMW est opaque par nature. Mais la tablette flotte devant l'écran
 * de jeu et la demande était de voir la partie à travers elle - une herbe
 * translucide sur une image serait boueuse. La tablette garde donc les cadres
 * et la boîte de statut, et échange son champ contre un sombre translucide.
 */
export type Field = 'grass' | 'glass';

export function fieldFill(field: Field): string {
  return field === 'grass' ? SMW.grass : 'rgba(16, 16, 26, 0.72)';
}

/**
 * Le fond, tileset compris.
 *
 * Les bandes alternées et leurs liserés clairs sont ce qui fait lire de
 * l'herbe plutôt qu'un aplat vert. Le champ de verre n'en a pas : une trame
 * par-dessus une image de jeu ajouterait du bruit à ce qu'on cherche à voir.
 */
export function drawField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  field: Field
): void {
  ctx.fillStyle = fieldFill(field);
  ctx.fillRect(0, 0, width, height);
  if (field !== 'grass') return;

  /*
   * Une texture, pas un motif.
   *
   * La première version alternait deux verts sur toute la largeur avec un
   * reflet clair tous les 28 px : rendue, elle se disputait l'attention avec
   * les jaquettes, qui sont ce que le panneau existe pour montrer. Les bandes
   * sont donc plus sombres et les reflets plus rares et plus discrets - assez
   * pour que ce soit de l'herbe, pas assez pour que l'oeil s'y arrête.
   */
  const band = 28;
  for (let y = 0; y < height; y += band) {
    ctx.fillStyle = (y / band) % 2 ? SMW.grassDark : '#489828';
    ctx.fillRect(0, y, width, band);
    ctx.fillStyle = 'rgba(136, 216, 88, 0.35)';
    for (let x = ((y / band) % 2) * band; x < width; x += band * 3) {
      ctx.fillRect(x, y + band / 2 - 2, band / 2, 3);
    }
  }
}

/** Contour, liseré, fond : les trois couches de toute boîte de ce style. */
function framed(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  liner: string,
  fill: string
): void {
  ctx.fillStyle = SMW.outline;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = liner;
  ctx.fillRect(x + EDGE, y + EDGE, w - EDGE * 2, h - EDGE * 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x + EDGE + LINER, y + EDGE + LINER, w - (EDGE + LINER) * 2, h - (EDGE + LINER) * 2);
}

/** La boîte de statut du HUD : liseré blanc, fond bleu nuit. */
export function statusBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  framed(ctx, x, y, w, h, SMW.ink, SMW.box);
}

/** Un logement, pour ce qui contient une image : liseré sable. */
export function slot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  framed(ctx, x, y, w, h, SMW.sand, SMW.sandDark);
}

/** Un ruban clair, pour une ligne de texte posée sur le fond. */
export function ribbon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.fillStyle = SMW.outline;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = SMW.ink;
  ctx.fillRect(x + EDGE, y + EDGE, w - EDGE * 2, h - EDGE * 2);
}

export type Tone = 'quiet' | 'loud' | 'warn';

const TONE_FILL: Record<Tone, string> = {
  quiet: SMW.box,
  loud: SMW.boxLite,
  warn: '#a02020'
};

/**
 * Un bouton, dans le style de la boîte de statut.
 *
 * Le survol épaissit le contour vers l'extérieur au lieu de tracer un trait
 * fin par-dessus : à cette distance un trait de 2 px ne se voit pas, et c'est
 * la même raison qui a fait monter `EDGE` à 5.
 */
export function chromeButton(
  ctx: CanvasRenderingContext2D,
  region: Region,
  label: string,
  tone: Tone,
  hovered: boolean,
  fontSize = 24
): void {
  if (hovered) {
    ctx.fillStyle = SMW.accent;
    ctx.fillRect(region.x - 5, region.y - 5, region.w + 10, region.h + 10);
  }
  framed(ctx, region.x, region.y, region.w, region.h, SMW.ink, TONE_FILL[tone]);
  ctx.fillStyle = SMW.ink;
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 4 px d'air, pas 12 : le cadre fournit déjà neuf pixels de retrait visuel,
  // et les douze que la première version ajoutait ont suffi à couper
  // « Sauvegardes » sur le bandeau. Le libellé est le contenu, la marge non.
  ctx.fillText(
    truncate(ctx, label, region.w - (EDGE + LINER) * 2 - 4),
    region.x + region.w / 2,
    region.y + region.h / 2
  );
}
