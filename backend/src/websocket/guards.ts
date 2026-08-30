import { Room } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { mayEnterRoom } from '../auth/anonymous.js';

const logger = createLogger('Guard');

/**
 * Resolves a room only if the caller is currently one of its players.
 *
 * Room ids are discoverable (they are handed out by `GET /api/rooms` and by
 * friend notifications), so every room-scoped socket event has to prove
 * membership rather than just proving the room exists. Returns null and logs
 * when the caller is not a member, so handlers can bail out uniformly.
 */
export function getMemberRoom(
  rooms: Map<string, Room>,
  roomId: string | undefined,
  userId: string,
  event: string
): Room | null {
  if (!roomId) return null;

  const room = rooms.get(roomId);
  if (!room) return null;

  if (!room.players.some(p => p.userId === userId)) {
    logger.warn({ roomId, userId, event }, 'Rejected room event from non-member');
    return null;
  }

  return room;
}

/**
 * Le salon dans lequel l'appelant a le droit d'entrer.
 *
 * `getMemberRoom` répond « êtes-vous déjà assis ici », ce qui est la bonne
 * question pour les vingt événements qui agissent sur un salon. Entrer est la
 * seule action pour laquelle ce n'est pas la bonne question, et il y a
 * exactement deux réponses : un compte est déjà membre (il a été assis par
 * `room:create` ou par `lobby:accept`, et ce qui reste est une reconnexion),
 * ou une session anonyme nomme ce salon-ci.
 *
 * Le salon vient de la session, jamais de la charge utile - c'est ce qui fait
 * qu'un lien reçu ouvre une porte et pas le bâtiment. Un anonyme qui émet
 * `room:join` sur un identifiant vu passer ailleurs reçoit le même « Room not
 * found » que n'importe quel non-membre, et n'apprend donc pas si ce salon
 * existe.
 *
 * Pour un compte, rien ne change : `mayEnterRoom` répond `false` dès que
 * `isAnonymous` est faux, donc une session portant un `anonymousRoomId` - ce
 * que rien ne produit, mais qu'une session recyclée pourrait - ne lui ouvre
 * aucune porte de plus.
 */
export function getJoinableRoom(
  rooms: Map<string, Room>,
  roomId: string | undefined,
  user: { id: string; isAnonymous: boolean },
  session: unknown,
  event: string
): Room | null {
  const asMember = getMemberRoom(rooms, roomId, user.id, event);
  if (asMember) return asMember;

  if (!mayEnterRoom(user, session, roomId)) return null;

  const room = rooms.get(roomId!);
  if (!room) return null;

  logger.info({ roomId, userId: user.id, event }, 'Anonymous session entering the room its link named');
  return room;
}
