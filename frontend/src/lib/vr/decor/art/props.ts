/**
 * Les objets proches : ceux que la stéréo voit en volume.
 *
 * Les tailles se lisent en mètres, à seize pixels le mètre. Un tuyau fait deux
 * mètres de haut et un de large, comme dans le jeu.
 *
 * Chaque objet a un motif de FAÇADE et un motif de FLANC. Le flanc n'est pas
 * un dessin de plus : c'est le même tracé dans une palette assombrie, ce que
 * `banded` rend immédiat. C'est ce qui permet de monter ces objets en boîte
 * sans produire une seule image d'art supplémentaire.
 */
import { banded, recolour } from './shapes';
import type { Art } from '../pixels';

/** 1 m de large, 1,5 m de haut : le fût sous la lèvre. */
export const PIPE_SHAFT = banded(16, 24, [
  { to: 1, colour: 'outline' },
  { to: 4, colour: 'pipeHi' },
  { to: 13, colour: 'pipe' },
  { to: 15, colour: 'pipeSide' },
  { to: 16, colour: 'outline' }
]);

/** Les flancs du fût : même tracé, palette assombrie. */
export const PIPE_SHAFT_SIDE = banded(16, 24, [
  { to: 1, colour: 'outline' },
  { to: 4, colour: 'pipe' },
  { to: 15, colour: 'pipeSide' },
  { to: 16, colour: 'outline' }
]);

/** La lèvre : 1,25 m de large, 0,5 m de haut. */
export const PIPE_LIP = banded(20, 8, [
  { to: 1, colour: 'outline' },
  { to: 5, colour: 'pipeHi' },
  { to: 17, colour: 'pipe' },
  { to: 19, colour: 'pipeSide' },
  { to: 20, colour: 'outline' }
]);

export const PIPE_LIP_SIDE = banded(20, 8, [
  { to: 1, colour: 'outline' },
  { to: 5, colour: 'pipe' },
  { to: 19, colour: 'pipeSide' },
  { to: 20, colour: 'outline' }
]);

/**
 * Le bloc `?`, en grille littérale.
 *
 * Le seul motif de ce lot qui ne se génère pas : un glyphe n'est pas une
 * répétition, et le décrire en bandes serait plus long que le dessiner.
 */
export const QUESTION_BLOCK: Art = {
  palette: { k: 'outline', y: 'block', h: 'blockHi', d: 'brickDark' },
  rows: [
    'kkkkkkkkkkkkkkkk',
    'khhhhhhhhhhhhhhk',
    'khyyyyyyyyyyyyhk',
    'khyyyykkkkyyyyhk',
    'khyyykkhhkkyyyhk',
    'khyykkhyyhkkyyhk',
    'khyykkyykkkkyyhk',
    'khyyyyyykkyyyyhk',
    'khyyyyykkyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khyyyyyyyyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khhhhhhhhhhhhhhk',
    'kkkkkkkkkkkkkkkk'
  ]
};

/** Le flanc d'un bloc : uni, contour compris. */
export const BLOCK_SIDE = banded(16, 16, [
  { to: 1, colour: 'outline' },
  { to: 15, colour: 'brickDark' },
  { to: 16, colour: 'outline' }
]);

/**
 * Les trois temps du pulsement, sans un pixel de plus.
 *
 * Le corps passe du jaune au clair et revient. Exactement le cyclage de
 * palette de l'original, et le poste d'animation le moins cher du lot : zéro
 * image d'art produite. `QUESTION_BLOCK` lui-même est le premier temps.
 */
export const QUESTION_BLOCK_1 = recolour(QUESTION_BLOCK, {
  block: 'blockHi',
  blockHi: 'block'
});
export const QUESTION_BLOCK_2 = recolour(QUESTION_BLOCK, { block: 'brickDark' });
