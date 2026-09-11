/**
 * Où se pose chaque élément du décor.
 *
 * Le pendant de `sceneLayout` pour le monde plutôt que pour les panneaux, et
 * trois-fois-rien de code : une liste de nombres. C'est voulu - ce qui se
 * décide ici doit pouvoir se relire d'un coup d'œil et se vérifier sans
 * casque.
 *
 * CE QUE `Prop` NE PORTE PAS : aucune taille. Elle se déduit du dessin -
 * largeur en pixels divisée par seize - ce qui rend la règle des seize pixels
 * par mètre vraie PAR CONSTRUCTION plutôt que par discipline. Grossir un
 * objet se fait donc en le dessinant plus grand, jamais en le mettant à
 * l'échelle, et c'est ce qui garantit que ses pixels restent de la taille de
 * tous les autres.
 *
 * Les azimuts sont volontairement irréguliers. Une répartition uniforme se
 * lit immédiatement comme une répétition - l'œil trouve la période - alors
 * qu'un décor de jeu est irrégulier.
 */
import { RINGS } from './composition';

export type Facing = 'fixed' | 'billboard';

export interface Prop {
  readonly art: string;
  /** Radians, 0 droit devant, croissant vers la droite du joueur. */
  readonly azimuth: number;
  readonly radius: number;
  /** Mètres entre le sol et le BAS de l'objet. Zéro : posé. */
  readonly standing: number;
  readonly facing: Facing;
}

const TURN = 2 * Math.PI;
/** Une fraction de tour, pour que les azimuts se lisent en douzièmes. */
const at = (twelfths: number) => (twelfths / 12) * TURN;

export function scenery(): readonly Prop[] {
  return [
    // Les collines : fixes, parce qu'à vingt mètres la stéréo ne distingue
    // plus le volume et qu'une silhouette franche vaut mieux qu'un pivot.
    { art: 'hillLarge', azimuth: at(0.7), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillSmall', azimuth: at(2.2), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillLarge', azimuth: at(4.1), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillSmall', azimuth: at(6.4), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillLarge', azimuth: at(8.3), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillSmall', azimuth: at(10.6), radius: RINGS.hills, standing: 0, facing: 'fixed' },

    // Les buissons : plus près que les collines, ce qui est tout l'intérêt -
    // c'est l'écart entre les deux anneaux qui produit la parallaxe.
    { art: 'bush', azimuth: at(1.4), radius: RINGS.creatures, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(3.3), radius: RINGS.clouds, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(5.1), radius: RINGS.creatures, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(7.8), radius: RINGS.clouds, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(9.2), radius: RINGS.creatures, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(11.5), radius: RINGS.clouds, standing: 0, facing: 'fixed' },

    // Les nuages : billboards, parce qu'à cette distance le pivot est
    // indétectable et qu'il évite de les dessiner sous trois angles.
    { art: 'cloud', azimuth: at(0.2), radius: RINGS.clouds, standing: 7, facing: 'billboard' },
    { art: 'cloud', azimuth: at(3.9), radius: RINGS.clouds, standing: 9, facing: 'billboard' },
    { art: 'cloud', azimuth: at(6.1), radius: RINGS.clouds, standing: 6, facing: 'billboard' },
    { art: 'cloud', azimuth: at(8.8), radius: RINGS.clouds, standing: 10, facing: 'billboard' },
    { art: 'cloud', azimuth: at(10.3), radius: RINGS.clouds, standing: 8, facing: 'billboard' }
  ];
}
