/**
 * Les sauvegardes prises en ligne, retrouvées hors-ligne - dans le même menu.
 *
 * Le défaut rapporté : sauvegarder en ligne, couper le réseau, rouvrir le jeu,
 * et ne rien trouver. Les savestates pris en ligne partaient par la socket
 * seule, et rien n'en restait sur l'appareil ; ceux que le serveur tenait
 * déjà n'étaient jamais rapatriés. Et le menu hors-ligne était un autre
 * composant, à trois emplacements. Trois choses sont donc prouvées ici, sur
 * un build et un vrai serveur (`offline-sync.config.ts`) :
 *
 *  1. une sauvegarde prise en ligne (SRAM et savestate) est là hors-ligne,
 *     après un rechargement, dans le menu de toujours, et se charge ;
 *  2. une sauvegarde qui existait déjà sur le serveur - semée par l'API, pas
 *     par l'appareil - est là hors-ligne après UN chargement en ligne de la
 *     bibliothèque, y compris sur un appareil neuf qui n'a jamais ouvert le
 *     jeu, SRAM comprise ;
 *  3. deux appareils écrasent hors-ligne la même sauvegarde : au retour du
 *     réseau, rien n'est perdu - le serveur et chaque appareil gardent les deux.
 *
 * Les captures du menu en ligne et hors-ligne, à 390×844 et 1440×900, vont
 * dans `e2e/offline-shots/`.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
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
	waitForGame,
	pauseAndPersist,
	goOffline,
	goOnline
} from './offline-device';

test.describe.configure({ mode: 'serial' });

/** Le compte de cette suite : ni celui ni ceux de `offline-sync.spec.ts`. */
const USER = '4';
const USER_ID = 'dev-user-4';
const SEEDED = 'Semée';

type Device = { context: BrowserContext; page: Page };
let wide: Device;
let narrow: Device;

/* -------------------------------------------------------------- lectures */

interface KeptState {
	id: string;
	name: string;
	serverId: string | null;
	supersedes: string | null;
}

/** Les savestates que l'appareil garde, tels que le menu hors-ligne les montre. */
async function keptStates(page: Page, options: { all?: boolean } = {}): Promise<KeptState[]> {
	const all = await page.evaluate(
		() =>
			new Promise<KeptState[]>((resolve) => {
				const open = indexedDB.open('psnes-local');
				open.onerror = () => resolve([]);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains('states')) {
						db.close();
						resolve([]);
						return;
					}
					const request = db.transaction('states', 'readonly').objectStore('states').getAll();
					request.onsuccess = () => {
						db.close();
						resolve(
							(request.result as KeptState[]).map((m) => ({
								id: m.id,
								name: m.name,
								serverId: m.serverId,
								supersedes: m.supersedes
							}))
						);
					};
					request.onerror = () => {
						db.close();
						resolve([]);
					};
				};
			})
	);
	if (options.all) return all;
	const replaced = new Set(all.map((m) => m.supersedes).filter(Boolean));
	return all.filter((m) => !replaced.has(m.id));
}

/**
 * Octet 0 de la SRAM que l'appareil garde, où qu'elle soit : à côté de la ROM,
 * ou dans le navigateur quand le dossier n'avait pas encore indexé la ROM au
 * moment du rapatriement. Le magasin local lit les deux et croit la plus
 * récente ; ici, l'une ou l'autre suffit.
 */
async function keptSram(page: Page): Promise<number | null> {
	const inFolder = await localCounter(page);
	if (inFolder !== null) return inFolder;
	return page.evaluate(
		(key) =>
			new Promise<number | null>((resolve) => {
				const open = indexedDB.open('psnes-local');
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains('saves')) {
						db.close();
						resolve(null);
						return;
					}
					const get = db.transaction('saves', 'readonly').objectStore('saves').get(key);
					get.onsuccess = () => {
						db.close();
						resolve((get.result as { bytes: Uint8Array } | undefined)?.bytes?.[0] ?? null);
					};
					get.onerror = () => {
						db.close();
						resolve(null);
					};
				};
			}),
		`${CHECKSUM}:srm`
	);
}

async function serverStates(page: Page): Promise<{ id: string; name: string; updatedAt: string }[]> {
	const games = (await (await page.request.get('/api/games')).json()) as {
		crc32: string;
		saves: { id: string; name: string; kind?: string; updatedAt: string }[];
	}[];
	return (games.find((g) => g.crc32 === CHECKSUM)?.saves ?? []).filter((s) => s.kind !== 'sram');
}

/** Une sauvegarde écrite sur le serveur par l'API, sans passer par cet appareil. */
async function seedServerState(page: Page, name: string): Promise<void> {
	const [first] = await serverStates(page);
	// Des octets de savestate réels, pour qu'elle se charge : ceux de la
	// sauvegarde que la partie vient d'écrire.
	const source = (await (await page.request.get(`/api/sync/${CHECKSUM}/states/${first.id}`)).json()) as {
		data: string;
	};
	const res = await page.request.post(`/api/sync/${CHECKSUM}/states`, {
		data: {
			syncId: `seed-${Date.now()}`,
			userId: USER_ID,
			name,
			data: source.data,
			screenshot: null,
			savedAt: Date.now() - 1000
		}
	});
	expect(res.ok()).toBe(true);
}

/* -------------------------------------------------------------- gestes */

async function openGame(page: Page): Promise<void> {
	await page.goto('/');
	await page.getByTitle(TITLE).first().click();
	await waitForGame(page);
	await pauseAndPersist(page);
}

async function openLoadMenu(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Load Game' }).click();
	await expect(page.locator('.submenu .grid-note', { hasText: 'Loading' })).toHaveCount(0);
}

/**
 * Chargée : le menu de chargement se referme de lui-même, et seulement alors.
 * Pas le toast - les toasts se taisent pendant une partie et vont au centre de
 * notifications.
 */
async function expectLoaded(page: Page): Promise<void> {
	await expect(page.locator('.submenu')).toHaveCount(0);
}

async function closeSubmenu(page: Page): Promise<void> {
	await page.locator('.submenu').getByRole('button', { name: 'Close' }).click();
}

/** Écraser la sauvegarde semée, depuis le menu d'écriture. */
async function overwriteSeeded(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Save Game' }).click();
	await page.locator('.tile', { hasText: SEEDED }).first().locator('.pick').click();
	await page.locator('.modal-content').getByRole('button', { name: 'Overwrite' }).click();
	await expect(page.locator('.submenu .tile', { hasText: SEEDED })).toHaveCount(1);
	await expect(page.locator('.submenu .btn-new')).toBeEnabled();
}

/* ------------------------------------------------------------------ 1 */

test('sauvegardé en ligne (SRAM et savestate), retrouvé hors-ligne dans le même menu, et chargé', async ({ browser }) => {
	wide = await newDevice(browser, { width: 1440, height: 900 });
	const { context, page } = wide;
	await installWorker(page);
	await signIn(page, USER);
	await addRomToLibrary(page);

	// En ligne, dans un salon solo : la SRAM part à la pause, le savestate par
	// le menu.
	await openGame(page);
	await expect(page).toHaveURL(/\/room\//);
	await page.getByRole('button', { name: 'Save Game' }).click();
	await page.getByRole('button', { name: /New save/ }).click();
	await expect(page.locator('.submenu .tile')).toHaveCount(1);
	await closeSubmenu(page);
	await expect.poll(() => serverSram(page), { timeout: 30_000 }).not.toBeNull();
	await expect.poll(async () => (await keptStates(page)).length, {
		message: 'le savestate pris en ligne est gardé sur l\'appareil, avant même la bibliothèque'
	}).toBe(1);

	// Une sauvegarde que le serveur a, et que cet appareil n'a jamais écrite.
	await seedServerState(page, SEEDED);

	await openLoadMenu(page);
	await expect(page.locator('.submenu .tile')).toHaveCount(2);
	await page.screenshot({ path: path.join(SHOTS, 'saves-menu-online-1440x900.png') });

	// Un chargement de la bibliothèque, en ligne : la semée est rapatriée.
	await page.goto('/');
	await expect.poll(async () => (await keptStates(page)).map((s) => s.name).sort(), { timeout: 30_000 }).toContain(SEEDED);

	await goOffline(context, page);
	await page.getByTitle(TITLE).first().click();
	await expect(page).toHaveURL(new RegExp(`/local\\?rom=${CHECKSUM}`));
	await waitForGame(page);
	await pauseAndPersist(page);

	// Le même menu : « Charger », les mêmes tuiles, et ce qui demande le
	// serveur est grisé, avec la raison.
	await openLoadMenu(page);
	const tiles = page.locator('.submenu .tile');
	await expect(tiles).toHaveCount(2);
	await expect(page.getByText(/Offline: these are the saves kept on this device/)).toBeVisible();
	await expect(tiles.first().locator('.remove')).toBeDisabled();
	await expect(tiles.first().locator('.remove')).toHaveAttribute('title', /Requires a connection/);
	await page.screenshot({ path: path.join(SHOTS, 'saves-menu-offline-1440x900.png') });

	await page.locator('.submenu .tile', { hasText: SEEDED }).locator('.pick').click();
	await expectLoaded(page);

	// L'autre, celle prise en ligne dans le salon, se charge aussi.
	await openLoadMenu(page);
	await page.locator('.submenu .tile').filter({ hasNotText: SEEDED }).locator('.pick').click();
	await expectLoaded(page);
});

/* ------------------------------------------------------------------ 2 */

test('un appareil neuf : un chargement de la bibliothèque en ligne suffit pour tout retrouver hors-ligne, SRAM comprise', async ({ browser }) => {
	narrow = await newDevice(browser, { width: 390, height: 844 });
	const { context, page } = narrow;
	await installWorker(page);
	await signIn(page, USER);
	// Le scan du dossier charge la bibliothèque : c'est le chargement en ligne.
	await addRomToLibrary(page);

	const onServer = await serverSram(page);
	expect(onServer).not.toBeNull();
	await expect.poll(async () => (await keptStates(page)).length, { timeout: 30_000 }).toBe(2);
	// La SRAM du serveur est sur l'appareil, sans que le jeu ait été ouvert.
	await expect.poll(() => keptSram(page), { timeout: 30_000 }).toBe(onServer);

	await goOffline(context, page);
	await page.getByTitle(TITLE).first().click();
	await waitForGame(page);
	await pauseAndPersist(page);
	// La partie hors-ligne repart de la SRAM du serveur : un démarrage de plus.
	await expect.poll(() => keptSram(page)).toBe((onServer! + 1) & 0xff);

	await openLoadMenu(page);
	await expect(page.locator('.submenu .tile')).toHaveCount(2);
	await page.screenshot({ path: path.join(SHOTS, 'saves-menu-offline-390x844.png') });
	await page.locator('.submenu .tile', { hasText: SEEDED }).locator('.pick').click();
	await expectLoaded(page);

	// Le même menu en ligne, à la même largeur.
	await page.goto('/');
	await goOnline(context, page);
	await openGame(page);
	await openLoadMenu(page);
	await expect(page.locator('.submenu .tile')).toHaveCount(2);
	await page.screenshot({ path: path.join(SHOTS, 'saves-menu-online-390x844.png') });
	await page.goto('/');
});

/* ------------------------------------------------------------------ 3 */

test('la même sauvegarde écrasée hors-ligne sur deux appareils : au retour, les deux versions restent partout', async () => {
	await wide.page.goto('/');
	await narrow.page.goto('/');
	// Chaque appareil a la copie de la semée, à jour.
	await expect.poll(async () => (await keptStates(narrow.page)).length, { timeout: 30_000 }).toBe(2);

	await goOffline(wide.context, wide.page);
	await goOffline(narrow.context, narrow.page);

	// Le grand écran écrase la semée d'abord, le petit ensuite.
	for (const device of [wide, narrow]) {
		await device.page.getByTitle(TITLE).first().click();
		await waitForGame(device.page);
		await pauseAndPersist(device.page);
		const before = (await keptStates(device.page, { all: true })).length;
		await overwriteSeeded(device.page);
		// Une fiche de plus, qui remplace l'autre sans l'effacer.
		await expect.poll(async () => (await keptStates(device.page, { all: true })).length).toBe(before + 1);
		// Hors-ligne, l'écrasement remplace la sauvegarde à l'écran.
		await expect.poll(async () => (await keptStates(device.page)).filter((s) => s.name === SEEDED).length).toBe(1);
		await device.page.goto('/');
	}

	// Le réseau revient, grand écran d'abord : son écrasement passe tel quel.
	await goOnline(wide.context, wide.page);
	await expect.poll(async () => (await serverStates(wide.page)).filter((s) => s.name === SEEDED).length, { timeout: 30_000 }).toBe(1);
	// Puis le petit : la semée qu'il croyait écraser a changé entre-temps. Le
	// serveur garde les deux, datées.
	await goOnline(narrow.context, narrow.page);
	await expect
		.poll(async () => (await serverStates(narrow.page)).filter((s) => s.name === SEEDED).length, {
			timeout: 30_000,
			message: 'rien n\'est écrasé : la version divergente devient une sauvegarde de plus'
		})
		.toBe(2);

	// Chaque appareil, après un chargement de la bibliothèque, garde les deux.
	for (const device of [narrow, wide]) {
		await device.page.goto('/');
		await expect
			.poll(async () => (await keptStates(device.page)).filter((s) => s.name === SEEDED && s.serverId).length, {
				timeout: 30_000
			})
			.toBe(2);
	}

	await wide.context.close();
	await narrow.context.close();
});
