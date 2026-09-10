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
      const id = roomId();
      // Hors groupe il n'y a personne à qui parler, et le relais refuserait
      // de toute façon : tout passe par l'appartenance au salon.
      if (!id) return;
      get(socket)?.emit(event, { roomId: id, ...(payload as object) });
    },

    resolve: (crc32) => resolveQuietly(crc32, { requestPermission: false }),

    receive(crc32) {
      const id = roomId();
      const sock = get(socket);
      if (!id || !sock) return Promise.reject(new Error('no room to receive in'));
      return receiveRom({ socket: sock as never, roomId: id, expectedCrc32: crc32 });
    },

    async keep(bytes, crc32, title) {
      // Accepter, c'est avoir le jeu : les octets ET la fiche. Garder sans
      // inscrire laissait le joueur sans carte à cliquer, ce que le
      // 2026-09-10 a déjà appris une fois.
      await keepReceived(bytes, { title });
      try {
        await registerGame(crc32, romFileName(title, crc32));
      } catch (err) {
        logger.warn('kept the shared game but could not add it to the library', err);
      }
    },

    async send(to, bytes) {
      const id = roomId();
      const sock = get(socket);
      if (!id || !sock) return;
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
