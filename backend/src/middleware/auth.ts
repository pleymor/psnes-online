import { Request, Response, NextFunction } from 'express';
import type { User } from '../db/types.js';
import { ANONYMOUS_FORBIDDEN } from '../auth/anonymous.js';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * Refuse tout ce qui appartient à un compte à quelqu'un qui n'en a pas.
 *
 * Rejoindre un salon n'est pas posséder une bibliothèque. Un anonyme entre par
 * un lien, s'assoit, joue - et c'est tout : pas de jeux, pas d'amis, pas de
 * sauvegardes, pas de configuration de compte, et surtout pas `/api/pseudo`,
 * qui poserait un handle définitif dans un espace de noms unique au nom d'une
 * session qui va disparaître.
 *
 * 403 et non 409 : le portique du pseudonyme dit « il vous manque une
 * condition », que le compte peut remplir. Ici il n'en manque aucune, le droit
 * n'existe pas. Le client sépare les deux sur le champ `error`, pas sur le
 * statut - c'est déjà la convention de ce fichier.
 */
export function requireAccount(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as User | undefined;
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (user.isAnonymous) {
    return res.status(403).json({ error: ANONYMOUS_FORBIDDEN });
  }
  next();
}

/**
 * Refuses every request from an account that has not chosen its pseudonym yet.
 *
 * The blocking modal in the browser is an assertion of the DOM, and it is
 * worked around by curl and a valid session cookie. This is the rule; the
 * modal is its presentation.
 *
 * 409 rather than 403. 403 would say "you are not allowed", which is false --
 * the account has every right, it is missing a precondition. 409 says the
 * state of the resource prevents the request, and this codebase already uses
 * it that way for `Friendship already exists`. The client separates the two
 * cases on the `error` field, not on the status.
 *
 * Mounted in index.ts at the mount point of each router rather than inside the
 * routers, so the whole policy is readable on one screen and adding a route
 * forces a decision about it.
 *
 * Trois états, pas deux, depuis qu'un joueur peut entrer sans compte : pas de
 * session (401), une session sans compte (403), un compte qui n'a pas encore
 * répondu au portique (409). L'anonyme passe avant le pseudonyme, et l'ordre
 * est la décision : `pseudoChosenAt` est null pour lui aussi, donc le tester
 * d'abord lui répondrait PSEUDO_REQUIRED - le client lèverait la modale
 * d'embarquement devant quelqu'un qui n'a pas de compte à embarquer, et
 * l'unique route ouverte pour en sortir lui donnerait un handle définitif.
 */
export function requirePseudo(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as User | undefined;
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (user.isAnonymous) {
    return res.status(403).json({ error: ANONYMOUS_FORBIDDEN });
  }
  if (!user.pseudoChosenAt) {
    return res.status(409).json({ error: 'PSEUDO_REQUIRED' });
  }
  next();
}
