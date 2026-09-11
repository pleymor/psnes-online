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

/**
 * Le sol sur lequel on marche : une SURFACE, vue du dessus.
 *
 * Corrigé le 2026-09-11 après une session sous casque. Le sol posait
 * `GROUND_BRICK`, et le propriétaire l'a signalé d'un mot : « c'est bizarre
 * d'avoir des briques ». Il avait raison, et la cause n'est pas le goût -
 * c'est une confusion de projection. Une brique est un dessin d'ÉLÉVATION,
 * vu de face ; c'est le bloc que Mario casse par en dessous. Un sol se voit
 * du DESSUS, et par le dessus on ne voit jamais la face d'une brique, on voit
 * une surface. Poser l'un pour l'autre donne un mur couché, ce qui est
 * exactement ce que ça donnait.
 *
 * D'où deux propriétés que ce motif a et que l'autre n'avait pas :
 *
 * **Aucun contour.** Un bord sombre fait réapparaître, une fois carrelé, la
 * grille régulière au mètre qu'on vient de supprimer - `vr-decor-art.test.ts`
 * le vérifie maintenant pour toute tuile de sol.
 *
 * **Un semis, pas une trame.** Les touffes plus sombres sont irrégulières et
 * ne touchent aucun bord, donc rien ne s'aligne d'une tuile à l'autre. Le
 * motif se répète quand même tous les mètres ; si ça se remarque sous casque,
 * la parade est une tuile de deux mètres (32 px), qui double la période.
 */
export const GROUND_TURF: Art = {
  palette: { g: 'grass', d: 'grassDark' },
  rows: [
    'gggggggggggggggg',
    'ggdgggggggddgggg',
    'gggggggggggggggg',
    'gggggddgggggggdg',
    'gdgggggggggggggg',
    'gggggggggddggggg',
    'ggggdggggggggggg',
    'gggggggggggggddg',
    'gggggggggggggggg',
    'gddggggggddggggg',
    'gggggggggggggggg',
    'ggggggddgggggggg',
    'ggdggggggggggdgg',
    'gggggggggggggggg',
    'ggggggggddgggggg',
    'gdgggggggggggggg'
  ]
};
