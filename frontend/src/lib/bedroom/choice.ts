/**
 * Quel mur derrière la bibliothèque, pour cette visite.
 *
 * `wallpaperChoice` est le réglage du profil ; `wall` est le mur qu'on voit.
 * Sur « Aléatoire », le tirage se fait une fois, au premier mur demandé après
 * le chargement de la page : ce module vit tant que la page vit, donc on
 * navigue de la bibliothèque au profil et retour sans changer de mur, et un
 * rechargement en tire un autre.
 *
 * En développement seulement, `?bg=nineties|gamer|pastel|blue` l'emporte, pour
 * regarder un mur sans toucher au réglage. `import.meta.env.DEV` est remplacé
 * par `false` au build, et la branche disparaît avec lui.
 */

import { derived, writable } from 'svelte/store';
import type { PreferenceStorage } from '$lib/stores/shader-preference';
import {
	drawWallpaper,
	isWallpaper,
	pickWallpaper,
	readWallpaperChoice,
	writeWallpaperChoice,
	type Wallpaper,
	type WallpaperChoice
} from '$lib/stores/wallpaper-preference';

/** `localStorage`, ou rien : en navigation privée stricte, y toucher lève. */
function storage(): PreferenceStorage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

function readChoice(): WallpaperChoice {
	const store = storage();
	if (!store) return 'random';
	try {
		return readWallpaperChoice(store);
	} catch {
		return 'random';
	}
}

export const wallpaperChoice = writable<WallpaperChoice>(readChoice());

let visitPick: Wallpaper | null = null;

/** Le tirage de la visite, fait une fois, au premier mur demandé sur « Aléatoire ». */
function drawForVisit(): Wallpaper {
	if (visitPick) return visitPick;
	const store = storage();
	try {
		visitPick = store ? drawWallpaper(store) : pickWallpaper(null);
	} catch {
		visitPick = pickWallpaper(null);
	}
	return visitPick;
}

function devOverride(): Wallpaper | null {
	if (!import.meta.env.DEV || typeof window === 'undefined') return null;
	const asked = new URLSearchParams(window.location.search).get('bg');
	return isWallpaper(asked) ? asked : null;
}

export const wall = derived(wallpaperChoice, (choice): Wallpaper => {
	return devOverride() ?? (choice === 'random' ? drawForVisit() : choice);
});

export function chooseWallpaper(choice: WallpaperChoice): void {
	wallpaperChoice.set(choice);
	const store = storage();
	if (!store) return;
	try {
		writeWallpaperChoice(store, choice);
	} catch {
		// Voir `storage()` : le choix vaut pour cette visite, c'est tout.
	}
}
