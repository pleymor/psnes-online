import { Socket } from 'socket.io';
import { ANONYMOUS_FORBIDDEN } from '../auth/anonymous.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AnonymousGate');

/**
 * Ce qu'un joueur sans compte n'a pas à émettre, en une liste.
 *
 * La règle est « rejoindre un salon n'est pas posséder un compte ». Trois
 * familles :
 *
 * - **La configuration du salon.** `room:choose-game` et `room:choose-save`
 *   lisent la bibliothèque de celui qui les émet - un anonyme n'en a pas, donc
 *   il poserait dans le salon un jeu que personne ne possède, en effaçant au
 *   passage le checksum dont l'autre joueur a besoin pour trouver son fichier.
 *   `room:setEmulationMode` et `room:setLatencyMode` sont déjà réservés au
 *   créateur, ce qu'un anonyme ne peut jamais être ; ils sont quand même
 *   nommés ici, parce qu'une garantie qui tient par une propriété d'un autre
 *   fichier est une garantie qu'un jour on retire sans le savoir.
 *   `room:release-game` détache le jeu du salon pour les deux joueurs : c'est
 *   modifier la configuration, pas jouer.
 * - **Les bibliothèques.** `game:save`, `game:load` et `game:saveSram`
 *   écrivent ou lisent des lignes qui appartiennent au propriétaire du jeu.
 *   Leurs gestionnaires refusent déjà quelqu'un qui ne possède pas la partie,
 *   et c'est ici la règle qui le dit plutôt qu'un effet de bord de la
 *   vérification de propriété. #12 a mis les ROM sur la machine du joueur, et
 *   `device-library-guest.test.ts` fixe déjà la règle : recevoir n'est pas
 *   posséder. Un anonyme en est le cas le plus fort.
 * - **Le carnet d'adresses.** Amis et invitations supposent un compte à
 *   retrouver la semaine prochaine.
 *
 * L'inverse compte autant : s'asseoir, prendre un port, se dire prêt, lancer,
 * mettre en pause, quitter et tout le transport pair-à-pair restent ouverts.
 * Un anonyme qui ne peut pas prendre un port est assis dans un salon où rien
 * ne démarrera jamais - une autre façon de ne pas l'avoir laissé entrer.
 */
export const ACCOUNT_ONLY_EVENTS: ReadonlySet<string> = new Set([
  // La configuration du salon
  'room:create',
  'room:choose-game',
  'room:choose-save',
  'room:release-game',
  'room:setEmulationMode',
  'room:setLatencyMode',
  // Les bibliothèques et les sauvegardes
  'game:save',
  'game:load',
  'game:saveSram',
  // Les amis et les invitations
  'friends:getOnlineStatus',
  'lobby:invite',
  'lobby:cancel',
  'lobby:accept',
  'lobby:decline'
]);

export function isAccountOnly(event: string): boolean {
  return ACCOUNT_ONLY_EVENTS.has(event);
}

/**
 * Pose le refus sur un socket anonyme, une fois, avant tout enregistrement.
 *
 * Au moment de l'enregistrement plutôt que dans chaque gestionnaire, comme
 * `protectHandlers` juste à côté et pour la même raison : une garde par
 * gestionnaire est une garde que le prochain gestionnaire ajouté oubliera. Ici
 * la politique tient sur un écran, et un événement réservé ajouté à la liste
 * protège d'un coup tous les fichiers qui l'écoutent.
 *
 * Le refus est bruyant - un `error` portant le code, comme les routes HTTP -
 * plutôt qu'un silence : un client qui n'obtient pas de réponse réessaie, et
 * une fonctionnalité désactivée doit se distinguer d'une panne.
 *
 * Ne fait rien pour un compte : ce socket n'a rien à traverser.
 */
export function gateAnonymousSocket(socket: Socket, user: { isAnonymous: boolean }): void {
  if (!user.isAnonymous) return;

  const originalOn = socket.on.bind(socket);
  (socket as unknown as { on: unknown }).on = (
    event: string,
    handler: (...args: unknown[]) => unknown
  ) =>
    originalOn(event as never, ((...args: unknown[]) => {
      if (isAccountOnly(event)) {
        logger.warn({ event }, 'Refused an account-only event from an anonymous session');
        socket.emit('error', {
          message: 'This needs an account.',
          code: ANONYMOUS_FORBIDDEN,
          event
        });
        return;
      }
      return handler(...args);
    }) as never);
}
