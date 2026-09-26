import { derived } from 'svelte/store';
import { user, userLoading } from './user';
import { linkState } from './connection';
import { playLocally } from './local-play';
import { offlineAccount } from './offline-account';
import { homeMode, onlineControls } from '../rooms/local-play';

/**
 * Quel accueil, lu par toutes les pages et non plus par la seule bibliothèque.
 *
 * Depuis que l'écran hors-ligne est l'écran en ligne, la barre, le profil et
 * le tiroir Amis doivent savoir s'ils tournent sans serveur : chacun garde ses
 * boutons, et éteint ceux qui en ont besoin. Un store dérivé plutôt que le même
 * appel recopié dans quatre composants, qui finiraient par ne pas trancher
 * pareil.
 */
export const currentHomeMode = derived(
	[user, userLoading, linkState, playLocally, offlineAccount],
	([$user, $loading, $link, $chosen, $offline]) =>
		homeMode({ user: $user, loading: $loading, link: $link, chosen: $chosen, offline: $offline })
);

/** Ce qui est allumé, éteint et pourquoi : `rooms/local-play.ts` en décide. */
export const controls = derived(currentHomeMode, ($mode) => onlineControls($mode));
