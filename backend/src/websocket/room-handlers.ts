import { Server, Socket } from 'socket.io';
import { Room, RoomPlayer, User, EmulationMode } from '../types/index.js';
import { randomUUID } from 'crypto';
import { getUserKeyConfig } from '../services/user-config.js';
import { notifyFriendsRoomStatusChanged, getFriendships } from '../services/friends.js';
import { toPublicRoom, withoutInvitation } from './room-view.js';
import { createLogger } from '../utils/logger.js';
import { parseLatencyMode } from '../utils/latency-mode.js';
import { cleanupRoomChecksums } from './sync-handlers.js';
import { cleanupHostReady } from './p2p-handlers.js';
import { cleanupZnetRoom } from './znet-handlers.js';
import { getDb } from '../db/sqlite.js';
import { findOwnedGameForRoom } from '../db/games.js';
import { findSaveWithGame } from '../db/saves.js';
import { saveSuitsRoom } from '../rooms/save-suits-room.js';
import { deleteInvitationsForRoom } from '../db/invitations.js';
import { requireGame } from '../rooms/require-game.js';
import { endsWithItsPlayer, markOffline, markOnline } from '../rooms/presence.js';
import { getJoinableRoom, getMemberRoom } from './guards.js';

const logger = createLogger('Room');

/**
 * Gives up whatever room the caller was already in.
 *
 * A room no longer dies when it empties, so without this a player accumulates
 * rooms nobody can reach: they are not in them, so they cannot dissolve them,
 * and the other member is left waiting in a lobby its partner has forgotten.
 * One room at a time is also what keeps the door on the home screen
 * unambiguous - there is only ever one room to resume.
 */
export async function leaveCurrentRoom(
  io: Server,
  socket: Socket,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
  // Copied before iterating: handleLeaveRoom can delete from `rooms`.
  const current = [...rooms.values()].filter(r => r.players.some(p => p.userId === user.id));
  for (const room of current) {
    await handleLeaveRoom(io, socket, room.id, rooms, user, getUserSocket);
  }
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

    // After the refusals above, never before: giving up a room the caller was
    // happily sitting in, and then refusing to build the new one, would leave
    // them with nothing over a payload mistake.
    await leaveCurrentRoom(io, socket, rooms, user, getUserSocket);

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
        pseudo: user.pseudo,
        avatar: user.avatar ?? undefined,
        port: 1, // Always assign creator to player 1
        isReady: true, // Always ready by default
        emulationReady: false,
        online: true,
        keyConfig: userKeyConfig
      }],
      status: autoStart ? 'playing' : 'waiting',
      // Lockstep by default: both players run the same deterministic core and
      // exchange inputs, so a room cannot end up with two machines quietly
      // diverging the way the dual mode does.
      emulationMode: payload.emulationMode ?? 'lockstep',
      latencyMode: 'auto',
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
      logger.info({ roomId, host: user.pseudo }, 'Game auto-started');
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
    /*
     * La seule porte d'entrée, et donc la seule qui ne peut pas se contenter
     * de `getMemberRoom`.
     *
     * Pour un compte le comportement est inchangé, mot pour mot : il est déjà
     * assis quand cet événement arrive, et un non-membre reçoit le même
     * refus qu'avant. `getJoinableRoom` ajoute une seule branche, celle d'une
     * session sans compte dont la session nomme ce salon-ci - le salon vient
     * de la session, pas de la charge utile, donc tenir un identifiant de
     * salon n'a jamais suffi et ne suffit toujours pas.
     */
    const room = getJoinableRoom(
      rooms,
      data?.roomId,
      user,
      (socket.request as any).session,
      'room:join'
    );

    if (!room) {
      /*
       * The same answer as before, with a name on it.
       *
       * `code` is deliberately one value for both halves of the refusal - the
       * room is gone, or it was never the caller's - because telling those two
       * apart is exactly what `getMemberRoom` refuses to do: room ids travel,
       * and confirming a room exists to somebody outside it tells them
       * something they should not learn. What the code adds is only that *this*
       * event was refused, which the caller already knew it had sent. The room
       * page uses it to tell its own dead room apart from any other complaint
       * arriving on the shared `error` channel.
       */
      socket.emit('error', { message: 'Room not found', code: 'roomGone', roomId: data?.roomId });
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
    /*
     * A save belongs to a game, so changing the game unstages it.
     *
     * Without this, arriving on `?save=` and then picking a different game left
     * the old save staged, and the mistake surfaced as "that save belongs to a
     * different game" once the emulator had booted - an error about something
     * nobody had asked for, at the worst possible moment.
     */
    room.resumeSaveId = undefined;
    room.resumeSaveName = undefined;
    // Overwritten, never merged: keeping the previous game's cover next to the
    // new game's title would be visibly wrong.
    room.gameCoverUrl = facts?.coverUrl ?? undefined;
    room.gameCrc32 = facts?.crc32 ?? undefined;

    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
    // Choosing the game is what opens the room: both members go, including the
    // one who just chose.
    openRoomForMembers(io, room, getUserSocket);
    logger.info({ roomId: room.id, gameId: game.gameId, by: user.pseudo }, 'Room game chosen');
  });

  // Release the room's game - the inverse of `room:choose-game`.
  //
  // Quitting a game or a lobby no longer quits the group: it only detaches
  // the game from the room, so both members land back on the home screen
  // still able to pick another game together. Leaving the group itself is a
  // home-screen action now (`leaveGroup`); this handler never touches
  // membership.
  socket.on('room:release-game', async (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'room:release-game');
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    room.gameId = undefined;
    room.gameTitle = undefined;
    room.gameCoverUrl = undefined;
    room.gameCrc32 = undefined;
    room.resumeSaveId = undefined;
    room.resumeSaveName = undefined;

    // Same reset as `game:stop` (game-handlers.ts): a seated player is ready
    // again, an unseated one is not. This handler can fire mid-game, so it
    // has to leave the room in the same state `game:stop` would.
    room.status = 'waiting';
    room.players.forEach(p => {
      p.isReady = p.port !== null;
    });

    // Lets a component already mounted on a running game unmount through the
    // path it already listens for, instead of this event teaching it a
    // second way to do the same thing.
    io.to(room.id).emit('game:stopped');
    io.to(room.id).emit('room:gameReleased', { byUserId: user.id, byPseudo: user.pseudo });
    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
    logger.info({ roomId: room.id, by: user.pseudo }, 'Room game released');
  });

  // Leave room
  socket.on('room:leave', (data: { roomId: string }) => {
    // The only path that gives up a seat. A dropped socket no longer comes
    // here: that is an absence, and it is handled by flipping `online`.
    handleLeaveRoom(io, socket, data.roomId, rooms, user, getUserSocket);
  });

  // Select controller port
  //
  // Broadcasts to `room:update` too (`broadcastRoomUpdate`), matching
  // `room:choose-game`'s pattern. Taking a seat declares ready in the same
  // stroke - the spec's own words for it - and that is exactly the kind of
  // change the VR launch screen has to see: it reads `my-room.ts`, which only
  // `room:update` (no `d`) feeds. Without this a friend selecting a port never
  // repainted the headset's screen.
  socket.on('room:selectPort', async (data: { roomId: string; port: 1 | 2 }) => {
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
    await broadcastRoomUpdate(io, room, getUserSocket);
  });

  // Unselect controller port - the inverse of `room:selectPort`, so it
  // broadcasts for the same reason.
  socket.on('room:unselectPort', async (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.port = null;
    player.isReady = false;
    io.to(data.roomId).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
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

  // Toggle ready. No caller in the frontend today - `room:selectPort` and
  // `room:unselectPort` are the only ways a player's readiness actually
  // changes - but it mutates the same field the VR launch screen reads, so it
  // gets the same broadcast rather than being a second, inconsistent way to
  // flip `isReady`.
  socket.on('room:toggleReady', async (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.isReady = !player.isReady;
    io.to(data.roomId).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
  });

  /*
   * Set the latency trade-off. Creator only, like the emulation mode - but
   * allowed while playing, which the emulation mode is not.
   *
   * Swapping emulator mode mid-game would tear down a running session; changing
   * the input delay only changes how far ahead each peer samples its own input,
   * which the engine handles while running and which a regression test covers at
   * twelve packet phases. The setting exists to be reached from the pause menu,
   * so refusing it there would leave it nowhere useful.
   */
  socket.on('room:setLatencyMode', (data: { roomId: string; latencyMode: unknown }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    if (room.createdBy !== user.id) return;

    // Parsed rather than compared: the setting is a frame count now, and the
    // value both players will live with cannot be whatever the socket sent.
    const latencyMode = parseLatencyMode(data.latencyMode);
    if (latencyMode === null) return;

    room.latencyMode = latencyMode;
    io.to(data.roomId).emit('room:updated', room);
    logger.info({ roomId: room.id, latencyMode }, 'Latency mode changed');
  });

  /*
   * Stage the save this room will start on, or clear it with a null id.
   *
   * Creator-only, like the latency mode: loading a state is not a private
   * preference, it decides where both players begin. The guards are the ones
   * `game:load` already applies - exists, owned by the caller, same ROM - and
   * that repetition is the point of the handler rather than an accident. Checked
   * only at boot, a wrong save became an error over a running game; checked
   * here, it is a refusal in the lobby, where there is still something to do
   * about it.
   *
   * Broadcasts to `room:update` too, same as `room:choose-game`: the VR
   * launch screen reads `resumeSaveId` off `my-room.ts`, which only that
   * event feeds. Without it a staged save was a visible no-op in a headset.
   */
  socket.on('room:choose-save', async (data: { roomId: string; saveId: string | null }) => {
    const room = rooms.get(data?.roomId);
    if (!room) return;
    if (room.createdBy !== user.id) {
      socket.emit('error', { message: 'Only the player who opened the room can choose a save' });
      return;
    }
    if (room.status !== 'waiting') {
      socket.emit('error', { message: 'The starting save cannot be changed once the room has started' });
      return;
    }

    // Starting from the beginning after all is ordinary use, not an error.
    if (data?.saveId == null) {
      room.resumeSaveId = undefined;
      room.resumeSaveName = undefined;
      io.to(room.id).emit('room:updated', room);
      await broadcastRoomUpdate(io, room, getUserSocket);
      logger.info({ roomId: room.id }, 'Starting save cleared');
      return;
    }

    const save = findSaveWithGame(getDb(), data.saveId);
    if (!save) {
      socket.emit('error', { message: 'Save not found' });
      return;
    }
    if (save.game.userId !== user.id) {
      socket.emit('error', { message: 'Not authorized to load this save' });
      return;
    }
    if (!saveSuitsRoom(room.gameCrc32, save.game.crc32)) {
      socket.emit('error', { message: 'That save belongs to a different game' });
      logger.warn(
        { roomId: room.id, saveId: data.saveId, roomCrc32: room.gameCrc32, saveCrc32: save.game.crc32 },
        'Refused to stage a save that does not belong to the room game'
      );
      return;
    }

    room.resumeSaveId = save.id;
    room.resumeSaveName = save.name;
    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
    logger.info({ roomId: room.id, saveId: save.id, by: user.pseudo }, 'Starting save staged');
  });

  // Set emulation mode (only room creator can change)
  socket.on('room:setEmulationMode', async (data: { roomId: string; emulationMode: EmulationMode }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    // Only the room creator can change the mode
    if (room.createdBy !== user.id) return;

    // Only allow changes in waiting status
    if (room.status !== 'waiting') return;

    room.emulationMode = data.emulationMode;
    io.to(data.roomId).emit('room:updated', room);
    /*
     * And to `room:update`, which is what `my-room.ts` listens to.
     *
     * Skipped when the other broadcasts were added, on the premise that
     * nothing in the VR model read this field. The VR shell then began
     * refusing to boot anything but lockstep, and `RoomView` began declaring
     * the field - so the premise died twice and nobody came back. Without
     * this, a creator switching to streaming while a VR player sits on the
     * launch screen leaves that player's copy saying `lockstep`: the guard
     * passes on stale state, and a lockstep session meets a `P2PRoom` in
     * mutual silence.
     */
    await broadcastRoomUpdate(io, room, getUserSocket);
    logger.info({ roomId: room.id, mode: data.emulationMode }, 'Emulation mode changed');
  });
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
export async function joinRoom(
  io: Server,
  socket: Socket,
  room: Room,
  user: User,
  getUserSocket: (id: string) => string | undefined
): Promise<boolean> {
  // Whichever door they came through, arriving is what makes them present -
  // and takes the room off the abandonment clock.
  markOnline(room, user.id);

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
    pseudo: user.pseudo,
    avatar: user.avatar ?? undefined,
    port: 2, // Guest always joins as player 2
    isReady: true, // Always ready by default
    emulationReady: false,
    online: true,
    keyConfig: userKeyConfig
  };

  room.players.push(player);
  socket.join(room.id);

  io.to(room.id).emit('room:updated', room);
  await broadcastRoomUpdate(io, room, getUserSocket);

  if (room.status === 'playing') {
    socket.emit('game:started');
    logger.info({ roomId: room.id, guest: user.pseudo }, 'Guest joined as Player 2 (game in progress)');
  }

  return true;
}

/**
 * Marks a user present in every room they belong to, and tells those rooms.
 *
 * The exact twin of `markPlayerAway` below, and it exists for the asymmetry it
 * closes: a disconnect marks a member away, but only `room:join` ever marked one
 * back - and only the room page emits it. A member sitting on their library was
 * therefore away for the rest of the session after a single reload, which showed
 * their partner an empty seat and collapsed the room to single player.
 *
 * This does not loosen the "away" guard on `game:start`. `online` already means
 * "a socket is connected and the seat is theirs", not "looking at the room
 * page": leaving that page has not marked anyone away since the lobby stopped
 * dying with it.
 */
export async function markPlayerPresent(
  io: Server,
  rooms: Map<string, Room>,
  userId: string,
  getUserSocket: (id: string) => string | undefined
) {
  for (const room of rooms.values()) {
    if (!markOnline(room, userId)) continue;
    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
  }
}

/**
 * Marks a user away in every room they belong to, and tells those rooms.
 *
 * Exported rather than inlined into the disconnect handler for two reasons.
 * The caller in `websocket/index.ts` must first decide whether this socket
 * closing means the *user* is gone - a client that reconnects registers its new
 * socket before the server declares the old one dead, and acting on the stale
 * one would mark somebody away who is sitting right there - so the guard has to
 * stay with the presence map. And the protocol test drives real sockets without
 * that map, so it needs the same body reachable on its own.
 */
export async function markPlayerAway(
  io: Server,
  rooms: Map<string, Room>,
  user: User,
  now: Date,
  getUserSocket: (id: string) => string | undefined
) {
  for (const room of rooms.values()) {
    if (!markOffline(room, user.id, now)) continue;

    /*
     * A room of one does not wait for its player to come back.
     *
     * Away-not-gone is a rule about groups: it keeps a seat warm for somebody a
     * second player is still waiting on. Alone there is nobody to wait, and the
     * room outliving the window costs its owner something real - one player may
     * only be in one room, so a solo room left `playing` disables every Play
     * button in their library until the twelve-hour sweep.
     *
     * The socket is already gone, hence `null`; `handleLeaveRoom` takes the
     * player out and, finding the room empty, tears it down and tells everyone.
     * Deleting the current entry while iterating a Map is defined behaviour.
     */
    if (endsWithItsPlayer(room)) {
      await handleLeaveRoom(io, null, room.id, rooms, user, getUserSocket);
      continue;
    }

    io.to(room.id).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
  }
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

  /*
   * Le partant, à qui plus rien ne parvient autrement.
   *
   * Tout ce qui suit passe par `io.to(roomId)`, et il vient d'être retiré de ce
   * canal : il ne recevait donc ni `player:left` ni `room:updated`, gardait le
   * salon dans son magasin, et voyait le bouton « quitter le groupe » jusqu'à
   * un rechargement. Quand il était le dernier, `room:destroyed` partait en
   * `io.emit` global et l'atteignait - le symptôme dépendait donc du nombre de
   * joueurs restants, ce qui est exactement ce qui le rendait déroutant.
   *
   * Émis avant la branche pour que le cas « dernier joueur » le reçoive aussi :
   * un seul chemin plutôt que deux qui se ressemblent.
   */
  socket?.emit('room:left', { roomId });

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
    logger.debug({ roomId, userId: user.id, pseudo: user.pseudo, wasHost }, 'Player left room');
    io.to(roomId).emit('player:left', {
      userId: user.id,
      pseudo: user.pseudo,
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
 * Tells every member of a room to go to its page.
 *
 * The one navigation channel, used by whoever chose the game *and* by the member
 * who did not - one path, so there is one behaviour to describe and one to test.
 *
 * Addressed per member, never with `io.to(room.id)`: a socket only enters a
 * room's channel through `room:create`, `lobby:accept` or `room:join`, and only
 * the room page emits the third. A member sitting on the library page is in the
 * channel until their first reload and out of it afterwards, while still holding
 * their seat - so the channel is exactly the wrong address here.
 *
 * `reason` travels because arriving is not always the same event: an invitee
 * seated into a room that is already playing is told so by the room screen,
 * which is what the `?from=invitation` marker has always been for.
 */
function openRoomForMembers(
  io: Server,
  room: Room,
  getUserSocket: (id: string) => string | undefined,
  reason?: 'invitation'
) {
  const payload = reason ? { roomId: room.id, reason } : { roomId: room.id };

  for (const player of room.players) {
    const socketId = getUserSocket(player.userId);
    if (socketId) io.to(socketId).emit('room:opened', payload);
  }
}

/**
 * Publishes a room update to the people entitled to see it: the players in the
 * room and the host's friends. This used to be an io.emit, which handed every
 * connected user each room's id and every player's keyConfig.
 */
export async function broadcastRoomUpdate(
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
