/**
 * Le fond d'écran de la bibliothèque : quatre murs de chambre et « Aléatoire »,
 * choisis dans la carte Affichage du profil.
 *
 * Sur un build de production et le vrai backend de `sync-stack.ts`, comme
 * `offline-layout.spec.ts` (même configuration, `bun run test:e2e:sync`) :
 * c'est le build qui doit être propre, sans le sélecteur flottant ni `?bg=`
 * des propositions, et c'est lui qui sert la bibliothèque hors-ligne.
 *
 *  1. le réglage propose cinq fonds, chacun avec son aperçu dessiné ; « Pastel »
 *     tient au rechargement, dans la bibliothèque, et hors-ligne ;
 *  2. « Aléatoire », le défaut, donne l'un des quatre, le garde d'une page à
 *     l'autre de la visite, et en tire un autre au chargement suivant ;
 *  3. la parallaxe : 18 px au plus, aucune frame demandée au repos, rien sous
 *     `prefers-reduced-motion`.
 *
 * Les captures - le réglage, et chaque mur à 390x844 et 1440x900 - vont dans
 * `e2e/wallpaper-shots/`.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { sramCounterRom } from './sram-counter-rom';

const SHOTS = path.join(__dirname, 'wallpaper-shots');
const WALLS = ['nineties', 'gamer', 'pastel', 'blue'];
const LABELS = ['Papier peint 90s', 'Chambre de gamer 16-bit', 'Pastel', 'Bleu', 'Aléatoire'];

const VIEWPORTS = [
	{ name: '390x844', width: 390, height: 844 },
	{ name: '1440x900', width: 1440, height: 900 }
];

test.describe.configure({ mode: 'serial' });

async function signedIn(browser: Browser, options: { reducedMotion?: 'reduce' | 'no-preference' } = {}) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
	// Le dossier de ROMs est un dossier de l'OPFS : aucun sélecteur à cliquer.
	await context.addInitScript(() => {
		(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
			async () => (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
	});
	const page = await context.newPage();
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
			);
		}
		localStorage.setItem('language', 'fr');
	});
	expect((await page.request.post('/auth/dev/login', { data: { userId: '1' } })).ok()).toBe(true);
	await page.goto('/');
	await expect(page.locator('.top-bar a.avatar')).toBeVisible();
	return { context, page };
}

/**
 * La ROM du test sur le compte, par le scan du dossier : une carte avec sa
 * jaquette devant le mur, pour juger de la lisibilité sur les captures.
 */
async function withOneGame(page: Page): Promise<void> {
	await page.evaluate(async (bytes) => {
		const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
		const file = await dir.getFileHandle('psnes-sram-counter.sfc', { create: true });
		const writable = await file.createWritable();
		await writable.write(new Uint8Array(bytes));
		await writable.close();
	}, [...sramCounterRom()]);
	await page.getByRole('button', { name: 'Choisir mon dossier de ROMs' }).click();
	await expect(page.getByText(/jeux ajoutés|déjà à jour|correspond déjà/i).first()).toBeVisible({ timeout: 30_000 });
}

function shownWall(page: Page) {
	return page.locator('.app-layout > .wall');
}

async function wallOnScreen(page: Page): Promise<string> {
	await expect(shownWall(page)).toHaveCount(1);
	const wall = (await shownWall(page).getAttribute('data-wall')) ?? '';
	expect(WALLS).toContain(wall);
	return wall;
}

function tiles(page: Page) {
	return page.locator('.wallpapers button');
}

/* ------------------------------------------------------------------ 1 */

test('cinq fonds dans le profil, chacun avec son aperçu ; « Pastel » tient au rechargement, dans la bibliothèque et hors-ligne', async ({
	browser
}) => {
	const { context, page } = await signedIn(browser);

	// Le build ne porte rien des propositions : ni sélecteur, ni `?bg=`.
	await expect(page.locator('.switcher')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Fond', exact: true })).toHaveCount(0);

	await page.locator('.top-bar a.avatar').click();
	await expect(page).toHaveURL(/\/profile/);
	await expect(page.getByRole('heading', { name: "Fond d'écran" })).toBeVisible();
	await expect(tiles(page)).toHaveCount(5);
	await expect(tiles(page).locator('.shader-name')).toHaveText(LABELS);

	// Les aperçus sont les murs eux-mêmes : un par fond, les quatre pour « Aléatoire ».
	for (let i = 0; i < 4; i++) {
		await expect(tiles(page).nth(i).locator('.wall')).toHaveAttribute('data-wall', WALLS[i]);
	}
	await expect(tiles(page).nth(4).locator('.wall')).toHaveCount(4);
	// Un aperçu ne demande aucune parallaxe : immobile, sans calque déplacé.
	for (const transform of await tiles(page).locator('.wall [data-depth]').evaluateAll((els) =>
		els.map((el) => (el as HTMLElement).style.transform)
	)) {
		expect(transform).toBe('');
	}

	// « Aléatoire » est le défaut.
	await expect(tiles(page).nth(4)).toHaveAttribute('aria-pressed', 'true');

	const card = page.locator('section.card', { has: page.locator('.wallpapers') });
	fs.mkdirSync(SHOTS, { recursive: true });
	// La barre est collante : elle passerait sur la carte capturée.
	const hideBar = await page.addStyleTag({ content: '.top-bar { visibility: hidden !important; }' });
	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.waitForTimeout(300);
		await card.screenshot({ path: path.join(SHOTS, `setting-${viewport.name}.png`) });
	}
	await hideBar.evaluate((el) => el.remove());
	await page.setViewportSize({ width: 1440, height: 900 });
	await withOneGame(page);

	await tiles(page).nth(2).click();
	await expect(tiles(page).nth(2)).toHaveAttribute('aria-pressed', 'true');
	await expect(tiles(page).nth(4)).toHaveAttribute('aria-pressed', 'false');

	await page.reload();
	await expect(tiles(page).nth(2)).toHaveAttribute('aria-pressed', 'true');

	await page.goto('/');
	expect(await wallOnScreen(page)).toBe('pastel');
	await page.reload();
	expect(await wallOnScreen(page)).toBe('pastel');

	// En production, `?bg=` n'est plus lu : le réglage reste le réglage.
	await page.goto('/?bg=nineties');
	expect(await wallOnScreen(page)).toBe('pastel');

	// Hors-ligne, la même mise en page, donc le même mur.
	await page.goto('/');
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByText('Hors-ligne', { exact: true }).first()).toBeVisible();
	expect(await wallOnScreen(page)).toBe('pastel');
	await context.setOffline(false);

	// Le titre de la bibliothèque, sur sa plaque sombre.
	await expect(page.locator('.page-header > div:first-child')).toHaveCSS('background-color', 'rgba(16, 16, 24, 0.82)');

	// Une capture par mur et par largeur.
	await page.goto('/');
	await expect(page.locator('.games-grid .game-card')).toHaveCount(1);
	for (const wall of WALLS) {
		await page.evaluate((id) => localStorage.setItem('psnes-wallpaper', id), wall);
		for (const viewport of VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await page.reload();
			expect(await wallOnScreen(page)).toBe(wall);
			await expect(page.locator('.games-grid .game-card img.art')).toBeVisible();
			await page.waitForTimeout(400);
			await page.screenshot({ path: path.join(SHOTS, `wall-${wall}-${viewport.name}.png`) });
		}
	}
	await page.evaluate(() => localStorage.removeItem('psnes-wallpaper'));

	await context.close();
});

/* ------------------------------------------------------------------ 2 */

test('« Aléatoire » donne l\'un des quatre, le garde pendant la visite, et en tire un autre au chargement suivant', async ({
	browser
}) => {
	const { context, page } = await signedIn(browser);
	await page.evaluate(() => {
		localStorage.removeItem('psnes-wallpaper');
		localStorage.removeItem('psnes-wallpaper-last');
	});
	await page.reload();

	const first = await wallOnScreen(page);
	expect(await page.evaluate(() => localStorage.getItem('psnes-wallpaper-last'))).toBe(first);

	// Dans l'application, sans rechargement : au profil, puis retour.
	await page.locator('.top-bar a.avatar').click();
	await expect(page).toHaveURL(/\/profile/);
	// Le mur n'appartient qu'à la bibliothèque.
	await expect(page.locator('.app-layout > .wall')).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);
	expect(await wallOnScreen(page)).toBe(first);

	// Chaque chargement tire à nouveau, et jamais celui d'avant.
	let previous = first;
	for (let visit = 0; visit < 6; visit++) {
		await page.reload();
		const next = await wallOnScreen(page);
		expect(next).not.toBe(previous);
		previous = next;
	}

	await context.close();
});

/* ------------------------------------------------------------------ 3 */

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test(`la parallaxe (${reducedMotion}) : 18 px au plus, aucune frame demandée au repos`, async ({ browser }) => {
		const { context, page } = await signedIn(browser, { reducedMotion });
		await page.evaluate(() => localStorage.setItem('psnes-wallpaper', 'nineties'));
		await page.addInitScript(() => {
			const raf = window.requestAnimationFrame.bind(window);
			const w = window as unknown as { __rafs: number };
			w.__rafs = 0;
			window.requestAnimationFrame = (cb) => {
				w.__rafs++;
				return raf(cb);
			};
		});
		await page.reload();
		await wallOnScreen(page);

		await page.mouse.move(1430, 890, { steps: 6 });
		await page.waitForTimeout(2000);
		const shifts = await page.locator('.app-layout > .wall [data-depth]').evaluateAll((els) =>
			els.map((el) => {
				const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
				return match ? Math.max(Math.abs(Number(match[1])), Math.abs(Number(match[2]))) : 0;
			})
		);
		expect(shifts.length).toBeGreaterThan(0);
		for (const shift of shifts) expect(shift).toBeLessThanOrEqual(18);
		if (reducedMotion === 'reduce') expect(Math.max(...shifts)).toBe(0);
		else expect(Math.max(...shifts)).toBeGreaterThan(8);

		const before = await page.evaluate(() => (window as unknown as { __rafs: number }).__rafs);
		await page.waitForTimeout(1500);
		const after = await page.evaluate(() => (window as unknown as { __rafs: number }).__rafs);
		expect(after - before, 'requestAnimationFrame au repos').toBe(0);

		await context.close();
	});
}
