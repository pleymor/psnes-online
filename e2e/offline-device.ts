/**
 * Un appareil pour les suites hors-ligne avec un compte (#71) : un navigateur
 * dont le dossier de ROMs est l'OPFS, son service worker, sa session, et de
 * quoi lire ce que l'appareil et le serveur tiennent.
 *
 * Partagé par `offline-sync.spec.ts` et `offline-saves.spec.ts`, qui tournent
 * sur la même pile (`offline-sync.config.ts`).
 */

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { sramCounterRom } from './sram-counter-rom';
import { crc32, normaliseRom } from '../frontend/src/lib/roms/checksum';

export const ROM_NAME = 'psnes-sram-counter.sfc';
export const SRM_NAME = 'psnes-sram-counter.srm';
export const ROM = sramCounterRom();
export const CHECKSUM = crc32(normaliseRom(ROM));
export const TITLE = 'Compteur de démarrages';
export const SHOTS = path.join(__dirname, 'offline-shots');

/* -------------------------------------------------------------- l'appareil */

export async function newDevice(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport });
	await context.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
	});
	const page = await context.newPage();
	return { context, page };
}

/** Première visite, en ligne : le worker s'installe et prend la page. */
export async function installWorker(page: Page): Promise<void> {
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

export async function signIn(page: Page, userId: '1' | '2' | '4'): Promise<void> {
	const res = await page.request.post('/auth/dev/login', { data: { userId } });
	expect(res.ok()).toBe(true);
}

/** La ROM dans le dossier, et le dossier choisi depuis le panneau ROM du profil. */
export async function addRomToLibrary(page: Page): Promise<void> {
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
export function localCounter(page: Page): Promise<number | null> {
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
export async function serverSram(page: Page): Promise<number | null> {
	const res = await page.request.get(`/api/sync/${CHECKSUM}/sram`);
	if (!res.ok()) return null;
	const body = (await res.json()) as { sram: string | null };
	return body.sram ? Buffer.from(body.sram, 'base64')[0] : null;
}

export async function serverSaves(page: Page): Promise<{ kind: string; name: string; updatedAt: string; data: number }[]> {
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

export async function waitForGame(page: Page): Promise<void> {
	await expect(page.getByRole('button', { name: /Menu \(Esc\)/ })).toBeVisible({ timeout: 45_000 });
	await expect(page.locator('.solo .overlay')).toHaveCount(0, { timeout: 45_000 });
	await page.waitForTimeout(500);
}

/** Ouvrir le menu pause écrit la SRAM tout de suite : sur l'appareil, puis dans la file. */
export async function pauseAndPersist(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.locator('.pause-menu')).toBeVisible();
}

/** Une partie : lancée depuis la bibliothèque, jouée jusqu'à la pause, quittée. */
export async function playOnce(page: Page): Promise<number> {
	await page.goto('/');
	await page.getByTitle(TITLE).first().click();
	await waitForGame(page);
	await pauseAndPersist(page);
	await expect.poll(() => localCounter(page)).not.toBeNull();
	const counter = (await localCounter(page))!;
	await page.goto('/');
	return counter;
}

export async function goOffline(context: BrowserContext, page: Page): Promise<void> {
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText('Offline', { exact: true })).toBeVisible();
}

export async function goOnline(context: BrowserContext, page: Page): Promise<void> {
	await context.setOffline(false);
	// `online` fait redemander `/auth/me` au layout ; sa réponse ouvre la
	// socket, `connected` vide la file. Le rechargement est le même chemin par
	// le lancement de l'application, au cas où l'événement serait passé.
	await expect(page.getByText('Offline', { exact: true })).toHaveCount(0, { timeout: 15_000 }).catch(async () => {
		await page.reload();
	});
}
