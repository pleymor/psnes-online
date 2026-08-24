import { Request, Response, NextFunction } from 'express';
import type { User } from '../db/types.js';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).user) {
    return res.status(401).json({ error: 'Not authenticated' });
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
 */
export function requirePseudo(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as User | undefined;
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!user.pseudoChosenAt) {
    return res.status(409).json({ error: 'PSEUDO_REQUIRED' });
  }
  next();
}
