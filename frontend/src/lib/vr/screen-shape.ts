/**
 * Où est l'écran, quelle taille il fait, à quelle hauteur, et s'il est courbe.
 *
 * Quatre réglages, et le modèle est celui d'une télévision dans une pièce : la
 * taille est une taille d'objet, la distance et la hauteur disent où cet objet
 * est posé. C'est la deuxième version de ce modèle, et la première mérite
 * d'être racontée parce que son échec ne se voyait pas en la lisant.
 *
 * La première tenait la taille ANGULAIRE constante d'un cran de distance à
 * l'autre - l'écran est un segment de cylindre, sa largeur suit son rayon,
 * donc reculer un arc d'angle fixe ne le rapetisse pas d'un degré. C'était
 * cohérent et inutilisable. Depuis le casque : « la distance ne règle pas la
 * distance mais la hauteur, et pas en m mais en cm », et les deux moitiés de
 * ce rapport sont justes. La taille ne changeait pas d'un dixième de degré,
 * donc le réglage ne se voyait pas ; et la largeur PHYSIQUE, elle, passait de
 * 2,09 à 4,50 m, ce qui faisait monter le bord haut de l'image de 90 cm.
 * L'écran se dilatait autour de l'origine de la session - le point où était la
 * tête au dernier recentrage - et jamais autour de l'œil, qui n'y est plus dès
 * que le joueur s'est redressé. Vu de 20 cm plus haut, presser Distance
 * dérivait l'image de 3 degrés vers le haut et ne faisait rien d'autre.
 * Mesuré, pas déduit.
 *
 * La taille est donc physique, nominale à 2,5 m : `angle` est l'angle couvert
 * QUAND l'écran est à cette distance, et la largeur en mètres que ça implique
 * le suit où qu'on le mette. Reculer rapetisse, s'approcher grossit, et la
 * hauteur ne fait que monter ou descendre.
 *
 * Des crans, pas des curseurs : le pointeur est un laser tenu à bout de bras,
 * et viser un bouton est franc là où faire glisser une poignée ne l'est pas.
 * Les bouts BUTENT au lieu de boucler - passer de 4,3 m à 2,0 m pour un clic
 * de trop sur « + » enverrait l'écran à la figure du joueur.
 *
 * La borne basse à 2,0 m n'est pas un goût, et elle n'est pas non plus le
 * simple fait que la tablette des options soit à 1,54 m des yeux. Il faut de
 * la SÉPARATION en plus de l'ordre : `vr-layout.test.ts` tient depuis la
 * tablette que « sans séparation il n'y a pas de parallaxe, donc pas d'effet
 * flottant ». 2,0 m laisse 46 cm devant elle. Un écran collé à la tablette
 * l'avalerait sans que rien dans le rendu ne dise pourquoi.
 *
 * La discipline de stockage est celle de `pad-map.ts`, qui la tient de
 * `stores/shader-preference.ts` : le défaut est RETIRÉ plutôt qu'écrit, et
 * tout ce qui est illisible - ou hors échelle, ce qui inclut un écran à trente
 * centimètres des yeux dont le joueur ne pourrait pas sortir - est retiré
 * plutôt que gardé.
 */

import type { PreferenceStorage } from '$lib/stores/shader-preference';

export interface ScreenShape {
  /** Mètres, des yeux au centre de l'image. */
  distance: number;
  /**
   * La taille, en degrés de champ de vision couverts À 2,5 M.
   *
   * Nominale, comme les pouces d'une télévision : elle dit la taille de
   * l'objet, pas la place qu'il prend dans le regard depuis le canapé. C'est
   * `layout.ts` qui en tire une largeur en mètres, une fois pour toutes.
   */
  angle: number;
  /** Mètres au-dessus (positif) ou en dessous du niveau des yeux. */
  height: number;
  curved: boolean;
}

/**
 * Les cinq distances.
 *
 * 2,0 est la borne de parallaxe (voir l'en-tête), 4,3 est là où l'image cesse
 * de donner une impression de profondeur - au-delà, les deux yeux voient
 * presque la même chose et l'écran redevient une affiche.
 *
 * L'angle étant le réglage de taille, reculer d'un cran n'enlève rien à
 * l'image : elle grandit en mètres d'autant qu'elle s'éloigne. Ce que ces cinq
 * crans changent est la convergence des yeux et la profondeur ressentie, pas
 * la taille apparente.
 */
export const SCREEN_DISTANCES: readonly number[] = [2.0, 2.5, 3.0, 3.6, 4.3];

/**
 * Les cinq tailles, en degrés.
 *
 * 45 est un moniteur posé sur un bureau, 80 est un écran de cinéma dont les
 * bords tombent en périphérie. Au-delà, les bords passeraient derrière les
 * pommettes du joueur - la raison que `layout.ts` donnait déjà pour arrêter
 * l'arc d'origine à 60.
 */
export const SCREEN_ANGLES: readonly number[] = [45, 52, 60, 70, 80];

/**
 * Les cinq hauteurs, en mètres depuis le niveau des yeux.
 *
 * Demandées depuis le casque, et pour une raison que le modèle ne pouvait pas
 * deviner : le zéro est la hauteur de la tête au dernier recentrage, donc un
 * joueur assis bas, allongé, ou qui a recentré debout n'avait aucun moyen de
 * remettre l'image devant ses yeux sans recentrer à nouveau dans la bonne
 * posture.
 *
 * Plus ou moins 40 cm, soit environ 9 degrés à la distance de référence. Assez
 * pour rattraper une posture, trop peu pour envoyer l'image hors du champ - et
 * l'écran garde sa taille, la hauteur n'étant pas un deuxième réglage de
 * taille.
 */
export const SCREEN_HEIGHTS: readonly number[] = [-0.4, -0.2, 0, 0.2, 0.4];

/**
 * Exactement la géométrie livrée avant ce réglage.
 *
 * `SCREEN_RADIUS = 2.5` et `SCREEN_ARC = Math.PI / 3` dans `layout.ts`, et un
 * écran qui a toujours été courbe. Un défaut qui différerait d'un centimètre
 * déplacerait l'écran de tous les joueurs qui n'ont rien demandé.
 */
export const DEFAULT_SHAPE: ScreenShape = {
  distance: 2.5,
  angle: 60,
  height: 0,
  curved: true
};

export const SCREEN_SHAPE_KEY = 'psnes-vr-screen';

/** L'indice du cran, ou celui du défaut si la valeur n'en est pas un. */
function rung(ladder: readonly number[], value: number, fallback: number): number {
  const index = ladder.indexOf(value);
  return index === -1 ? ladder.indexOf(fallback) : index;
}

function stepped(
  ladder: readonly number[],
  value: number,
  fallback: number,
  by: 1 | -1
): number {
  const next = rung(ladder, value, fallback) + by;
  // Buté, pas bouclé. Voir l'en-tête.
  if (next < 0 || next >= ladder.length) return value;
  return ladder[next];
}

export function stepDistance(shape: ScreenShape, by: 1 | -1): ScreenShape {
  return {
    ...shape,
    distance: stepped(SCREEN_DISTANCES, shape.distance, DEFAULT_SHAPE.distance, by)
  };
}

export function stepAngle(shape: ScreenShape, by: 1 | -1): ScreenShape {
  return {
    ...shape,
    angle: stepped(SCREEN_ANGLES, shape.angle, DEFAULT_SHAPE.angle, by)
  };
}

export function stepHeight(shape: ScreenShape, by: 1 | -1): ScreenShape {
  return {
    ...shape,
    height: stepped(SCREEN_HEIGHTS, shape.height, DEFAULT_SHAPE.height, by)
  };
}

/** Le cran occupé sur chaque échelle, pour dessiner la position et savoir
 *  quel bout est atteint. */
export function shapeRungs(
  shape: ScreenShape
): { distance: number; angle: number; height: number } {
  return {
    distance: rung(SCREEN_DISTANCES, shape.distance, DEFAULT_SHAPE.distance),
    angle: rung(SCREEN_ANGLES, shape.angle, DEFAULT_SHAPE.angle),
    height: rung(SCREEN_HEIGHTS, shape.height, DEFAULT_SHAPE.height)
  };
}

function isValidShape(raw: unknown): raw is ScreenShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const source = raw as Record<string, unknown>;
  if (typeof source.curved !== 'boolean') return false;
  if (typeof source.distance !== 'number' || typeof source.angle !== 'number') return false;
  if (typeof source.height !== 'number') return false;
  // Sur l'échelle, pas seulement dans la plage : les crans sont ce que
  // l'interface sait dessiner et ce que « + » sait parcourir, donc une valeur
  // intermédiaire serait un état dont le joueur ne pourrait pas bouger sans
  // d'abord passer par un cran voisin.
  return (
    SCREEN_DISTANCES.includes(source.distance) &&
    SCREEN_ANGLES.includes(source.angle) &&
    SCREEN_HEIGHTS.includes(source.height)
  );
}

function sameShape(a: ScreenShape, b: ScreenShape): boolean {
  return (
    a.distance === b.distance &&
    a.angle === b.angle &&
    a.height === b.height &&
    a.curved === b.curved
  );
}

export function readScreenShape(storage: PreferenceStorage): ScreenShape {
  const stored = storage.getItem(SCREEN_SHAPE_KEY);
  if (!stored) return DEFAULT_SHAPE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    storage.removeItem(SCREEN_SHAPE_KEY);
    return DEFAULT_SHAPE;
  }

  /*
   * Une forme sans hauteur est une forme d'avant ce réglage, pas une forme
   * illisible.
   *
   * Elle est complétée plutôt que jetée : zéro est exactement ce que ce joueur
   * avait, et lui reprendre sa distance et sa taille pour un champ qui
   * n'existait pas encore serait gratuit.
   */
  if (parsed && typeof parsed === 'object' && !('height' in parsed)) {
    (parsed as Record<string, unknown>).height = DEFAULT_SHAPE.height;
  }

  if (!isValidShape(parsed)) {
    storage.removeItem(SCREEN_SHAPE_KEY);
    return DEFAULT_SHAPE;
  }

  // Reconstruite plutôt que rendue telle quelle, comme `readPadMap` : l'objet
  // parsé peut porter des clés en plus, et rien en aval ne doit s'en soucier.
  return {
    distance: parsed.distance,
    angle: parsed.angle,
    height: parsed.height,
    curved: parsed.curved
  };
}

export function writeScreenShape(storage: PreferenceStorage, shape: ScreenShape): void {
  if (!isValidShape(shape)) return;
  if (sameShape(shape, DEFAULT_SHAPE)) {
    storage.removeItem(SCREEN_SHAPE_KEY);
    return;
  }
  storage.setItem(SCREEN_SHAPE_KEY, JSON.stringify(shape));
}
