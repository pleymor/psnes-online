/**
 * L'état réel d'une invitation, qui n'est pas toujours celui qu'on a stocké.
 *
 * `expired` n'est jamais écrit en base au moment où ça arrive - personne ne
 * regarde. Il se calcule à la lecture, en comparant le délai à un instant
 * qu'on reçoit. L'instant est un paramètre et non `Date.now()` : sans ça,
 * aucun test ne peut faire vieillir une invitation, et l'expiration est
 * précisément ce qu'il faut prouver.
 */
/**
 * `cancelled` is the inviter's side withdrawing, and it is deliberately not
 * `declined`: conflating "they said no" with "I took it back" would put the
 * wrong sentence in front of the invitee and leave the table unreadable
 * afterwards. The column is plain `TEXT` with no CHECK constraint (see
 * migrations/0002_room_invitations.sql), so a fourth value needs no migration.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type InvitationState = InvitationStatus | 'expired';

export function invitationState(
  invitation: { status: InvitationStatus; expiresAt: Date },
  now: Date
): InvitationState {
  // Un état déjà décidé gagne : relire une invitation acceptée - ou annulée -
  // plus tard ne doit pas la transformer en expirée.
  if (invitation.status !== 'pending') return invitation.status;
  return invitation.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}
