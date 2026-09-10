/**
 * L'unique conversation de partage de cette session.
 *
 * `keep-offer.ts` est une fabrique parce que deux salons ne coexistent pas
 * mais deux tests si ; ici c'est l'inverse qui décide. L'offre doit atteindre
 * le joueur où qu'il soit - c'est la raison pour laquelle `InvitationCard`
 * vit dans le layout et pas dans une page - alors que le geste d'envoyer part
 * de la bibliothèque. Deux endroits, une seule conversation, donc une seule
 * instance. La fabrique reste dans `roms/sharing.ts`, et c'est elle que les
 * tests utilisent.
 *
 * Construite paresseusement : les dépendances veulent la socket et IndexedDB,
 * dont aucune n'existe au moment où un module s'évalue.
 */

import { get } from 'svelte/store';
import { socket } from '$lib/api/socket';
import { myRoom } from '$lib/rooms/my-room';
import { games, loadGames } from '$lib/stores/games';
import { createSharing, type Sharing } from '$lib/roms/sharing';
import { resolveQuietly, keepReceived } from '$lib/roms/provider';
import { registerGame } from '$lib/roms/local-library';
import { romFileName } from '$lib/roms/rom-file';
import { receiveRom, sendRom } from '$lib/roms/transfer';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('Sharing');

let instance: Sharing | null = null;

/** Le salon du groupe, qui est ce qui autorise le transfert côté serveur. */
function roomId(): string | null {
  return get(myRoom)?.id ?? null;
}

export function sharing(): Sharing {
  if (instance) return instance;

  instance = createSharing({
    emit(event, payload) {
      /*
       * Le salon que la charge utile porte l'emporte sur celui du store.
       *
       * Une réponse à une offre répond sur le salon de l'offre - le serveur
       * vient de valider l'appartenance avant de la relayer. Ne consulter
       * `myRoom` que pour ce qui part d'ici, c'est-à-dire l'offre elle-même.
       */
      const carried = (payload as { roomId?: string }).roomId;
      const id = carried ?? roomId();
      const sock = get(socket);
      // Rendre `false` plutôt que se taire : l'appelant décide si une
      // question qui n'est pas partie doit quand même afficher une attente.
      if (!id || !sock) {
        logger.warn('nothing sent: no room or no socket', { event, room: id ?? null });
        return false;
      }
      sock.emit(event, { roomId: id, ...(payload as object) });
      return true;
    },

    resolve: (crc32) => resolveQuietly(crc32, { requestPermission: false }),

    /*
     * La bibliothèque, et pas ce que l'appareil sait ouvrir.
     *
     * `/api/games` est déjà en mémoire dans le store `games` : la question
     * « ce jeu est-il à moi » se lit dedans sans requête.
     */
    inLibrary: async (crc32) => get(games).some((g) => g.crc32 === crc32),

    receive(crc32, roomId) {
      const sock = get(socket);
      if (!sock) return Promise.reject(new Error('no socket to receive on'));
      return receiveRom({ socket: sock as never, roomId, expectedCrc32: crc32 });
    },

    async keep(bytes, crc32, title) {
      // Accepter, c'est avoir le jeu : les octets ET la fiche. Garder sans
      // inscrire laissait le joueur sans carte à cliquer, ce que le
      // 2026-09-10 a déjà appris une fois.
      await keepReceived(bytes, { title });
      try {
        await registerGame(crc32, romFileName(title, crc32));
        /*
         * Et relire la bibliothèque, sinon la carte n'apparaît qu'au prochain
         * chargement de page : la ligne existe côté serveur et rien sur
         * l'écran ne le sait. Accepter doit se voir tout de suite - c'est la
         * seule confirmation que le joueur reçoive.
         */
        await loadGames();
      } catch (err) {
        logger.warn('kept the shared game but could not add it to the library', err);
      }
    },

    async send(to, bytes) {
      const id = roomId();
      const sock = get(socket);
      if (!id || !sock) {
        logger.warn('asked to send a ROM with no room or no socket');
        return;
      }
      await sendRom({
        socket: sock as never,
        roomId: id,
        to,
        rom: bytes,
        // Rien ne tourne à 60 images par seconde ici - c'est tout l'intérêt
        // d'avoir sorti le partage du lancement - mais céder la main garde
        // l'interface vivante pendant quatre mégaoctets.
        pause: () => new Promise<void>((resolve) => setTimeout(resolve, 0))
      });
    }
  });

  return instance;
}

/** Pour les tests d'intégration, qui montent plusieurs sessions. */
export function forgetSharingForTest(): void {
  instance = null;
}
