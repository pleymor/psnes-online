/**
 * Ce qu'un écran affiche à la place d'une cote, quand il n'y en a pas.
 *
 * Quatre situations produisent « pas de cote » et ne veulent pas dire la même
 * chose : pas de jeu choisi, un jeu dont personne ne sait lire la mémoire, un
 * joueur sans compte, et un compte qui n'a pas encore joué. Les confondre donne
 * un écran qui ment - « 1000 » pour quelqu'un qui n'a jamais joué ressemble à un
 * résultat, et une case vide sur un jeu non observé promet qu'elle se remplira.
 *
 * Pur et sans store, pour la même raison que `rooms/anonymous-join.ts` : c'est
 * la règle qui décide de ce que le joueur voit, elle doit se lire seule et se
 * prouver sans navigateur.
 */

export type RatingDisplay =
  /** Rien à montrer, et rien à promettre. */
  | { kind: 'hidden' }
  /** Un joueur sans compte : jamais classé, et ce n'est pas un défaut. */
  | { kind: 'guest' }
  /** Un compte qui n'a pas encore joué sur ce jeu. */
  | { kind: 'unranked' }
  | { kind: 'rated'; rating: number; matches: number };

/** La ligne que `standingsOf` rend pour un joueur, ou null pour un siège vide. */
export interface Standing {
  userId: string;
  isAnonymous: boolean;
  rating: number | null;
  matches: number | null;
}

export function ratingDisplay(input: {
  /** Le jeu du salon, ou null tant qu'aucun n'est choisi. */
  gameCrc32: string | null | undefined;
  /** Si ce jeu a une ligne dans `watched-roms.ts`. Faux : aucune partie n'en sortira. */
  watched: boolean;
  standing: Standing | null | undefined;
}): RatingDisplay {
  if (!input.gameCrc32 || !input.watched) return { kind: 'hidden' };
  if (!input.standing) return { kind: 'hidden' };

  // Avant tout le reste : un invité n'a pas d'identité durable, donc il ne sera
  // jamais classé. Le dire « non classé » laisserait croire qu'un combat
  // suffirait à remplir la case.
  if (input.standing.isAnonymous) return { kind: 'guest' };

  const { rating, matches } = input.standing;
  // Zéro partie vaut absence : la base ne devrait pas produire une telle ligne,
  // mais « 1000 · 0 partie » serait la formulation la plus trompeuse possible.
  if (rating === null || matches === null || matches === 0) return { kind: 'unranked' };

  return { kind: 'rated', rating, matches };
}
