/**
 * Le retour que la barre offre depuis un salon.
 *
 * Ce qui est gardé ici n'est pas l'apparence mais la NATURE du contrôle.
 * `way-back.ts` exclut le salon de sa liste, et dit pourquoi : quitter un
 * salon détache le jeu, rend le siège quand on est seul et oublie le salon
 * mémorisé, avant de naviguer. Un `<a href="/">` ne ferait rien de tout
 * cela et ramènerait le joueur à la bibliothèque encore assis dans un salon
 * que le serveur croit occupé.
 *
 * D'où l'assertion sur le nom de la balise, qui a l'air d'un détail et est
 * exactement la différence entre le contrôle voulu et le bug : les deux
 * mènent à `/`, un seul libère le siège.
 */

import { test, expect } from '@playwright/test';
import { loginDev, connectSocket, createRoom } from './helpers';

test('le retour depuis un salon emprunte l action de la page, pas un lien', async ({
	page,
	context
}) => {
	const cookie = await loginDev('1');
	await context.addCookies(
		cookie.split('; ').map(pair => {
			const [name, ...rest] = pair.split('=');
			return { name, value: rest.join('='), domain: 'localhost', path: '/' };
		})
	);

	const connection = await connectSocket(cookie);
	const socket = (connection as any).socket ?? connection;
	const room: any = await createRoom(socket, 'Chrono Trigger');
	const roomId = room?.id ?? room?.roomId ?? room;

	try {
		await page.goto(`/room/${roomId}`);
		const arrow = page.locator('.back.arrow');
		await expect(arrow).toBeVisible();

		// Une flèche seule, donc le nom vit dans l'étiquette accessible : sans
		// elle, ce bouton s'appellerait « » pour un lecteur d'écran.
		await expect(arrow).toHaveAttribute('aria-label', /.+/);

		// Le point entier de ce test.
		expect(await arrow.evaluate(el => el.tagName)).toBe('BUTTON');
		expect(await arrow.evaluate(el => el.getAttribute('href'))).toBeNull();

		await arrow.click();
		await expect(page).toHaveURL(/\/$/);
	} finally {
		socket?.close?.();
	}
});
