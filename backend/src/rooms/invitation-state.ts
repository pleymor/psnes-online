/**
 * L'état réel d'une invitation, qui n'est pas toujours celui qu'on a stocké.
 *
 * `expired` n'est jamais écrit en base au moment où ça arrive - personne ne
 * regarde. Il se calcule à la lecture, en comparant le délai à un instant
 * qu'on reçoit. L'instant est un paramètre et non `Date.now()` : sans ça,
 * aucun test ne peut faire vieillir une invitation, et l'expiration est
 * précisément ce qu'il faut prouver.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'declined';
export type InvitationState = InvitationStatus | 'expired';

export function invitationState(
  invitation: { status: InvitationStatus; expiresAt: Date },
  now: Date
): InvitationState {
  // Un état déjà décidé gagne : relire une invitation acceptée plus tard ne
  // doit pas la transformer en expirée.
  if (invitation.status !== 'pending') return invitation.status;
  return invitation.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}
