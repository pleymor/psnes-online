/**
 * Le mobilier : le comptoir qui porte les trois pupitres.
 *
 * Aucun de ces trois motifs n'est dessiné. Le premier EMPILE l'appareil du sol
 * de brique, le deuxième le recolore, le troisième est un aplat. C'est
 * délibéré : la brique du comptoir doit être la même maçonnerie que celle du
 * monde, et deux grilles qui se ressemblent finissent toujours par diverger.
 */
import { recolour } from './shapes';
import { GROUND_BRICK } from './ground';
import type { Art } from '../pixels';

/**
 * Un bloc d'un mètre de large et DEUX de haut.
 *
 * Les deux mètres sont une contrainte d'ancrage rendue en pixels : le comptoir
 * est ancré aux panneaux, le sol ne l'est pas, donc sa base doit descendre
 * sous n'importe quel sol plausible plutôt que de viser une hauteur mesurée
 * qu'elle ne saurait pas suivre. Seuls les quatre-vingts centimètres du haut
 * se voient ; le disque du sol enterre le reste.
 *
 * `GROUND_BRICK` porte déjà deux rangs d'appareil décalés sur ses seize
 * lignes. Les empiler en donne quatre cohérents, sans un caractère de plus.
 *
 * LE MORTIER N'EST PAS NOIR, et c'est une session casque qui l'a imposé.
 * L'arithmétique : à seize pixels le mètre, un pixel fait 6,25 cm, donc les
 * lignes de contour de `GROUND_BRICK` mesurent 6 à 12 cm d'épaisseur dans le
 * monde. Sur un sol, à cinq mètres, c'était de la matière ; sur un comptoir, à
 * un mètre du nez, c'étaient des barres noires, et l'objet se lisait comme des
 * dalles orange plutôt que comme de la maçonnerie. Le brun sombre garde les
 * joints sans les faire crier.
 *
 * Ce que ça ne corrige pas : les briques font 50 x 25 cm, parce que c'est ce
 * que la règle des seize pixels par mètre impose à cette distance. Elle n'est
 * pas en cause - c'est elle qui fait que tous les pixels du monde ont la même
 * taille - elle ne sait simplement pas dessiner de la maçonnerie fine à portée
 * de main.
 */
export const COUNTER_BRICK: Art = recolour(
  { palette: GROUND_BRICK.palette, rows: [...GROUND_BRICK.rows, ...GROUND_BRICK.rows] },
  { outline: 'brickDark' }
);

/** Les flancs : même tracé, palette assombrie, comme tout le lot 3. */
export const COUNTER_SIDE: Art = recolour(COUNTER_BRICK, {
  brick: 'brickDark',
  brickLight: 'brick'
});

/**
 * Le plateau : un aplat clair, sans contour.
 *
 * La leçon du sol, mot pour mot : un bord sombre redessine une grille
 * régulière tous les mètres, que l'œil lit comme un artefact plutôt que comme
 * une matière.
 *
 * C'est le seul motif du dépôt qu'une face non carrée peut étirer sans mentir,
 * parce qu'un aplat étiré reste le même aplat. La règle des seize pixels par
 * mètre ne lui doit donc rien - et c'est pour ça qu'il peut couvrir un plateau
 * d'un mètre sur trente-cinq centimètres en restant carré.
 */
export const COUNTER_TOP: Art = {
  palette: { l: 'brickLight' },
  rows: Array.from({ length: 16 }, () => 'l'.repeat(16))
};
