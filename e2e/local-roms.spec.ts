/**
 * The library, now that ROMs stay on the player's machine.
 *
 * What this pins down is the contract between the two halves: the browser
 * computes a game's identity from the file it holds, and the server stores
 * only that identity. If they ever disagree on how a ROM is identified, a
 * player's saves detach from their game and a guest is told they have the
 * wrong cartridge when they do not - both silent, both miserable to diagnose.
 *
 * It also guards the promise the whole change rests on: no route hands out
 * ROM bytes any more.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { loginDev, apiFetch, connectSocket, waitForEvent } from './helpers';
import { crc32, normaliseRom, unzipFirstEntry } from '../frontend/src/lib/roms/checksum';

const romsDir = path.resolve(__dirname, '..', 'backend', 'roms');

function anyLocalRom(): string | null {
	if (!existsSync(romsDir)) return null;
	const found = readdirSync(romsDir).find((f) => /\.(smc|sfc|zip)$/i.test(f));
	return found ? path.join(romsDir, found) : null;
}

test('a game is added by what its file contains, never by uploading it', async () => {
	const romPath = anyLocalRom();
	test.skip(!romPath, 'no ROM available on this machine');

	const bytes = await unzipFirstEntry(new Uint8Array(readFileSync(romPath!)));
	const checksum = crc32(normaliseRom(bytes));

	const cookie = await loginDev('1');
	const filename = `e2e-${checksum}.sfc`;

	const created = await apiFetch(cookie, '/api/games', {
		method: 'POST',
		body: JSON.stringify({ checksum, filename })
	});
	expect(created.ok).toBeTruthy();
	const game = await created.json();

	try {
		expect(game.crc32).toBe(checksum);

		// Adding the same cartridge again lands on the same row rather than
		// making a second one, so saves stay in one place.
		const again = await apiFetch(cookie, '/api/games', {
			method: 'POST',
			body: JSON.stringify({ checksum, filename: 'a-different-name.sfc' })
		});
		expect((await again.json()).id).toBe(game.id);

		// The room a guest joins has to carry the checksum: it is all they get
		// to find their own copy with.
		const socket = await connectSocket(cookie);
		socket.emit('room:create', { gameId: game.id, gameTitle: game.title });
		const room = await waitForEvent<any>(socket, 'room:created', 5000);
		expect(room?.gameCrc32).toBe(checksum);
		socket.disconnect();
	} finally {
		await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
	}
});

test('no route serves ROM bytes any more', async () => {
	const cookie = await loginDev('1');

	for (const route of [
		'/api/games/drive-token',
		'/api/games/upload',
		'/api/games/add-from-drive'
	]) {
		const res = await apiFetch(cookie, route, { method: 'POST' });
		expect(res.status, `${route} must be gone`).toBe(404);
	}

	const games = await (await apiFetch(cookie, '/api/games')).json();
	if (games.length > 0) {
		const res = await apiFetch(cookie, `/api/games/${games[0].id}/download`);
		expect(res.status).toBe(404);
	}
});

test('a game with no checksum is offered a way back', async () => {
	// The six games carried over from the Drive era. They keep their saves, so
	// they must be re-linkable rather than thrown away.
	const cookie = await loginDev('1');

	const created = await apiFetch(cookie, '/api/games', {
		method: 'POST',
		body: JSON.stringify({ checksum: 'DEADBEEF', filename: 'legacy.sfc' })
	});
	const game = await created.json();

	try {
		const relinked = await apiFetch(cookie, `/api/games/${game.id}/checksum`, {
			method: 'PATCH',
			body: JSON.stringify({ checksum: 'CAFEBABE' })
		});
		expect(relinked.ok).toBeTruthy();
		expect((await relinked.json()).crc32).toBe('CAFEBABE');

		// And a checksum that is not one is refused rather than stored.
		const bad = await apiFetch(cookie, `/api/games/${game.id}/checksum`, {
			method: 'PATCH',
			body: JSON.stringify({ checksum: 'not-a-crc' })
		});
		expect(bad.status).toBe(400);
	} finally {
		await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
	}
});
