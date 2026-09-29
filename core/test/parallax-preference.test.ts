/**
 * L'interrupteur de la parallaxe du mur : allumé par défaut, seul « éteint »
 * s'écrit, et une valeur que ce build ne connaît pas est effacée.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_PARALLAX,
	readParallax,
	readWallpaperChoice,
	writeParallax,
	writeWallpaperChoice
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

test('the parallax is on by default', () => {
	assert.equal(DEFAULT_PARALLAX, true);
	assert.equal(readParallax(memoryStorage()), true);
});

test('turning it off is kept under its own key, and turning it back on clears it', () => {
	const storage = memoryStorage();
	writeParallax(storage, false);
	assert.equal(storage.data.get('psnes-parallax'), 'off');
	assert.equal(readParallax(storage), false);
	writeParallax(storage, true);
	assert.equal(storage.data.size, 0);
	assert.equal(readParallax(storage), true);
});

test('an unknown stored value is removed and reads as on', () => {
	const storage = memoryStorage({ 'psnes-parallax': 'maybe' });
	assert.equal(readParallax(storage), true);
	assert.equal(storage.data.has('psnes-parallax'), false);
});

test('the switch and the wall do not touch each other', () => {
	const storage = memoryStorage();
	writeWallpaperChoice(storage, 'gamer');
	writeParallax(storage, false);
	assert.equal(readWallpaperChoice(storage), 'gamer');
	writeWallpaperChoice(storage, 'random');
	assert.equal(readParallax(storage), false);
	assert.deepEqual([...storage.data.keys()], ['psnes-parallax']);
});
