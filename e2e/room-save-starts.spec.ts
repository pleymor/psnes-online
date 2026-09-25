/**
 * Dans le salon en attente, un clic sur une sauvegarde lance la partie.
 *
 * Avant, il ne faisait que la poser, et il fallait encore appuyer sur
 * « Démarrer le jeu ». Deux choses sont vérifiées ici : un seul clic mène à la
 * surface de jeu sans toucher le bouton, et un double clic n'envoie qu'un seul
 * `game:start` - le serveur ne refuse pas le second, il relancerait la session.
 *
 * Même montage que `room-lobby-fit.spec.ts`, avec un hôte seul : c'est le cas
 * où le bouton est allumé dès l'arrivée, puisque le créateur est assis et prêt
 * d'office. La sauvegarde est écrite comme dans `resume-from-save.spec.ts` :
 * des octets que le serveur range et rend, jamais un état chargeable - la
 * surface de jeu apparaît sans ROM, c'est tout ce que ce test regarde.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { loginDev, apiFetch, connectSocket, waitForEvent, type TestSocket } from './helpers';

/** Aucun vrai dump ne porte cette somme : l'entrée est toujours la nôtre. */
const CHECKSUM = 'BEEF5A7E';

async function seatCookie(context: BrowserContext, cookie: string) {
	await context.addCookies(
		cookie.split('; ').map(pair => {
			const [name, ...rest] = pair.split('=');
			return { name, value: rest.join('='), domain: 'localhost', path: '/' };
		})
	);
}

/** Un salon en attente, son jeu, et une sauvegarde de l'hôte sur ce jeu. */
async function roomWithASave(cookie: string) {
	const game = await (
		await apiFetch(cookie, '/api/games', {
			method: 'POST',
			body: JSON.stringify({ checksum: CHECKSUM, filename: 'save-click-starts.sfc' })
		})
	).json();

	const host = await connectSocket(cookie);
	const created = waitForEvent<{ id: string }>(host, 'room:created', 10_000);
	host.emit('room:create', { gameId: game.id, gameTitle: game.title, autoStart: false });
	const room = await created;
	if (!room) throw new Error('room:created');

	const saved = waitForEvent<{ saveId: string }>(host, 'game:saved');
	host.emit('game:save', {
		roomId: room.id,
		name: 'Juste avant le boss',
		saveData: Buffer.alloc(1024, 7).toString('base64'),
		screenshot: null
	});
	if (!(await saved)) throw new Error('game:saved');

	return { game, roomId: room.id, host };
}

/** Compte les `game:start` que la page envoie sur sa socket. */
function countStarts(page: Page) {
	const sent: string[] = [];
	page.on('websocket', ws => {
		ws.on('framesent', frame => {
			if (typeof frame.payload === 'string' && frame.payload.includes('"game:start"')) {
				sent.push(frame.payload);
			}
		});
	});
	return sent;
}

async function openSaves(page: Page, roomId: string) {
	await page.goto(`/room/${roomId}`);
	await expect(page.locator('.btn-start')).toBeEnabled();
	await page.locator('.btn-setup', { hasText: /Démarrer sur une sauvegarde|Start from a save/ }).click();
	const tile = page.locator('.tile .pick').first();
	await expect(tile).toBeVisible();
	return tile;
}

test.describe('un clic sur une sauvegarde lance la partie', () => {
	let cookie: string;
	let game: { id: string } | null = null;
	let roomId: string | null = null;
	let host: TestSocket | null = null;

	test.beforeEach(async ({ context }) => {
		cookie = await loginDev('1');
		({ game, roomId, host } = await roomWithASave(cookie));
		await seatCookie(context, cookie);
	});

	test.afterEach(async () => {
		if (host && roomId) host.emit('room:leave', { roomId });
		host?.close();
		// La cascade emporte la sauvegarde avec le jeu.
		if (game) await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		game = null;
		roomId = null;
		host = null;
	});

	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 1440, height: 900 }
	]) {
		test(`un seul clic mène au jeu, sans le bouton (${viewport.width}x${viewport.height})`, async ({
			page
		}, testInfo) => {
			await page.setViewportSize(viewport);
			const starts = countStarts(page);
			const started = waitForEvent(host!, 'game:started', 15_000);

			const tile = await openSaves(page, roomId!);
			await page.screenshot({ path: testInfo.outputPath(`avant-${viewport.width}x${viewport.height}.png`) });

			await tile.click();

			expect(await started, 'le serveur a lancé la partie').not.toBeNull();
			await expect(page.locator('.solo')).toBeVisible();
			await expect(page.locator('.btn-start')).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath(`apres-${viewport.width}x${viewport.height}.png`) });

			expect(starts).toHaveLength(1);
		});
	}

	test('un double clic n’envoie qu’un seul lancement', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const starts = countStarts(page);
		let serverStarts = 0;
		host!.on('game:started', () => serverStarts++);

		const tile = await openSaves(page, roomId!);
		await tile.dblclick();

		await expect(page.locator('.solo')).toBeVisible();
		// Le temps qu'un second lancement, s'il était parti, revienne.
		await page.waitForTimeout(1500);
		expect(starts, 'game:start envoyés par la page').toHaveLength(1);
		expect(serverStarts, 'game:started reçus du serveur').toBe(1);
	});

	test('bouton éteint : le clic pose la sauvegarde et dit pourquoi rien ne part', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		const starts = countStarts(page);

		const tile = await openSaves(page, roomId!);
		// L'hôte rend sa manette : plus personne d'assis et prêt, le bouton s'éteint.
		host!.emit('room:unselectPort', { roomId });
		await expect(page.locator('.btn-start')).toBeDisabled();

		await tile.click();

		await expect(page.locator('.starting-save')).toContainText('Juste avant le boss');
		await expect(page.locator('.start-hint')).toBeVisible();
		await expect(page.locator('.solo')).toHaveCount(0);
		expect(starts).toHaveLength(0);
	});
});
