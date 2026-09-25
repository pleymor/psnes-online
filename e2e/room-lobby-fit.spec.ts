/**
 * L'écran d'attente d'un salon tient dans un téléphone, sans défiler.
 *
 * Mesuré avant la refonte, en 390x844 avec deux joueurs : 1245 px de page
 * pour 844 de fenêtre, et le bouton « Démarrer » 370 px sous le bord. Rien
 * dans la suite ne le voyait - on peut cliquer un bouton qu'il faut d'abord
 * aller chercher en faisant défiler.
 *
 * `scrollHeight` contre `innerHeight` est la mesure juste, pour la même
 * raison que `scrollWidth` dans `narrow-bar.spec.ts` : elle vaut la hauteur
 * de la fenêtre quand rien ne dépasse, davantage dès que quelque chose sort.
 * Deux joueurs assis, parce que c'est l'état le plus haut : le choix du mode
 * d'émulation n'apparaît qu'à partir de deux.
 */

import { test, expect } from '@playwright/test';
import { loginDev, apiFetch, connectSocket, waitForEvent, seatGuestByInvitation } from './helpers';

test('le salon en attente tient dans un écran de 390x844 sans défiler', async ({ page, context }) => {
	const hostCookie = await loginDev('1');
	const guestCookie = await loginDev('2');
	const game = await (
		await apiFetch(hostCookie, '/api/games', {
			method: 'POST',
			body: JSON.stringify({ checksum: 'FE000001', filename: 'Chrono Trigger (USA).sfc' })
		})
	).json();

	const host = await connectSocket(hostCookie);
	const guest = await connectSocket(guestCookie);
	let room: { id: string } | null = null;
	try {
		const created = waitForEvent<{ id: string }>(host, 'room:created', 10_000);
		host.emit('room:create', { gameId: game.id, gameTitle: game.title, autoStart: false });
		room = await created;
		expect(room, 'room:created').not.toBeNull();
		expect(
			await seatGuestByInvitation(hostCookie, guestCookie, host, guest, room!.id, 'dev-user-2'),
			'le second joueur est assis'
		).not.toBeNull();

		await context.addCookies(
			hostCookie.split('; ').map(pair => {
				const [name, ...rest] = pair.split('=');
				return { name, value: rest.join('='), domain: 'localhost', path: '/' };
			})
		);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/room/${room!.id}`);
		await expect(page.locator('.player')).toHaveCount(2);
		await expect(page.locator('.mode-segments')).toBeVisible();

		const { scrollHeight, innerHeight } = await page.evaluate(() => ({
			scrollHeight: document.documentElement.scrollHeight,
			innerHeight: window.innerHeight
		}));
		expect(scrollHeight, 'la page ne défile pas').toBeLessThanOrEqual(innerHeight);

		// Et le bouton de lancement est à l'écran, pas seulement dans la page.
		const start = (await page.locator('.btn-start').boundingBox())!;
		expect(start.y + start.height).toBeLessThanOrEqual(innerHeight);
	} finally {
		if (room) {
			host.emit('room:leave', { roomId: room.id });
			guest.emit('room:leave', { roomId: room.id });
		}
		host.close();
		guest.close();
	}
});
