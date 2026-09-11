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
 * DEUX OMBRES À NE PAS HABITER, et elles ne se ressemblent pas.
 *
 * L'écran de jeu couvre `screenShadow()`, 46,4 degrés de part et d'autre du
 * devant, et le test de placement le tient. Les deux pupitres de `layout.ts`
 * en ajoutent une autre : à 1,06 m et 0,95 m de large ils couvrent 24,1
 * degrés autour de ±60, donc de 36 à 84 degrés de chaque côté. Mais ils
 * pendent sous les yeux - inclinés de 40 degrés en arrière, ils vont de -7,8
 * à -41 degrés d'élévation - et c'est ce qui décide quoi passe :
 *
 * - la rangée de blocs `?` passe AU-DESSUS d'eux, parce qu'elle est à hauteur
 *   de frappe. Seul l'écran la contraint.
 * - un tuyau est posé au sol, de -10,1 à +2,5 degrés, donc un pupitre le
 *   coupe. Il lui faut passer les 84 degrés, et c'est pour ça que le tuyau de
 *   devant est à 96 et non à 63 - où il sortait du pupitre « Bibliothèque »
 *   comme une tige.
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
      azimuth: at(3.2),
      radius: RINGS.pipes,
      standing: 0,
      depth: 1
    },
    {
      front: 'pipeLip',
      side: 'pipeLipSide',
      top: 'pipeLipSide',
      azimuth: at(3.2),
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

    /*
     * La rangée de blocs `?`, à hauteur de frappe.
     *
     * `standing` est une hauteur AU-DESSUS DU SOL, comme partout ici : le sol
     * n'est pas connu de ce module, et `build.ts` y ajoute -floorHeight. Donc
     * 2,4 m du sol, ce qui met le dessous des blocs à 1,2 m de l'œil d'un
     * joueur assis (`FLOOR_FALLBACK`) et à 0,8 m de celui d'un joueur debout.
     * L'écart est la conséquence assumée d'un décor posé sur le sol plutôt que
     * mesuré depuis les yeux - le sol, lui, ne peut pas flotter.
     *
     * LES AZIMUTS NE SONT PAS LIBRES. Ils valaient -12, 0 et +12 degrés, soit
     * pile derrière l'image du jeu : trois blocs corrects et invisibles depuis
     * l'ancre, trouvés dans le casque le 2026-09-11. L'écran couvre jusqu'à
     * `screenShadow()`, 46 degrés de part et d'autre, et le test de placement
     * refuse tout objet proche dont le BORD y entre. Le tuyau de devant est
     * parti à l'opposé pour la même raison.
     *
     * Les douze degrés qui séparent les trois, eux, sont voulus : à sept
     * mètres ils font 1,47 m d'écart pour des blocs d'un mètre, donc une
     * rangée qui se lit comme une rangée plutôt que trois blocs épars. C'est
     * le seul endroit du décor où la régularité est le but.
     */
    {
      front: 'questionBlock',
      side: 'blockSide',
      top: 'blockSide',
      azimuth: at(2.1),
      radius: RINGS.props,
      standing: 2.4,
      depth: 1
    },
    {
      front: 'questionBlock',
      side: 'blockSide',
      top: 'blockSide',
      azimuth: at(2.5),
      radius: RINGS.props,
      standing: 2.4,
      depth: 1
    },
    {
      front: 'questionBlock',
      side: 'blockSide',
      top: 'blockSide',
      azimuth: at(2.9),
      radius: RINGS.props,
      standing: 2.4,
      depth: 1
    }
  ];
}
