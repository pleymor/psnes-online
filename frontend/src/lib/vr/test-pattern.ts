/**
 * La mire de l'écran : une RÈGLE, pas une décoration.
 *
 * Le ciel et le brun du bloc `?`, et non le ciel et la brique : deux
 * complémentaires à pleine saturation sur des cellules de seize pixels
 * vibrent, et l'œil ne tient pas la frontière en place sur un écran de deux
 * mètres. Ici le contraste est un contraste de VALEUR - bleu clair contre brun
 * profond - donc la grille reste tranchante sans scintiller. Les trois paires
 * candidates ont été rendues et comparées avant de choisir.
 *
 * Elle existe pour qu'on puisse juger la géométrie, la distance, la hauteur et
 * les proportions de l'écran avant qu'une ROM soit en jeu - `screen.ts` le dit
 * depuis toujours : « a screen that is too low is obvious against a grid and
 * invisible against Super Mario World. » Ce module change ses COULEURS pour
 * qu'elle cesse de jurer avec le monde Mario ; il ne change pas sa nature, et
 * tout ce qui suit sert à mesurer.
 *
 * Sorti de `screen.ts` pour deux raisons qui se rejoignent : un tampon
 * d'octets se vérifie sous Bun alors qu'un maillage three ne s'y construit
 * pas, et la planche de rendu qui a servi à choisir ces couleurs devait
 * appeler exactement ce que le casque appelle. Recopier la boucle dans un
 * script jetable aurait fait deux énoncés d'un même dessin.
 */
import { COLOURS } from './decor/palette';

/** Seize pixels : la taille d'une tuile SMB, donc la cadence est déjà juste. */
export const TEST_PATTERN_CELL = 16;

/** La demi-longueur des bras de la croix centrale, en pixels. */
const CROSS_ARM = 24;
/** L'épaisseur des repères, en pixels. Impair : ils ont un axe. */
const MARK_THICKNESS = 3;
/** La longueur d'un repère de bord, vers l'intérieur. */
const EDGE_MARK = 12;

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

/**
 * Peint la mire dans `data`, en RGBA, sur `stride` pixels de large.
 *
 * `width` et `height` décrivent l'image utile ; le reste de la foulée est de
 * la marge. Cette marge est peinte en MAGENTA, et ce n'est pas un choix
 * esthétique resté là par inertie : si le joueur en voit un seul pixel, c'est
 * que `uMax` est faux. La teindre aux couleurs du monde la rendrait
 * invisible, c'est-à-dire inutile - `screen.ts` la voulait « unmistakable
 * rather than subtle », et une couleur qui n'existe nulle part ailleurs dans
 * ce monde est exactement ça.
 */
export function paintTestPattern(
  data: Uint8Array,
  width: number,
  height: number,
  stride: number
): void {
  const light = channels(COLOURS.sky);
  const dark = channels(COLOURS.brickDark);
  const ink = channels(COLOURS.outline);

  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  const half = Math.floor(MARK_THICKNESS / 2);

  /*
   * Les repères, en contour noir sur les deux couleurs du damier.
   *
   * Ce que le damier seul ne sait pas dire : il montre qu'un écran est de
   * travers, jamais de combien ni de quel côté. Une croix au centre exact et
   * un repère au milieu de chaque arête rendent le centrage et la symétrie
   * mesurables d'un coup d'œil - et ils servent la règle, pas la décoration.
   */
  const onCross = (x: number, y: number): boolean =>
    (Math.abs(x - midX) <= half && Math.abs(y - midY) <= CROSS_ARM) ||
    (Math.abs(y - midY) <= half && Math.abs(x - midX) <= CROSS_ARM);

  const onEdgeMark = (x: number, y: number): boolean =>
    (Math.abs(x - midX) <= half && (y < EDGE_MARK || y >= height - EDGE_MARK)) ||
    (Math.abs(y - midY) <= half && (x < EDGE_MARK || x >= width - EDGE_MARK));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < stride; x++) {
      const i = (y * stride + x) * 4;
      if (x >= width) {
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 255;
        data[i + 3] = 255;
        continue;
      }
      const cell = ((x / TEST_PATTERN_CELL) | 0) + ((y / TEST_PATTERN_CELL) | 0);
      const colour = onCross(x, y) || onEdgeMark(x, y) ? ink : cell & 1 ? light : dark;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
      data[i + 3] = 255;
    }
  }
}
