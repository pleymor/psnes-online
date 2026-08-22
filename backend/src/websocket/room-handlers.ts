import { Server, Socket } from 'socket.io';
import { Room, RoomPlayer, User, EmulationMode } from '../types/index.js';
import { randomUUID } from 'crypto';
import { getUserKeyConfig } from '../services/user-config.js';
import { notifyFriendsRoomStatusChanged, getFriendships } from '../services/friends.js';
import { toPublicRoom, withoutInvitation } from './room-view.js';
import { createLogger } from '../utils/logger.js';
import { cleanupRoomChecksums } from './sync-handlers.js';
import { cleanupHostReady } from './p2p-handlers.js';
import { cleanupZnetRoom } from './znet-handlers.js';
import { getDb, type Database } from '../db/sqlite.js';
import { findOwnedGameForRoom } from '../db/games.js';
import { findFriendshipBetween } from '../db/friendships.js';
import { findUserById } from '../db/users.js';
import {
  createInvitation,
  deleteInvitationsForRoom,
  findInvitationById,
  listPendingInvitationsFor,
  listPendingInvitationsForRoom,
  markInvitation,
  refreshInvitationDeadline,
  type Invitation
} from '../db/invitations.js';
import { invitationState } from '../rooms/invitation-state.js';
import { requireGame } from '../rooms/require-game.js';
import { getMemberRoom } from './guards.js';

const logger = createLogger('Room');

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
  fromDisplayName: string;
  fromAvatar?: string;
  /** Undefined while the room has no game yet, which is now an ordinary state. */
  gameTitle?: string;
  expiresAt: Date;
}

function toInvitationView(
  invitation: Invitation,
  room: Room,
  from: { displayName: string; avatar: string | null } | null
): InvitationView {
  return {
    id: invitation.id,
    roomId: invitation.roomId,
    fromUserId: invitation.fromUserId,
    fromDisplayName: from?.displayName ?? 'Unknown player',
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

export function registerRoomHandlers(
  socket: Socket,
  io: Server,
  user: User,
  rooms: Map<string, Room>,
  getUserSocket: (id: string) => string | undefined
) {
  // Create room, with or without a game: a room is now a place where players
  // meet, and the game can be chosen once they are both there.
  socket.on('room:create', async (data?: { gameId?: string; gameTitle?: string; autoStart?: boolean; emulationMode?: EmulationMode } | null) => {
    const payload = data ?? {};
    // Both fields or neither. `requireGame` refuses a half-filled game, so a
    // room built from one would carry a gameId that no handler would honour.
    const game = requireGame(payload);
    if (!game && (payload.gameId || payload.gameTitle)) {
      socket.emit('error', { message: 'A game needs both an id and a title' });
      return;
    }

    const autoStart = payload.autoStart ?? false;
    // Solo is the only caller that auto-starts, and it always has a game.
    // Auto-starting without one would put the room straight into `playing`
    // with nothing to run: a state no screen can render and no core can play.
    if (autoStart && !game) {
      socket.emit('error', { message: 'A room cannot start without a game' });
      return;
    }

    const roomId = randomUUID();
    const userKeyConfig = await getUserKeyConfig(user.id);
    // Read from the host's library rather than trusting the payload: the guest
    // will use this checksum to pick a file off their own disk and the cover is
    // rendered as an image source, so both have to be what the server recorded.
    // No game means no facts to copy, so a room cannot end up wearing a cover
    // for a game it does not have.
    const facts = game ? findOwnedGameForRoom(getDb(), game.gameId, user.id) : null;

    const room: Room = {
      id: roomId,
      gameId: game?.gameId,
      gameTitle: game?.gameTitle,
      gameCoverUrl: facts?.coverUrl ?? undefined,
      gameCrc32: facts?.crc32 ?? undefined,
      hostId: user.id,
      createdBy: user.id,
      players: [{
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar ?? undefined,
        port: 1, // Always assign creator to player 1
        isReady: true, // Always ready by default
        emulationReady: false,
        keyConfig: userKeyConfig
      }],
      status: autoStart ? 'playing' : 'waiting',
      // Lockstep by default: both players run the same deterministic core and
      // exchange inputs, so a room cannot end up with two machines quietly
      // diverging the way the dual mode does.
      emulationMode: payload.emulationMode ?? 'lockstep',
      createdAt: new Date()
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    socket.emit('room:created', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
    notifyFriendsAboutRoom(io, user.id, room, getUserSocket);

    if (autoStart) {
      await notifyFriendsRoomStatusChanged(io, user.id, room.id, 'playing', getUserSocket);
      io.to(roomId).emit('game:started');
      logger.info({ roomId, host: user.displayName }, 'Game auto-started');
    }
  });

  // Join room - a return trip, now that the invitation is the only door in.
  //
  // Every legitimate caller is already a player by the time this arrives:
  // `room:create` seats its creator, `lobby:accept` seats an invitee through
  // the same `joinRoom` below, and the room page emits this event at mount
  // and again on reconnect - by which point the seat is already theirs, and
  // `joinRoom`'s existing-player branch is what actually answers it. So this
  // event no longer needs to accept a stranger at all: `getMemberRoom` gives
  // a non-member the same "Room not found" every other room-scoped event
  // gives them, rather than a different answer that would confirm the room
  // exists.
  socket.on('room:join', async (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'room:join');

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    await joinRoom(io, socket, room, user, getUserSocket);
  });

  // Choose - or change - the room's game.
  //
  // Callable more than once before the launch: trying a game, seeing the guest
  // does not have it, and picking another is ordinary lobby use, not an error.
  socket.on('room:choose-game', async (data: { roomId: string; gameId: string; gameTitle: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'room:choose-game');
    if (!room) {
      // One answer for "no such room" and "you are not in it": room ids travel
      // (friend notifications, the rooms list), so confirming a room exists to
      // someone who is not in it tells them something they should not learn.
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.status !== 'waiting') {
      socket.emit('error', { message: 'The game cannot be changed once the room has started' });
      return;
    }

    const game = requireGame(data ?? {});
    if (!game) {
      socket.emit('error', { message: 'A game needs both an id and a title' });
      return;
    }

    /*
     * Both facts come from the chooser's library, never from the payload.
     *
     * The checksum because the other player picks a file off their own disk
     * with it. The cover because this handler is the one place where a *guest*
     * describes a game in someone else's room, and the cover is broadcast to
     * the host and rendered as an image source - a URL nobody vouched for has
     * no business getting there.
     */
    const facts = findOwnedGameForRoom(getDb(), game.gameId, user.id);

    room.gameId = game.gameId;
    room.gameTitle = game.gameTitle;
    // Overwritten, never merged: keeping the previous game's cover next to the
    // new game's title would be visibly wrong.
    room.gameCoverUrl = facts?.coverUrl ?? undefined;
    room.gameCrc32 = facts?.crc32 ?? undefined;

    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
    logger.info({ roomId: room.id, gameId: game.gameId, by: user.displayName }, 'Room game chosen');
  });

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
        displayName: user.displayName
      });
    }

    // The room is no longer waiting on anyone, so its view has to say so and
    // the invite panel comes back on its own. The room may already be gone -
    // an invitation outlives the room it names.
    const declinedRoom = rooms.get(invitation.roomId);
    if (declinedRoom) await broadcastRoomUpdate(io, declinedRoom, getUserSocket);

    logger.info({ roomId: invitation.roomId, userId: user.id }, 'Invitation declined');
  });

  // Leave room
  socket.on('room:leave', (data: { roomId: string }) => {
    // Deliberate, so no grace period - and cancel any pending one.
    if (data?.roomId) cancelScheduledLeave(data.roomId, user.id);
    handleLeaveRoom(io, socket, data.roomId, rooms, user, getUserSocket);
  });

  // Select controller port
  socket.on('room:selectPort', (data: { roomId: string; port: 1 | 2 }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    const occupiedPlayer = room.players.find(p => p.port === data.port && p.userId !== user.id);

    if (occupiedPlayer) {
      const otherPort = data.port === 1 ? 2 : 1;
      occupiedPlayer.port = otherPort;
    }

    player.port = data.port;
    player.isReady = true;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Unselect controller port
  socket.on('room:unselectPort', (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.port = null;
    player.isReady = false;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Update key config
  socket.on('room:updateKeyConfig', (data: { roomId: string; keyConfig: any }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.keyConfig = data.keyConfig;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Toggle ready
  socket.on('room:toggleReady', (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.isReady = !player.isReady;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Set emulation mode (only room creator can change)
  socket.on('room:setEmulationMode', (data: { roomId: string; emulationMode: EmulationMode }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    // Only the room creator can change the mode
    if (room.createdBy !== user.id) return;

    // Only allow changes in waiting status
    if (room.status !== 'waiting') return;

    room.emulationMode = data.emulationMode;
    io.to(data.roomId).emit('room:updated', room);
    logger.info({ roomId: room.id, mode: data.emulationMode }, 'Emulation mode changed');
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

/**
 * Puts a player in a room and tells everyone entitled to know.
 *
 * Shared by `room:join` and `lobby:accept` so that the player construction,
 * the port assignment and the broadcast exist in one place - three things that
 * would drift apart in two copies.
 *
 * Returns whether the caller is in the room afterwards. The only refusal is a
 * full room, which it reports to the socket itself.
 */
async function joinRoom(
  io: Server,
  socket: Socket,
  room: Room,
  user: User,
  getUserSocket: (id: string) => string | undefined
): Promise<boolean> {
  // Whichever door they came through, arriving reclaims a seat that is waiting
  // out its grace period.
  cancelScheduledLeave(room.id, user.id);

  const existingPlayer = room.players.find(p => p.userId === user.id);
  if (existingPlayer) {
    // The reconnection path: the seat is already theirs, so nothing is added
    // and nobody else has anything to learn.
    socket.join(room.id);
    socket.emit('room:updated', room);

    if (room.status === 'playing') {
      socket.emit('game:started');
    }
    return true;
  }

  /*
   * Read before the capacity check, deliberately.
   *
   * With the await between the check and the push, two people accepting an
   * invitation in the same tick both saw one free seat and both took it: a
   * three-player room with two players on port 2. It does not happen today
   * only because `getUserKeyConfig` resolves without ever yielding to the
   * event loop, which is a property of a function elsewhere and not a promise
   * this code can rely on. Everything from the check to the push is now
   * synchronous, so there is no window to lose.
   */
  const userKeyConfig = await getUserKeyConfig(user.id);

  if (room.players.length >= 2) {
    socket.emit('error', { message: 'Room is full' });
    return false;
  }

  const player: RoomPlayer = {
    userId: user.id,
    displayName: user.displayName,
    avatar: user.avatar ?? undefined,
    port: 2, // Guest always joins as player 2
    isReady: true, // Always ready by default
    emulationReady: false,
    keyConfig: userKeyConfig
  };

  room.players.push(player);
  socket.join(room.id);

  io.to(room.id).emit('room:updated', room);
  await broadcastRoomUpdate(io, room, getUserSocket);

  if (room.status === 'playing') {
    socket.emit('game:started');
    logger.info({ roomId: room.id, guest: user.displayName }, 'Guest joined as Player 2 (game in progress)');
  }

  return true;
}

/**
 * Departures waiting out their grace period, keyed by room and user.
 *
 * A socket that drops is not a player who left. Removing them on the spot
 * destroyed rooms mid-game: the last player's connection blinked, the room was
 * deleted, and when their socket came back a moment later there was nothing to
 * rejoin - every netplay packet from then on was refused as coming from a
 * non-member, while the game itself carried on happily sending them.
 *
 * Emulation saturates the main thread, which makes those blinks routine rather
 * than rare.
 */
const pendingDepartures = new Map<string, NodeJS.Timeout>();

const DISCONNECT_GRACE_MS = 45_000;

const departureKey = (roomId: string, userId: string) => `${roomId}:${userId}`;

/**
 * Arms the timer for one seat, replacing whatever was already holding it.
 *
 * The timer is `unref`'d, for the same reason the cache's sweep is: a grace
 * period must never be what keeps a process alive. In production the HTTP
 * server holds the process open, so it fires exactly as before; anywhere else
 * - a test, a script - a seat waiting out its forty-five seconds would
 * otherwise add forty-five seconds to the exit, which is the failure the
 * cache's own interval used to hide.
 */
function armDeparture(key: string, delayMs: number, release: () => void) {
  clearTimeout(pendingDepartures.get(key));

  const timer = setTimeout(() => {
    pendingDepartures.delete(key);
    release();
  }, delayMs);
  timer.unref();

  pendingDepartures.set(key, timer);
}

/**
 * Removes a player only if they are still gone once the grace period ends.
 *
 * `delayMs` exists so a test can watch a grace period elapse in milliseconds
 * instead of forty-five seconds. Production never passes it.
 */
export function scheduleLeaveRoom(
  io: Server,
  socket: Socket,
  roomId: string,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined,
  delayMs: number = DISCONNECT_GRACE_MS
) {
  armDeparture(departureKey(roomId, user.id), delayMs, () => {
    logger.info({ roomId, userId: user.id }, 'Grace period elapsed, removing player');
    void handleLeaveRoom(io, socket, roomId, rooms, user, getUserSocket);
  });

  logger.debug({ roomId, userId: user.id }, 'Player disconnected, holding their seat');
}

/** Called when the player is back, so their seat is never given up. */
export function cancelScheduledLeave(roomId: string, userId: string) {
  const key = departureKey(roomId, userId);
  const timer = pendingDepartures.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingDepartures.delete(key);
  logger.info({ roomId, userId }, 'Player returned within the grace period');
}

/**
 * Holds a restored player's seat for the usual grace period.
 *
 * Called once per player when rooms are read back after a restart, where
 * everyone is disconnected by definition. It deliberately reuses the same
 * timer map as `scheduleLeaveRoom`, so `cancelScheduledLeave` releases it
 * through the ordinary path when the player's socket comes back - a returning
 * player needs no special case.
 */
export function holdRestoredSeat(
  io: Server,
  roomId: string,
  rooms: Map<string, Room>,
  userId: string,
  displayName: string,
  getUserSocket: (id: string) => string | undefined
) {
  armDeparture(departureKey(roomId, userId), DISCONNECT_GRACE_MS, () => {
    logger.info({ roomId, userId }, 'Restored player did not come back, removing');
    void handleLeaveRoom(io, null, roomId, rooms, { id: userId, displayName } as User, getUserSocket);
  });

  logger.debug({ roomId, userId }, 'Holding a restored seat');
}

export async function handleLeaveRoom(
  io: Server,
  socket: Socket | null,
  roomId: string,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const wasHost = room.hostId === user.id;

  room.players = room.players.filter(p => p.userId !== user.id);
  // Null when the departure comes from a restored room rather than a live
  // socket: after a restart there is no socket to take out of the channel.
  socket?.leave(roomId);

  if (room.players.length === 0) {
    await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'destroyed', getUserSocket);
    // Clean up per-room state so nothing outlives the room itself
    cleanupRoomChecksums(roomId);
    cleanupHostReady(roomId);
    cleanupZnetRoom(roomId);
    // Its invitations have nowhere left to lead. This keeps rows from piling
    // up; it is not what makes `lobby:accept` correct - that comes from the
    // room-still-exists check there, and neither replaces the other.
    deleteInvitationsForRoom(getDb(), roomId);
    rooms.delete(roomId);
    io.emit('room:destroyed', { roomId });
  } else {
    logger.debug({ roomId, userId: user.id, displayName: user.displayName, wasHost }, 'Player left room');
    io.to(roomId).emit('player:left', {
      userId: user.id,
      displayName: user.displayName,
      wasHost
    });

    if (wasHost) {
      room.hostId = room.players[0].userId;
      io.to(roomId).emit('host:left');
    }

    io.to(roomId).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
  }
}

/**
 * Tells the host's friends a room now exists.
 *
 * Lives here rather than in `services/friends.ts`, where it used to, because it
 * needs `toPublicRoom` and `room-view.ts` needs `getFriendships` - so the two
 * modules imported each other. That cycle resolved only because ESM hoists
 * function declarations and neither module touched the other while evaluating;
 * the first top-level statement either one gained would have broken it. The
 * websocket layer is where this function's dependencies already live.
 *
 * The view is built once, not once per friend: it runs an indexed checksum
 * lookup per player, and N online friends were paying for N identical copies.
 * Its sibling below has always done it this way.
 */
async function notifyFriendsAboutRoom(
  io: Server,
  userId: string,
  room: Room,
  getUserSocket: (id: string) => string | undefined
) {
  const friendships = await getFriendships(userId);
  // The public view, not the raw room. room-view.ts exists to drop each
  // player's keyConfig - "a private input setting with no use outside the room
  // it belongs to" - and a friend is by definition outside it. Sending the raw
  // room here handed every online friend everybody's key bindings. The friends
  // list only ever reads id, gameTitle, status and the player list, all of
  // which the public view keeps. Minus the pending invitation: every recipient
  // here is by definition outside the room, and the invitee's name is not
  // theirs to learn.
  const payload = withoutInvitation(toPublicRoom(room));

  for (const friendship of friendships) {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:roomCreated', { userId, room: payload });
    }
  }
}

/**
 * Publishes a room update to the people entitled to see it: the players in the
 * room and the host's friends. This used to be an io.emit, which handed every
 * connected user each room's id and every player's keyConfig.
 */
async function broadcastRoomUpdate(
  io: Server,
  room: Room,
  getUserSocketId: (id: string) => string | undefined
) {
  const payload = toPublicRoom(room);
  /*
   * Two payloads, because the audience is two audiences.
   *
   * Everything else in this view is about the room itself, and a friend
   * watching the lobby list is meant to see it. The pending invitation is not:
   * it names somebody who is not in the room and may be a stranger to the
   * friend receiving it. Members get it because the panel is built from it;
   * everyone else gets the room without it.
   */
  const forOnlookers = withoutInvitation(payload);
  const members = new Set<string>(room.players.map(p => p.userId));
  const onlookers = new Set<string>();

  for (const friendship of await getFriendships(room.hostId)) {
    const friendId =
      friendship.initiatorId === room.hostId ? friendship.receiverId : friendship.initiatorId;
    // Disjoint from `members`, so a friend who is also a player still gets
    // exactly one update - the fuller one.
    if (!members.has(friendId)) onlookers.add(friendId);
  }

  for (const userId of members) {
    const socketId = getUserSocketId(userId);
    if (socketId) io.to(socketId).emit('room:update', payload);
  }

  for (const userId of onlookers) {
    const socketId = getUserSocketId(userId);
    if (socketId) io.to(socketId).emit('room:update', forOnlookers);
  }
}
