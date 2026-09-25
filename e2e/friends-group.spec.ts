/**
 * Deux amis, deux navigateurs : inviter, former le groupe, le quitter.
 *
 * Ce qui est gardé ici, ce sont trois choses que l'on ne voit qu'avec deux
 * écrans ouverts à la fois. « Inviter » ferme le tiroir Amis. Quand A quitte
 * le groupe, B cesse de voir « Quitter le groupe » - le salon survit pour lui,
 * et c'est ce qui laissait le bouton en place - et apprend qui est parti. Et
 * « Retirer l'ami », qu'on lisait « retirer du groupe », porte désormais un nom
 * qui ne se confond avec rien.
 *
 * Les captures vont dans `test-results/friends-group/`, pour la description
 * de la PR.
 */

import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { loginDev, connectSocket, befriendDevUsers } from './helpers';

const SHOTS = 'test-results/friends-group';

async function signedIn(browser: Browser, cookie: string): Promise<BrowserContext> {
	// En français : c'est la langue du libellé et de la notification à vérifier.
	const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 800 } });
	await context.addCookies(
		cookie.split('; ').map(pair => {
			const [name, ...rest] = pair.split('=');
			return { name, value: rest.join('='), domain: 'localhost', path: '/' };
		})
	);
	return context;
}

/** Rend le siège que chacun tient peut-être d'une exécution précédente. */
async function leaveEveryRoom(cookie: string, userId: string) {
	const socket = await connectSocket(cookie);
	for (const room of socket.initialRoomsList ?? []) {
		if (room.players?.some((p: { userId: string }) => p.userId === userId)) {
			socket.emit('room:leave', { roomId: room.id });
		}
	}
	await new Promise(r => setTimeout(r, 300));
	socket.close();
}

test('inviter ferme le tiroir, et quitter le groupe se voit chez l autre', async ({ browser }) => {
	const cookieA = await loginDev('1');
	const cookieB = await loginDev('2');
	await befriendDevUsers(cookieA, cookieB);

	const me = async (cookie: string) =>
		(await fetch(`${process.env.E2E_API_URL || 'http://localhost:3000'}/auth/me`, {
			headers: { Cookie: cookie }
		}).then(r => r.json())) as { id: string; pseudo: string };
	const [userA, userB] = [await me(cookieA), await me(cookieB)];
	await leaveEveryRoom(cookieA, userA.id);
	await leaveEveryRoom(cookieB, userB.id);

	const contextA = await signedIn(browser, cookieA);
	const contextB = await signedIn(browser, cookieB);
	const a = await contextA.newPage();
	const b = await contextB.newPage();

	try {
		await a.goto('/');
		await b.goto('/');
		await expect(a.locator('.app-layout')).toBeVisible();
		await expect(b.locator('.app-layout')).toBeVisible();

		// A ouvre le tiroir Amis et invite B : le tiroir se ferme.
		await a.getByRole('button', { name: 'Amis' }).click();
		const drawer = a.locator('.friends-drawer');
		await expect(drawer).toBeVisible();
		await drawer.getByRole('button', { name: 'Inviter' }).click();
		await expect(drawer).toBeHidden();
		await expect(a.getByText(`En attente de ${userB.pseudo}`, { exact: false })).toBeVisible();

		// B accepte depuis sa notification : le groupe existe des deux côtés.
		await b.getByRole('button', { name: 'Accepter' }).click();
		const leaveA = a.getByRole('button', { name: 'Quitter le groupe' });
		const leaveB = b.getByRole('button', { name: 'Quitter le groupe' });
		await expect(leaveA).toBeVisible();
		await expect(leaveB).toBeVisible();
		await expect(b.getByText(`En groupe avec ${userA.pseudo}`)).toBeVisible();
		await b.screenshot({ path: `${SHOTS}/b-avant-depart.png` });

		// A quitte : B perd le bouton et apprend qui est parti.
		await leaveA.click();
		await expect(leaveA).toBeHidden();
		await expect(leaveB).toBeHidden();
		await expect(b.getByText(`En groupe avec ${userA.pseudo}`)).toBeHidden();
		await expect(b.getByRole('alert').filter({ hasText: `${userA.pseudo} a quitté le groupe` })).toBeVisible();
		await b.screenshot({ path: `${SHOTS}/b-apres-depart.png` });

		// Et le groupe se reforme : l'invitation est de nouveau offerte à B.
		await b.getByRole('button', { name: 'Amis' }).click();
		await expect(b.locator('.friends-drawer').getByRole('button', { name: 'Inviter' })).toBeVisible();

		// Le libellé renommé, dans la fiche de l'ami - sans rompre quoi que ce soit.
		await b.locator('.friends-drawer .friend-main').filter({ hasText: userA.pseudo }).click();
		const unfriend = b.getByRole('button', { name: 'Rompre cette belle amitié' });
		await expect(unfriend).toBeVisible();
		await expect(b.getByText("Retirer l'ami")).toHaveCount(0);
		// Le temps du fondu d entrée : la capture sert à la PR, pas à l assertion.
		await b.waitForTimeout(500);
		await b.screenshot({ path: `${SHOTS}/bouton-renomme.png` });

		// La confirmation reste, sous le même nom.
		await unfriend.click();
		await expect(b.getByRole('button', { name: 'Rompre cette belle amitié' }).last()).toBeVisible();
		await b.waitForTimeout(500);
		await b.screenshot({ path: `${SHOTS}/confirmation-renommee.png` });
		await b.getByRole('button', { name: 'Annuler' }).click();
	} finally {
		await contextA.close();
		await contextB.close();
	}
});
