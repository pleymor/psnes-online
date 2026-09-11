/**
 * Le relief lointain, tout entier dérivé d'une seule silhouette.
 *
 * Les tailles se lisent en mètres : un lobe de rayon r fait 2r pixels de
 * large, et seize pixels font un mètre (`ART_PIXELS_PER_METRE`).
 *
 * LES RAYONS SE CHOISISSENT EN DEGRÉS, PAS EN PIXELS, et c'est la leçon de la
 * première version. Elle donnait `[16, 24, 16]` à la grande colline et
 * `[12, 12]` à la petite, soit 1,50 m et 0,75 m de haut. Mesuré depuis un œil
 * à 1,20 m, avec les collines à vingt mètres :
 *
 *     [16,24,16]  ->  sommet à +0,9° au-dessus de l'horizon
 *     [12,12]     ->  sommet à -1,3°, donc SOUS l'horizon
 *
 * La petite colline n'était pas une colline : c'était une bosse qu'on
 * regardait d'en haut. Et la grande était une bande verte posée sur la ligne
 * d'horizon. Aucun test ne pouvait le dire - une silhouette parfaitement
 * correcte peut être parfaitement plate.
 *
 * La cause était une proportion : dans SMB la grande colline fait trois blocs
 * de haut, donc trois mètres à l'échelle de ce monde (§2 de la spec), et nous
 * en avions mis un et demi. Les rayons ci-dessous rendent +5,1° et +0,9°.
 *
 * Donc : en changer un veut dire re-mesurer l'angle, pas regarder le dessin.
 * Le script tient en dix lignes - hauteur, distance, `atan((h - 1.2) / d)`.
 */
import { mound } from './shapes';

/** 10 m x 3 m. Trois blocs de haut, comme dans l'original. */
export const HILL_LARGE = mound([16, 48, 16], {
  body: 'hill',
  shade: 'hillDark',
  edge: 'outline'
});

/** 3 m x 1,5 m. Un seul lobe, comme la petite colline de SMB. */
export const HILL_SMALL = mound([24], {
  body: 'hill',
  shade: 'hillDark',
  edge: 'outline'
});

/**
 * 4 m x 1 m. Même forme que le nuage ci-dessous, et ce n'est pas une économie
 * qu'on s'accorde : dans SMB, le buisson et le nuage SONT le même dessin, à la
 * palette près.
 */
export const BUSH = mound([8, 16, 8], {
  body: 'grass',
  shade: 'grassDark',
  edge: 'outline'
});

/** Le même, en blanc. */
export const CLOUD = mound([8, 16, 8], {
  body: 'cloud',
  shade: 'cloud',
  edge: 'outline'
});
