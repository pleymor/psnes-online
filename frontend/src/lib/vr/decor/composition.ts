/**
 * Toutes les profondeurs du décor, dans un module sans three.
 *
 * Le pendant exact de `layout.ts`, et pour la même raison : sans casque et
 * sans GPU sous Bun, la seule façon de tenir une géométrie responsable est de
 * la sortir du code qui dessine. `layout.ts` a attrapé deux erreurs de signe
 * grâce à cette séparation.
 *
 * Coordonnées de three, comme `layout.ts` : le joueur à l'origine regardant
 * -Z, +X à sa droite, +Y en haut. Mais à une différence près qui est tout
 * l'objet de `scene.ts`'s groupe `room` : ici, y = 0 est la hauteur de
 * référence de la session, PAS la tête au dernier recentrage. Le sol s'y place
 * à `-floorHeight` et n'en bouge plus.
 */
import { SCREEN_DISTANCES, SCREEN_ANGLES, SCREEN_HEIGHTS } from '../screen-shape';
import { screenWidth } from '../screen-geometry';
import { SIZE_REFERENCE_DISTANCE } from '../layout';
import { aspectRatioOf, type PixelAspect } from '$lib/znet/fit';

/** Seize pixels d'art par mètre : la résolution native d'une tuile SMB. */
export const ART_PIXELS_PER_METRE = 16;

/**
 * Combien de fois la tuile du sol se répète d'un bord à l'autre du disque.
 *
 * Les uv d'un `CircleGeometry` couvrent 0..1 d'un bord à l'autre, donc c'est
 * le DIAMÈTRE en mètres - une tuile par mètre. Ici plutôt que dans `build.ts`
 * parce que c'est la même affirmation que `ART_PIXELS_PER_METRE`, et que deux
 * énoncés d'un même fait dérivent tôt ou tard.
 */
export function floorRepeat(): number {
  return SKY_RADIUS * 2;
}

/** La couleur de fond de `scene.ts`. Le rideau la porte aussi, pour que la
 *  fin du fondu soit exactement la salle noire d'aujourd'hui - une seule
 *  déclaration plutôt que le même littéral recopié à 3000 lignes de distance. */
export const ROOM_DARK = 0x0a0a12;

/** Le `far` de la `PerspectiveCamera` de `scene.ts`. Partagé pour que le test
 *  qui vérifie que le ciel tient dessous ne porte pas sa propre copie du
 *  nombre qu'il garde. */
export const CAMERA_FAR = 50;

/** Sous les yeux, en mètres, quand le casque refuse de dire où est le sol. */
export const FLOOR_FALLBACK = 1.2;

export const SKY_RADIUS = 30;
export const CURTAIN_RADIUS = 5.5;
/** Ce qui doit rester libre entre le coin le plus lointain de l'écran et le
 *  rideau. Pas une tolérance numérique : de la place pour que le joueur voie
 *  l'écran se détacher du noir plutôt que le raser. */
export const CURTAIN_MARGIN = 0.15;

/**
 * De combien les deux origines de la scène peuvent s'écarter verticalement.
 *
 * Le rideau vit dans le groupe `world`, centré sur l'ancre - comme les
 * panneaux, et c'est nécessaire : son dégagement intérieur est mesuré contre
 * l'écran, qui est ancré lui aussi. Le décor vit dans le groupe `room`, dont
 * le `y` ne suit PAS l'ancre, sans quoi le sol monterait avec le joueur.
 *
 * Les deux origines coïncident au premier recentrage et s'écartent à chacun
 * des suivants, de la différence de hauteur de tête - jouer assis puis se
 * lever et recentrer. Huit dixièmes de mètre couvre largement ce trajet.
 *
 * Ce que la réserve empêche est précis : sans elle, un décor à six mètres de
 * l'origine de `room` peut se retrouver à moins de cinq mètres et demi de
 * l'origine de `world`, donc DEVANT un rideau qui est censé le cacher - et
 * réapparaître au milieu d'une partie.
 */
export const ANCHOR_DRIFT = 0.8;

export const DECOR_NEAR = 6.5;
export const FADE_SECONDS = 0.4;

/** Le rayon de chaque famille d'objets. Voir la spec, §4.4. */
export const RINGS = {
  /** Blocs `?`, briques, pièces. */
  props: 7,
  pipes: 9,
  creatures: 12,
  clouds: 15,
  hills: 20,
  sky: SKY_RADIUS
} as const;

const ASPECTS: readonly PixelAspect[] = ['crt', 'square'];

/**
 * La distance du point de l'écran le plus éloigné de l'œil, sur TOUS les
 * réglages possibles.
 *
 * C'est le nombre dont dépend le rayon du rideau, et il n'est pas devinable :
 * l'écran est réglable en distance, en angle, en hauteur, en forme et en
 * rapport de pixel, soit cinq cents combinaisons (5×5×5×2×2). Calculé plutôt
 * que constaté, pour qu'un sixième cran de distance fasse rougir le test au
 * lieu de masquer silencieusement l'image du jeu.
 *
 * Deux pièges déjà payés, tous deux dans le sens dangereux :
 *
 * - **La largeur se lit à la distance de RÉFÉRENCE, pas à celle du joueur.**
 *   C'est la correction que `layout.ts` documente : la taille est nominale,
 *   comme les pouces d'un téléviseur, donc `screenWidth` prend
 *   `SIZE_REFERENCE_DISTANCE` et la distance choisie n'agit que sur le
 *   placement.
 * - **Le plus PETIT rapport de pixel donne le coin le plus lointain.**
 *   `aspectRatioOf` rend 4/3 en `crt` mais 8/7 en `square`, et la hauteur vaut
 *   largeur / rapport : les pixels carrés donnent donc l'écran le plus haut.
 *   Ne mesurer que le crt sous-estime de onze centimètres.
 */
export function screenReach(): number {
  let worst = 0;
  for (const distance of SCREEN_DISTANCES)
    for (const angle of SCREEN_ANGLES)
      for (const height of SCREEN_HEIGHTS)
        for (const curved of [true, false])
          for (const aspect of ASPECTS) {
            const arc = (angle * Math.PI) / 180;
            const width = screenWidth(SIZE_REFERENCE_DISTANCE, arc, curved);
            const halfHeight = width / aspectRatioOf(aspect) / 2;
            const top = Math.abs(height) + halfHeight;
            // Un écran courbe est un cylindre : tous ses points sont à la même
            // distance horizontale. Un écran plat est une corde, donc ses coins
            // s'éloignent de la moitié de sa largeur.
            const far = curved
              ? Math.hypot(distance, top)
              : Math.hypot(width / 2, top, distance);
            if (far > worst) worst = far;
          }
  return worst;
}
