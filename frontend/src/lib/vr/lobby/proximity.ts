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
const SOLID: Presence = { visible: true, opacity: 1 };

/**
 * `mine` est `null` tant que je n'ai pas encore de pose.
 *
 * Le repli habite ICI plutôt que chez l'appelant, et ce n'est pas du rangement :
 * « que montre-t-on quand on ne sait pas où l'on est » est une politique de
 * proximité comme les deux seuils, et écrite chez celui qui dessine elle serait
 * hors de portée de tout test - `avatars.ts` importe three, donc rien sous Bun
 * ne peut l'exécuter.
 *
 * Et le repli est SOLIDE, pas absent : l'effacement existe pour qu'un ami ne
 * me gêne pas, or sans ma propre pose il n'y a aucune gêne à constater. Choisir
 * l'inverse ferait disparaître tout le lobby pendant la première image de
 * chaque session, ce qui se lirait comme « les amis ne se chargent pas ».
 */
export function presenceFor(mine: Pose | null, theirs: Pose): Presence {
  if (mine === null) return SOLID;

  // En trois dimensions, et non à plat : un ami perché sur un tuyau est au
  // même point au sol et pourtant loin. À plat, il disparaîtrait sous nos
  // pieds sans rien gêner du tout.
  const distance = Math.hypot(theirs[0] - mine[0], theirs[1] - mine[1], theirs[2] - mine[2]);

  if (distance <= FADE_NEAR) return ABSENT;
  if (distance >= FADE_FULL) return SOLID;

  return {
    visible: true,
    opacity: (distance - FADE_NEAR) / (FADE_FULL - FADE_NEAR)
  };
}
