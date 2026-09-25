/**
 * Solo without an account, with the network cut (#70).
 *
 * The only test that tells "it works" from "it works because the server
 * answered": one online visit installs the service worker, then the context
 * goes offline and everything after that - the reload, the core, the ROM, the
 * battery save - has to come from this machine.
 *
 * The ROM is made in `sram-counter-rom.ts` rather than looked for: none is
 * committed, and a skip would hide exactly what this has to prove. It counts
 * its boots in SRAM, so a second session that found the first one's save
 * reads one more than the first did.
 *
 * The folder is the origin-private file system standing in for the player's:
 * `showDirectoryPicker` opens a native dialog no test can drive, and an OPFS
 * directory is a real `FileSystemDirectoryHandle` - the same reads, writes and
 * permission queries go through it.
 *
 * Run with `bun run test:e2e:offline`. Screenshots land in
 * `e2e/offline-shots/` (gitignored) for the pull request.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { sramCounterRom } from './sram-counter-rom';
import { crc32, normaliseRom } from '../frontend/src/lib/roms/checksum';

const ROM_NAME = 'psnes-sram-counter.sfc';
const ROM = sramCounterRom();
const CHECKSUM = crc32(normaliseRom(ROM));
const SHOTS = path.join(__dirname, 'offline-shots');

const VIEWPORTS = [
	{ name: 'phone', width: 390, height: 844 },
	{ name: 'desktop', width: 1440, height: 900 }
];

/** The folder picker, answered with an OPFS directory. */
async function useOpfsFolder(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
	});
}

/** A browser with no folder picker at all: Firefox and Safari. */
async function withoutFolderPicker(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		delete (Window.prototype as unknown as Record<string, unknown>).showDirectoryPicker;
		delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
	});
}

/** First visit, online: the worker installs, precaches, and takes the page. */
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

async function putRomInFolder(page: Page): Promise<void> {
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
}

/** Byte 0 of the `.srm` next to the ROM, or null while there is none. */
function srmInFolder(page: Page): Promise<number | null> {
	return page.evaluate(async (name) => {
		try {
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('roms');
			const file = await (await dir.getFileHandle(name)).getFile();
			return new Uint8Array(await file.arrayBuffer())[0] ?? null;
		} catch {
			return null;
		}
	}, ROM_NAME.replace(/\.sfc$/, '.srm'));
}

function fileInFolder(page: Page, name: string): Promise<boolean> {
	return page.evaluate(async (n) => {
		try {
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('roms');
			await dir.getFileHandle(n);
			return true;
		} catch {
			return false;
		}
	}, name);
}

/** Byte 0 of the battery save kept in this browser, or null. */
function srmOnDevice(page: Page, checksum: string): Promise<number | null> {
	return page.evaluate(
		(key) =>
			new Promise<number | null>((resolve) => {
				const open = indexedDB.open('psnes-local');
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains('saves')) return resolve(null);
					const get = db.transaction('saves').objectStore('saves').get(key);
					get.onsuccess = () => {
						db.close();
						resolve(get.result ? (get.result.bytes as Uint8Array)[0] : null);
					};
					get.onerror = () => resolve(null);
				};
			}),
		`${checksum}:srm`
	);
}

/** The game is running once the boot overlay is gone and the menu button is up. */
async function waitForGame(page: Page): Promise<void> {
	await expect(page.getByRole('button', { name: /Menu \(Esc\)/ })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.solo .overlay')).toHaveCount(0, { timeout: 30_000 });
	// A few frames, so the program has run and the counter moved.
	await page.waitForTimeout(500);
}

/** Opening the pause menu writes the battery save now, not in thirty seconds. */
async function openPauseMenu(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.locator('.pause-menu')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
	test(`offline, the folder: the app opens by itself and the progress survives a reload (${viewport.name})`, async ({
		browser
	}) => {
		const context = await browser.newContext({ viewport });
		await useOpfsFolder(context);
		const page = await context.newPage();

		await installWorker(page);
		await putRomInFolder(page);

		await context.setOffline(true);
		await page.reload();

		// No sign-in page: the server never answered, so the home switched to
		// solo play by itself.
		await expect(page.getByText('Solo, no account')).toBeVisible();
		await expect(page.getByText(/server cannot be reached/i)).toBeVisible();
		// Nothing that belongs to an account.
		await expect(page.getByRole('button', { name: /Sign in with Google/ })).toHaveCount(0);
		await expect(page.locator('a[href="/profile"]')).toHaveCount(0);

		await page.getByRole('button', { name: 'Choose my ROM folder' }).click();
		const card = page.locator('.card', { hasText: 'psnes-sram-counter' });
		await expect(card).toBeVisible();
		await expect(page.locator('[data-note="localSavesInFolder"]')).toBeVisible();
		await page.screenshot({ path: path.join(SHOTS, `home-offline-${viewport.name}.png`), fullPage: true });

		await card.getByRole('button', { name: 'Play' }).click();
		await expect(page).toHaveURL(new RegExp(`/local\\?rom=${CHECKSUM}`));
		await waitForGame(page);
		await page.screenshot({ path: path.join(SHOTS, `game-offline-${viewport.name}.png`) });

		await openPauseMenu(page);
		await expect.poll(() => srmInFolder(page)).not.toBeNull();
		const first = (await srmInFolder(page))!;

		// A savestate slot too, into `<rom>.state1` next to it.
		await page.getByRole('button', { name: 'Saves' }).click();
		await page.locator('[data-slot="1"]').getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Saved in slot 1')).toBeVisible();
		await page.screenshot({ path: path.join(SHOTS, `saves-offline-${viewport.name}.png`) });
		expect(await fileInFolder(page, 'psnes-sram-counter.state1')).toBe(true);
		await page.locator('[data-slot="1"]').getByRole('button', { name: 'Load' }).click();
		await expect(page.getByText('Slot 1 loaded')).toBeVisible();

		// Still offline: the game page itself comes back from the worker, and
		// boots from the save the first session wrote.
		await page.reload();
		await waitForGame(page);
		await openPauseMenu(page);
		await expect.poll(() => srmInFolder(page)).toBe((first + 1) & 0xff);

		await context.close();
	});
}

test('offline, no folder picker: saves fall back to this browser, and survive a reload', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await withoutFolderPicker(context);
	const page = await context.newPage();

	await installWorker(page);
	await context.setOffline(true);
	await page.reload();

	await expect(page.getByText('Solo, no account')).toBeVisible();
	// The fallback is silent in game and said on the ROM panel.
	await expect(page.locator('[data-note="localSavesUnsupported"]')).toBeVisible();

	await page.locator('input[type="file"]').setInputFiles({
		name: ROM_NAME,
		mimeType: 'application/octet-stream',
		buffer: Buffer.from(ROM)
	});
	const card = page.locator('.card', { hasText: 'psnes-sram-counter' });
	await expect(card).toBeVisible();

	await card.getByRole('button', { name: 'Play' }).click();
	await waitForGame(page);
	await openPauseMenu(page);
	await expect.poll(() => srmOnDevice(page, CHECKSUM)).not.toBeNull();
	const first = (await srmOnDevice(page, CHECKSUM))!;

	await page.reload();
	await waitForGame(page);
	await openPauseMenu(page);
	await expect.poll(() => srmOnDevice(page, CHECKSUM)).toBe((first + 1) & 0xff);

	await context.close();
});

test('online, the sign-in page offers a discreet way in without an account', async ({ page }) => {
	// A server that answers, with nobody signed in. `vite preview` has no
	// backend behind its proxy, so this is the part of one the page asks.
	await page.route('**/auth/me', (route) => route.fulfill({ json: null }));
	await page.route('**/auth/mode', (route) => route.fulfill({ json: { mode: 'google' } }));
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
	const link = page.getByRole('button', { name: 'Play without an account' });
	await expect(link).toBeVisible();
	await link.click();
	await expect(page.getByText('Solo, no account')).toBeVisible();
	await expect(page.getByText(/Nothing is sent to the server/)).toBeVisible();
	await page.getByRole('button', { name: 'Sign in instead' }).click();
	await expect(link).toBeVisible();
});

test('Chrome finds the app installable: manifest, icons and a worker that serves offline', async ({
	browser
}) => {
	// The check behind DevTools' Application > Manifest panel, which is what
	// decides whether Chrome offers to install the app. Lighthouse dropped its
	// PWA category in version 12, so this is the one that still exists.
	const context = await browser.newContext();
	const page = await context.newPage();
	await installWorker(page);

	const cdp = await context.newCDPSession(page);
	const manifest = await cdp.send('Page.getAppManifest');
	expect(manifest.errors, JSON.stringify(manifest.errors)).toEqual([]);
	const parsed = JSON.parse(manifest.data ?? '{}');
	expect(parsed.display).toBe('standalone');
	expect(parsed.icons.map((i: { sizes: string }) => i.sizes)).toEqual(
		expect.arrayContaining(['192x192', '512x512'])
	);
	expect(parsed.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

	const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
	console.log('installability errors:', JSON.stringify(installabilityErrors));
	expect(installabilityErrors).toEqual([]);

	await context.close();
});
