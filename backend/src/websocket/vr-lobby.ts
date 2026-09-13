/**
 * Qui est dans le lobby VR, où, et à qui le dire.
 *
 * LE SERVEUR NE RELAIE RIEN. `vr:pose` écrit dans une carte et s'arrête là ;
 * c'est un unique battement qui parle. La conséquence est ce qui a fait
 * choisir cette forme : un client ne peut pas, en émettant plus vite,
 * augmenter la charge que ses amis reçoivent, et chacun reçoit UN message par
 * battement quel que soit son nombre d'amis présents.
 *
 * ET UN DÉPART EST UNE ABSENCE. Il n'y a pas de message « untel est parti » :
 * l'instantané suivant ne le contient plus, un point c'est tout. Ça supprime
 * toute une classe de courses - « il est parti » qui double « voici sa pose »
 * et laisse un fantôme - parce que présence et position sont le même message.
 *
 * L'ensemble des destinataires est calculé ICI, jamais fourni par le client,
 * et il est mis en cache à l'entrée : `listAcceptedFriendshipsWithProfiles`
 * touche la base, et l'appeler quinze fois par seconde et par joueur serait
 * exactement le défaut que ce module existe pour ne pas avoir.
 *
 * Aucune pose n'est persistée.
 */
import { Server, Socket } from 'socket.io';
import { User } from '../types/index.js';
import { Presence } from './presence.js';
import { getDb } from '../db/sqlite.js';
import { listAcceptedFriendshipsWithProfiles } from '../db/friendships.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VrLobby');

/** Quinze instantanés par seconde. */
export const BEAT_MS = 66;

/**
 * Le plafond d'un client, généreux d'un tiers par rapport aux quinze qu'il
 * doit émettre.
 *
 * Au-delà on IGNORE, on ne déconnecte pas : une rafale peut venir d'un réveil
 * de tâche ou d'une image en retard, et couper la session de quelqu'un pour ça
 * serait une punition sans faute. Le plafond n'est là que pour qu'un client
 * modifié ne puisse pas inonder la carte.
 *
 * La fenêtre est SAUTANTE et non glissante : le compteur repart de zéro dès que
 * la seconde est écoulée, donc 25 poses à 999 ms suivies de 25 à 1001 ms passent
 * toutes les cinquante. Ce facteur deux est sans importance ici, et le dire vaut
 * mieux que le corriger : ce plafond n'existe pas pour facturer à la pose mais
 * pour qu'une inondation soutenue soit impossible, et un client qui émettrait
 * 50 poses toutes les deux secondes n'inonde rien. Une fenêtre réellement
 * glissante demanderait de garder l'horodatage de chaque pose - de la mémoire
 * par joueur et par seconde, pour resserrer une borne dont personne n'a besoin.
 */
export const MAX_POSES_PER_SECOND = 25;

/** `[x, y, z, qx, qy, qz, qw]`. */
type Pose = [number, number, number, number, number, number, number];

interface PeerPose {
  head: Pose;
  left: Pose | null;
  right: Pose | null;
}

interface Present {
  /**
   * Le socket par lequel ce joueur est en VR. Clé de toute mutation : voir
   * `presence.ts` et la reconnexion tardive plus bas.
   */
  socketId: string;
  /**
   * Mutable, et c'est `forgetFriendship` qui l'exige.
   *
   * Ce cache est lu une fois à l'entrée - une lecture en base par battement et
   * par joueur serait le défaut que ce module existe pour ne pas avoir - donc
   * une amitié défaite en séance doit pouvoir y être retirée sur place, sans
   * rouvrir la base.
   */
  friendIds: Set<string>;
  pose: PeerPose | null;
  /** Fenêtre sautante du plafond de débit : voir `MAX_POSES_PER_SECOND`. */
  windowStart: number;
  posesInWindow: number;
}

export interface VrLobby {
  /** Pour `getOnlineFriends` : qui est actuellement en VR. */
  isInVr(userId: string): boolean;
  /**
   * Ces deux-là ne sont plus amis : qu'ils cessent de se voir, tout de suite.
   *
   * LE CACHE D'AMIS EST LU À L'ENTRÉE, donc une désamitié en séance ne
   * l'atteint pas : sans cet appel, chacun continue de recevoir la pose de
   * l'autre jusqu'à ce que l'un des deux quitte la VR. C'est la seule règle de
   * confidentialité de cette fonctionnalité - « aucune pose n'atteint quelqu'un
   * qui n'est pas un ami accepté » - et elle se tiendrait autrement à la durée
   * d'une session.
   *
   * DES DEUX CÔTÉS, parce que la carte porte deux entrées symétriques et qu'un
   * seul côté nettoyé laisserait la fuite dans l'autre sens.
   *
   * La défense côté client ne rattrape rien : sa liste d'amis est périmée dans
   * le MÊME sens que ce cache-ci - les deux se trompent ensemble - donc la
   * profondeur est illusoire et c'est bien ici qu'il faut couper le fil.
   */
  forgetFriendship(userA: string, userB: string): void;
  /** Arrête le battement. Pour les tests et l'arrêt du serveur. */
  stop(): void;
  /** Branche les écouteurs d'une connexion. Appelé une fois par socket. */
  attach(socket: Socket, user: User): void;
}

/**
 * Valide une pose à la FORME, et rend `null` sinon.
 *
 * Sept nombres finis, ou rien. Une pose partiellement valide qui passerait
 * donnerait un `NaN` dans une matrice, donc un ami qui disparaît du rendu chez
 * tous ses amis sans que rien ne soit journalisé nulle part.
 */
function readPose(value: unknown): Pose | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return null;
  }
  return value as Pose;
}

/**
 * `registerVrLobby` est appelé UNE fois au démarrage - il détient la carte et
 * le battement - et l'objet qu'il rend est branché par connexion via `attach`.
 * La même séparation que `Presence` (une instance) et `presence.register` (par
 * socket).
 */
export function registerVrLobby(io: Server, presence: Presence): VrLobby {
  const present = new Map<string, Present>();
  let beat: ReturnType<typeof setInterval> | null = null;

  /** Les amis acceptés de quelqu'un, lus une fois pour toute sa session VR. */
  function friendIdsOf(userId: string): Set<string> {
    return new Set(
      listAcceptedFriendshipsWithProfiles(getDb(), userId).map(friendship =>
        friendship.initiatorId === userId ? friendship.receiver.id : friendship.initiator.id
      )
    );
  }

  /*
   * Le battement n'existe pas tant que personne n'est là.
   *
   * Un serveur au repos ne doit pas se réveiller quinze fois par seconde pour
   * parcourir une carte vide. Armé au premier entrant, désarmé au dernier
   * sortant - et c'est un test qui le garde, sans quoi la version « toujours
   * armé » passerait inaperçue pour toujours.
   */
  function arm(): void {
    if (beat !== null) return;
    beat = setInterval(tick, BEAT_MS);
  }

  function disarm(): void {
    if (beat === null) return;
    clearInterval(beat);
    beat = null;
  }

  function tick(): void {
    for (const me of present.values()) {
      const peers = [];
      for (const friendId of me.friendIds) {
        const friend = present.get(friendId);
        // Pas encore de pose : présent mais pas encore situé. On ne l'annonce
        // pas, plutôt que de l'annoncer à l'origine du décor - ce qui le
        // ferait apparaître une image dans le comptoir avant de sauter à sa
        // vraie place.
        if (!friend || friend.pose === null) continue;
        peers.push({
          id: friendId,
          head: friend.pose.head,
          left: friend.pose.left,
          right: friend.pose.right
        });
      }
      // Jamais soi-même : la boucle parcourt `friendIds`, dont on ne fait pas
      // partie. L'exclusion est donc structurelle et non une condition qu'on
      // pourrait oublier.
      io.to(me.socketId).emit('vr:lobby', { peers });
    }
  }

  /**
   * Retire ce joueur, et rend l'entrée retirée - ou `null` si rien ne l'a été.
   *
   * Rendre l'entrée est ce qui évite de relire la base pour prévenir ses amis :
   * ses destinataires sont dedans, et on les tient donc encore en main après
   * coup. Un `null` dit du même souffle qu'il n'y a personne à prévenir.
   */
  function leave(userId: string, socketId: string): Present | null {
    const entry = present.get(userId);
    if (!entry) return null;
    /*
     * LA MUTATION EST CLAVETÉE SUR LE SOCKET.
     *
     * Le piège que `presence.ts` documente déjà, et qui a fait disparaître des
     * joueurs de la liste d'amis : un client qui se reconnecte enregistre son
     * nouveau socket tout de suite, tandis que le serveur peut ne déclarer
     * l'ancien mort que vingt secondes plus tard. Traiter cette mort sans
     * vérifier détruirait l'entrée de la connexion NEUVE.
     */
    if (entry.socketId !== socketId) return null;
    present.delete(userId);
    if (present.size === 0) disarm();
    return entry;
  }

  /**
   * Prévient les amis en ligne qu'on est entré ou sorti de la VR.
   *
   * Le même canal que `friend:statusChanged`, et volontairement : « en VR »
   * est un état d'ami comme « en ligne », pas un état d'une autre famille.
   * Sans ça, personne ne saurait depuis la page à plat qu'il y a quelqu'un à
   * rejoindre - et on ne met pas un casque au hasard.
   *
   * Les destinataires sont passés plutôt que relus : à la sortie, l'entrée
   * n'est déjà plus dans la carte, et rouvrir la base pour une liste qu'on
   * vient de tenir dans la main serait une lecture par sortie pour rien.
   */
  function notifyFriendsVrChanged(
    userId: string, friendIds: ReadonlySet<string>, inVr: boolean
  ): void {
    for (const friendId of friendIds) {
      const socketId = presence.socketFor(friendId);
      if (socketId) io.to(socketId).emit('friend:statusChanged', { userId, online: true, inVr });
    }
  }

  return {
    isInVr: userId => present.has(userId),

    /*
     * Aucune sortie du lobby, et c'est voulu : ils restent chacun en VR, avec
     * leurs autres amis. Ce qui disparaît est la ligne entre eux deux, et rien
     * d'autre - le battement suivant ne les mettra plus dans l'instantané de
     * l'autre, ce qui est exactement « un départ est une absence » appliqué à
     * un seul destinataire.
     */
    forgetFriendship(userA, userB) {
      present.get(userA)?.friendIds.delete(userB);
      present.get(userB)?.friendIds.delete(userA);
    },

    stop: disarm,

    attach(socket: Socket, user: User): void {
      socket.on('vr:enter', () => {
        // Entrer est un ÉTAT, pas un évènement : reçu deux fois, le second est
        // sans effet. Sinon un client qui réémet au retour d'un menu se
        // dédoublerait dans l'instantané de ses amis.
        const friendIds = friendIdsOf(user.id);
        const existing = present.get(user.id);
        present.set(user.id, {
          socketId: socket.id,
          friendIds,
          // Une réentrée depuis le même socket garde la pose : sinon l'ami
          // clignote hors du monde le temps d'un battement.
          pose: existing?.socketId === socket.id ? existing.pose : null,
          windowStart: Date.now(),
          posesInWindow: 0
        });
        arm();
        logger.debug({ user: user.pseudo }, 'entré dans le lobby VR');
        notifyFriendsVrChanged(user.id, friendIds, true);
      });

      socket.on('vr:pose', (data: unknown) => {
        const entry = present.get(user.id);
        // Clavetée sur le socket comme la sortie : une pose venue d'une
        // connexion que le joueur a déjà remplacée n'est pas la sienne.
        if (!entry || entry.socketId !== socket.id) return;

        const now = Date.now();
        if (now - entry.windowStart >= 1000) {
          entry.windowStart = now;
          entry.posesInWindow = 0;
        }
        entry.posesInWindow += 1;
        if (entry.posesInWindow > MAX_POSES_PER_SECOND) return;

        const payload = data as { head?: unknown; left?: unknown; right?: unknown } | null;
        const head = readPose(payload?.head);
        // Sans tête, pas de pose : les mains sans elle n'ont nulle part où
        // aller, et la proximité se mesure tête à tête.
        if (head === null) return;

        entry.pose = {
          head,
          left: readPose(payload?.left),
          right: readPose(payload?.right)
        };
      });

      socket.on('vr:leave', () => {
        const gone = leave(user.id, socket.id);
        if (gone) notifyFriendsVrChanged(user.id, gone.friendIds, false);
      });

      socket.on('disconnect', () => {
        const gone = leave(user.id, socket.id);
        if (gone) notifyFriendsVrChanged(user.id, gone.friendIds, false);
      });
    }
  };
}
