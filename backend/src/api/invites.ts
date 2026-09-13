import { Router } from 'express';
import { getDb } from '../db/sqlite.js';
import {
  INVITE_QUOTA, countAccounts, countChargedInvites, findInviteById,
  listInvitesOf, maxUsers, mintInvite, revokeInvite, type SignupInvite
} from '../db/signup-invites.js';
import { findUserById } from '../db/users.js';
import { asyncHandler } from '../middleware/async-handler.js';
import type { User } from '../db/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Invites');

export const invitesRouter = Router();

function frontendUrl(): string {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

/**
 * Ce qu'un joueur apprend de ses propres invitations.
 *
 * Écrite à la main plutôt que dérivée de la ligne, pour la raison que `toSelf`
 * documente dans api/auth.ts : une colonne ajoutée plus tard à `SignupInvite`
 * ne doit pas pouvoir rejoindre cette réponse par accident. `inviterId` et
 * `inviteeId` restent au serveur -- le pseudonyme du filleul est ce qui est
 * lisible, son identifiant interne n'apprend rien à personne.
 */
export function toInviteView(
  invite: SignupInvite, inviteePseudo: string | null, base: string
) {
  return {
    id: invite.id,
    code: invite.code,
    url: `${base.replace(/\/$/, '')}/?invite=${invite.code}`,
    usedAt: invite.usedAt ? invite.usedAt.toISOString() : null,
    inviteePseudo
  };
}

function viewOf(db: ReturnType<typeof getDb>, invite: SignupInvite) {
  const invitee = invite.inviteeId ? findUserById(db, invite.inviteeId) : null;
  const pseudo = invitee ? `${invitee.pseudo}#${invitee.discriminator}` : null;
  return toInviteView(invite, pseudo, frontendUrl());
}

invitesRouter.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const me = req.user as User;
  const charged = countChargedInvites(db, me.id);
  res.json({
    quota: INVITE_QUOTA,
    remaining: Math.max(0, INVITE_QUOTA - charged),
    platformFull: countAccounts(db) >= maxUsers(),
    invites: listInvitesOf(db, me.id).map(invite => viewOf(db, invite))
  });
}));

invitesRouter.post('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const me = req.user as User;

  // Le plafond est vérifié ici ET à la consommation. Ici pour ne pas laisser
  // frapper un lien vers une plateforme pleine ; là-bas parce que des semaines
  // peuvent passer entre les deux, et qu'un lien émis n'est pas une place
  // réservée.
  if (countAccounts(db) >= maxUsers()) {
    return res.status(503).json({ error: 'PLATFORM_FULL' });
  }
  if (countChargedInvites(db, me.id) >= INVITE_QUOTA) {
    return res.status(403).json({ error: 'QUOTA_EXHAUSTED' });
  }

  const invite = mintInvite(db, me.id);
  logger.info({ userId: me.id, inviteId: invite.id }, 'Signup invite minted');
  res.status(201).json(viewOf(db, invite));
}));

invitesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const me = req.user as User;
  const invite = findInviteById(db, req.params.id);

  // Un lien qui n'est pas le vôtre est un lien qui n'existe pas : un 403
  // confirmerait l'existence d'un identifiant à qui l'a deviné.
  if (!invite || invite.inviterId !== me.id) {
    return res.status(404).json({ error: 'INVITE_UNKNOWN' });
  }
  if (invite.usedAt) {
    return res.status(409).json({ error: 'INVITE_USED' });
  }

  revokeInvite(db, invite.id);
  res.status(204).end();
}));
