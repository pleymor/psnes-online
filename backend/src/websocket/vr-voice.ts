/**
 * Qui s'entend parler en VR, et le seul fil qui passe par ici : la signalisation.
 *
 * LE SERVEUR NE TOUCHE JAMAIS À UN SON. La voix va d'un casque à l'autre en
 * WebRTC, pair à pair ; ce qui transite ici est l'offre, la réponse et les
 * candidats ICE d'une négociation - quelques kilo-octets de texte par
 * conversation, jamais un échantillon. Rien n'est ni enregistré ni persisté,
 * et le serveur n'a aucun moyen de l'être : il ne voit pas passer l'audio.
 *
 * QUI S'ENTEND EST CALCULÉ ICI, JAMAIS FOURNI PAR LE CLIENT - la règle même de
 * `vr-lobby.ts`, et pour la même raison. Deux joueurs s'entendent si et
 * seulement si :
 *
 * - ils sont amis acceptés, lu une fois à l'entrée comme le lobby le fait ;
 * - ET ils sont dans le même ESPACE : le lobby VR partagé (`lobby`), ou le
 *   même salon de groupe pendant une partie à deux (`room:<id>`), auquel cas
 *   l'appartenance au salon est revérifiée à chaque calcul.
 *
 * Un inconnu n'entre donc jamais dans une conversation, même assis dans le
 * même salon : l'amitié est une condition, pas une option. Et un ami resté au
 * lobby n'entend pas celui qui joue ailleurs.
 *
 * Un relais de signal ne part que vers un pair que CE calcul désigne au moment
 * où il passe. Un client modifié qui nommerait n'importe quel identifiant dans
 * `to` ne joint personne.
 *
 * SÉPARÉ DE `vr-lobby.ts` PARCE QUE LES DEUX N'ONT PAS LA MÊME VIE. La carte du
 * lobby perd le joueur dès qu'une partie commence (le rideau tombe, les têtes
 * disparaissent), alors que la voix est précisément ce qu'on veut garder
 * pendant une partie à deux. Les attacher au même état aurait coupé la parole
 * au premier « lance, on joue ».
 */
import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { listAcceptedFriendshipsWithProfiles } from '../db/friendships.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VrVoice');

/**
 * Le plus gros message de signalisation qu'on relaie.
 *
 * Une offre SDP audio seule tient en deux ou trois kilo-octets ; seize laissent
 * de la marge à une renégociation et à un navigateur bavard, et ferment la
 * porte à qui voudrait se servir de ce relais comme d'un tuyau de données.
 */
export const MAX_SIGNAL_BYTES = 16 * 1024;

/**
 * Le plafond de signaux par seconde et par client.
 *
 * Une négociation échange une offre, une réponse et une dizaine de candidats
 * de chaque côté, étalés sur une seconde. Soixante couvrent trois ou quatre
 * pairs qui négocient ensemble ; au-delà on ignore sans déconnecter, comme
 * `vr-lobby.ts` le fait pour les poses et pour la même raison.
 */
export const MAX_SIGNALS_PER_SECOND = 60;

/** `lobby`, ou `room:<id>`. */
type Space = string;

interface Speaker {
  socketId: string;
  friendIds: Set<string>;
  space: Space;
  /** Le salon qui a donné cet espace, `null` au lobby. */
  roomId: string | null;
  windowStart: number;
  signalsInWindow: number;
}

export interface VoicePeer {
  id: string;
  /**
   * Qui fait l'offre. Décidé ici plutôt que par chaque client, pour qu'il y en
   * ait toujours exactement un : deux offres croisées s'annulent, et aucune
   * n'est une offre qu'un seul des deux a le droit de faire.
   */
  initiator: boolean;
}

export interface VrVoice {
  /** Ces deux-là ne sont plus amis : qu'ils cessent de s'entendre, tout de suite. */
  forgetFriendship(userA: string, userB: string): void;
  /** Branche les écouteurs d'une connexion. Appelé une fois par socket. */
  attach(socket: Socket, user: User): void;
}

export interface VrVoiceOptions {
  /** Les amis acceptés d'un joueur. Par défaut, la base ; injectable pour les tests. */
  friendIdsOf?: (userId: string) => Set<string>;
}

function friendIdsFromDb(userId: string): Set<string> {
  return new Set(
    listAcceptedFriendshipsWithProfiles(getDb(), userId).map(friendship =>
      friendship.initiatorId === userId ? friendship.receiver.id : friendship.initiator.id
    )
  );
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

export function registerVrVoice(
  io: Server,
  rooms: Map<string, Room>,
  opts: VrVoiceOptions = {}
): VrVoice {
  const friendIdsOf = opts.friendIdsOf ?? friendIdsFromDb;
  const speakers = new Map<string, Speaker>();

  /** Est-il toujours assis dans le salon qui lui a donné son espace ? */
  function stillSeated(userId: string, speaker: Speaker): boolean {
    if (speaker.roomId === null) return true;
    const room = rooms.get(speaker.roomId);
    return !!room && room.players.some(p => p.userId === userId);
  }

  /**
   * Ceux que `userId` entend, et qui l'entendent - la relation est symétrique
   * par construction, puisque chaque condition l'est.
   */
  function peersOf(userId: string): VoicePeer[] {
    const me = speakers.get(userId);
    if (!me || !stillSeated(userId, me)) return [];
    const peers: VoicePeer[] = [];
    for (const friendId of me.friendIds) {
      const friend = speakers.get(friendId);
      if (!friend || friend.space !== me.space) continue;
      // Les deux caches, et pas le mien seul : `forgetFriendship` les vide
      // ensemble, mais une amitié acceptée après l'entrée de l'un n'est que
      // dans le cache de l'autre. On attend qu'ils soient d'accord.
      if (!friend.friendIds.has(userId)) continue;
      if (!stillSeated(friendId, friend)) continue;
      peers.push({ id: friendId, initiator: userId < friendId });
    }
    return peers;
  }

  /** Redit à chacun des concernés avec qui il parle désormais. */
  function announce(userIds: Iterable<string>): void {
    for (const userId of new Set(userIds)) {
      const speaker = speakers.get(userId);
      if (!speaker) continue;
      io.to(speaker.socketId).emit('vr:voice:peers', { peers: peersOf(userId) });
    }
  }

  /** Moi, et tous ceux de mes amis qui parlent : ceux que mon mouvement touche. */
  function touchedBy(userId: string, friendIds: ReadonlySet<string>): string[] {
    return [userId, ...[...friendIds].filter(id => speakers.has(id))];
  }

  function leave(userId: string, socketId: string): void {
    const entry = speakers.get(userId);
    // Claveté sur le socket, comme `vr-lobby.ts` : la mort tardive d'un vieux
    // socket ne doit pas couper la parole à la connexion neuve.
    if (!entry || entry.socketId !== socketId) return;
    speakers.delete(userId);
    announce(touchedBy(userId, entry.friendIds));
  }

  return {
    forgetFriendship(userA, userB) {
      speakers.get(userA)?.friendIds.delete(userB);
      speakers.get(userB)?.friendIds.delete(userA);
      // Contrairement aux poses, qui s'arrêtent d'elles-mêmes au battement
      // suivant, une connexion WebRTC ouverte continue sans le serveur. Il
      // faut donc le DIRE aux deux, pour qu'ils raccrochent.
      announce([userA, userB]);
    },

    attach(socket: Socket, user: User): void {
      socket.on('vr:voice:join', (data: unknown) => {
        const payload = data as { roomId?: unknown } | null;
        const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;

        let space: Space = 'lobby';
        if (roomId !== null) {
          const room = rooms.get(roomId);
          // Même refus muet que `getMemberRoom` : un non-membre n'apprend pas
          // si ce salon existe.
          if (!room || !room.players.some(p => p.userId === user.id)) {
            logger.warn({ userId: user.id, roomId }, 'Refused voice for a room the caller is not in');
            return;
          }
          space = `room:${roomId}`;
        }

        const before = speakers.get(user.id);
        const friendIds = friendIdsOf(user.id);
        speakers.set(user.id, {
          socketId: socket.id,
          friendIds,
          space,
          roomId,
          windowStart: Date.now(),
          signalsInWindow: 0
        });
        logger.debug({ user: user.pseudo, space }, 'voix VR ouverte');
        announce(touchedBy(user.id, new Set([...friendIds, ...(before?.friendIds ?? [])])));
      });

      socket.on('vr:voice:leave', () => leave(user.id, socket.id));
      socket.on('disconnect', () => leave(user.id, socket.id));

      socket.on('vr:voice:signal', (data: unknown) => {
        const me = speakers.get(user.id);
        if (!me || me.socketId !== socket.id) return;

        const now = Date.now();
        if (now - me.windowStart >= 1000) {
          me.windowStart = now;
          me.signalsInWindow = 0;
        }
        me.signalsInWindow += 1;
        if (me.signalsInWindow > MAX_SIGNALS_PER_SECOND) return;

        const payload = data as { to?: unknown; signal?: unknown } | null;
        const to = typeof payload?.to === 'string' ? payload.to : null;
        if (to === null || payload?.signal === undefined) return;
        if (sizeOf(payload.signal) > MAX_SIGNAL_BYTES) return;

        // LA règle : on ne relaie que vers quelqu'un que le calcul désigne
        // à cet instant. Tout le reste de ce fichier sert cette ligne.
        if (!peersOf(user.id).some(peer => peer.id === to)) return;
        const target = speakers.get(to);
        if (!target) return;
        io.to(target.socketId).emit('vr:voice:signal', { from: user.id, signal: payload.signal });
      });
    }
  };
}
