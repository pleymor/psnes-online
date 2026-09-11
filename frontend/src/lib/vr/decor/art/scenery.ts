/**
 * Le relief lointain, tout entier dérivé d'une seule silhouette.
 *
 * Les tailles se lisent en mètres : un lobe de rayon r fait 2r pixels de
 * large, et seize pixels font un mètre (`ART_PIXELS_PER_METRE`). Une colline
 * `[16, 24, 16]` mesure donc sept mètres de large sur un mètre cinquante de
 * haut - ce qui, posée à vingt mètres, occupe vingt degrés de vision.
 */
import { mound } from './shapes';

export const HILL_LARGE = mound([16, 24, 16], {
  body: 'hill',
  shade: 'hillDark',
  edge: 'outline'
});

export const HILL_SMALL = mound([12, 12], {
  body: 'hill',
  shade: 'hillDark',
  edge: 'outline'
});

/** Même forme que la colline : c'est ce que faisait l'original. */
export const BUSH = mound([8, 8, 8], {
  body: 'grass',
  shade: 'grassDark',
  edge: 'outline'
});

/** Et le nuage aussi - seule la palette change. */
export const CLOUD = mound([8, 12, 8], {
  body: 'cloud',
  shade: 'cloud',
  edge: 'outline'
});
