/**
 * Jouer sans compte, en solo, hors-ligne compris : ce que l'accueil montre.
 *
 * Le patron d'`anonymous-join.ts`, un fichier de plus : des fonctions pures,
 * sans store ni fetch, dont le seul rôle est que le joueur ne se voie pas
 * offrir des boutons qui échoueront.
 *
 * Le mot est `local`, et c'en est un troisième exprès. `guest` est le pair
 * non-hôte d'un salon ; `anonymous` est un joueur que le SERVEUR a créé pour
 * un salon (`backend/src/auth/anonymous.ts`), qui a besoin du réseau. Celui-ci
 * n'est créé par personne, ne parle à aucun serveur et vit dans le navigateur.
 */

import type { LinkState } from '../stores/connection.js';
import { AVAILABLE, unavailable, type Availability, type UnavailableReason } from './anonymous-join.js';

export type HomeMode =
	/** `/auth/me` n'a pas encore répondu : ne rien trancher. */
	| { kind: 'waiting' }
	/** Un compte - ou un anonyme - est là : l'accueil habituel. */
	| { kind: 'account' }
	/** Personne, le serveur répond : la page de connexion, avec son petit lien. */
	| { kind: 'signIn' }
	/** Solo sans compte. `why` dit si le joueur l'a choisi ou si le serveur s'est tu. */
	| { kind: 'local'; why: 'chosen' | 'unreachable' }
	/**
	 * Solo hors-ligne, sous le compte qui jouait sur cet appareil (#71) : sa
	 * bibliothèque telle qu'elle a été vue en ligne, et des sauvegardes qui
	 * partiront vers lui au retour du réseau.
	 */
	| { kind: 'offline-account'; account: { id: string; pseudo: string; discriminator: string } };

/**
 * Quel accueil montrer.
 *
 * Le basculement automatique n'a lieu que sur `unreachable` - le serveur n'a
 * JAMAIS répondu - et sur rien d'autre, par décision : `reconnecting` et
 * `offline` décrivent une connexion qui a existé, et un joueur avec un compte
 * dont le réseau hoquette ne doit pas voir sa bibliothèque remplacée par un
 * mode qui n'a ni ses jeux ni ses sauvegardes.
 *
 * Un compte l'emporte sur tout : s'il y a un `user`, le serveur a répondu à
 * `/auth/me`, et un `unreachable` ne peut alors venir que de la socket - ce
 * que le bandeau du layout dit déjà, sans rien retirer de l'écran.
 */
export function homeMode(input: {
	user: { isAnonymous: boolean } | null;
	loading: boolean;
	link: LinkState;
	chosen: boolean;
	/** Le compte retenu sur cet appareil, posé seulement quand le serveur s'est tu. */
	offline?: { id: string; pseudo: string; discriminator: string } | null;
}): HomeMode {
	if (input.loading) return { kind: 'waiting' };
	if (input.user) return { kind: 'account' };
	// Le compte retenu passe avant le mode sans compte : un joueur connecté
	// hier dont le réseau manque aujourd'hui est toujours ce joueur-là, et ses
	// sauvegardes de ce soir doivent partir vers lui.
	if (input.link === 'unreachable' && input.offline) {
		return { kind: 'offline-account', account: input.offline };
	}
	if (input.link === 'unreachable') return { kind: 'local', why: 'unreachable' };
	if (input.chosen) return { kind: 'local', why: 'chosen' };
	return { kind: 'signIn' };
}

/** Les deux accueils sans serveur : solo sans compte, et compte hors-ligne. */
export type OfflineMode = Extract<HomeMode, { kind: 'local' } | { kind: 'offline-account' }>;

export function isOfflineMode(mode: HomeMode): mode is OfflineMode {
	return mode.kind === 'local' || mode.kind === 'offline-account';
}

/**
 * Les contrôles de l'application en ligne qui demandent le serveur, un par un.
 *
 * Nommés par ce que le joueur voit, pas par la route qu'ils appellent : c'est
 * la liste que la revue relit pour savoir ce qui est éteint hors-ligne.
 */
export interface OnlineControls {
	/** Ouvrir le tiroir Amis. Il s'ouvre hors-ligne : la liste retenue s'y lit. */
	friendsDrawer: Availability;
	/** Inviter un ami, annuler une invitation, ajouter un ami, répondre à une demande. */
	friendActions: Availability;
	/** Le bouton VR de la barre : le lobby est sur le serveur. */
	vr: Availability;
	/** La fiche d'un jeu : salon, correction, suppression, partage, sauvegardes du serveur. */
	gameDetails: Availability;
	/** Rescanner le dossier : il inscrit les jeux trouvés au compte. */
	rescan: Availability;
	/** Changer de pseudonyme, les invitations d'inscription. */
	accountSettings: Availability;
	/** Exporter et importer sa configuration : les commandes vivent sur le compte. */
	configFile: Availability;
	/** Exporter ou importer ses sauvegardes : elles sont lues sur le serveur. */
	savesArchive: Availability;
	/** Se déconnecter : c'est le serveur qui ferme la session. */
	logout: Availability;
}

/**
 * Ce que l'application en ligne garde allumé, selon l'accueil.
 *
 * #70 retirait tout ce qui appartient à un compte (§4.4) ; c'est maintenant
 * éteint à sa place, avec sa raison, pour que l'écran hors-ligne soit l'écran
 * en ligne et non une page à part. Seul le tiroir Amis reste ouvrable pour un
 * compte hors-ligne : il montre les amis vus à la dernière connexion, et ce
 * qu'il propose y est éteint.
 */
export function onlineControls(mode: HomeMode): OnlineControls {
	const online = !isOfflineMode(mode);
	const ok = (allowed: boolean, reason: UnavailableReason) => (allowed ? AVAILABLE : unavailable(reason));
	const reason: UnavailableReason = mode.kind === 'local' ? 'needsAccount' : 'needsConnection';
	return {
		friendsDrawer: ok(mode.kind !== 'local', 'needsAccount'),
		friendActions: ok(online, reason),
		vr: ok(online, reason),
		gameDetails: ok(online, reason),
		rescan: ok(online, reason),
		accountSettings: ok(online, reason),
		configFile: ok(online, reason),
		savesArchive: ok(online, reason),
		logout: ok(online, 'needsConnection')
	};
}

/** Où mène « Jouer » sur un jeu local. Une route statique, donc précachée. */
export function localPlayHref(checksum: string): string {
	return `/local?rom=${encodeURIComponent(checksum)}`;
}

/**
 * Qui synchronise une partie jouée par `/local`.
 *
 * Le compte de la session s'il y en a un - un joueur connecté dont le serveur
 * vient de se taire en pleine soirée -, sinon celui retenu sur l'appareil,
 * sinon personne : c'est alors le joueur sans compte de #70, et rien ne part.
 */
export function localPlayer(
	user: { id: string; isAnonymous: boolean } | null,
	offline: { id: string } | null
): string | null {
	if (user) return user.isAnonymous ? null : user.id;
	return offline?.id ?? null;
}
