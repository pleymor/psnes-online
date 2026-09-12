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
  /**
   * Cet élément SUIT-IL le joueur quand il marche ?
   *
   * Le ciel, le sol et le lointain suivent ; le proche reste posé, donc on
   * s'en éloigne vraiment et on en fait le tour. C'est ce qui permet d'aller
   * partout sans sortir d'un monde qui ne fait que trente mètres.
   *
   * DÉCLARÉ ET NON DÉDUIT D'UN RAYON, parce qu'un seuil ne marche pas ici :
   * `scenery()` pose des buissons sur l'anneau des créatures (12 m) ET sur
   * celui des nuages (15 m). N'importe quel seuil entre les deux ferait suivre
   * la moitié des buissons et rester l'autre - des buissons qui se dédoublent
   * dès qu'on marche.
   */
  readonly distant: boolean;
}

const TURN = 2 * Math.PI;
/** Une fraction de tour, pour que les azimuts se lisent en douzièmes. */
const at = (twelfths: number) => (twelfths / 12) * TURN;

export function scenery(): readonly Prop[] {
  return [
    // Les collines : fixes, parce qu'à vingt mètres la stéréo ne distingue
    // plus le volume et qu'une silhouette franche vaut mieux qu'un pivot.
    { art: 'hillLarge', azimuth: at(0.7), radius: RINGS.hills, standing: 0, facing: 'fixed', distant: true },
    { art: 'hillSmall', azimuth: at(2.2), radius: RINGS.hills, standing: 0, facing: 'fixed', distant: true },
    { art: 'hillLarge', azimuth: at(4.1), radius: RINGS.hills, standing: 0, facing: 'fixed', distant: true },
    { art: 'hillSmall', azimuth: at(6.4), radius: RINGS.hills, standing: 0, facing: 'fixed', distant: true },
    { art: 'hillLarge', azimuth: at(8.3), radius: RINGS.hills, standing: 0, facing: 'fixed', distant: true },
    { art: 'hillSmall', azimuth: at(10.6), radius: RINGS.hills, standing: 0, facing: 'fixed', distant: true },

    // Les buissons : plus près que les collines, ce qui est tout l'intérêt -
    // c'est l'écart entre les deux anneaux qui produit la parallaxe.
    { art: 'bush', azimuth: at(1.4), radius: RINGS.creatures, standing: 0, facing: 'fixed', distant: false },
    { art: 'bush', azimuth: at(3.3), radius: RINGS.clouds, standing: 0, facing: 'fixed', distant: false },
    { art: 'bush', azimuth: at(5.1), radius: RINGS.creatures, standing: 0, facing: 'fixed', distant: false },
    { art: 'bush', azimuth: at(7.8), radius: RINGS.clouds, standing: 0, facing: 'fixed', distant: false },
    { art: 'bush', azimuth: at(9.2), radius: RINGS.creatures, standing: 0, facing: 'fixed', distant: false },
    { art: 'bush', azimuth: at(11.5), radius: RINGS.clouds, standing: 0, facing: 'fixed', distant: false },

    // Les nuages : billboards, parce qu'à cette distance le pivot est
    // indétectable et qu'il évite de les dessiner sous trois angles.
    { art: 'cloud', azimuth: at(0.2), radius: RINGS.clouds, standing: 7, facing: 'billboard', distant: true },
    { art: 'cloud', azimuth: at(3.9), radius: RINGS.clouds, standing: 9, facing: 'billboard', distant: true },
    { art: 'cloud', azimuth: at(6.1), radius: RINGS.clouds, standing: 6, facing: 'billboard', distant: true },
    { art: 'cloud', azimuth: at(8.8), radius: RINGS.clouds, standing: 10, facing: 'billboard', distant: true },
    { art: 'cloud', azimuth: at(10.3), radius: RINGS.clouds, standing: 8, facing: 'billboard', distant: true }
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
  /**
   * Les motifs du pulsement, s'il pulse. C'est la FAÇADE qui change de
   * palette, pas l'objet qui bouge - d'où sa place ici plutôt que dans
   * `creatures()` : une boîte qui pulse reste une boîte, et un quad animé posé
   * devant sa façade se battrait avec elle en profondeur.
   *
   * Le premier motif doit être `front`, pour que l'objet au repos soit celui
   * que `boxFor` a construit.
   */
  readonly frames?: readonly string[];
  /** Hertz du pulsement. La spec §7 plafonne à trois pour une telle surface. */
  readonly hz?: number;
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
      depth: 1,
      // Celui du milieu bat, les deux autres non : trois blocs qui pulsent en
      // phase feraient une enseigne, et la spec interdit le clignotement de
      // grande surface. Un seul, au centre de la rangée, se lit comme un
      // détail vivant.
      frames: ['questionBlock', 'questionBlock1', 'questionBlock2'],
      hz: 3
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

/**
 * Ce qui bouge, et à quelle distance.
 *
 * Le rayon n'est pas un choix esthétique ici : c'est lui qui tient la première
 * règle de confort. Un goomba à un mètre par seconde couvre 4,8 degrés par
 * seconde à douze mètres, et le double à six. Rapprocher une créature est donc
 * la façon dont cette règle se viole - pas l'accélérer - et le test mesure
 * bien le rapport des deux.
 *
 * `span` est la LONGUEUR du va-et-vient, parcouru de part et d'autre du point
 * posé ici : `motion.ts` reçoit donc des bornes à plus ou moins la moitié, ce
 * qui fait que changer `span` n'a jamais besoin de corriger l'azimut.
 */
export interface Creature {
  /** Les motifs de la boucle, dans l'ordre. */
  readonly frames: readonly string[];
  readonly hz: number;
  readonly azimuth: number;
  readonly radius: number;
  /** Mètres entre le sol et le BAS de l'objet, comme partout ici. */
  readonly standing: number;
  readonly motion:
    | { readonly kind: 'patrol'; readonly span: number; readonly speed: number }
    | {
        readonly kind: 'piranha';
        readonly period: number;
        readonly outFor: number;
        readonly travel: number;
        readonly rise: number;
      };
}

export function creatures(): readonly Creature[] {
  return [
    {
      frames: ['goombaA', 'goombaB'],
      hz: 8,
      azimuth: at(2.6),
      radius: RINGS.creatures,
      standing: 0,
      motion: { kind: 'patrol', span: 3, speed: 0.9 }
    },
    {
      frames: ['goombaA', 'goombaB'],
      hz: 8,
      azimuth: at(8.9),
      radius: RINGS.creatures,
      standing: 0,
      motion: { kind: 'patrol', span: 3, speed: 0.9 }
    },
    /*
     * La plante sort du tuyau posé au MÊME azimut par `props()`, et le test de
     * placement tient cette égalité. Elle a déjà failli se perdre : le tuyau
     * de devant est passé de at(1.1) à at(3.2) pour sortir de l'ombre de
     * l'écran, et le plan, écrit avant, disait encore at(1.1).
     */
    {
      frames: ['piranhaClosed', 'piranhaOpen'],
      hz: 4,
      azimuth: at(3.2),
      radius: RINGS.pipes,
      standing: 1.4,
      /*
       * `travel` n'est pas un réglage de goût : la lèvre du tuyau culmine à
       * 2,0 m du sol et la tête part de 1,4 m, donc au-delà de 0,6 m sa base
       * quitte la lèvre et la tête plane, détachée, avec du ciel dessous. Vu
       * dans le casque à 1,1 m, et c'est le test de placement qui le tient
       * maintenant. C'est aussi ce qui rend toute tige inutile.
       */
      motion: { kind: 'piranha', period: 6, outFor: 2.4, travel: 0.6, rise: 0.4 }
    }
  ];
}
