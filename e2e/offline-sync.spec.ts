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

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { sramCounterRom } from './sram-counter-rom';
import { crc32, normaliseRom } from '../frontend/src/lib/roms/checksum';

const ROM_NAME = 'psnes-sram-counter.sfc';
const SRM_NAME = 'psnes-sram-counter.srm';
const ROM = sramCounterRom();
const CHECKSUM = crc32(normaliseRom(ROM));
const TITLE = 'Compteur de démarrages';
const SHOTS = path.join(__dirname, 'offline-shots');

test.describe.configure({ mode: 'serial' });

/* -------------------------------------------------------------- l'appareil */

async function newDevice(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport });
	await context.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
	});
	const page = await context.newPage();
	return { context, page };
}

/** Première visite, en ligne : le worker s'installe et prend la page. */
async function installWorker(page: Page): Promise<void> {
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
			);
		}
	});
}

async function signIn(page: Page, userId: '1' | '2'): Promise<void> {
	const res = await page.request.post('/auth/dev/login', { data: { userId } });
	expect(res.ok()).toBe(true);
}

/** La ROM dans le dossier, et le dossier choisi depuis le panneau ROM du profil. */
async function addRomToLibrary(page: Page): Promise<void> {
	await page.evaluate(
		async ({ name, bytes }) => {
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
			const file = await dir.getFileHandle(name, { create: true });
			const writable = await file.createWritable();
			await writable.write(new Uint8Array(bytes));
			await writable.close();
		},
		{ name: ROM_NAME, bytes: [...ROM] }
	);
	await page.goto('/profile');
	await page.getByRole('button', { name: 'Choose my ROM folder' }).click();
	// Le scan fini : un jeu ajouté au compte, ou déjà là pour le second appareil.
	await expect(page.getByText(/games added|already matches the folder/i)).toBeVisible({ timeout: 30_000 });
	await page.goto('/');
	await expect(page.locator('.game-card', { hasText: TITLE }).or(page.getByTitle(TITLE))).toBeVisible();
}

/** Octet 0 du `.srm` à côté de la ROM - la partie de cet appareil. */
function localCounter(page: Page): Promise<number | null> {
	return page.evaluate(async (name) => {
		try {
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('roms');
			const file = await (await dir.getFileHandle(name)).getFile();
			return new Uint8Array(await file.arrayBuffer())[0] ?? null;
		} catch {
			return null;
		}
	}, SRM_NAME);
}

/** Ce que le serveur tient, lu par la route de la file sous la session de la page. */
async function serverSram(page: Page): Promise<number | null> {
	const res = await page.request.get(`/api/sync/${CHECKSUM}/sram`);
	if (!res.ok()) return null;
	const body = (await res.json()) as { sram: string | null };
	return body.sram ? Buffer.from(body.sram, 'base64')[0] : null;
}

async function serverSaves(page: Page): Promise<{ kind: string; name: string; updatedAt: string; data: number }[]> {
	const games = (await (await page.request.get('/api/games')).json()) as { id: string; crc32: string }[];
	const game = games.find((g) => g.crc32 === CHECKSUM)!;
	const saves = (await (await page.request.get(`/api/games/${game.id}/saves`)).json()) as {
		kind: string; name: string; updatedAt: string; data: { data: number[] } | string;
	}[];
	return saves.map((s) => ({
		kind: s.kind,
		name: s.name,
		updatedAt: s.updatedAt,
		data: typeof s.data === 'string' ? Buffer.from(s.data, 'base64')[0] : s.data.data[0]
	}));
}

async function waitForGame(page: Page): Promise<void> {
	await expect(page.getByRole('button', { name: /Menu \(Esc\)/ })).toBeVisible({ timeout: 45_000 });
	await expect(page.locator('.solo .overlay')).toHaveCount(0, { timeout: 45_000 });
	await page.waitForTimeout(500);
}

/** Ouvrir le menu pause écrit la SRAM tout de suite : sur l'appareil, puis dans la file. */
async function pauseAndPersist(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.locator('.pause-menu')).toBeVisible();
}

/** Une partie : lancée depuis la bibliothèque, jouée jusqu'à la pause, quittée. */
async function playOnce(page: Page): Promise<number> {
	await page.goto('/');
	await page.getByTitle(TITLE).first().click();
	await waitForGame(page);
	await pauseAndPersist(page);
	await expect.poll(() => localCounter(page)).not.toBeNull();
	const counter = (await localCounter(page))!;
	await page.goto('/');
	return counter;
}

async function goOffline(context: BrowserContext, page: Page): Promise<void> {
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText('Offline', { exact: true })).toBeVisible();
}

async function goOnline(context: BrowserContext, page: Page): Promise<void> {
	await context.setOffline(false);
	// `online` fait redemander `/auth/me` au layout ; sa réponse ouvre la
	// socket, `connected` vide la file. Le rechargement est le même chemin par
	// le lancement de l'application, au cas où l'événement serait passé.
	await expect(page.getByText('Offline', { exact: true })).toHaveCount(0, { timeout: 15_000 }).catch(async () => {
		await page.reload();
	});
}

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
