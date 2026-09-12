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
  /**
   * La brique des pupitres latéraux.
   *
   * Sombre et sourde, et surtout PAS le `#c84c0c` du monde : le comptoir sur
   * lequel ces pupitres reposent est fait de cette brique-là, donc la
   * reprendre ici les ferait fondre l'un dans l'autre. Le chrome est un
   * système à part - l'en-tête de ce fichier le dit - et il garde ses propres
   * couleurs.
   */
  brick: '#7c3c18',
  /** Le joint : plus sombre que la brique, jamais noir. Voir `drawField`. */
  brickJoint: '#5c2a10',
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
export type Field = 'grass' | 'glass' | 'brick' | 'frost';

export function fieldFill(field: Field): string {
  if (field === 'grass') return SMW.grass;
  if (field === 'brick') return SMW.brick;
  /*
   * Le dépoli est plus transparent que le verre de la tablette, et c'est ce
   * qui le distingue : la tablette flotte devant l'IMAGE DU JEU, qu'elle doit
   * assombrir assez pour porter du texte blanc ; un pupitre latéral n'a que du
   * décor derrière lui, donc il peut se permettre de le laisser passer
   * davantage. Sombre quand même, et pour la même raison qu'elle : un voile
   * clair sur de l'herbe vive et un comptoir orange rendrait les libellés
   * illisibles.
   */
  if (field === 'frost') return 'rgba(22, 26, 38, 0.55)';
  return 'rgba(16, 16, 26, 0.72)';
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

  if (field === 'brick') {
    /*
     * Un appareil de brique, et des joints qu'on devine plutôt qu'on ne les
     * lit.
     *
     * La leçon de l'herbe, quelques lignes plus bas, s'applique ici en pire :
     * une brique a des joints, donc des lignes franches PARTOUT, et sur 1120
     * pixels une grille noire se disputerait les jaquettes bien plus fort
     * qu'un reflet vert. Les joints sont donc `brickJoint`, à peine plus
     * sombres que la brique, et un test borne cet écart pour qu'un réglage
     * futur ne puisse pas les durcir sans rougir.
     *
     * Le décalage d'un rang sur l'autre est ce qui fait lire de la maçonnerie
     * plutôt qu'un quadrillage - c'est la même raison que `art/ground.ts`
     * donne pour le sol de brique du monde.
     */
    const course = 28;
    const brick = 56;
    const joint = 2;
    ctx.fillStyle = SMW.brickJoint;
    for (let y = 0; y < height; y += course) {
      ctx.fillRect(0, y, width, joint);
      const offset = ((y / course) % 2) * (brick / 2);
      for (let x = -offset; x < width; x += brick) ctx.fillRect(x, y, joint, course);
    }
    return;
  }

  if (field === 'frost') {
    /*
     * Du verre, sans flou - parce qu'un panneau NE PEUT PAS flouter ce qui est
     * derrière lui. Sa texture est composée par-dessus la scène : ses pixels
     * ne voient jamais ceux du décor. Un vrai flou demanderait de rendre la
     * scène dans une cible puis de l'échantillonner dans un shader, soit une
     * passe de plus par œil, à 72 Hz, à côté de l'émulateur.
     *
     * CE QUI A ÉTÉ RETIRÉ, ET POURQUOI. La première version ajoutait un grain
     * fin, pour faire « dépoli ». Dans le casque, elle tenait tant qu'on
     * baissait la tête et devenait du BÉTON dès qu'on la levait. La cause
     * n'est pas le grain seul mais ce qu'il y a derrière : vers le bas,
     * l'herbe et le comptoir passent au travers et l'œil lit du verre ; vers
     * le haut il n'y a que du ciel uni, donc plus rien à voir au travers, et
     * il ne reste qu'un voile gris texturé - la définition du béton.
     *
     * Un verre ne se lit donc comme un verre que s'il porte des indices de
     * SURFACE, qui ne dépendent pas du fond. Les deux ci-dessous en sont :
     * un reflet oblique, qu'aucune matière n'a, et un bord éclairé, qui dit
     * qu'il y a une plaque et où elle s'arrête.
     */

    /*
     * Le reflet oblique. En bandes plutôt qu'en dégradé, et ce n'est pas un
     * raccourci : les six fichiers de test des panneaux passent chacun un faux
     * contexte écrit à la main, et aucun n'implémente `createLinearGradient` -
     * l'employer a fait tomber vingt-sept tests d'un coup. Ces doubles
     * décrivent le sous-ensemble d'API que les peintres ont le droit
     * d'utiliser, et l'élargir demanderait six modifications du même fait.
     *
     * L'obliquité est ce qui compte. Un dégradé vertical se lit comme un
     * éclairage, donc comme de la matière ; une bande en biais se lit comme le
     * reflet d'une fenêtre, donc comme une plaque.
     */
    const steps = 48;
    const span = width + height;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      // Deux reflets, un large et un fin, comme sur une vitre réelle.
      const wide = Math.max(0, 1 - Math.abs(t - 0.24) / 0.16);
      const thin = Math.max(0, 1 - Math.abs(t - 0.52) / 0.05);
      const alpha = 0.085 * wide * wide + 0.06 * thin;
      if (alpha < 0.004) continue;
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
      // Un parallélogramme à 45 degrés, dessiné en tranches verticales.
      const slice = span / steps;
      const x = t * span - height;
      for (let y = 0; y < height; y += 8) {
        ctx.fillRect(x + (height - y), y, slice, 8);
      }
    }

    /*
     * Le bord éclairé : deux liserés clairs en haut et à gauche, deux sombres
     * en bas et à droite. C'est l'indice le moins cher et le plus fort - il
     * dit qu'une plaque commence ici et finit là, ce qu'aucun voile ne dit.
     */
    const rim = 3;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(0, 0, width, rim);
    ctx.fillRect(0, 0, rim, height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(0, height - rim, width, rim);
    ctx.fillRect(width - rim, 0, rim, height);
    return;
  }

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
