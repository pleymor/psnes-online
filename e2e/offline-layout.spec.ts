/**
 * Hors-ligne, la même application : une carte par ROM, et la mise en page
 * d'en ligne, avec ce qui demande le serveur éteint à sa place.
 *
 * Sur un build et le vrai backend de `sync-stack.ts`, comme `offline-sync.spec.ts`
 * (même configuration, `bun run test:e2e:sync`) :
 *
 *  1. avec un compte : la ROM du test est sur le compte (titre et jaquette du
 *     serveur) ET dans le dossier (nom de fichier). En ligne comme hors-ligne,
 *     une seule carte, avec sa jaquette. Hors-ligne, la barre et l'avatar sont
 *     là, le tiroir Amis s'ouvre sur l'ami retenu et son bouton Inviter est
 *     éteint, avec sa raison. Le réseau revient : l'application quitte le mode
 *     hors-ligne sans rechargement ;
 *  2. sans compte : la même grille, une carte, la barre et l'avatar, qui mène
 *     au panneau ROM du profil ; Amis éteint, faute de compte.
 *
 * Les captures - en ligne à gauche, hors-ligne à droite, à 390x844 et
 * 1440x900 - vont dans `e2e/offline-shots/`.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { sramCounterRom } from './sram-counter-rom';

const ROM_NAME = 'psnes-sram-counter.sfc';
const ROM = sramCounterRom();
const TITLE = 'Compteur de démarrages';
const SHOTS = path.join(__dirname, 'offline-shots');

const VIEWPORTS = [
	{ name: '390x844', width: 390, height: 844 },
	{ name: '1440x900', width: 1440, height: 900 }
];

test.describe.configure({ mode: 'serial' });

async function newDevice(browser: Browser) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await context.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
	});
	const page = await context.newPage();
	return { context, page };
}

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

/** Dev 1 et dev 2 amis, par le même chemin que l'interface : la demande, puis l'acceptation. */
async function befriend(browser: Browser, page: Page): Promise<void> {
	const other = await browser.newContext();
	try {
		expect((await other.request.post('/auth/dev/login', { data: { userId: '2' } })).ok()).toBe(true);
		for (const request of [page.request, other.request]) {
			for (const f of (await (await request.get('/api/friends')).json()) as { friendshipId: string }[]) {
				await request.delete(`/api/friends/${f.friendshipId}`);
			}
			for (const r of (await (await request.get('/api/friends/requests')).json()) as { id: string }[]) {
				await request.delete(`/api/friends/${r.id}`);
			}
		}
		const sent = await page.request.post('/api/friends/request', { data: { handle: 'DevTwo#0002' } });
		expect(sent.ok()).toBe(true);
		const { id } = (await sent.json()) as { id: string };
		expect((await other.request.post(`/api/friends/accept/${id}`)).ok()).toBe(true);
	} finally {
		await other.close();
	}
}

/** Toutes les cartes de la grille : c'est leur nombre qui dit s'il y a un doublon. */
function cards(page: Page) {
	return page.locator('.games-grid .game-card');
}

async function expectOneCardWithCover(page: Page): Promise<void> {
	await expect(cards(page)).toHaveCount(1);
	const card = cards(page).first();
	await expect(card).toHaveAttribute('title', TITLE);
	const cover = card.locator('img.art');
	await expect(cover).toBeVisible();
	await expect
		.poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth), { message: 'la jaquette se charge' })
		.toBeGreaterThan(0);
}

/** Une capture par largeur, rangée sous son nom pour la mise côte à côte. */
async function shoot(page: Page, shots: Map<string, Buffer>, side: 'online' | 'offline'): Promise<void> {
	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.waitForTimeout(400);
		shots.set(`${side}-${viewport.name}`, await page.screenshot());
	}
	await page.setViewportSize({ width: 1440, height: 900 });
}

/** En ligne à gauche, hors-ligne à droite : une image par largeur. */
async function sideBySide(browser: Browser, shots: Map<string, Buffer>, who: string): Promise<void> {
	fs.mkdirSync(SHOTS, { recursive: true });
	const context = await browser.newContext();
	const page = await context.newPage();
	for (const viewport of VIEWPORTS) {
		const online = shots.get(`online-${viewport.name}`)!;
		const offline = shots.get(`offline-${viewport.name}`)!;
		const width = viewport.width * 2 + 48;
		await page.setViewportSize({ width, height: viewport.height + 60 });
		await page.setContent(`
			<style>
				body { margin: 0; background: #131319; color: #fff; font: 16px system-ui, sans-serif; }
				.row { display: flex; gap: 16px; padding: 8px 16px 16px; }
				figure { margin: 0; }
				figcaption { padding: 4px 0 8px; }
				img { display: block; width: ${viewport.width}px; outline: 1px solid #444; }
			</style>
			<div class="row">
				<figure><figcaption>${who} · en ligne · ${viewport.name}</figcaption>
					<img src="data:image/png;base64,${online.toString('base64')}"></figure>
				<figure><figcaption>${who} · hors-ligne · ${viewport.name}</figcaption>
					<img src="data:image/png;base64,${offline.toString('base64')}"></figure>
			</div>`);
		const slug = who === 'compte' ? 'account' : 'no-account';
		await page.screenshot({ path: path.join(SHOTS, `layout-${slug}-${viewport.name}.png`), fullPage: true });
	}
	await context.close();
}

/* ------------------------------------------------------------------ 1 */

test('avec un compte : la même ROM sur le compte et dans le dossier est une seule carte, avec sa jaquette, en ligne comme hors-ligne ; hors-ligne la barre reste et Inviter est éteint', async ({
	browser
}) => {
	const { context, page } = await newDevice(browser);
	await installWorker(page);
	expect((await page.request.post('/auth/dev/login', { data: { userId: '1' } })).ok()).toBe(true);
	await befriend(browser, page);

	// Le jeu est inscrit au compte par le scan du dossier : le compte a sa
	// fiche et sa jaquette, l'appareil a le fichier, sous son nom à lui.
	await putRomInFolder(page);
	await page.goto('/profile');
	await page.getByRole('button', { name: 'Choose my ROM folder' }).click();
	await expect(page.getByText(/games added|already matches the folder/i)).toBeVisible({ timeout: 30_000 });

	// En ligne : une carte. Et le tiroir Amis se remplit, ce qui le retient.
	await page.goto('/');
	await expectOneCardWithCover(page);
	await page.locator('.top-bar button.friends').click();
	await expect(page.locator('.friends-drawer').getByText('DevTwo')).toBeVisible();
	await expect(page.locator('.friends-drawer .btn-invite-friend')).toBeEnabled();
	await page.locator('.top-bar button.friends').click();
	const shots = new Map<string, Buffer>();
	await shoot(page, shots, 'online');

	// Hors-ligne : la même page.
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText('Offline', { exact: true })).toBeVisible();
	await expectOneCardWithCover(page);
	await expect(page.locator('.top-bar')).toBeVisible();
	await expect(page.locator('.top-bar a.avatar')).toBeVisible();
	await expect(page.locator('.top-bar a.avatar')).toHaveAttribute('href', '/profile');
	await expect(cards(page).first().locator('button.details')).toBeDisabled();
	await expect(cards(page).first().locator('button.details')).toHaveAttribute('title', 'Requires a connection');
	await shoot(page, shots, 'offline');

	// Le tiroir s'ouvre sur l'ami retenu, et tout ce qu'il propose est éteint.
	await page.locator('.top-bar button.friends').click();
	const drawer = page.locator('.friends-drawer');
	await expect(drawer.getByText('DevTwo')).toBeVisible();
	const invite = drawer.locator('.btn-invite-friend');
	await expect(invite).toHaveCount(1);
	await expect(invite).toBeDisabled();
	await expect(invite).toHaveAttribute('title', 'Requires a connection');
	await expect(drawer.locator('.btn-add')).toBeDisabled();
	await expect(drawer.getByText(/Offline: your friends as they were/)).toBeVisible();
	await page.screenshot({ path: path.join(SHOTS, 'layout-account-offline-friends-1440x900.png') });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: path.join(SHOTS, 'layout-account-offline-friends-390x844.png') });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.locator('.top-bar button.friends').click();

	// Le profil hors-ligne : ses cartes, ce qui demande le serveur éteint.
	await page.locator('.top-bar a.avatar').click();
	await expect(page.getByText(/Offline: what goes through the server/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Logout' })).toBeDisabled();
	await expect(page.locator('section.rom-source')).toBeVisible();
	await page.screenshot({ path: path.join(SHOTS, 'layout-account-offline-profile-1440x900.png'), fullPage: true });

	// Le réseau revient, sans rechargement : le mode hors-ligne s'en va, la
	// grille repasse à la bibliothèque du compte - toujours une carte.
	await page.goto('/');
	await expect(page.getByText('Offline', { exact: true })).toBeVisible();
	await context.setOffline(false);
	// Un vrai navigateur émet `online` ici ; l'émulation de Chromium coupe et
	// rend le réseau sans l'émettre (mesuré : aucun évènement reçu). On le
	// fait donc comme le navigateur le ferait.
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(page.getByText('Offline', { exact: true })).toHaveCount(0, { timeout: 15_000 });
	await expectOneCardWithCover(page);
	await expect(cards(page).first().locator('button.details')).toBeEnabled();

	await sideBySide(browser, shots, 'compte');
	await context.close();
});

/* ------------------------------------------------------------------ 2 */

test('sans compte : la même grille, une carte par ROM ; la barre et l\'avatar restent, Amis est éteint faute de compte', async ({
	browser
}) => {
	const { context, page } = await newDevice(browser);
	await installWorker(page);
	await putRomInFolder(page);

	// En ligne, par le lien de la page de connexion.
	await page.getByRole('button', { name: 'Play without an account' }).click();
	await expect(page.getByText('Solo, no account')).toBeVisible();
	await expect(page.locator('.top-bar a.avatar')).toBeVisible();
	// L'avatar mène au panneau ROM, où le dossier se choisit.
	await page.locator('.top-bar a.avatar').click();
	await expect(page.getByText(/No account: these settings stay on this device/).first()).toBeVisible();
	await page.getByRole('button', { name: 'Choose my ROM folder' }).click();
	await expect(page.locator('[data-note="localSavesInFolder"]')).toBeVisible();
	await page.goto('/');
	await expect(cards(page)).toHaveCount(1);
	await expect(cards(page).first()).toHaveAttribute('title', 'psnes-sram-counter');
	const shots = new Map<string, Buffer>();
	await shoot(page, shots, 'online');

	// Hors-ligne : la bascule est automatique, la page est la même.
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText(/server cannot be reached/i)).toBeVisible();
	await expect(cards(page)).toHaveCount(1);
	await expect(page.locator('.top-bar a.avatar')).toBeVisible();
	const friends = page.locator('.top-bar button.friends');
	await expect(friends).toBeVisible();
	await expect(friends).toBeDisabled();
	await expect(friends).toHaveAttribute('title', 'Requires an account');
	await expect(cards(page).first().locator('button.details')).toBeDisabled();
	await shoot(page, shots, 'offline');

	// Et la carte se joue, par `/local`.
	await cards(page).first().click();
	await expect(page).toHaveURL(/\/local\?rom=/);

	await sideBySide(browser, shots, 'sans compte');
	await context.close();
});
