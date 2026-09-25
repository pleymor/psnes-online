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
import type { AccountFeatures } from './anonymous-join.js';

export type HomeMode =
	/** `/auth/me` n'a pas encore répondu : ne rien trancher. */
	| { kind: 'waiting' }
	/** Un compte - ou un anonyme - est là : l'accueil habituel. */
	| { kind: 'account' }
	/** Personne, le serveur répond : la page de connexion, avec son petit lien. */
	| { kind: 'signIn' }
	/** Solo sans compte. `why` dit si le joueur l'a choisi ou si le serveur s'est tu. */
	| { kind: 'local'; why: 'chosen' | 'unreachable' };

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
}): HomeMode {
	if (input.loading) return { kind: 'waiting' };
	if (input.user) return { kind: 'account' };
	if (input.link === 'unreachable') return { kind: 'local', why: 'unreachable' };
	if (input.chosen) return { kind: 'local', why: 'chosen' };
	return { kind: 'signIn' };
}

/** Ce qu'un écran peut proposer en solo sans compte : ce qu'un compte offre, moins tout. */
export interface LocalFeatures extends AccountFeatures {
	/** Sauvegarder et charger, par le magasin local et non par la socket. */
	localSaves: boolean;
}

/**
 * Tout ce qui appartient à un compte disparaît : amis, salons, invitations,
 * profil, lobby VR, export de sauvegardes (#70 §4.4). Il ne reste que jouer et
 * sauvegarder sur cette machine.
 */
export function localFeatures(): LocalFeatures {
	return {
		library: false,
		friends: false,
		profile: false,
		saves: false,
		roomSetup: false,
		ratings: false,
		localSaves: true
	};
}

/** Où mène « Jouer » sur un jeu local. Une route statique, donc précachée. */
export function localPlayHref(checksum: string): string {
	return `/local?rom=${encodeURIComponent(checksum)}`;
}
