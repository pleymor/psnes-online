/**
 * Starting a game already at one of its saves.
 *
 * This covers the half that can be covered: the library offers the saves it
 * already holds, and the chosen one is carried into the room.
 *
 * The other half - that a booted core is actually handed the save - was checked
 * by hand, and deliberately is not a test here. It needs a real ROM, so it can
 * only run against a game that is already in the library, and writing a
 * savestate into one is irreversible: nothing in this application can delete a
 * save. A test that leaked a savestate on every run would cost more than it is
 * worth. It becomes writable the day saves can be deleted.
 */

import { test, expect, type BrowserContext } from '@playwright/test';
import { loginDev, apiFetch, connectSocket, waitForEvent, keepRomOnDevice } from './helpers';

async function seatCookie(context: BrowserContext, cookie: string) {
	await context.addCookies(
		cookie.split('; ').map(pair => {
			const [name, ...rest] = pair.split('=');
			return { name, value: rest.join('='), domain: 'localhost', path: '/' };
		})
	);
}

/**
 * Adds a game, and says whether it was actually new.
 *
 * `POST /api/games` answers with the *existing* entry when the checksum is
 * already in the library - by design, so picking a ROM twice lands on it rather
 * than duplicating it. A test that ignored that would delete one of the
 * player's real games in its cleanup, and the cascade would take its saves.
 */
async function addGame(cookie: string, checksum: string, filename: string) {
	const game = await (
		await apiFetch(cookie, '/api/games', {
			method: 'POST',
			body: JSON.stringify({ checksum, filename })
		})
	).json();
	return { game, isOurs: game.filename === filename };
}

/** A library entry, plus one save written into it through the room it lives in. */
async function gameWithASave(cookie: string, checksum: string, filename: string) {
	const { game, isOurs } = await addGame(cookie, checksum, filename);

	const socket = await connectSocket(cookie);
	const created = waitForEvent<{ id: string }>(socket, 'room:created');
	socket.emit('room:create', { gameId: game.id, gameTitle: game.title, autoStart: false });
	const room = await created;
	if (!room) throw new Error('no room to write a save in');

	const saved = waitForEvent<{ saveId: string }>(socket, 'game:saved');
	socket.emit('game:save', {
		roomId: room.id,
		name: 'A place to come back to',
		// Not a loadable state - this half never starts a core. It only has to be
		// bytes the server stores and hands back.
		saveData: Buffer.alloc(1024, 7).toString('base64'),
		screenshot: null
	});
	const save = await saved;
	if (!save) throw new Error('the save was not written');

	socket.emit('room:leave', { roomId: room.id });
	socket.close();
	return { game, saveId: save.saveId, isOurs };
}

test.describe('resuming from a save', () => {
	test('the library offers its saves and carries the chosen one into the room', async ({
		page,
		context
	}) => {
		const cookie = await loginDev('1');
		const checksum = 'BEEF0001';
		const { game, saveId } = await gameWithASave(cookie, checksum, 'resume-wiring.sfc');
		await seatCookie(context, cookie);
		// The account owning the game is not enough for it to be on the grid:
		// the library shows what this device can open. See keepRomOnDevice.
		await keepRomOnDevice(page, checksum);

		// A request here would mean the grid fetched the saves itself. That
		// endpoint ships the savestates - about a megabyte each - and the library
		// already had the summaries, so this must stay at zero.
		const savesRequests: string[] = [];
		page.on('request', r => {
			if (/\/api\/games\/[^/]+\/saves/.test(r.url())) savesRequests.push(r.url());
		});

		try {
			await page.goto('/');
			await page.locator('.game-card', { hasText: 'resume-wiring' }).locator('.cover').click();

			const section = page.locator('.resume');
			await expect(section).toBeVisible();
			await expect(section.locator('.tile')).toHaveCount(1);
			await expect(section.locator('.tile')).toContainText('A place to come back to');

			await section.locator('.tile').first().click();
			await page.waitForURL(/\/room\/[^?]+\?save=/, { timeout: 15_000 });
			expect(new URL(page.url()).searchParams.get('save')).toBe(saveId);

			expect(savesRequests, 'the grid must not re-fetch what it was handed').toEqual([]);
		} finally {
			// Safe to delete outright: BEEF0001 is not any real dump, so this entry
			// is always one this test created, and the cascade takes its save.
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});

});
