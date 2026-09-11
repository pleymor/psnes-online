/**
 * Le sol : la brique, et la brique coiffée d'herbe.
 *
 * Seize pixels de côté, parce qu'une tuile fait un mètre et que
 * `ART_PIXELS_PER_METRE` vaut seize (`composition.ts`). Ce n'est pas une
 * coïncidence à maintenir de tête : `vr-decor-art.test.ts` le vérifie sur
 * toute tuile dont le nom commence par `ground`.
 *
 * Le motif de briques est décalé d'une rangée sur l'autre, comme un vrai
 * appareil. Sans ce décalage, un sol carrelé donne des lignes de mortier
 * continues d'un bout à l'autre du monde, et l'œil les lit comme une grille
 * plutôt que comme de la maçonnerie.
 */
import type { Art } from '../pixels';

const BRICK_PALETTE = { b: 'brick', l: 'brickLight', k: 'outline' } as const;

export const GROUND_BRICK: Art = {
  palette: BRICK_PALETTE,
  rows: [
    'kkkkkkkkkkkkkkkk',
    'kllllllkkllllllk',
    'kllllllkkllllllk',
    'kbbbbbbkkbbbbbbk',
    'kbbbbbbkkbbbbbbk',
    'kbbbbbbkkbbbbbbk',
    'kbbbbbbkkbbbbbbk',
    'kkkkkkkkkkkkkkkk',
    'llllkkllllllkkll',
    'llllkkllllllkkll',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb'
  ]
};

export const GROUND_GRASS: Art = {
  palette: { ...BRICK_PALETTE, g: 'grass', d: 'grassDark' },
  rows: [
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'dddddddddddddddd',
    'kkkkkkkkkkkkkkkk',
    'llllllkkllllllkk',
    'llllllkkllllllkk',
    'bbbbbbkkbbbbbbkk',
    'bbbbbbkkbbbbbbkk',
    'bbbbbbkkbbbbbbkk',
    'kkkkkkkkkkkkkkkk',
    'llkkllllllkkllll',
    'llkkllllllkkllll',
    'bbkkbbbbbbkkbbbb',
    'bbkkbbbbbbkkbbbb',
    'bbkkbbbbbbkkbbbb'
  ]
};
