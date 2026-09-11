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

/**
 * Les objets qu'on voit en volume, montés en boîte.
 *
 * Le rayon est borné à douze mètres et le test le tient : au-delà, la stéréo
 * ne perçoit plus l'épaisseur, et la boîte coûterait quatre faces pour rien.
 * C'est la règle de la spec §6, et elle a une conséquence pratique - déplacer
 * un tuyau plus loin ne se fait pas en changeant un nombre ici, mais en le
 * repassant en quad plat.
 */
export interface BoxProp {
  readonly front: string;
  readonly side: string;
  readonly top: string;
  readonly azimuth: number;
  readonly radius: number;
  /** Mètres entre le sol et le BAS de l'objet, comme `Prop.standing`. */
  readonly standing: number;
  /** Mètres. Un tuyau est aussi profond que large. */
  readonly depth: number;
}

export function props(): readonly BoxProp[] {
  return [
    // Un tuyau complet : le fût, puis la lèvre posée dessus.
    {
      front: 'pipeShaft',
      side: 'pipeShaftSide',
      top: 'pipeShaftSide',
      azimuth: at(1.1),
      radius: RINGS.pipes,
      standing: 0,
      depth: 1
    },
    {
      front: 'pipeLip',
      side: 'pipeLipSide',
      top: 'pipeLipSide',
      azimuth: at(1.1),
      radius: RINGS.pipes,
      standing: 1.5,
      depth: 1.25
    },

    {
      front: 'pipeShaft',
      side: 'pipeShaftSide',
      top: 'pipeShaftSide',
      azimuth: at(7.4),
      radius: RINGS.pipes,
      standing: 0,
      depth: 1
    },
    {
      front: 'pipeLip',
      side: 'pipeLipSide',
      top: 'pipeLipSide',
      azimuth: at(7.4),
      radius: RINGS.pipes,
      standing: 1.5,
      depth: 1.25
    },

    // La rangée de blocs `?`, à hauteur de frappe : 1,2 m au-dessus de l'œil,
    // donc `standing` vaut la hauteur du sol plus 1,2 - mais le sol n'est pas
    // connu ici, et c'est voulu. `build.ts` ajoute -floorHeight ; ce qui suit
    // est donc la hauteur AU-DESSUS DU SOL, comme pour tout le reste.
    {
      front: 'questionBlock',
      side: 'blockSide',
      top: 'blockSide',
      azimuth: at(11.6),
      radius: RINGS.props,
      standing: 2.4,
      depth: 1
    },
    {
      front: 'questionBlock',
      side: 'blockSide',
      top: 'blockSide',
      azimuth: at(0),
      radius: RINGS.props,
      standing: 2.4,
      depth: 1
    },
    {
      front: 'questionBlock',
      side: 'blockSide',
      top: 'blockSide',
      azimuth: at(0.4),
      radius: RINGS.props,
      standing: 2.4,
      depth: 1
    }
  ];
}
