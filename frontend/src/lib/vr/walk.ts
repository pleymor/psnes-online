/**
 * Marcher de quelques pas au stick, dans un module sans three.
 *
 * Le pendant de `layout.ts` et de `decor/composition.ts` pour le déplacement :
 * tout ce qui se décide est ici, testable sous Bun, et `scene.ts` ne fait
 * qu'appliquer le résultat.
 *
 * CE QUE CETTE FONCTION NE SAIT PAS, ET C'EST VOULU : aucune convention de
 * repère. Elle reçoit l'avant et la droite de la caméra tout faits plutôt
 * qu'un angle, parce que ce dépôt a payé trois erreurs de signe sur des
 * conventions dans la seule journée du 2026-09-11 - les boîtes du décor
 * tournées de 180° parce qu'un quad regarde +Z et une boîte -Z, le bord bas
 * d'un panneau dont la composante z change de signe avec le tangage, la
 * tangente du comptoir. Et surtout : un test qui dériverait l'angle de la même
 * façon que le code serait dupe de la même erreur. Avec deux vecteurs donnés,
 * il ne peut pas l'être.
 *
 * La seule convention qui reste est celle de la manette, et elle est
 * documentée là où elle s'applique : l'axe Y d'un stick est NÉGATIF vers
 * l'avant.
 */

/**
 * Sous ce débattement, le stick est au repos.
 *
 * CE N'EST PAS `XR_AXIS_THRESHOLD`, qui vaut 0,5 et que `pad.ts` partage avec
 * le mode à plat « so a stick feels the same in both modes ». Ce seuil-là
 * répond à une question binaire - la croix est-elle pressée - et un demi-
 * débattement mort sur une marche donnerait un départ en sursaut. Deux
 * questions différentes, deux nombres, et surtout pas un seul partagé.
 */
export const WALK_DEAD_ZONE = 0.15;

/** Mètres par seconde à plein débattement. Trois mètres en deux secondes et
 *  demie : une marche, pas une course. */
export const WALK_SPEED = 1.2;

/**
 * Le rayon du disque où l'on a le droit d'aller.
 *
 * Ce n'est pas une timidité, c'est ce que le monde porte. Le décor est un
 * diorama centré sur le joueur - collines à 20 m, nuages à 15, tuyaux à 9 -
 * et s'en éloigner révèle que c'est une couronne de panneaux plats. Le rideau
 * est une sphère de 5,5 m centrée sur l'ancre. Et le mobilier doit rester à
 * portée, sans quoi le joueur laisse son interface derrière lui.
 */
export const WALK_RADIUS = 3;

export interface WalkInput {
  /** Le décalage courant du monde, en mètres, dans le plan. */
  readonly offset: readonly [number, number];
  /** Les deux axes du stick, bruts. */
  readonly stick: readonly [number, number];
  /** L'avant de la caméra, à plat et normalisé. */
  readonly forward: readonly [number, number];
  /** La droite de la caméra, à plat et normalisée. */
  readonly right: readonly [number, number];
  /** Secondes depuis l'image précédente. */
  readonly dt: number;
}

/** Le décalage après une image. */
export function walk(input: WalkInput): [number, number] {
  const [ox, oz] = input.offset;
  const [sx, sy] = input.stick;

  /*
   * La zone morte s'applique à la LONGUEUR, pas à chaque axe.
   *
   * Par axe, un stick poussé en diagonale à 0,12 sur chacun serait ignoré
   * alors qu'il est clairement poussé ; et deux seuils indépendants font des
   * démarrages en marche d'escalier sur les diagonales.
   */
  const push = Math.hypot(sx, sy);
  if (push <= WALK_DEAD_ZONE) return [ox, oz];

  /*
   * La rampe, et le plafond commun aux deux axes.
   *
   * `push` est borné à 1 AVANT la rampe : un stick lit parfois 1,02 dans les
   * coins, et sans ça la diagonale irait plus vite que l'axe - l'erreur
   * classique de ce genre de code, invisible en lisant et évidente en jouant.
   */
  const reach = Math.min(1, (push - WALK_DEAD_ZONE) / (1 - WALK_DEAD_ZONE));
  const speed = WALK_SPEED * reach * reach;

  // L'axe Y d'un stick est négatif vers l'avant.
  const ax = sx / push;
  const ay = -sy / push;
  const dx = (input.right[0] * ax + input.forward[0] * ay) * speed * input.dt;
  const dz = (input.right[1] * ax + input.forward[1] * ay) * speed * input.dt;

  let x = ox + dx;
  let z = oz + dz;

  /*
   * La borne PROJETTE, elle n'arrête pas.
   *
   * Poussé dans le mur, le joueur glisse le long du bord au lieu de se figer :
   * une butée franche fige les deux axes d'un coup et se sent comme un bug,
   * un glissement se sent comme un mur.
   */
  const out = Math.hypot(x, z);
  if (out > WALK_RADIUS) {
    x = (x / out) * WALK_RADIUS;
    z = (z / out) * WALK_RADIUS;
  }
  return [x, z];
}

/**
 * La vitesse du dernier pas, en mètres par seconde.
 *
 * Sert à la vignette, et rend zéro plutôt qu'un infini quand `dt` est nul -
 * ce qui arrive à la toute première image, où deux horloges ne se sont pas
 * encore parlé.
 */
export function walkSpeed(
  before: readonly [number, number],
  after: readonly [number, number],
  dt: number
): number {
  if (!(dt > 0)) return 0;
  return Math.hypot(after[0] - before[0], after[1] - before[1]) / dt;
}
