import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findUserById } from '../db/users.js';
import { notifyFriendsStatusChanged, getOnlineFriends } from '../services/friends.js';
import {
  markPlayerAway,
  markPlayerPresent,
  registerRoomHandlers
} from './room-handlers.js';
import { registerInvitationHandlers, pendingInvitationsFor } from './invitation-handlers.js';
import { registerGameHandlers } from './game-handlers.js';
import { registerP2PHandlers } from './p2p-handlers.js';
import { registerSyncHandlers } from './sync-handlers.js';
import { registerZnetHandlers } from './znet-handlers.js';
import { registerRomTransferHandlers } from './rom-transfer.js';
import { registerMatchHandlers } from './match-handlers.js';
import { toPublicRoomFor, visibleRoomsFor } from './room-view.js';
import { gateAnonymousSocket } from './anonymous-gate.js';
import { anonymousRoomOf } from '../auth/anonymous.js';
import { createLogger } from '../utils/logger.js';
import { Presence } from './presence.js';
import { registerVrLobby, type VrLobby } from './vr-lobby.js';

const logger = createLogger('WebSocket');

const rooms = new Map<string, Room>();
const presence = new Presence();

/*
 * Le lobby VR détient sa carte et son battement, donc il n'existe qu'une fois -
 * et pas avant `io`, dont il a besoin pour parler. D'où cette variable plutôt
 * qu'un `const` à côté de `presence` : c'est `initializeWebSocket` qui la
 * remplit, et `attach` qui branche chaque connexion dessus.
 */
let vrLobby: VrLobby | null = null;

// Export io instance for use in other modules
let ioInstance: Server | null = null;

export function getIO(): Server | null {
  return ioInstance;
}

export function getUserSocket(userId: string): string | undefined {
  return presence.socketFor(userId);
}

/**
 * Qui est en VR, pour les trois endroits qui l'annoncent aux amis.
 *
 * Une fonction plutôt que `vrLobby.isInVr` passé directement : `vrLobby` est
 * nul tant que `initializeWebSocket` n'a pas tourné, et `api/friends.ts` a
 * besoin de la même réponse sans rien savoir de cette variable. Nul se lit
 * « personne n'est en VR », ce qui est la vérité avant qu'un lobby existe.
 */
export function isUserInVr(userId: string): boolean {
  return vrLobby?.isInVr(userId) === true;
}

/**
 * Deux joueurs viennent de cesser d'être amis : que le lobby VR l'apprenne.
 *
 * Le même détour que `isUserInVr` juste au-dessus, et pour la même raison :
 * `api/friends.ts` supprime l'amitié et n'a aucune raison de connaître
 * `vrLobby`, qui n'existe de toute façon pas avant `initializeWebSocket`. Nul
 * se lit « personne n'est en VR », donc il n'y a rien à oublier.
 *
 * Sans cet appel, le cache d'amis que le lobby a lu à `vr:enter` continue de
 * faire voyager la pose de chacun vers l'autre jusqu'à ce que l'un des deux
 * quitte la VR - voir `VrLobby.forgetFriendship`.
 */
export function forgetVrFriendship(userA: string, userB: string): void {
  vrLobby?.forgetFriendship(userA, userB);
}

export function getRooms(): Map<string, Room> {
  return rooms;
}

/**
 * Wraps socket.on so a throwing or rejecting handler is logged instead of
 * escalating to an unhandledRejection that would terminate the process.
 * Installed once per connection, before any handler is registered, so it
 * covers every event including ones added later.
 */
function protectHandlers(socket: Socket) {
  const originalOn = socket.on.bind(socket);
  (socket as any).on = (event: string, handler: (...args: any[]) => unknown) =>
    originalOn(event, (...args: any[]) => {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          result.catch(err => logger.error({ err, event }, 'Socket handler rejected'));
        }
      } catch (err) {
        logger.error({ err, event }, 'Socket handler threw');
      }
    });
}

export function initializeWebSocket(io: Server) {
  ioInstance = io;
  vrLobby = registerVrLobby(io, presence);

  io.on('connection', async (socket: Socket) => {
    try {
      await handleConnection(io, socket);
    } catch (err) {
      logger.error({ err, socketId: socket.id }, 'Connection setup failed');
      socket.disconnect();
    }
  });

  return { rooms };
}

async function handleConnection(io: Server, socket: Socket) {
  logger.debug({ socketId: socket.id }, 'Client connected');

  protectHandlers(socket);

  const session = (socket.request as any).session;
  const userId = session?.passport?.user;
  if (!userId) {
    socket.disconnect();
    return;
  }

  // Load full user data from database (WebSocket doesn't run deserializeUser)
  const user = findUserById(getDb(), userId);

  if (!user) {
    logger.error({ userId }, 'User not found');
    socket.disconnect();
    return;
  }

  // The onboarding gate, on the socket as well as on the routes. Without it an
  // account with no chosen pseudonym would still hold a presence, a claim on a
  // seat in a room, and a stream of friend:* events while the modal is up.
  //
  // The emit before the disconnect is not decoration: socket.io reconnects in
  // a loop otherwise, and the client never learns why.
  /*
   * La porte du joueur sans compte, et son unique salon.
   *
   * Un anonyme a `pseudoChosenAt` null comme un compte neuf, donc sans cette
   * branche placée *avant* le portique d'embarquement il serait renvoyé vers
   * une modale qu'il ne peut pas franchir. Il ne passe pas pour autant sans
   * contrôle : son socket n'existe que tant que le salon nommé par sa session
   * existe.
   *
   * Le salon est relu à chaque connexion et pas seulement à l'entrée : un
   * salon meurt quand son dernier joueur le quitte, et une session anonyme
   * survivrait au sien. Un socket sans salon n'aurait plus rien à faire ici -
   * il ne peut ni en créer un, ni en rejoindre un autre - mais il tiendrait
   * une présence et écouterait.
   *
   * L'`emit` avant la déconnexion pour la raison écrite plus bas : sans lui
   * socket.io reboucle et le client n'apprend jamais pourquoi.
   */
  if (user.isAnonymous) {
    const roomId = anonymousRoomOf(session);
    if (!roomId || !rooms.has(roomId)) {
      logger.info({ userId: user.id, roomId }, 'Refusing an anonymous socket whose room is gone');
      socket.emit('auth:anonymousRoomGone');
      socket.disconnect();
      return;
    }
  } else if (!user.pseudoChosenAt) {
    logger.info({ userId: user.id }, 'Refusing a socket from an account with no chosen pseudonym');
    socket.emit('auth:pseudoRequired');
    socket.disconnect();
    return;
  }

  /*
   * Le grillage, posé une fois et avant tout enregistrement.
   *
   * Après `protectHandlers`, donc à l'intérieur de sa protection, et avant les
   * `registerXHandlers` ci-dessous : un événement réservé aux comptes est
   * refusé au moment où son gestionnaire s'enregistre, ce qui couvre du même
   * coup les sept fichiers de gestionnaires et ceux qu'on ajoutera. Ne fait
   * rien pour un compte.
   */
  gateAnonymousSocket(socket, user);

  // The email is gone from this line along with the column. The pseudonym
  // stays: it is a pseudonym by construction, so it is loggable without
  // reservation, and it is what keeps these lines readable.
  logger.info({ userId: user.id, user: user.pseudo }, 'User connected');

  presence.register(user, socket.id);

  // Après `presence.register` : l'annonce « je suis en VR » passe par la carte
  // de présence pour joindre les amis, donc celui qui entre doit d'abord y être.
  vrLobby?.attach(socket, user);

  // Register every handler before awaiting anything else. socket.io discards
  // events that arrive with no listener attached, so any await placed before
  // this point is a window in which a client's first emit is silently dropped.
  socket.on('friends:getOnlineStatus', async () => {
    const onlineFriends = await getOnlineFriends(user.id, presence, { isInVr: isUserInVr });
    socket.emit('friends:online', onlineFriends);
  });

  registerRoomHandlers(socket, io, user, rooms, getUserSocket);
  registerInvitationHandlers(socket, io, user, rooms, getUserSocket);
  registerGameHandlers(socket, io, user.id, rooms, getUserSocket);
  registerP2PHandlers(socket, user, io, rooms);
  registerSyncHandlers(socket, io, user.id, rooms);
  registerZnetHandlers(socket, user, io, rooms);
  registerRomTransferHandlers(socket, user, io, rooms, getUserSocket);
  registerMatchHandlers(socket, io, user.id, rooms);

  /*
   * Back from wherever they were: their seat is theirs again in every room they
   * belong to.
   *
   * Before the two emits below, so the rooms list this socket is about to
   * receive already says so. Without this a member who reloaded any page other
   * than the room screen stayed marked away for the rest of the session: only
   * `room:join` ever marked anyone back, and only the room screen sends it.
   */
  await markPlayerPresent(io, rooms, user.id, getUserSocket);

  // Invitations that were waiting while they were away. Sent before the rooms
  // list because that list doubles as the "setup finished" signal, and scoped
  // to invitations addressed to this user: an invitation carries a room id, so
  // the same discipline applies here as below.
  socket.emit('lobby:invitations', pendingInvitationsFor(getDb(), user.id, rooms, new Date()));

  // Send current rooms list, scoped the same way as GET /api/rooms —
  // broadcasting every room here would hand out room ids (and previously
  // every player's keyConfig) to anyone who merely opened a socket.
  // Doubles as the "setup finished" signal for clients.
  const visible = await visibleRoomsFor(user.id, rooms);
  // Per caller, not per room: a friend's room is listed, but the person it is
  // waiting on is only named to the people actually in it.
  socket.emit('rooms:list', visible.map(room => toPublicRoomFor(room, user.id)));

  // Notify friends that this user is now online
  //
  // `isUserInVr` plutôt que `false` : une reconnexion pendant une session VR
  // repasse par ici, et annoncer « en ligne, pas en VR » la ferait disparaître
  // du lobby chez ses amis alors qu'elle a toujours le casque sur la tête.
  await notifyFriendsStatusChanged(io, user.id, true, isUserInVr(user.id), getUserSocket);

  // Disconnect
  socket.on('disconnect', async () => {
    logger.debug({ socketId: socket.id, user: user.pseudo }, 'Client disconnected');

    /*
     * Only act if this socket is still the user's current one.
     *
     * A client that reconnects registers its new socket immediately, while the
     * server may not declare the old one dead until its ping timeout - up to
     * twenty seconds later. Acting unconditionally tore down state belonging
     * to the *new* connection: the user vanished from the presence map, so
     * every targeted emit after that went nowhere. A new room simply never
     * appeared for the other player until they reloaded, and they showed as
     * offline to their friends.
     */
    if (!presence.unregister(user.id, socket.id)) {
      logger.debug(
        { socketId: socket.id, user: user.pseudo },
        'Stale socket closed, user already reconnected'
      );
      return;
    }

    // `false` en dur, et pas `isUserInVr` : un socket fermé ne porte pas de
    // casque, et la sortie du lobby VR peut arriver après cette ligne.
    await notifyFriendsStatusChanged(io, user.id, false, false, getUserSocket);

    // Away, not gone. Their seat, their port and their membership are all
    // still theirs; what changes is that a game can no longer start against
    // them, and that an empty room starts counting down.
    //
    // Below the stale-socket guard above, deliberately: acting on a socket the
    // user has already replaced would mark somebody away who is sitting there.
    await markPlayerAway(io, rooms, user, new Date(), getUserSocket);

  });
}
