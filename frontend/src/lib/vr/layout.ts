/**
 * Every distance and angle in the VR scene, in one three-free module.
 *
 * None of these numbers is measured. They are reasoned starting points, and the
 * only way to settle them is to put a headset on: that is precisely why they
 * live apart from anything that draws, so tuning them is a one-file change.
 *
 * The layout is the "cockpit" of the three that were considered. The screen is
 * a wide arc at 2.5 m; the two lecterns are much nearer, lower, and yawed
 * inward. That nearness is the entire reason this shape won - legibility
 * follows angular distance, not panel size, so a cover grid on a 3 m arc is
 * unreadable however large the panel is.
 *
 * Coordinates are three.js's: the player stands at the origin looking down -Z,
 * +X to their right, +Y up.
 */

import { aspectRatioOf, type PixelAspect } from '$lib/znet/fit';
import { screenWidth } from './screen-geometry';
import type { ScreenShape } from './screen-shape';
import type { PanelSize } from './panel';

export interface Placement {
  position: [number, number, number];
  /** Radians, `[pitch, yaw, 0]`. Negative pitch tips the top away from the
   * player, turning a lowered panel's face up toward the eyes. */
  rotation: [number, number, number];
  /** Metres. */
  width: number;
  height: number;
}

export interface ScreenPlacement {
  /** Metres from the eye to the centre of the picture. The cylinder's radius
   *  when curved, the plane's depth when flat. */
  distance: number;
  /** Radians of horizontal field of view the picture covers, whatever its
   *  shape. `screen-geometry.ts` turns that into a width. */
  arc: number;
  height: number;
  centerY: number;
  curved: boolean;
}

export interface SceneLayout {
  screen: ScreenPlacement;
  library: Placement;
  friends: Placement;
  profile: Placement;
  /** Les menus d'options, devant l'écran. Voir les constantes ci-dessus. */
  tablet: Placement;
}

/*
 * Every y here is measured from the player's eyes, not from the floor.
 *
 * That follows from the reference space: `xr-session.ts` asks for `local`
 * only, whose origin is the head's pose when the session opens, so y = 0 is
 * eye level. It used to ask for `local-floor` and place everything from a
 * guessed 1.6 m eye height, which was wrong for anybody sitting down - and
 * which the old `local` fallback would have hung a full 1.6 m overhead.
 *
 * There is no height left to guess: the scene is placed where the head
 * actually was.
 */

/**
 * The horizontal radius, not the distance - `eyeDistance` is the distance.
 *
 * Brought in from 1.2 with the width taken up to 0.95 at the same time. The
 * two together are what carried the lecterns from 30.5 degrees of view to
 * 44.8, because 30.5 was measured and reported as too small to read without
 * leaning in. Neither constant alone gets there without going somewhere
 * uncomfortable: the panel would have to reach 1.0 m across to do it from
 * 1.2 m, or sit at 0.8 m to do it at its old size.
 */
const LECTERN_DISTANCE = 1.06;
/** 60 degrees off centre: peripheral, so it is not in the way, but reachable by
 * a glance rather than a turn of the whole body. */
const LECTERN_AZIMUTH = Math.PI / 3;
/** How far below the eyes the lecterns hang. */
const LECTERN_DROP = 0.45;
/** 40 degrees, tipped back so a lowered panel faces raised eyes. */
const LECTERN_PITCH = -(Math.PI * 40) / 180;
const LECTERN_WIDTH = 0.95;
/**
 * 0.95 / (1120 / 840), and the division is the point.
 *
 * `panel-mesh.ts` maps the whole canvas onto the whole plane, uv 0..1 on both
 * axes, so a lectern whose metres are not the shape of its canvas stretches
 * every glyph on it. It was once 0.5 against an 800 x 600 canvas, which is
 * 1.40 over 1.3333: five per cent too wide, everywhere, invisible as a defect
 * and quietly wrong. `vr-layout.test.ts` holds the two numbers together from
 * now on, which is what makes changing either safe.
 */
const LECTERN_HEIGHT = 0.7125;

const BAND_DISTANCE = 1.0;
const BAND_DROP = 0.75;
const BAND_PITCH = -(Math.PI * 55) / 180;
/*
 * La tablette : les menus d'options, à leur propre profondeur.
 *
 * Chaque nombre est déduit, pas choisi. 1,12 / 0,84 = 4/3 parce que c'est la
 * forme du canvas de `panels/controls.ts` (1024 x 768), et un panneau qui n'a
 * pas la forme de son canvas étire tout son texte. 1,5 m parce que son centre
 * est alors à 1,540 m des yeux, qu'elle occupe 40,0 degrés, et que 1024/40,0
 * donne 25,6 pixels de canvas par degré contre les 25 du Quest 3.
 *
 * L'écran est à 2,5 m : il reste un mètre franc entre les deux surfaces, et
 * c'est cette séparation qui fait que « flottant devant l'écran » veut dire
 * quelque chose.
 *
 * La descente de 0,35 m est un arbitrage chiffré, et choisi contre deux
 * autres. L'image du jeu occupe -21,4 à +21,4 degrés et la tablette -28,4 à
 * +2,1 : elle couvre 55 % de l'image et en laisse 45 % au-dessus d'elle. Plus
 * bas elle couvrirait moins - 42 % à 0,50 m - mais son bord bas passerait
 * derrière le bandeau, qui est plus proche. Plus haut elle dégagerait le
 * bandeau et mangerait l'image : 64 % à 0,25 m. 0,35 m est le premier cran où
 * la marge au-dessus du bandeau est réelle plutôt que rasante.
 *
 * Flotter devant l'écran implique d'en masquer une part. La demande était que
 * le jeu reste SUR l'écran de jeu, pas qu'on le voie entièrement.
 */
const TABLET_DISTANCE = 1.5;
const TABLET_DROP = 0.35;
const TABLET_WIDTH = 1.12;
const TABLET_HEIGHT = TABLET_WIDTH / (1024 / 768);
/** L'élévation de son propre centre, donc elle fait face au regard. */
const TABLET_PITCH = -Math.atan(TABLET_DROP / TABLET_DISTANCE);

const BAND_WIDTH = 0.9;
const BAND_HEIGHT = 0.3;

/**
 * A lectern at `azimuth`, facing the player.
 *
 * The yaw is the negative of the azimuth: a plane's normal starts at +Z, and
 * rotating by -azimuth about Y turns it back toward the origin. Getting the
 * sign wrong here shows the player the back of an invisible panel, which reads
 * as "the panel did not load".
 */
function lectern(azimuth: number): Placement {
  return {
    position: [
      LECTERN_DISTANCE * Math.sin(azimuth),
      -LECTERN_DROP,
      -LECTERN_DISTANCE * Math.cos(azimuth)
    ],
    rotation: [LECTERN_PITCH, -azimuth, 0],
    width: LECTERN_WIDTH,
    height: LECTERN_HEIGHT
  };
}

/**
 * The distance at which the size setting is also the size seen.
 *
 * The size is nominal, like a television's inches: `shape.angle` is the angle
 * the picture covers WHEN it sits here, and the width in metres that implies
 * follows it everywhere else. Reading the setting at the chosen distance
 * instead - which is what the first version did - kept the angle constant and
 * scaled the object, so the distance setting changed nothing that could be
 * seen. `screen-shape.ts` tells that story with the measurements.
 *
 * 2.5 m because that is what shipped: at the default the two readings agree to
 * the last decimal, so no player's screen moves for this correction.
 *
 * Exportée depuis que `decor/composition.ts` calcule la portée maximale de
 * l'écran : c'est la distance à laquelle `screenPlacement` lit la taille, donc
 * la recopier là-bas ferait deux vérités pour un seul nombre.
 */
export const SIZE_REFERENCE_DISTANCE = 2.5;

/**
 * Where the screen is, from what the player chose.
 *
 * Its own function because it is the only placement that changes during a
 * session: `scene.reshapeScreen` re-runs THIS rather than `sceneLayout`, so
 * the panels are not re-placed for a screen setting - and so the two paths
 * cannot drift into placing the screen differently.
 *
 * The width comes from `screenWidth` rather than being computed here, because
 * a flat screen covering the same angle is about 10 % wider than a curved one
 * (its edges are further from the eye). Dividing the wrong width by the aspect
 * ratio would stretch a flat picture vertically - and that reads as a decoding
 * bug, nowhere near the layout.
 */
export function screenPlacement(aspect: PixelAspect, shape: ScreenShape): ScreenPlacement {
  const nominalArc = (shape.angle * Math.PI) / 180;
  // Fixed in metres, whatever the distance. This one line is the correction.
  const width = screenWidth(SIZE_REFERENCE_DISTANCE, nominalArc, shape.curved);

  /*
   * The angle that width actually covers from where the player put it.
   *
   * Two formulas because two shapes, and they are the inverses of
   * `screenWidth`: a curved picture IS its arc, so it covers `width /
   * distance`; a flat one is a chord, so it covers `2 atan(width / 2d)`. Both
   * give back `nominalArc` at the reference distance, which is what makes the
   * setting honest there and only there - `vr-layout.test.ts` says why no
   * parametrisation can make it honest everywhere for both shapes at once.
   */
  const arc = shape.curved
    ? width / shape.distance
    : 2 * Math.atan(width / (2 * shape.distance));

  return {
    distance: shape.distance,
    arc,
    curved: shape.curved,
    height: width / aspectRatioOf(aspect),
    // Straight ahead by default, and the player's own offset from there. Eye
    // level is where the head was at the last recentre, which is not where the
    // player is once they have sat down or stretched - see `SCREEN_HEIGHTS`.
    centerY: shape.height
  };
}

/**
 * The whole scene, for a screen the player may have moved.
 *
 * The shape is a required argument rather than a defaulted one on purpose: an
 * omitted screen setting would silently give the caller the shipped geometry,
 * which is exactly the bug that would leave a player's choice applied to the
 * mesh and not to the layout the pointer is tested against.
 *
 * Only the screen listens to it. The tablet in particular does NOT follow the
 * screen: it stays at 1.5 m whatever the player chose, which is what keeps its
 * angular size - tuned by looking at renders - and its distance from the band
 * fixed. That works because the nearest rung is 2.0 m; the parallax gap it
 * leaves is what `screen-shape.ts` documents as the reason for that floor.
 */
export function sceneLayout(aspect: PixelAspect, shape: ScreenShape): SceneLayout {
  return {
    screen: screenPlacement(aspect, shape),
    library: lectern(-LECTERN_AZIMUTH),
    friends: lectern(LECTERN_AZIMUTH),
    profile: {
      position: [0, -BAND_DROP, -BAND_DISTANCE],
      rotation: [BAND_PITCH, 0, 0],
      width: BAND_WIDTH,
      height: BAND_HEIGHT
    },
    tablet: {
      position: [0, -TABLET_DROP, -TABLET_DISTANCE],
      rotation: [TABLET_PITCH, 0, 0],
      width: TABLET_WIDTH,
      height: TABLET_HEIGHT
    }
  };
}

/**
 * What a Quest 3 can actually show, in pixels per degree of view.
 *
 * 2064 x 2208 per eye behind a lens that puts roughly 25 pixels into each
 * central degree. It is a device figure, not a measurement of ours, and it is
 * here rather than inline because it is the yardstick every panel's canvas is
 * sized against - see `pixelsPerDegree`.
 */
export const QUEST_3_PIXELS_PER_DEGREE = 25;

/**
 * Metres from the eyes to a panel's centre.
 *
 * NOT `LECTERN_DISTANCE`. That constant is the horizontal radius, and the drop
 * below eye level is the other leg of the triangle: a lectern 1.06 out and
 * 0.45 down is 1.15 away. Computing an angle from the radius alone overstates
 * it by that ratio, which is a mistake already made once on this file.
 */
export function eyeDistance(placement: Placement): number {
  const [x, y, z] = placement.position;
  return Math.hypot(x, y, z);
}

/**
 * How much of the view a panel takes up, in degrees.
 *
 * This is the number legibility answers to, and the reason this module's
 * header calls the cockpit layout the one that won: a panel's size in metres
 * means nothing on its own. Measured across the width, which is the axis the
 * canvases are widest on and the one the text runs along.
 */
export function angularWidth(placement: Placement): number {
  return (2 * Math.atan(placement.width / 2 / eyeDistance(placement)) * 180) / Math.PI;
}

/**
 * A panel's canvas resolution expressed in the same units as the headset's.
 *
 * The two want to be about equal, and both directions of mismatch cost
 * something. Below the display's figure the canvas is the limit: its pixels
 * are magnified, so the text is soft - which is the trap in enlarging a
 * panel's metres and leaving its canvas alone. Far above it the extra pixels
 * are drawn and then thrown away, and they were worse than useless while
 * these textures had mipmaps, because there was no detail beneath the
 * display's reach for a mip level to protect.
 */
export function pixelsPerDegree(placement: Placement, canvas: PanelSize): number {
  return canvas.width / angularWidth(placement);
}

/**
 * Le haut et le bas d'un panneau, en degrés au-dessus de l'horizon.
 *
 * Le tangage compte, et c'est tout l'intérêt : il fait pivoter les deux bords
 * autour du centre, donc un tangage arrière rapproche le bord bas du joueur en
 * même temps qu'il le descend. Deux estimations successives de la marge entre
 * la tablette et le bandeau se sont trouvées fausses pour avoir sauté cette
 * étape, dont une avec le signe inversé - d'où le cas de contrôle du panneau à
 * plat dans `vr-layout.test.ts`, qui est la seule assertion qu'une version
 * signée à l'envers échoue.
 *
 * Seul le tangage est lu. Un lacet ne change rien à une étendue verticale, et
 * aucun panneau de cette scène n'a de roulis - `panel-mesh.ts` explique
 * pourquoi son ordre de rotation est `YXZ` précisément pour qu'il n'y en ait
 * pas.
 */
export function verticalSpan(placement: Placement): { top: number; bottom: number } {
  const [, y, z] = placement.position;
  const [pitch] = placement.rotation;
  const half = placement.height / 2;

  /*
   * Le vecteur « haut » du panneau après son tangage.
   *
   * Une rotation d'angle p autour de X envoie (0,1,0) sur (0, cos p, sin p).
   * Le signe de la composante z est ce qui s'est trompé une fois : avec p
   * négatif elle est négative, donc le bord haut s'ÉLOIGNE du joueur, ce que
   * le cas du panneau à plat face au ciel vérifie sans ambiguïté.
   */
  const upY = half * Math.cos(pitch);
  const upZ = half * Math.sin(pitch);

  const angle = (dy: number, dz: number) =>
    (Math.atan2(y + dy, -(z + dz)) * 180) / Math.PI;

  return { top: angle(upY, upZ), bottom: angle(-upY, -upZ) };
}

/**
 * Le comptoir qui porte les trois pupitres.
 *
 * Rien ici n'est un choix de composition : chaque tronçon se déduit du panneau
 * qu'il porte. C'est ce qui rend l'écart IMPOSSIBLE plutôt que surveillé -
 * déplacer un pupitre déplace son bloc, et aucune position n'est écrite deux
 * fois.
 *
 * Ce module ne connaît ni three ni `decor/`, et ne doit pas les connaître :
 * `decor/composition.ts` importe déjà `SIZE_REFERENCE_DISTANCE` d'ici, donc la
 * dépendance inverse ferait un cycle.
 */

/**
 * Un bloc fait un mètre de large.
 *
 * Déclaré ici parce que c'est une décision de composition - le comptoir est
 * pavé de blocs d'un mètre, comme un mur de Mario - mais l'art doit s'y
 * conformer, et `vr-decor-art.test.ts` tient les deux ensemble.
 */
export const COUNTER_BLOCK_WIDTH = 1;

/**
 * La profondeur du plateau, comptée depuis le bord bas du panneau en
 * S'ÉLOIGNANT du joueur : c'est la largeur de plateau qu'il voit.
 *
 * Le seul nombre libre de tout le comptoir. Tout le reste est dérivé.
 */
export const COUNTER_DEPTH = 0.35;

export interface CounterRun {
  /** Le centre de la face du DESSUS, en mètres depuis l'œil. */
  readonly top: [number, number, number];
  /**
   * L'azimut vers lequel la face avant regarde - PAS celui où le bloc est
   * posé. `boxYaw` (`decor/box.ts`) en tire le lacet, pour que le piège
   * +Z/-Z reste enfermé à un seul endroit du dépôt.
   */
  readonly facing: number;
}

/**
 * Le milieu du bord bas d'un panneau, en mètres depuis l'œil.
 *
 * `verticalSpan` fait la même rotation plus haut mais rend des ANGLES et
 * ignore le lacet, d'où cette seconde fonction plutôt qu'un partage forcé. Son
 * commentaire vaut ici : le signe de la composante z est ce qui se trompe, et
 * avec un tangage négatif elle est POSITIVE, donc le bord bas se rapproche du
 * joueur.
 */
function bottomEdge(placement: Placement): [number, number, number] {
  const [x, y, z] = placement.position;
  const [pitch, yaw] = placement.rotation;
  const half = placement.height / 2;
  const downY = -half * Math.cos(pitch);
  const downZ = -half * Math.sin(pitch);
  return [x + downZ * Math.sin(yaw), y + downY, z + downZ * Math.cos(yaw)];
}

/**
 * Les trois tronçons, dans l'ordre du tour : gauche, fond, droite.
 *
 * L'ordre n'est pas cosmétique - le test de continuité compare les voisins
 * deux à deux, et il n'a de sens que si la liste suit le U.
 */
export function counterRuns(layout: SceneLayout): readonly CounterRun[] {
  return [layout.library, layout.profile, layout.friends].map((panel) => ({
    top: bottomEdge(panel),
    facing: -panel.rotation[1]
  }));
}
