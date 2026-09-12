/**
 * Se déplacer et tourner au stick, dans un module sans three.
 *
 * Le pendant de `layout.ts` et de `decor/composition.ts` pour la locomotion :
 * tout ce qui se décide est ici, testable sous Bun, et `scene.ts` ne fait
 * qu'appliquer.
 *
 * TOUT EST INCRÉMENTAL. Ces fonctions rendent le déplacement et la rotation
 * D'UNE IMAGE, jamais un état absolu, et ce n'est pas un détail de style : une
 * rotation se fait autour du joueur, donc autour d'un point qui bouge, et une
 * position absolue recalculée à chaque image ne saurait pas le faire. La
 * locomotion est une matrice que `scene.ts` accumule ; ici on ne produit que
 * les petits pas qu'elle compose.
 *
 * CE QUE CE MODULE NE SAIT PAS, ET C'EST VOULU : aucune convention de repère.
 * Il reçoit l'avant et la droite de la caméra tout faits plutôt qu'un angle,
 * parce que ce dépôt a payé QUATRE erreurs de signe sur des conventions - les
 * boîtes du décor tournées de 180°, le bord bas d'un panneau, la tangente du
 * comptoir, et le monde qui reculait quand le joueur avançait. La quatrième
 * est la plus instructive : la fonction pure était juste, et c'est la jointure
 * qui mentait.
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
 * débattement mort sur une marche donnerait un départ en sursaut.
 */
export const WALK_DEAD_ZONE = 0.15;

/** Mètres par seconde à plein débattement. Une marche, pas une course. */
export const WALK_SPEED = 1.2;

/**
 * Le facteur de la course, bouton B tenu.
 *
 * Deux et pas davantage : la vitesse de défilement en périphérie est ce qui
 * donne la nausée, et elle croît avec ce nombre. 2,4 m/s est un pas vif, pas
 * un sprint - et la vignette s'assombrit d'autant, puisqu'elle suit la
 * vitesse réelle.
 */
export const RUN_FACTOR = 2;

/** Un cran de rotation : trente degrés, soit douze pour un tour. */
export const TURN_STEP = Math.PI / 6;

/** Degrés par seconde en rotation continue, pour qui la préfère. */
export const TURN_SPEED = (Math.PI * 90) / 180;

/**
 * Le débattement qui déclenche un cran, et celui sous lequel il se réarme.
 *
 * Deux seuils et non un : avec un seul, un pouce qui tremble autour de la
 * limite déclencherait une rafale de crans. C'est l'hystérésis, et c'est la
 * même raison qui fait qu'un thermostat n'a pas un seul nombre.
 */
export const TURN_FIRE = 0.7;
export const TURN_REARM = 0.3;

export interface WalkInput {
  /** Les deux axes du stick, bruts. */
  readonly stick: readonly [number, number];
  /** L'avant de la caméra, à plat et normalisé. */
  readonly forward: readonly [number, number];
  /** La droite de la caméra, à plat et normalisée. */
  readonly right: readonly [number, number];
  /** Secondes depuis l'image précédente. */
  readonly dt: number;
  /** Le bouton de course est-il tenu. */
  readonly running?: boolean;
}

/** Le déplacement de CETTE image, en mètres, dans le plan. */
export function walk(input: WalkInput): [number, number] {
  const [sx, sy] = input.stick;

  /*
   * La zone morte s'applique à la LONGUEUR, pas à chaque axe.
   *
   * Par axe, un stick poussé en diagonale à 0,12 sur chacun serait ignoré
   * alors qu'il est clairement poussé ; et deux seuils indépendants font des
   * démarrages en marche d'escalier sur les diagonales.
   */
  const push = Math.hypot(sx, sy);
  if (push <= WALK_DEAD_ZONE) return [0, 0];

  /*
   * La rampe, et le plafond commun aux deux axes.
   *
   * `push` est borné à 1 AVANT la rampe : un stick lit parfois 1,02 dans les
   * coins, et sans ça la diagonale irait plus vite que l'axe - l'erreur
   * classique de ce genre de code, invisible en lisant et évidente en jouant.
   */
  const reach = Math.min(1, (push - WALK_DEAD_ZONE) / (1 - WALK_DEAD_ZONE));
  const speed = WALK_SPEED * reach * reach * (input.running ? RUN_FACTOR : 1);

  // L'axe Y d'un stick est négatif vers l'avant.
  const ax = sx / push;
  const ay = -sy / push;
  return [
    (input.right[0] * ax + input.forward[0] * ay) * speed * input.dt,
    (input.right[1] * ax + input.forward[1] * ay) * speed * input.dt
  ];
}

/** L'état d'un cran : armé ou non. Un cran par poussée, pas une rafale. */
export interface SnapState {
  readonly armed: boolean;
}

export const SNAP_READY: SnapState = { armed: true };

/**
 * Un cran de rotation, si le stick vient d'être poussé.
 *
 * Rend le lacet de cette image - zéro la plupart du temps - et l'état à
 * reporter.
 *
 * LE SIGNE EST CELUI DE THREE, pas celui du pouce. Une rotation positive
 * autour de +Y tourne vers la GAUCHE du joueur, donc pousser le stick à droite
 * doit rendre un lacet NÉGATIF. La première version faisait l'inverse, et le
 * casque l'a dit en quatre mots : « le stick droit est inversé ». C'est la
 * cinquième erreur de signe de ce projet, et la deuxième où le test encodait
 * la faute au lieu de l'attraper - d'où ce paragraphe plutôt qu'une
 * correction muette.
 *
 * Le désarmement, lui, est ce qui fait qu'un stick tenu à fond ne tourne pas en
 * continu : c'est tout l'intérêt du cran, et sans lui on aurait une rotation
 * continue saccadée, soit le pire des deux mondes.
 */
export function snapTurn(stickX: number, state: SnapState): { yaw: number; state: SnapState } {
  const push = Math.abs(stickX);
  if (!state.armed) {
    return { yaw: 0, state: push < TURN_REARM ? SNAP_READY : state };
  }
  if (push < TURN_FIRE) return { yaw: 0, state };
  return { yaw: -Math.sign(stickX) * TURN_STEP, state: { armed: false } };
}

/**
 * La rotation continue de cette image.
 *
 * Même zone morte et même rampe que la marche : les deux sticks doivent se
 * sentir de la même famille.
 */
export function smoothTurn(stickX: number, dt: number): number {
  const push = Math.abs(stickX);
  if (push <= WALK_DEAD_ZONE) return 0;
  const reach = Math.min(1, (push - WALK_DEAD_ZONE) / (1 - WALK_DEAD_ZONE));
  // Négatif vers la droite : voir `snapTurn`, même convention et même piège.
  return -Math.sign(stickX) * TURN_SPEED * reach * reach * dt;
}

/**
 * La vitesse d'un pas, en mètres par seconde, pour piloter la vignette.
 *
 * Rend zéro plutôt qu'un infini quand `dt` est nul - ce qui arrive à la toute
 * première image, où deux horloges ne se sont pas encore parlé.
 */
export function walkSpeed(step: readonly [number, number], dt: number): number {
  if (!(dt > 0)) return 0;
  return Math.hypot(step[0], step[1]) / dt;
}
