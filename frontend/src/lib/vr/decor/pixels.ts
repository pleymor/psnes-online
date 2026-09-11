/**
 * L'art du décor : une grille de caractères, une palette, des octets RGBA.
 *
 * Le format est choisi pour être lisible dans un diff et modifiable sans
 * outil. Un caractère y désigne un NOM de couleur (`palette.ts`), jamais une
 * valeur, ce qui laisse la porte ouverte au cyclage de palette.
 *
 * Aucune dépendance au DOM, volontairement : cette fonction rend un tableau
 * d'octets et rien de plus. `build.ts` en fait une `ImageData`. C'est la
 * seule façon de tester cette arithmétique sous Bun, où il n'y a ni canvas ni
 * GPU - et `picture-filter.ts` raconte dans ce dépôt ce que coûte de ne pas
 * le faire.
 *
 * Tout ce qui est douteux jette, et jette en NOMMANT le coupable. Un motif
 * mal formé qui se rendrait quand même donnerait des pixels noirs quelque
 * part dans un casque, à des heures de sa cause.
 */
import { COLOURS, type ColourName } from './palette';

/** Le seul caractère qui ne désigne pas une couleur. */
export const TRANSPARENT = '.';

export interface Art {
  readonly palette: Readonly<Record<string, ColourName>>;
  readonly rows: readonly string[];
}

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, ligne du haut d'abord, comme `ImageData`. */
  readonly data: Uint8ClampedArray;
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

export function rasterise(art: Art): Raster {
  if (art.rows.length === 0) throw new Error('motif vide : aucune ligne');

  const width = art.rows[0].length;
  if (width === 0) throw new Error('motif vide : la ligne 0 est vide');

  art.rows.forEach((row, index) => {
    if (row.length !== width) {
      throw new Error(
        `motif en dents de scie : la ligne ${index} fait ${row.length}, attendu ${width}`
      );
    }
  });

  // Résolu une fois par caractère plutôt qu'une fois par pixel : une tuile de
  // 16x16 vaut 256 recherches, et l'atlas en compte des dizaines.
  const resolved = new Map<string, [number, number, number]>();
  for (const [char, name] of Object.entries(art.palette)) {
    const hex = COLOURS[name];
    if (!hex) throw new Error(`la palette pointe sur une couleur inconnue : ${name}`);
    resolved.set(char, channels(hex));
  }

  const height = art.rows.length;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const char = art.rows[y][x];
      const at = (y * width + x) * 4;
      if (char === TRANSPARENT) continue; // déjà 0,0,0,0
      const rgb = resolved.get(char);
      if (!rgb) throw new Error(`caractère '${char}' absent de la palette (ligne ${y})`);
      data[at] = rgb[0];
      data[at + 1] = rgb[1];
      data[at + 2] = rgb[2];
      data[at + 3] = 255;
    }
  }

  return { width, height, data };
}
