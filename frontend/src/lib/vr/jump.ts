/**
 * Sauter, tomber, se poser : la verticale du joueur, sans three.
 *
 * Le seul endroit du lobby où le temps fait autre chose qu'animer un décor.
 * Tout est ici pour la même raison que `walk.ts` : un tir balistique se
 * vérifie sous Bun, un maillage non.
 *
 * LA HAUTEUR EST TOUJOURS « AU-DESSUS DU SOL », comme `standing` dans
 * `placement.ts`. Zéro, c'est les pieds sur l'herbe ; deux, c'est debout sur
 * un tuyau. Aucune de ces valeurs ne connaît la hauteur mesurée du plancher -
 * `build.ts` l'ajoute, exactement comme il le fait pour le décor.
 */

/**
 * Le sommet d'un saut tenu à fond, en mètres.
 *
 * Trois mètres : la hauteur demandée, et celle de Mario. C'est au-dessus d'un
 * tuyau de deux mètres, donc on peut monter dessus en visant large.
 */
export const JUMP_HEIGHT = 3;

/**
 * La gravité, en mètres par seconde carrée.
 *
 * Trois fois celle de la Terre, et c'est délibéré dans les deux sens. Pour le
 * registre : une gravité de dessin animé est ce qui fait qu'un saut de trois
 * mètres se lit comme un saut et non comme un envol. Pour le confort : elle
 * écourte la phase aérienne à moins d'une seconde, et le malaise vient de la
 * DURÉE d'un mouvement que l'oreille interne ne sent pas, pas de son
 * amplitude.
 */
export const GRAVITY = 30;

/** La vitesse initiale qui atteint exactement `JUMP_HEIGHT`. Déduite, pas
 *  choisie : v = racine de deux g h. */
export const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);

/**
 * Ce qui reste de l'élan quand on relâche le bouton en montant.
 *
 * Le saut variable de Mario, et il tient en une ligne : couper la vitesse
 * ascendante à la moitié environ coupe la hauteur au carré de ça, soit un
 * saut minimum de 0,9 m. Assez pour monter sur le comptoir, pas assez pour le
 * tuyau - ce qui donne au bouton quelque chose à dire.
 */
export const JUMP_CUT = 0.55;

/** Au-delà, une image sautée ferait traverser le sol. Voir `step`. */
const MAX_DT = 0.1;

export interface Vertical {
  /** Mètres au-dessus du sol. */
  readonly y: number;
  /** Mètres par seconde, positif vers le haut. */
  readonly velocity: number;
}

export const STANDING: Vertical = { y: 0, velocity: 0 };

export interface JumpInput {
  /** Le bouton vient-il d'être enfoncé, cette image. */
  readonly pressed: boolean;
  /** Est-il tenu, cette image. */
  readonly holding: boolean;
  /** La hauteur du sol SOUS le joueur : zéro sur l'herbe, deux sur un tuyau. */
  readonly support: number;
  /** Secondes depuis l'image précédente. */
  readonly dt: number;
}

/** Le joueur est-il posé sur quelque chose. */
export function grounded(state: Vertical, support: number): boolean {
  return state.velocity <= 0 && state.y <= support + 1e-6;
}

/**
 * Une image de verticale.
 *
 * L'ordre des trois décisions n'est pas indifférent : on coupe l'élan AVANT
 * d'intégrer, sinon un relâchement arrive une image trop tard et la hauteur
 * minimale n'est pas celle qu'on croit.
 */
export function step(state: Vertical, input: JumpInput): Vertical {
  /*
   * Une image sautée ne doit pas faire traverser le sol.
   *
   * Le casque en saute à chaque ouverture de menu système, et intégrer un
   * demi-seconde d'un coup ferait passer le joueur sous l'herbe - d'où il ne
   * remonterait jamais, puisque le support est dessus.
   */
  const dt = Math.min(Math.max(input.dt, 0), MAX_DT);

  if (grounded(state, input.support)) {
    const posed = { y: input.support, velocity: 0 };
    return input.pressed ? { y: input.support, velocity: JUMP_SPEED } : posed;
  }

  // Couper l'élan si le bouton est lâché en montant : le saut variable.
  let velocity = state.velocity;
  if (!input.holding && velocity > 0) velocity = Math.min(velocity, JUMP_SPEED * JUMP_CUT);

  /*
   * L'intégration exacte de la parabole, et non `v -= g·dt` puis `y += v·dt`.
   *
   * Le schéma naïf sous-estime le sommet de `v₀·dt/2` - neuf centimètres sur
   * trois mètres à 72 Hz - et, bien pire, il rend la HAUTEUR DU SAUT
   * DÉPENDANTE DE LA CADENCE : le même appui monterait moins haut sur un
   * casque à 90 Hz. Le demi `g·dt²` retire cette dépendance, et il est la
   * cinématique elle-même plutôt qu'une correction.
   */
  const y = state.y + velocity * dt - 0.5 * GRAVITY * dt * dt;
  velocity -= GRAVITY * dt;

  // L'atterrissage : on se pose SUR le support, jamais dedans.
  if (velocity < 0 && y <= input.support) return { y: input.support, velocity: 0 };
  return { y, velocity };
}
