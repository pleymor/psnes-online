/**
 * Quel fond derrière la bibliothèque : l'un des quatre murs proposés, ou le
 * ciel d'aujourd'hui.
 *
 * Le temps que l'opérateur choisisse. `?bg=a|b|c|d|current` dans l'adresse
 * l'emporte, pour qu'un lien montre toujours le même fond ; sinon le dernier
 * choix du sélecteur, retenu dans ce navigateur.
 */

import { writable } from 'svelte/store';
import { replaceState } from '$app/navigation';

export const WALLS = ['current', 'a', 'b', 'c', 'd'] as const;
export type Wall = (typeof WALLS)[number];

export const WALL_NAMES: Record<Wall, string> = {
	current: 'Ciel actuel',
	a: 'A · Papier peint 90s',
	b: 'B · Chambre de gamer 16-bit',
	c: 'C · Pastel, ciel de nuit',
	d: 'D · Bleu repensé'
};

const KEY = 'psnes.bg-preview';

function isWall(value: unknown): value is Wall {
	return typeof value === 'string' && (WALLS as readonly string[]).includes(value);
}

function initial(): Wall {
	if (typeof window === 'undefined') return 'current';
	const asked = new URLSearchParams(window.location.search).get('bg');
	if (isWall(asked)) return asked;
	try {
		const kept = localStorage.getItem(KEY);
		if (isWall(kept)) return kept;
	} catch {
		// Navigation privée : on repart du ciel, c'est tout.
	}
	return 'current';
}

export const wall = writable<Wall>(initial());

export function chooseWall(next: Wall): void {
	wall.set(next);
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Voir plus haut.
	}
	const url = new URL(window.location.href);
	url.searchParams.set('bg', next);
	// Par le routeur : un `history.replaceState` nu, SvelteKit le reprendrait.
	replaceState(url, {});
}
