import { Router } from 'express';
import { getDb } from '../db/sqlite.js';
import type { User } from '../db/types.js';
import { claimPseudo, PseudoFullError } from '../db/users.js';
import { requireAuth } from '../middleware/auth.js';
import { isValidPseudo } from '../utils/pseudo.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Pseudo');

/**
 * The one router that is not behind requirePseudo, which is the reason it
 * exists as a router at all rather than as a route on userRouter: keeping it
 * separate lets `/api/user` be barred whole, instead of splitting the policy
 * between an exception at the mount point and an exception inside the router.
 */
export const pseudoRouter = Router();

pseudoRouter.use(requireAuth);

/**
 * Claims a pseudonym, first time or any time after.
 *
 * One route for the onboarding modal and for the profile page, because the
 * operation is the same one - validate, allocate a discriminator, write,
 * stamp pseudoChosenAt. Two endpoints doing this would drift apart on
 * validation sooner or later.
 *
 * Changing a pseudonym draws a new discriminator, so a handle shared earlier
 * stops resolving. Existing friendships are untouched: they point at the
 * internal id.
 */
pseudoRouter.put('/', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { pseudo } = req.body ?? {};

  if (!isValidPseudo(pseudo)) {
    return res.status(400).json({ error: 'PSEUDO_INVALID' });
  }

  try {
    const handle = claimPseudo(getDb(), user.id, pseudo);
    logger.info({ userId: user.id, pseudo: handle.pseudo }, 'Pseudonym claimed');
    res.json(handle);
  } catch (err) {
    if (err instanceof PseudoFullError) {
      return res.status(409).json({ error: 'PSEUDO_FULL' });
    }
    throw err;
  }
}));
