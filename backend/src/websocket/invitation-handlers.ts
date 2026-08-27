import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { getDb, type Database } from '../db/sqlite.js';
import { findUserById } from '../db/users.js';
import { findFriendshipBetween } from '../db/friendships.js';
import {
  createInvitation,
  findInvitationById,
  listPendingInvitationsFor,
  listPendingInvitationsForRoom,
  markInvitation,
  refreshInvitationDeadline,
  type Invitation
} from '../db/invitations.js';
import { invitationState } from '../rooms/invitation-state.js';
import { getMemberRoom } from './guards.js';
import { broadcastRoomUpdate, joinRoom, leaveCurrentRoom } from './room-handlers.js';

const logger = createLogger('Invitation');

/**
 * How long an invitation stands.
 *
 * Long enough that a friend who is away from the keyboard can still answer,
 * short enough that a stale one does not sit in their tray pointing at a room
 * that has long since been abandoned.
 */
const INVITATION_TTL_MS = 10 * 60_000;

/** What a client is told about an invitation it has received. */
export interface InvitationView {
  id: string;
  roomId: string;
  fromUserId: string;
  fromPseudo: string;
  fromAvatar?: string;
  /** Undefined while the room has no game yet, which is now an ordinary state. */
  gameTitle?: string;
  expiresAt: Date;
}

function toInvitationView(
  invitation: Invitation,
  room: Room,
  from: { pseudo: string; avatar: string | null } | null
): InvitationView {
  return {
    id: invitation.id,
    roomId: invitation.roomId,
    fromUserId: invitation.fromUserId,
    fromPseudo: from?.pseudo ?? 'Unknown player',
    fromAvatar: from?.avatar ?? undefined,
    gameTitle: room.gameTitle,
    expiresAt: invitation.expiresAt
  };
}

/**
 * The invitations a user should see right now: still pending at this instant,
 * and naming a room that still exists.
 *
 * Both filters are needed. `deleteInvitationsForRoom` keeps rows from piling
 * up when a room dies, but it cannot help an invitation whose room died
 * between two reads - and an invitation naming a dead room would offer a
 * client a room id it can do nothing with.
 *
 * Only invitations addressed to `userId` are ever returned: an invitation
 * carries a room id, so the same scoping discipline as `rooms:list` applies.
 * The instant is a parameter for the same reason `invitationState` takes one.
 */
export function pendingInvitationsFor(
  db: Database,
  userId: string,
  rooms: Map<string, Room>,
  now: Date
): InvitationView[] {
  const views: InvitationView[] = [];

  for (const invitation of listPendingInvitationsFor(db, userId)) {
    if (invitationState(invitation, now) !== 'pending') continue;

    const room = rooms.get(invitation.roomId);
    if (!room) continue;

    views.push(toInvitationView(invitation, room, findUserById(db, invitation.fromUserId)));
  }

  return views;
}

export function registerInvitationHandlers(
  socket: Socket,
  io: Server,
  user: User,
  rooms: Map<string, Room>,
  getUserSocket: (id: string) => string | undefined
) {
  // Invite a friend into this room.
  socket.on('lobby:invite', async (data: { roomId: string; friendId: string }) => {
    // The order of these checks is deliberate: membership first, so someone
    // outside the room can never learn from an error message whether two other
    // people are friends, nor how full the room is.
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'lobby:invite');
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (!data?.friendId) {
      socket.emit('error', { message: 'No friend to invite' });
      return;
    }

    const friendship = findFriendshipBetween(getDb(), user.id, data.friendId);
    if (!friendship || friendship.status !== 'accepted') {
      socket.emit('error', { message: 'You can only invite a friend' });
      return;
    }

    if (room.players.some(p => p.userId === data.friendId)) {
      socket.emit('error', { message: 'They are already in this room' });
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    const now = new Date();
    /*
     * One pending invitation per room, and this is where that is enforced.
     *
     * The screen replaces the friend list with a single "waiting for X, cancel"
     * panel, so a second invitation would have nowhere to appear; but the rule
     * lives here rather than in the UI because two tabs would otherwise
     * disagree with the server about what the room is waiting on.
     *
     * `invitationState` and not the stored column: nothing writes `expired`
     * when it happens, so a row that ran out ten minutes ago still reads
     * `pending` and would block every later invitation forever.
     */
    const pendingHere = listPendingInvitationsForRoom(getDb(), room.id).filter(
      invitation => invitationState(invitation, now) === 'pending'
    );

    // Re-inviting is how you reach a friend who was offline a moment ago, so it
    // must not pile up rows: an invitation for this same room that is still
    // pending is re-delivered rather than duplicated, or the friend's tray
    // would show the same room twice.
    const existing = pendingHere.find(invitation => invitation.toUserId === data.friendId);

    if (!existing && pendingHere.length > 0) {
      socket.emit('error', {
        message: 'Someone has already been invited to this room. Cancel that invitation first.'
      });
      return;
    }

    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    // The reused row gets a fresh deadline: an invitation re-sent at nine
    // minutes and thirty seconds would otherwise arrive with thirty seconds to
    // live, and the inviter has no other way to extend it.
    const invitation = existing
      ? refreshInvitationDeadline(getDb(), existing.id, expiresAt)
      : createInvitation(getDb(), room.id, user.id, data.friendId, expiresAt);

    const view = toInvitationView(invitation, room, user);

    // Delivered now if they are connected. Otherwise it simply waits in the
    // table until they are - which is the whole reason it is persisted.
    const friendSocket = getUserSocket(data.friendId);
    if (friendSocket) io.to(friendSocket).emit('lobby:invitation', view);

    socket.emit('lobby:invite-sent', view);
    // The public view now carries this invitation, and it is what makes the
    // invite panel give way to "waiting for X" on every member's screen and
    // survive a reload.
    await broadcastRoomUpdate(io, room, getUserSocket);
    logger.info(
      { roomId: room.id, from: user.id, to: data.friendId, delivered: Boolean(friendSocket), reused: Boolean(existing) },
      'Invitation sent'
    );
  });

  /*
   * Take back the room's pending invitation.
   *
   * Any member may cancel, not only whoever sent it. That is the same rule the
   * rest of this room already follows - either player chooses the game, either
   * player launches - and with one invitation per room there is exactly one
   * thing to take back.
   */
  socket.on('lobby:cancel', async (data: { invitationId: string }) => {
    const invitation = data?.invitationId
      ? findInvitationById(getDb(), data.invitationId)
      : null;

    if (!invitation) {
      socket.emit('error', { message: 'Invitation not found' });
      return;
    }

    // Membership of the invitation's own room, checked the way every other
    // room-scoped event checks it. A non-member gets the same answer as for an
    // id that does not exist, so a stranger holding a room id learns nothing
    // about whether an invitation is outstanding in it.
    const room = getMemberRoom(rooms, invitation.roomId, user.id, 'lobby:cancel');
    if (!room) {
      socket.emit('error', { message: 'Invitation not found' });
      return;
    }

    if (invitation.status !== 'pending') {
      socket.emit('error', { message: 'This invitation has already been answered' });
      return;
    }

    // `cancelled`, never `declined`: the invitee did not turn anything down,
    // and a table that cannot tell the two apart cannot be read later.
    markInvitation(getDb(), invitation.id, 'cancelled');

    socket.emit('lobby:cancelled', { invitationId: invitation.id, roomId: room.id });

    // It has to leave the invitee's tray, or they accept something that no
    // longer exists and get an error for their trouble.
    const inviteeSocket = getUserSocket(invitation.toUserId);
    if (inviteeSocket) {
      io.to(inviteeSocket).emit('lobby:invitation-cancelled', {
        invitationId: invitation.id,
        roomId: invitation.roomId
      });
    }

    // And the room view loses it, which is what brings the invite panel back.
    await broadcastRoomUpdate(io, room, getUserSocket);
    logger.info({ roomId: room.id, invitationId: invitation.id, by: user.id }, 'Invitation cancelled');
  });

  // Accept an invitation and join its room.
  socket.on('lobby:accept', async (data: { invitationId: string }) => {
    const invitation = findOwnInvitation(socket, data?.invitationId, user.id);
    if (!invitation) return;

    // This is where the real instant enters the system: `invitationState`
    // stays pure and the caller reads the clock.
    const state = invitationState(invitation, new Date());
    if (state !== 'pending') {
      socket.emit('error', {
        message:
          state === 'expired'
            ? 'This invitation has expired'
            : state === 'cancelled'
              // Nobody answered it. "Already answered" here would be the last
              // place where withdrawing and refusing are the same sentence -
              // the very conflation the fourth state exists to prevent - and it
              // is what the invitee reads when their click and the cancellation
              // cross in flight.
              ? 'This invitation was withdrawn'
              : 'This invitation has already been answered'
      });
      return;
    }

    /*
     * The room has to still be there.
     *
     * A room whose last player leaves is deleted, so an invitation can name a
     * room that is already gone long before its ten minutes are up. Checking
     * `pending` is not enough - the status says nobody answered, not that
     * there is anywhere to go.
     */
    const room = rooms.get(invitation.roomId);
    if (!room) {
      // Terminal is what this invitation is - nothing can ever make its room
      // exist again - and `declined` is the terminal state that fits: the
      // invitee is the one holding it, and nobody in the room withdrew it,
      // which is all `cancelled` is ever allowed to mean.
      markInvitation(getDb(), invitation.id, 'declined');
      socket.emit('error', { message: 'That room no longer exists' });
      return;
    }

    // Here rather than at the top of the handler: every refusal above - the
    // invitation being spent, expired, somebody else's, or its room gone - must
    // not cost the invitee the room they are already in.
    //
    // A full room can still refuse below, and that one does cost them. Accepted
    // deliberately: the alternative is asking whether the seat is free and then
    // taking it, and that gap is exactly the race the capacity check was moved
    // to close.
    await leaveCurrentRoom(io, socket, rooms, user, getUserSocket);

    // Joining goes through the same path as `room:join`, so the player
    // construction, the port assignment and the broadcast exist once.
    const joined = await joinRoom(io, socket, room, user, getUserSocket);
    // Left pending on failure: a full room can free up while the invitation is
    // still valid, and marking it now would burn it for nothing.
    if (!joined) return;

    markInvitation(getDb(), invitation.id, 'accepted');
    // `joinRoom` broadcast the room view while this row was still pending, so
    // that view still names an invitation for a player who is now sitting in
    // the room. One more broadcast, after the mark, is what clears it.
    await broadcastRoomUpdate(io, room, getUserSocket);
    socket.emit('lobby:accepted', { invitationId: invitation.id, roomId: room.id });

    /*
     * Only when there is something to open.
     *
     * An invitation answered into a room that already has a game is the "invited
     * from a room I was already sitting in" case, and the invitee is taken there
     * as they always were. An invitation into a room with no game forms the
     * group and nothing else: both players stay on their library, which is where
     * the game gets chosen now.
     *
     * Decided here rather than by the client: the invitation the invitee is
     * holding may name a room that had no game when it was sent and has one now.
     */
    if (room.gameId) {
      const invitee = getUserSocket(user.id);
      if (invitee) io.to(invitee).emit('room:opened', { roomId: room.id, reason: 'invitation' });
    }

    logger.info({ roomId: room.id, userId: user.id }, 'Invitation accepted');
  });

  // Turn an invitation down.
  socket.on('lobby:decline', async (data: { invitationId: string }) => {
    const invitation = findOwnInvitation(socket, data?.invitationId, user.id);
    if (!invitation) return;

    // Deliberately blind to the clock: declining an invitation that has just
    // expired is not an error, and the outcome the invitee asked for - it
    // leaves their tray - is the same either way.
    if (invitation.status !== 'pending') {
      socket.emit('error', { message: 'This invitation has already been answered' });
      return;
    }

    markInvitation(getDb(), invitation.id, 'declined');
    socket.emit('lobby:declined', { invitationId: invitation.id });

    const inviterSocket = getUserSocket(invitation.fromUserId);
    if (inviterSocket) {
      io.to(inviterSocket).emit('lobby:invitation-declined', {
        invitationId: invitation.id,
        roomId: invitation.roomId,
        userId: user.id,
        pseudo: user.pseudo
      });
    }

    // The room is no longer waiting on anyone, so its view has to say so and
    // the invite panel comes back on its own. The room may already be gone -
    // an invitation outlives the room it names.
    const declinedRoom = rooms.get(invitation.roomId);
    if (declinedRoom) await broadcastRoomUpdate(io, declinedRoom, getUserSocket);

    logger.info({ roomId: invitation.roomId, userId: user.id }, 'Invitation declined');
  });
}

/**
 * The invitation, only if it was addressed to this user.
 *
 * A missing invitation and someone else's invitation get the same answer on
 * purpose: telling them apart would confirm to a stranger that an invitation
 * with that id exists. Reports the refusal itself and returns null.
 */
function findOwnInvitation(socket: Socket, invitationId: string | undefined, userId: string): Invitation | null {
  const invitation = invitationId ? findInvitationById(getDb(), invitationId) : null;

  if (!invitation || invitation.toUserId !== userId) {
    socket.emit('error', { message: 'Invitation not found' });
    return null;
  }

  return invitation;
}
