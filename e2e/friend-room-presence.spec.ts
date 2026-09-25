/**
 * « Dans un salon » suit l'appartenance : trois amis, trois navigateurs.
 *
 * A crée un salon et y fait entrer B, puis A « quitte le groupe ». Le salon
 * survit pour B. C, ami des deux, regarde sa liste : A n'y est plus « dans un
 * salon », B y est toujours. Avant, la liste rangeait les salons par leur
 * créateur - A restait dedans chez tous ses amis, et B, qui n'avait rien créé,
 * n'y apparaissait jamais.
 *
 * Les captures vont dans `test-results/friend-room-presence/`, pour la
 * description de la PR.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API, apiFetch, loginDev, connectSocket, befriendDevUsers, clearFriendships } from './helpers';

const SHOTS = 'test-results/friend-room-presence';

async function signedIn(browser: Browser, cookie: string): Promise<BrowserContext> {
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

/** `from` demande `handle` en ami, `to` accepte. */
async function befriend(from: string, to: string, handle: string) {
	const request = await apiFetch(from, '/api/friends/request', {
		method: 'POST',
		body: JSON.stringify({ handle })
	}).then(r => r.json());
	await apiFetch(to, `/api/friends/accept/${request.id}`, { method: 'POST' });
}

/** La ligne d'un ami dans le tiroir, et ce qu'elle dit de lui. */
function friendRow(page: Page, pseudo: string) {
	return page.locator('.friends-drawer .friend').filter({ hasText: pseudo });
}

test('quitter le groupe sort de « Dans un salon » chez ses amis, pas celui qui reste', async ({ browser }) => {
	const cookieA = await loginDev('1');
	const cookieB = await loginDev('2');
	const cookieC = await loginDev('4');

	const me = async (cookie: string) =>
		(await fetch(`${API}/auth/me`, { headers: { Cookie: cookie } }).then(r => r.json())) as {
			id: string;
			pseudo: string;
		};
	const [userA, userB, userC] = [await me(cookieA), await me(cookieB), await me(cookieC)];

	// A-B par l'aide commune (qui efface d'abord toutes leurs amitiés), puis C
	// ami des deux.
	await clearFriendships(cookieC);
	await befriendDevUsers(cookieA, cookieB);
	await befriend(cookieA, cookieC, 'DevFour#0004');
	await befriend(cookieB, cookieC, 'DevFour#0004');

	await leaveEveryRoom(cookieA, userA.id);
	await leaveEveryRoom(cookieB, userB.id);
	await leaveEveryRoom(cookieC, userC.id);

	const contextA = await signedIn(browser, cookieA);
	const contextB = await signedIn(browser, cookieB);
	const contextC = await signedIn(browser, cookieC);
	const a = await contextA.newPage();
	const b = await contextB.newPage();
	const c = await contextC.newPage();

	try {
		for (const page of [a, b, c]) {
			await page.goto('/');
			await expect(page.locator('.app-layout')).toBeVisible();
		}

		// C ouvre sa liste et la garde ouverte : tout ce qui suit doit lui
		// parvenir sans rechargement.
		await c.getByRole('button', { name: 'Amis' }).click();
		await expect(c.locator('.friends-drawer')).toBeVisible();
		await expect(friendRow(c, userA.pseudo).locator('.online-status')).toHaveText('En ligne');
		await expect(friendRow(c, userB.pseudo).locator('.online-status')).toHaveText('En ligne');

		// A crée le groupe en invitant B, B accepte.
		await a.getByRole('button', { name: 'Amis' }).click();
		await friendRow(a, userB.pseudo).getByRole('button', { name: 'Inviter' }).click();
		await expect(a.getByText(`En attente de ${userB.pseudo}`, { exact: false })).toBeVisible();
		await b.getByRole('button', { name: 'Accepter' }).click();
		const leaveA = a.getByRole('button', { name: 'Quitter le groupe' });
		await expect(leaveA).toBeVisible();
		await expect(b.getByRole('button', { name: 'Quitter le groupe' })).toBeVisible();

		// Tous deux dans un salon chez C - B compris, qui ne l'a pas créé.
		await expect(friendRow(c, userA.pseudo).locator('.room-status')).toHaveText('Dans un salon');
		await expect(friendRow(c, userB.pseudo).locator('.room-status')).toHaveText('Dans un salon');
		await c.screenshot({ path: `${SHOTS}/c-avant-depart.png` });

		// A quitte. Le salon survit pour B.
		await leaveA.click();
		await expect(leaveA).toBeHidden();
		await expect(b.getByRole('alert').filter({ hasText: `${userA.pseudo} a quitté le groupe` })).toBeVisible();

		// Chez C : A n'est plus dans aucun salon, B y est toujours.
		await expect(friendRow(c, userA.pseudo).locator('.room-status')).toHaveCount(0);
		await expect(friendRow(c, userA.pseudo).locator('.online-status')).toHaveText('En ligne');
		await expect(friendRow(c, userB.pseudo).locator('.room-status')).toHaveText('Dans un salon');
		await c.screenshot({ path: `${SHOTS}/c-apres-depart.png` });

		// Chez B, resté dans le salon : A n'y est plus.
		await b.getByRole('button', { name: 'Amis' }).click();
		await expect(friendRow(b, userA.pseudo).locator('.room-status')).toHaveCount(0);
		await expect(friendRow(b, userA.pseudo).locator('.online-status')).toHaveText('En ligne');
		await b.screenshot({ path: `${SHOTS}/b-apres-depart.png` });

		// Chez A, ami de B : B est toujours dans un salon.
		await expect(a.locator('.friends-drawer')).toBeHidden();
		await a.getByRole('button', { name: 'Amis' }).click();
		await expect(friendRow(a, userB.pseudo).locator('.room-status')).toHaveText('Dans un salon');

		// Un rechargement reconstruit la même chose, depuis le serveur.
		await c.reload();
		await expect(c.locator('.app-layout')).toBeVisible();
		await c.getByRole('button', { name: 'Amis' }).click();
		await expect(friendRow(c, userB.pseudo).locator('.room-status')).toHaveText('Dans un salon');
		await expect(friendRow(c, userA.pseudo).locator('.online-status')).toHaveText('En ligne');
		await expect(friendRow(c, userA.pseudo).locator('.room-status')).toHaveCount(0);
		await c.screenshot({ path: `${SHOTS}/c-apres-rechargement.png` });

		// B part à son tour, seul dans son salon : le salon meurt, et B en sort
		// chez C. Par un socket à part - seul, B n'a plus de bouton pour partir.
		await leaveEveryRoom(cookieB, userB.id);
		await expect(friendRow(c, userB.pseudo).locator('.room-status')).toHaveCount(0);
	} finally {
		await contextA.close();
		await contextB.close();
		await contextC.close();
	}
});
