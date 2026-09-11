/**
 * La mire de l'écran, et pourquoi elle se teste.
 *
 * Elle vivait dans `screen.ts`, au milieu de three, donc rien ne la vérifiait.
 * Sortie en fonction pure, c'est un tampon d'octets : chacune de ses
 * propriétés devient une assertion, et deux d'entre elles sont des
 * diagnostics dont la perte serait silencieuse.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  paintTestPattern,
  TEST_PATTERN_CELL
} from '../../frontend/src/lib/vr/test-pattern.js';
import { COLOURS } from '../../frontend/src/lib/vr/decor/palette.js';

const WIDTH = 256;
const HEIGHT = 224;
const STRIDE = 512;

function painted(): Uint8Array {
  const data = new Uint8Array(STRIDE * HEIGHT * 4);
  paintTestPattern(data, WIDTH, HEIGHT, STRIDE);
  return data;
}

function at(data: Uint8Array, x: number, y: number): [number, number, number] {
  const i = (y * STRIDE + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

test('la marge est magenta, d_un bout à l_autre', () => {
  /*
   * Le diagnostic le plus important de ce fichier. Cette marge occupe les
   * colonnes au-delà de l'image utile, et si le joueur en voit un seul pixel,
   * c'est que `uMax` est faux. Le magenta est choisi parce qu'il n'existe
   * nulle part ailleurs dans ce monde : `screen.ts` le voulait « unmistakable
   * rather than subtle ». Le teindre aux couleurs du décor le rendrait
   * invisible, donc inutile.
   */
  const data = painted();
  for (const y of [0, 1, HEIGHT >> 1, HEIGHT - 1]) {
    for (const x of [WIDTH, WIDTH + 1, STRIDE - 1]) {
      assert.deepEqual(at(data, x, y), [255, 0, 255], `(${x},${y}) n'est pas magenta`);
    }
  }
});

test('l_image utile ne contient aucun magenta', () => {
  // L'autre moitié du même diagnostic : un magenta égaré dans l'image ferait
  // crier au défaut d'uMax là où il n'y en a pas.
  const data = painted();
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = at(data, x, y);
      assert.ok(!(r === 255 && g === 0 && b === 255), `magenta en (${x},${y})`);
    }
  }
});

test('les cellules font seize pixels, la taille d_une tuile', () => {
  // C'est ce qui fait de la mire une RÈGLE : une cadence qui correspond à la
  // grille du jeu, donc un écran mal proportionné se voit au comptage.
  const data = painted();
  const first = at(data, 2, 2);
  assert.notDeepEqual(at(data, 2 + TEST_PATTERN_CELL, 2), first, 'pas d_alternance');
  assert.deepEqual(at(data, 2 + 2 * TEST_PATTERN_CELL, 2), first, 'période fausse');
  assert.notDeepEqual(at(data, 2, 2 + TEST_PATTERN_CELL), first, 'pas d_alternance verticale');
});

test('la croix tombe au centre exact', () => {
  // Ce que le damier seul ne sait pas dire : il montre qu_un écran est de
  // travers, jamais de combien ni de quel côté.
  const data = painted();
  const ink = channels(COLOURS.outline);
  assert.deepEqual(at(data, WIDTH >> 1, HEIGHT >> 1), ink, 'pas de croix au centre');
  assert.deepEqual(at(data, WIDTH >> 1, (HEIGHT >> 1) - 10), ink, 'bras vertical absent');
  assert.deepEqual(at(data, (WIDTH >> 1) - 10, HEIGHT >> 1), ink, 'bras horizontal absent');
  // Et elle ne déborde pas : à quarante pixels du centre, on est dans le damier.
  assert.notDeepEqual(at(data, (WIDTH >> 1) + 40, HEIGHT >> 1), ink, 'bras trop long');
});

test('les quatre repères de bord sont là', () => {
  const data = painted();
  const ink = channels(COLOURS.outline);
  assert.deepEqual(at(data, WIDTH >> 1, 0), ink, 'repère du haut');
  assert.deepEqual(at(data, WIDTH >> 1, HEIGHT - 1), ink, 'repère du bas');
  assert.deepEqual(at(data, 0, HEIGHT >> 1), ink, 'repère de gauche');
  assert.deepEqual(at(data, WIDTH - 1, HEIGHT >> 1), ink, 'repère de droite');
});

test('la mire porte les couleurs du monde, et pas deux gris', () => {
  // Le but de tout ce changement. Les deux teintes viennent de `palette.ts`,
  // donc changer le monde change la mire, et elle ne peut pas dériver.
  const data = painted();
  const seen = new Set<string>();
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) seen.add(at(data, x, y).join(','));
  }
  assert.ok(seen.has(channels(COLOURS.sky).join(',')), 'le ciel est absent');
  assert.ok(seen.has(channels(COLOURS.brickDark).join(',')), 'le brun sombre est absent');
  assert.equal(seen.size, 3, `trois couleurs attendues, vu ${[...seen].join(' | ')}`);
});
