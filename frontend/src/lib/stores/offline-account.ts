import { writable } from 'svelte/store';

/**
 * Le compte qui jouait sur cet appareil, pour qu'il puisse jouer sans réseau
 * (#71).
 *
 * Sans lui, un joueur connecté qui ouvre l'application hors-ligne tombe dans
 * le mode sans compte de #70 : `/auth/me` n'a pas répondu, personne n'est
 * connecté, et ses sauvegardes de la soirée ne partiraient vers aucun compte.
 * Avec lui, l'appareil sait pour qui il garde la file.
 *
 * Ce n'est pas une session et cela n'en ouvre aucune : rien n'est envoyé au
 * nom de ce compte tant que le serveur ne l'a pas reconnu par son cookie, et
 * le serveur refuse de toute façon une écriture dont le `userId` n'est pas
 * celui de la session (`backend/src/api/sync.ts`). Il ne garde que ce qu'il
 * faut pour afficher « vous jouez hors-ligne en tant que … » : l'id, le
 * pseudo, le discriminant - jamais l'avatar ni rien que `/auth/me` dise en
 * plus.
 *
 * Retenu à chaque connexion réussie, oublié à la déconnexion : un navigateur
 * partagé ne doit pas présenter le compte du précédent au suivant.
 */
export interface RememberedAccount {
	id: string;
	pseudo: string;
	discriminator: string;
}

const KEY = 'psnes.account';

/** Le compte retenu, ou null. Lit sans lever : une navigation privée n'a pas de stockage. */
export function readRememberedAccount(storage: Pick<Storage, 'getItem'> | null): RememberedAccount | null {
	try {
		const raw = storage?.getItem(KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<RememberedAccount>;
		if (typeof parsed.id !== 'string' || typeof parsed.pseudo !== 'string' || typeof parsed.discriminator !== 'string') {
			return null;
		}
		return { id: parsed.id, pseudo: parsed.pseudo, discriminator: parsed.discriminator };
	} catch {
		return null;
	}
}

export function rememberAccount(
	storage: Pick<Storage, 'setItem'> | null,
	account: { id: string; pseudo: string; discriminator: string; isAnonymous?: boolean; needsPseudo?: boolean }
): void {
	// Un anonyme n'a pas de bibliothèque à retrouver hors-ligne, et un compte
	// qui n'a pas choisi son pseudonyme n'a pas encore passé le portique.
	if (account.isAnonymous || account.needsPseudo) return;
	try {
		storage?.setItem(
			KEY,
			JSON.stringify({ id: account.id, pseudo: account.pseudo, discriminator: account.discriminator })
		);
	} catch {
		// Stockage refusé : ce compte ne jouera pas hors-ligne sous son nom.
	}
}

export function forgetAccount(storage: Pick<Storage, 'removeItem'> | null): void {
	try {
		storage?.removeItem(KEY);
	} catch {
		// Rien à oublier.
	}
}

/**
 * Le compte dont on joue hors-ligne, posé par le layout quand `/auth/me` n'a
 * pas eu de réponse et qu'un compte est retenu. Null dans tous les autres cas,
 * y compris en ligne : là, c'est `user` qui dit qui joue.
 */
export const offlineAccount = writable<RememberedAccount | null>(null);
