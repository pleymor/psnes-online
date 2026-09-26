/**
 * Hors-ligne d'abord, avec un compte (#71), sur un build et un vrai serveur.
 *
 * Trois choses, et la deuxième est le ticket (§9) :
 *
 *  1. un joueur connecté joue sans réseau - sa bibliothèque a ses titres et
 *     ses jaquettes, sa SRAM est écrite sur l'appareil et attend dans la file -
 *     puis le réseau revient et la file se vide toute seule ;
 *  2. deux navigateurs, un compte, le réseau coupé sur les deux, une partie
 *     avancée de chaque côté, puis le réseau rendu : la plus récente devient la
 *     SRAM, l'autre est une sauvegarde datée, et rien n'est perdu ;
 *  3. une synchronisation qui échoue se voit - en jeu, et sur le panneau ROM.
 *
 * La ROM est celle de `sram-counter-rom.ts` : elle compte ses démarrages dans
 * sa SRAM, donc l'octet 0 dit quelle partie on regarde. Le dossier de ROMs est
 * l'OPFS, comme dans `offline.spec.ts`.
 *
 * `bun run test:e2e:sync` - voir `offline-sync.config.ts` pour ce qui tourne.
 */

import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
	CHECKSUM,
	TITLE,
	SHOTS,
	newDevice,
	installWorker,
	signIn,
	addRomToLibrary,
	localCounter,
	serverSram,
	serverSaves,
	waitForGame,
	pauseAndPersist,
	playOnce,
	goOffline,
	goOnline
} from './offline-device';

test.describe.configure({ mode: 'serial' });

/* ------------------------------------------------------------------ 1 */

test('connecté puis hors-ligne : la bibliothèque garde titres et jaquettes, la SRAM attend, puis part au retour', async ({ browser }) => {
	const { context, page } = await newDevice(browser);
	await installWorker(page);
	await signIn(page, '1');
	await addRomToLibrary(page);

	// En ligne, la jaquette se charge - et le worker la garde.
	const onlineCover = page.getByTitle(TITLE).locator('img');
	await expect(onlineCover).toBeVisible();
	await expect.poll(() => onlineCover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
	await page.waitForTimeout(500);

	await goOffline(context, page);
	await expect(page.getByText(/You are playing as Dev/)).toBeVisible();
	const offlineCover = page.getByTitle(TITLE).locator('img');
	await expect(offlineCover).toBeVisible();
	await expect
		.poll(() => offlineCover.evaluate((img: HTMLImageElement) => img.naturalWidth), {
			message: 'la jaquette vue en ligne vient du cache du worker'
		})
		.toBeGreaterThan(0);
	await expect(page.getByText('All your saves are on the server.')).toBeVisible();
	await page.screenshot({ path: path.join(SHOTS, 'sync-offline-library.png'), fullPage: true });

	// Jouer hors-ligne, sous son compte.
	await page.getByTitle(TITLE).first().click();
	await expect(page).toHaveURL(new RegExp(`/local\\?rom=${CHECKSUM}`));
	await waitForGame(page);
	await pauseAndPersist(page);
	await expect.poll(() => localCounter(page)).not.toBeNull();
	// La SRAM vierge du cœur n'est pas nulle : on compare à ce que la partie a écrit.
	const played = (await localCounter(page))!;
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sync-badge')).toHaveText(/Offline · saved here/);
	await page.screenshot({ path: path.join(SHOTS, 'sync-offline-game-pending.png') });

	await page.goto('/');
	await expect(page.getByText('1 save waiting to be sent')).toBeVisible();
	await page.screenshot({ path: path.join(SHOTS, 'sync-offline-pending.png'), fullPage: true });

	// Le réseau revient : la file se vide sans que le joueur fasse rien.
	await goOnline(context, page);
	await expect.poll(() => serverSram(page), { timeout: 30_000 }).toBe(played);
	await page.goto('/profile');
	await expect(page.getByTestId('sync-status')).toContainText('All your saves are on the server.');
	await page.locator('section.rom-source').screenshot({ path: path.join(SHOTS, 'sync-rom-panel-sent.png') });

	await context.close();
});

/* ------------------------------------------------------------------ 2 */

test('deux navigateurs, un compte, hors-ligne tous les deux : la plus récente devient la SRAM, l\'autre est gardée datée, rien n\'est perdu', async ({ browser }) => {
	const a = await newDevice(browser);
	const b = await newDevice(browser);
	for (const d of [a, b]) {
		await installWorker(d.page);
		await signIn(d.page, '2');
		await addRomToLibrary(d.page);
	}

	// Une partie sur A, en ligne : c'est d'elle que A repartira.
	const a1 = await playOnce(a.page);
	await expect.poll(() => serverSram(a.page), { timeout: 30_000 }).toBe(a1);

	// Le réseau coupé sur les deux.
	await goOffline(a.context, a.page);
	await goOffline(b.context, b.page);

	// B avance plus loin, d'abord : trois démarrages sur son propre appareil,
	// qui n'a jamais vu la partie de A.
	let bLast = 0;
	for (let i = 0; i < 3; i++) bLast = await playOnce(b.page);
	// B part de la SRAM vierge du cœur, comme A l'avait fait : son premier démarrage vaut a1.
	expect(bLast).toBe((a1 + 2) & 0xff);
	// A joue ensuite, une fois : c'est la partie la plus récente.
	const aLast = await playOnce(a.page);
	expect(aLast).toBe((a1 + 1) & 0xff);

	// Le réseau rendu, B d'abord, A ensuite.
	await goOnline(b.context, b.page);
	await expect.poll(() => serverSram(b.page), { timeout: 30_000 }).toBe(bLast);
	await goOnline(a.context, a.page);
	await expect.poll(() => serverSram(a.page), { timeout: 30_000 }).toBe(aLast);

	// La plus récente est la SRAM ; la partie de B est gardée, datée ; et
	// chaque partie que chaque appareil a laissée existe quelque part.
	const saves = await serverSaves(a.page);
	const kept = saves.filter((s) => s.kind === 'sram');
	expect(kept.length).toBeGreaterThanOrEqual(1);
	expect(kept.map((s) => s.data)).toContain(bLast);
	const everything = [await serverSram(a.page), ...kept.map((s) => s.data)];
	expect(everything).toEqual(expect.arrayContaining([aLast, bLast]));

	// Le joueur la voit, datée, dans le menu de chargement, et peut la restaurer.
	await a.page.goto('/');
	await a.page.getByTitle(TITLE).first().click();
	await waitForGame(a.page);
	await a.page.keyboard.press('Escape');
	await a.page.getByRole('button', { name: 'Load Game' }).click();
	const tile = a.page.locator('.tile', { hasText: 'Kept cartridge save' }).first();
	await expect(tile).toBeVisible();
	await expect(tile.getByRole('button', { name: /Restore/ })).toBeVisible();
	await a.page.screenshot({ path: path.join(SHOTS, 'sync-conflict-kept.png') });

	// B, relancé en ligne, suit la plus récente : sa propre partie est là-bas.
	// Par `/local` : la partie de A tient encore le salon de ce compte, et le
	// chemin de la SRAM est le même dans les deux. A vient de redémarrer le jeu
	// pour ouvrir son menu, donc la plus récente est désormais celle-là.
	await expect.poll(() => serverSram(a.page), { timeout: 30_000 }).toBe((aLast + 1) & 0xff);
	const latest = (await serverSram(a.page))!;
	await b.page.goto(`/local?rom=${CHECKSUM}`);
	await waitForGame(b.page);
	await pauseAndPersist(b.page);
	await expect.poll(() => localCounter(b.page)).toBe((latest + 1) & 0xff);

	await a.context.close();
	await b.context.close();
});

/* ------------------------------------------------------------------ 3 */

test('une synchronisation qui échoue se voit : en jeu, et sur le panneau ROM, avec de quoi réessayer', async ({ browser }) => {
	const { context, page } = await newDevice(browser);
	await installWorker(page);
	await signIn(page, '1');
	await addRomToLibrary(page);

	await context.route('**/api/sync/**', (route) =>
		route.request().method() === 'GET'
			? route.continue()
			: route.fulfill({ status: 500, json: { error: 'boom' } })
	);

	await page.getByTitle(TITLE).first().click();
	await waitForGame(page);
	await pauseAndPersist(page);
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sync-badge')).toHaveText(/Sync failed/, { timeout: 15_000 });
	await page.screenshot({ path: path.join(SHOTS, 'sync-failed-game.png') });

	await page.goto('/profile');
	const panel = page.getByTestId('sync-status');
	await expect(panel).toContainText('1 save waiting to be sent');
	await expect(panel).toContainText('Sync failed: the server refused them for now');
	await page.locator('section.rom-source').screenshot({ path: path.join(SHOTS, 'sync-rom-panel-failed.png') });

	await context.unroute('**/api/sync/**');
	await panel.getByRole('button', { name: 'Retry now' }).click();
	await expect(panel).toContainText('All your saves are on the server.');

	await context.close();
});
