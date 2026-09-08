/**
 * Où est l'écran, quelle part du regard il remplit, et s'il est courbe.
 *
 * Trois réglages, et le deuxième explique pourquoi ils sont trois plutôt que
 * deux. L'écran est un segment de cylindre dont l'ARC est le réglage de
 * taille : sa largeur en mètres suit son rayon, donc le reculer ne le fait pas
 * paraître plus petit d'un seul degré. Une « taille » en mètres serait donc le
 * même réglage que la distance, exprimé deux fois. En angle, les deux axes
 * sont indépendants : la distance décide du confort de convergence et de la
 * profondeur ressentie, l'angle décide de combien de champ de vision l'image
 * occupe.
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
  /** Degrés de champ de vision horizontal que l'image couvre. */
  angle: number;
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
 * Exactement la géométrie livrée avant ce réglage.
 *
 * `SCREEN_RADIUS = 2.5` et `SCREEN_ARC = Math.PI / 3` dans `layout.ts`, et un
 * écran qui a toujours été courbe. Un défaut qui différerait d'un centimètre
 * déplacerait l'écran de tous les joueurs qui n'ont rien demandé.
 */
export const DEFAULT_SHAPE: ScreenShape = { distance: 2.5, angle: 60, curved: true };

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

/** Le cran occupé sur chaque échelle, pour dessiner la position et savoir
 *  quel bout est atteint. */
export function shapeRungs(shape: ScreenShape): { distance: number; angle: number } {
  return {
    distance: rung(SCREEN_DISTANCES, shape.distance, DEFAULT_SHAPE.distance),
    angle: rung(SCREEN_ANGLES, shape.angle, DEFAULT_SHAPE.angle)
  };
}

function isValidShape(raw: unknown): raw is ScreenShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const source = raw as Record<string, unknown>;
  if (typeof source.curved !== 'boolean') return false;
  if (typeof source.distance !== 'number' || typeof source.angle !== 'number') return false;
  // Sur l'échelle, pas seulement dans la plage : les crans sont ce que
  // l'interface sait dessiner et ce que « + » sait parcourir, donc une valeur
  // intermédiaire serait un état dont le joueur ne pourrait pas bouger sans
  // d'abord passer par un cran voisin.
  return SCREEN_DISTANCES.includes(source.distance) && SCREEN_ANGLES.includes(source.angle);
}

function sameShape(a: ScreenShape, b: ScreenShape): boolean {
  return a.distance === b.distance && a.angle === b.angle && a.curved === b.curved;
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

  if (!isValidShape(parsed)) {
    storage.removeItem(SCREEN_SHAPE_KEY);
    return DEFAULT_SHAPE;
  }

  // Reconstruite plutôt que rendue telle quelle, comme `readPadMap` : l'objet
  // parsé peut porter des clés en plus, et rien en aval ne doit s'en soucier.
  return { distance: parsed.distance, angle: parsed.angle, curved: parsed.curved };
}

export function writeScreenShape(storage: PreferenceStorage, shape: ScreenShape): void {
  if (!isValidShape(shape)) return;
  if (sameShape(shape, DEFAULT_SHAPE)) {
    storage.removeItem(SCREEN_SHAPE_KEY);
    return;
  }
  storage.setItem(SCREEN_SHAPE_KEY, JSON.stringify(shape));
}
