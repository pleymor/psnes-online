/**
 * Le fond d'écran de la bibliothèque : le réglage retenu, et le tirage de
 * « Aléatoire » - toujours l'un des quatre murs, jamais deux fois de suite
 * le même.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_WALLPAPER,
	WALLPAPERS,
	drawWallpaper,
	pickWallpaper,
	readWallpaperChoice,
	writeWallpaperChoice,
	type Wallpaper
} from '../../frontend/src/lib/stores/wallpaper-preference.js';

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key)
	};
}

/** Un générateur déterministe, pour que mille tirages soient les mêmes à chaque lancement. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

test('there are four walls, and « Aléatoire » is the default', () => {
	assert.deepEqual([...WALLPAPERS], ['nineties', 'gamer', 'pastel', 'blue']);
	assert.equal(DEFAULT_WALLPAPER, 'random');
	assert.equal(readWallpaperChoice(memoryStorage()), 'random');
});

test('a chosen wall is kept, and choosing the default clears the key', () => {
	const storage = memoryStorage();
	writeWallpaperChoice(storage, 'pastel');
	assert.equal(readWallpaperChoice(storage), 'pastel');
	writeWallpaperChoice(storage, 'random');
	assert.equal(storage.data.size, 0);
	assert.equal(readWallpaperChoice(storage), 'random');
});

test('an unknown stored value is removed and reads as the default', () => {
	// `current` was the blue sky of the preview, and is no longer offered.
	const storage = memoryStorage({ 'psnes-wallpaper': 'current' });
	assert.equal(readWallpaperChoice(storage), 'random');
	assert.equal(storage.data.has('psnes-wallpaper'), false);
});

test('writing something that is not a choice stores nothing', () => {
	const storage = memoryStorage();
	writeWallpaperChoice(storage, 'sky' as Wallpaper);
	assert.equal(storage.data.size, 0);
});

test('a pick is always one of the four walls, even at the edges of the random range', () => {
	const random = seeded(7);
	for (let i = 0; i < 1000; i++) {
		const last = i % 5 === 4 ? null : WALLPAPERS[i % 4];
		assert.ok(WALLPAPERS.includes(pickWallpaper(last, random)));
	}
	for (const edge of [0, 0.999999, 1, -0.5, 2]) {
		assert.ok(WALLPAPERS.includes(pickWallpaper(null, () => edge)), `random() = ${edge}`);
		assert.ok(WALLPAPERS.includes(pickWallpaper('gamer', () => edge)), `random() = ${edge}`);
	}
});

test('a pick never repeats the last wall', () => {
	const random = seeded(42);
	for (const last of WALLPAPERS) {
		for (let i = 0; i < 250; i++) assert.notEqual(pickWallpaper(last, random), last);
	}
});

test('every other wall can come up', () => {
	const random = seeded(3);
	const seen = new Set<Wallpaper>();
	for (let i = 0; i < 200; i++) seen.add(pickWallpaper('blue', random));
	assert.deepEqual([...seen].sort(), ['gamer', 'nineties', 'pastel']);
});

test('successive visits never show the same wall twice in a row', () => {
	const storage = memoryStorage();
	const random = seeded(11);
	let previous = drawWallpaper(storage, random);
	for (let visit = 0; visit < 500; visit++) {
		const next = drawWallpaper(storage, random);
		assert.ok(WALLPAPERS.includes(next));
		assert.notEqual(next, previous);
		previous = next;
	}
});

test('a garbled last wall is ignored rather than trusted', () => {
	const storage = memoryStorage({ 'psnes-wallpaper-last': 'sky' });
	assert.ok(WALLPAPERS.includes(drawWallpaper(storage, () => 0.5)));
});
