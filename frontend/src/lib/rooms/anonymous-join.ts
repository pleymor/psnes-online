/**
 * La porte sans compte, côté navigateur.
 *
 * Trois fonctions pures, sans store ni fetch, pour la même raison que leur
 * jumelle `backend/src/auth/anonymous.ts` : ce sont des règles, elles doivent
 * se lire seules. Le serveur reste l'autorité - il refuse en 403 tout ce qui
 * appartient à un compte, quoi qu'affiche cet écran - et ce fichier existe pour
 * que le joueur ne se voie pas offrir des boutons qui échoueront.
 *
 * Le mot est `anonymous` et pas `guest` : dans ce dépôt un `guest` est le pair
 * non-hôte d'un salon (`webrtc/p2p-manager.ts`, `znet/protocol.ts`). Rôle dans
 * un salon d'un côté, identité de l'autre.
 */

/** L'état de la page d'un salon vis-à-vis de la porte sans compte. */
export type AnonymousJoinState =
  /** La session n'est pas encore lue : ne rien proposer. */
  | { kind: 'waiting' }
  /** Quelqu'un est là, compte ou anonyme : la page de salon fait son travail. */
  | { kind: 'joined' }
  /** Personne, et la porte est ouverte : proposer d'entrer dans ce salon. */
  | { kind: 'offer'; roomId: string }
  /** Personne, et pas de porte : la connexion est le seul chemin. */
  | { kind: 'signInOnly' };

/**
 * Que montrer à l'ouverture d'un lien de salon.
 *
 * `waiting` d'abord, et ce n'est pas de la prudence gratuite : `/auth/me` est
 * une requête, donc `user` vaut null pendant un instant à chaque chargement de
 * page. Sans cet état, l'offre d'entrer sans compte clignoterait devant un
 * joueur parfaitement connecté.
 *
 * `joined` couvre le compte *et* l'anonyme : une fois entré, un anonyme est un
 * joueur du salon comme un autre, et lui remontrer la porte serait lui proposer
 * d'ouvrir une seconde session par-dessus la sienne.
 */
export function anonymousJoinState(input: {
  user: { isAnonymous: boolean } | null;
  loading: boolean;
  enabled: boolean;
  roomId: string;
}): AnonymousJoinState {
  if (input.loading) return { kind: 'waiting' };
  if (input.user) return { kind: 'joined' };
  if (!input.enabled || !input.roomId) return { kind: 'signInOnly' };
  return { kind: 'offer', roomId: input.roomId };
}

/**
 * La clé de traduction pour un refus de `POST /auth/anonymous`.
 *
 * `ROOM_NOT_FOUND` couvre volontairement « ce salon n'existe pas » et « ce
 * salon est plein » : le serveur répond la même chose aux deux pour ne pas
 * confirmer l'existence d'un salon à qui en tient l'identifiant. Le message
 * doit donc rester vrai dans les deux cas - ce n'est pas un cas manquant.
 *
 * Un code inconnu tombe sur un message plutôt que sur rien : un écran muet
 * après un clic est indiscernable d'une page cassée.
 */
/**
 * Les clés que ce refus peut nommer, énumérées plutôt que `string`.
 *
 * Avec `string`, `t()` acceptait n'importe quoi et une clé renommée dans les
 * traductions n'aurait été découverte qu'à l'écran, sous la forme d'une clé
 * brute affichée au joueur. Le compilateur le voit maintenant.
 */
export type DoorMessageKey =
  | 'anonymousRoomGone'
  | 'anonymousAlreadySignedIn'
  | 'pseudoInvalid'
  | 'anonymousTooManyAttempts'
  | 'anonymousDisabled'
  | 'anonymousJoinFailed';

export function anonymousDoorMessage(status: number, error: string): DoorMessageKey {
  switch (error) {
    case 'ROOM_NOT_FOUND':
      return 'anonymousRoomGone';
    case 'ALREADY_SIGNED_IN':
      return 'anonymousAlreadySignedIn';
    case 'PSEUDO_INVALID':
      return 'pseudoInvalid';
    case 'TOO_MANY_ATTEMPTS':
      return 'anonymousTooManyAttempts';
    case 'ANONYMOUS_DISABLED':
      return 'anonymousDisabled';
    default:
      return 'anonymousJoinFailed';
  }
}

/** Ce qu'un écran a le droit de proposer, selon qui regarde. */
export interface AccountFeatures {
  /** La bibliothèque de jeux : `/api/games`. */
  library: boolean;
  /** Les amis, les demandes, les invitations : `/api/friends`, `lobby:*`. */
  friends: boolean;
  /** Le profil et le pseudonyme : `/api/user`, `/api/pseudo`. */
  profile: boolean;
  /** Sauvegarder, charger, la SRAM : `game:save`, `game:load`. */
  saves: boolean;
  /** Choisir le jeu, la sauvegarde de départ, les modes : la configuration du salon. */
  roomSetup: boolean;
}

const NOTHING: AccountFeatures = {
  library: false,
  friends: false,
  profile: false,
  saves: false,
  roomSetup: false
};

const EVERYTHING: AccountFeatures = {
  library: true,
  friends: true,
  profile: true,
  saves: true,
  roomSetup: true
};

/**
 * Ce que cet écran peut offrir à ce joueur.
 *
 * Le miroir exact des deux politiques du serveur - `requirePseudo` pour les
 * routes, `websocket/anonymous-gate.ts` pour les événements - et rien de plus :
 * ce n'est pas ici que l'autorisation est décidée, c'est ici qu'on évite
 * d'afficher un bouton dont on sait qu'il recevra 403.
 *
 * Rejoindre un salon n'est pas posséder un compte : un anonyme s'assoit, prend
 * un port, joue, met en pause et s'en va. Il ne configure pas le salon d'un
 * autre, ne sauvegarde pas sur la cartouche d'un autre, et ne se fait pas
 * d'amis - #12 a mis les ROM sur la machine du joueur, et recevoir une ROM
 * pour y jouer n'a jamais voulu dire la posséder.
 *
 * `null` répond comme un anonyme : sans session, aucun de ces écrans n'a de
 * sens, et répondre « oui » monterait des vues que la première requête
 * refuserait.
 */
export function accountFeaturesAllowed(user: { isAnonymous: boolean } | null): AccountFeatures {
  return user && !user.isAnonymous ? { ...EVERYTHING } : { ...NOTHING };
}
