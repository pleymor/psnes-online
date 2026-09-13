/**
 * Ce qu'on montre d'un ami selon sa distance, et pourquoi on ne montre rien de
 * trop près.
 *
 * La règle vient du propriétaire, mot pour mot : « les autres deviennent
 * invisibles quand on se chevauche pour ne pas se gêner ». Elle tient la place
 * d'une décision qu'on a écartée - attribuer une place de départ côté serveur.
 * Tout le monde entre au même point du repère du décor, donc tout le monde se
 * superpose pendant quelques secondes ; trois lignes d'arithmétique règlent ça
 * sans allocateur, et règlent en prime le cas qu'aucun allocateur ne pourrait
 * régler : un ami qui vient se coller à vous.
 *
 * UN FONDU, PAS UNE BASCULE. Une disparition sèche se remarque davantage
 * qu'une transparence : l'œil attrape le changement brutal, pas le graduel.
 *
 * ET `visible: false`, PAS `opacity: 0`. Un objet transparent invisible coûte
 * encore son tri à chaque image, et ce dépôt a déjà payé un basculement
 * d'ordre de rendu sur une surface transparente. Sous le seuil, l'objet sort
 * du rendu pour de bon.
 */
import type { Pose } from './roster';

/** En deçà, l'ami n'est pas dessiné du tout. */
export const FADE_NEAR = 0.5;
/** Au-delà, il est entièrement solide. */
export const FADE_FULL = 1.2;

export interface Presence {
  visible: boolean;
  /** 0..1. Une seule valeur pour la tête, les mains ET la plaque de pseudo :
   *  un nom qui flotte sans visage est pire que pas de nom. */
  opacity: number;
}

const ABSENT: Presence = { visible: false, opacity: 0 };

export function presenceFor(mine: Pose, theirs: Pose): Presence {
  // En trois dimensions, et non à plat : un ami perché sur un tuyau est au
  // même point au sol et pourtant loin. À plat, il disparaîtrait sous nos
  // pieds sans rien gêner du tout.
  const distance = Math.hypot(theirs[0] - mine[0], theirs[1] - mine[1], theirs[2] - mine[2]);

  if (distance <= FADE_NEAR) return ABSENT;
  if (distance >= FADE_FULL) return { visible: true, opacity: 1 };

  return {
    visible: true,
    opacity: (distance - FADE_NEAR) / (FADE_FULL - FADE_NEAR)
  };
}
