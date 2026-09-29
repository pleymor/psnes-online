/**
 * Le fond d'écran de la bibliothèque : l'un des quatre murs de chambre, ou le
 * hasard.
 *
 * Rangé dans `localStorage` à côté du shader et du format d'image, parce que
 * c'est un réglage d'affichage de cet appareil comme eux : il marche sans
 * compte et sans réseau, et aucun réglage d'affichage ne passe par le serveur.
 *
 * « Aléatoire », le défaut, tire un mur par visite - un chargement de page - et
 * le garde tant qu'on navigue dans l'application. Le tirage suivant évite le
 * précédent, retenu sous sa propre clé : deux fois de suite le même mur, et le
 * hasard aurait l'air d'une panne.
 *
 * Prend son stockage plutôt que d'aller chercher `localStorage`, pour se
 * tester sans navigateur.
 */

import type { PreferenceStorage } from './shader-preference';

export const WALLPAPERS = ['nineties', 'gamer', 'pastel', 'blue'] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

export type WallpaperChoice = Wallpaper | 'random';
export const WALLPAPER_CHOICES: readonly WallpaperChoice[] = [...WALLPAPERS, 'random'];

export const DEFAULT_WALLPAPER: WallpaperChoice = 'random';

const KEY = 'psnes-wallpaper';
const LAST_KEY = 'psnes-wallpaper-last';

export function isWallpaper(value: unknown): value is Wallpaper {
	return typeof value === 'string' && (WALLPAPERS as readonly string[]).includes(value);
}

/** Un choix de fond, ou null quand la valeur n'en est pas un. */
export function parseWallpaperChoice(value: unknown): WallpaperChoice | null {
	return value === 'random' || isWallpaper(value) ? value : null;
}

/**
 * Le choix retenu, « Aléatoire » à défaut.
 *
 * Une valeur que ce build ne connaît pas est effacée, comme pour le format
 * d'image : laissée là, elle voudrait dire « Aléatoire » en ayant l'air d'un
 * choix.
 */
export function readWallpaperChoice(storage: PreferenceStorage): WallpaperChoice {
	const stored = storage.getItem(KEY);
	if (!stored) return DEFAULT_WALLPAPER;
	const choice = parseWallpaperChoice(stored);
	if (choice === null) {
		storage.removeItem(KEY);
		return DEFAULT_WALLPAPER;
	}
	return choice;
}

/** Retient le choix. Le défaut efface la clé. */
export function writeWallpaperChoice(storage: PreferenceStorage, choice: WallpaperChoice): void {
	if (parseWallpaperChoice(choice) === null) return;
	if (choice === DEFAULT_WALLPAPER) storage.removeItem(KEY);
	else storage.setItem(KEY, choice);
}

/**
 * Un mur au hasard parmi les quatre, jamais `last`.
 *
 * `random` rend un nombre dans [0, 1), comme `Math.random` : le test en passe
 * un qui ne l'est pas tout à fait, et le résultat reste dans la liste.
 */
export function pickWallpaper(last: Wallpaper | null, random: () => number = Math.random): Wallpaper {
	const pool = WALLPAPERS.filter((wall) => wall !== last);
	const index = Math.floor(random() * pool.length);
	return pool[Math.min(Math.max(index, 0), pool.length - 1)];
}

/**
 * Le tirage d'une visite : un mur qui n'est pas celui du tirage d'avant, et
 * qui devient à son tour « celui d'avant ».
 */
export function drawWallpaper(storage: PreferenceStorage, random: () => number = Math.random): Wallpaper {
	const last = storage.getItem(LAST_KEY);
	const wall = pickWallpaper(isWallpaper(last) ? last : null, random);
	storage.setItem(LAST_KEY, wall);
	return wall;
}

/*
 * La parallaxe du mur, qu'on peut couper : certains n'aiment pas voir le fond
 * bouger. Allumée par défaut, comme #100 l'a livrée ; seul « éteinte » s'écrit,
 * sous sa propre clé, à côté du mur.
 */

const PARALLAX_KEY = 'psnes-parallax';

export const DEFAULT_PARALLAX = true;

/**
 * La parallaxe est-elle voulue. Une valeur inconnue est effacée et vaut le
 * défaut, comme pour le mur.
 */
export function readParallax(storage: PreferenceStorage): boolean {
	const stored = storage.getItem(PARALLAX_KEY);
	if (!stored) return DEFAULT_PARALLAX;
	if (stored === 'off') return false;
	storage.removeItem(PARALLAX_KEY);
	return DEFAULT_PARALLAX;
}

/** Retient le choix. Le défaut efface la clé. */
export function writeParallax(storage: PreferenceStorage, on: boolean): void {
	if (on === DEFAULT_PARALLAX) storage.removeItem(PARALLAX_KEY);
	else storage.setItem(PARALLAX_KEY, 'off');
}
