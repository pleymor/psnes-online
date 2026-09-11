/**
 * La silhouette partagée par les collines, les buissons et les nuages.
 *
 * Ce n'est pas une économie qu'on s'accorde : dans Super Mario Bros., ces
 * trois-là SONT le même dessin, à la palette près. Écrire un générateur plutôt
 * que trois grilles littérales rend donc l'original plus fidèlement, en plus
 * de remplacer deux cents lignes de caractères par des nombres qu'un test peut
 * vérifier.
 *
 * Une « mound » est une rangée de lobes semi-circulaires posés côte à côte.
 * Les rayons décident de tout : `[8, 12, 8]` fait une colline à trois bosses
 * dont celle du milieu dépasse, `[8]` fait un buisson d'une seule.
 */
import type { ColourName } from '../palette';
import type { Art } from '../pixels';
import { TRANSPARENT } from '../pixels';

export interface MoundPalette {
  /** Le corps. */
  readonly body: ColourName;
  /** Le bas, plus sombre : ce qui empêche la forme de paraître découpée. */
  readonly shade: ColourName;
  /** Le contour, sur le sommet de chaque colonne. */
  readonly edge: ColourName;
}

/** Depuis le bas, la hauteur de la bande sombre. */
const SHADE_ROWS = 3;

export function mound(radii: readonly number[], palette: MoundPalette): Art {
  if (radii.length === 0) throw new Error('une silhouette sans lobe');
  for (const radius of radii) {
    if (!Number.isInteger(radius) || radius <= 0) {
      throw new Error(`rayon de lobe invalide : ${radius}`);
    }
  }

  const width = radii.reduce((sum, radius) => sum + 2 * radius, 0);
  const height = Math.max(...radii);

  // Le centre de chaque lobe, en pixels depuis la gauche.
  const centres: number[] = [];
  let cursor = 0;
  for (const radius of radii) {
    centres.push(cursor + radius);
    cursor += 2 * radius;
  }

  /** La hauteur de la silhouette à la colonne x : le plus haut des lobes. */
  function silhouette(x: number): number {
    let top = 0;
    radii.forEach((radius, index) => {
      // Le pixel est échantillonné en son MILIEU (+0.5), sinon la forme est
      // décalée d'un demi-pixel et le miroir se casse.
      const dx = x + 0.5 - centres[index];
      const inside = radius * radius - dx * dx;
      if (inside <= 0) return;
      const lobe = Math.round(Math.sqrt(inside));
      if (lobe > top) top = lobe;
    });
    return top;
  }

  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    // y = 0 est le haut de l'image ; la silhouette se mesure depuis le bas.
    const fromBottom = height - y;
    let row = '';
    for (let x = 0; x < width; x++) {
      const top = silhouette(x);
      if (fromBottom > top) {
        row += TRANSPARENT;
      } else if (fromBottom === top) {
        row += 'e';
      } else if (fromBottom <= SHADE_ROWS) {
        row += 's';
      } else {
        row += 'b';
      }
    }
    rows.push(row);
  }

  return {
    palette: { b: palette.body, s: palette.shade, e: palette.edge },
    rows
  };
}

/**
 * Un motif fait de bandes verticales : tout ce qui est un tube en pixel-art.
 *
 * Un tuyau de SMB est exactement ça - un liseré noir, deux colonnes claires
 * qui font la lumière, le corps, une colonne sombre, un liseré. Le décrire en
 * bandes plutôt qu'en grille littérale évite quarante lignes de caractères et
 * rend la vérification possible : `to` doit atteindre la largeur, sinon il
 * reste un trou vertical qu'on ne verrait que dans un casque.
 */
export interface Band {
  /** La colonne après la dernière de cette bande. Cumulatif. */
  readonly to: number;
  readonly colour: ColourName;
}

export function banded(width: number, height: number, bands: readonly Band[]): Art {
  if (width <= 0 || height <= 0) throw new Error(`taille invalide : ${width}x${height}`);
  const last = bands[bands.length - 1];
  if (!last || last.to !== width) {
    // Le message doit se lire « couvre N colonnes sur M » au singulier
    // (« total » plutôt que « bandes ») : le test de la Task 16 vérifie ce
    // message par une regex sur ce fragment exact, et « les bandes couvrent »
    // ne le contient pas (« couvre » n'y apparaît qu'à l'intérieur de
    // « couvrent », jamais suivi d'un espace).
    throw new Error(`le total des bandes couvre ${last?.to ?? 0} colonnes sur ${width}`);
  }

  const palette: Record<string, ColourName> = {};
  let row = '';
  let from = 0;
  bands.forEach((band, index) => {
    const char = String.fromCharCode(97 + index); // a, b, c…
    palette[char] = band.colour;
    row += char.repeat(band.to - from);
    from = band.to;
  });

  return { palette, rows: Array.from({ length: height }, () => row) };
}
