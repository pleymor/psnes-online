/**
 * Ce qui bouge : le goomba et la plante carnivore.
 *
 * Les deux restent des BILLBOARDS, jamais des boîtes. La spec §6 le dit : un
 * sprite de jeu 2D n'a jamais eu de dos, et lui en donner un serait le seul
 * endroit où l'on trahirait vraiment le registre. Un tuyau en volume reste un
 * tuyau ; un goomba en volume n'est plus un goomba.
 *
 * Deux images chacun, à huit par seconde.
 *
 * CE QUI DOIT ÊTRE IDENTIQUE D'UNE IMAGE À L'AUTRE l'est par construction,
 * pas par relecture : les lignes communes sont écrites une fois et épandues
 * dans les deux variantes. Un œil qui sauterait d'un pixel entre deux images
 * ne se lit pas comme un défaut de dessin mais comme un tremblement, et c'est
 * exactement le genre d'écart qu'une grille recopiée à la main finit par
 * produire. Ici, seules les lignes des PIEDS diffèrent, et ça se voit dans la
 * forme du code.
 */
import { banded } from './shapes';
import type { Art } from '../pixels';

const GOOMBA_PALETTE = { k: 'outline', g: 'goomba', f: 'goombaFoot', w: 'cloud' } as const;

/** Le corps et les yeux : dix lignes, les mêmes sur les deux images. */
const GOOMBA_BODY = [
  '.....kkkkkk.....',
  '...kkggggggkk...',
  '..kggggggggggk..',
  '.kggggggggggggk.',
  'kggwwkggggkwwggk',
  'kggwkkggggkkwggk',
  'kgggkkggggkkgggk',
  'kggggggggggggggk',
  'kggggggggggggggk',
  '.kggggggggggggk.'
] as const;

/** Pieds écartés. 1 m de large, 0,875 m de haut. */
export const GOOMBA_A: Art = {
  palette: GOOMBA_PALETTE,
  rows: [
    ...GOOMBA_BODY,
    '..kffffffffffk..',
    '.kfffkkkkkkfffk.',
    'kfffk......kfffk',
    'kkkk........kkkk'
  ]
};

/** Pieds serrés : la deuxième image de la marche. */
export const GOOMBA_B: Art = {
  palette: GOOMBA_PALETTE,
  rows: [
    ...GOOMBA_BODY,
    '..kffffffffffk..',
    '.kffffffffffffk.',
    '..kkffffffffkk..',
    '....kkkkkkkk....'
  ]
};

/** Le pied de la plante : une tige verte qui monte du tuyau. */
export const PIRANHA_STEM = banded(8, 16, [
  { to: 1, colour: 'outline' },
  { to: 3, colour: 'pipeHi' },
  { to: 7, colour: 'pipe' },
  { to: 8, colour: 'outline' }
]);

const PIRANHA_PALETTE = { k: 'outline', r: 'brick', w: 'cloud', d: 'brickDark' } as const;

/** Le crâne et les taches : au-dessus de la gueule, donc immobile. */
const PIRANHA_HEAD = [
  '...kkkkkkkkkk...',
  '..krrrrrrrrrrk..',
  '.krrwwrrrrwwrrk.',
  'krrrwwrrrrwwrrrk'
] as const;

/** Le menton et le col : sous la gueule, donc immobile aussi. */
const PIRANHA_CHIN = ['.krrrrrrrrrrrrk.', '..kkddddddddkk..'] as const;

/** Gueule fermée. */
export const PIRANHA_CLOSED: Art = {
  palette: PIRANHA_PALETTE,
  rows: [
    ...PIRANHA_HEAD,
    'krrrrrrrrrrrrrrk',
    'krrrkkkkkkkkrrrk',
    'krrrrrrrrrrrrrrk',
    'krrrrrrrrrrrrrrk',
    ...PIRANHA_CHIN
  ]
};

/**
 * Gueule ouverte.
 *
 * Franchement ouverte : le noir sur toute la largeur, une rangée claire au
 * milieu pour les dents, et le noir à nouveau. Une gueule timide serait pire
 * qu'une gueule fermée - le mouvement se lirait comme un scintillement.
 */
export const PIRANHA_OPEN: Art = {
  palette: PIRANHA_PALETTE,
  rows: [
    ...PIRANHA_HEAD,
    'krrrrrrrrrrrrrrk',
    'kkkkkkkkkkkkkkkk',
    'kwwwwwwwwwwwwwwk',
    'kkkkkkkkkkkkkkkk',
    ...PIRANHA_CHIN
  ]
};
