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
 *     `prefers-reduced-motion` ;
 *  4. l'interrupteur « Effet de profondeur (parallaxe) » : allumé par défaut,
 *     coupé il laisse les calques au repos sans rien écouter, sans
 *     rechargement, et tient au rechargement ;
 *  5. sous `prefers-reduced-motion`, l'interrupteur est grisé et dit pourquoi ;
 *  6. le mur défile avec les étagères, pixel pour pixel, sur les quatre murs,
 *     et descend au moins jusqu'à la dernière étagère d'une longue
 *     bibliothèque ; le défilement ne coûte aucune frame longue.
 *
 * Les captures - le réglage, chaque mur à 390x844 et 1440x900, en haut et
 * après défilement - vont dans `e2e/wallpaper-shots/`, avec le coût mesuré du
 * défilement dans `scroll-cost.jsonl`.
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

/* ------------------------------------------------------------------ 4 */

/**
 * Compte les frames demandées et les demandes de permission d'inclinaison :
 * coupée, la parallaxe ne doit faire ni l'un ni l'autre.
 */
async function counting(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const w = window as unknown as { __rafs: number; __tiltAsks: number };
		const raf = window.requestAnimationFrame.bind(window);
		w.__rafs = 0;
		w.__tiltAsks = 0;
		window.requestAnimationFrame = (cb) => {
			w.__rafs++;
			return raf(cb);
		};
		(window.DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission =
			async () => {
				w.__tiltAsks++;
				return 'granted';
			};
	});
}

function parallaxSwitch(page: Page) {
	return page.getByRole('switch', { name: 'Effet de profondeur (parallaxe)' });
}

/** Le plus grand déplacement des calques du mur, en pixels. */
async function largestShift(page: Page): Promise<number> {
	const shifts = await page.locator('.app-layout > .wall [data-depth]').evaluateAll((els) =>
		els.map((el) => {
			const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
			return match ? Math.max(Math.abs(Number(match[1])), Math.abs(Number(match[2]))) : 0;
		})
	);
	expect(shifts.length).toBeGreaterThan(0);
	return Math.max(...shifts);
}

/** La souris d'un coin à l'autre, puis le temps que les calques arrivent. */
async function sweep(page: Page): Promise<number> {
	const before = await page.evaluate(() => (window as unknown as { __rafs: number }).__rafs);
	await page.mouse.move(10, 10, { steps: 4 });
	await page.mouse.move(1430, 890, { steps: 6 });
	await page.mouse.wheel(0, 400);
	await page.waitForTimeout(2000);
	const after = await page.evaluate(() => (window as unknown as { __rafs: number }).__rafs);
	return after - before;
}

test('« Effet de profondeur » : allumé par défaut, coupé sans rechargement, les calques au repos, et tenu au rechargement', async ({
	browser
}) => {
	const { context, page } = await signedIn(browser);
	await page.evaluate(() => {
		localStorage.setItem('psnes-wallpaper', 'nineties');
		localStorage.removeItem('psnes-parallax');
	});
	await counting(page);
	await page.reload();
	await wallOnScreen(page);

	// Allumée par défaut : le mur suit la souris.
	await sweep(page);
	expect(await largestShift(page)).toBeGreaterThan(8);

	// Dans le profil, juste sous le fond d'écran, et allumé.
	await page.locator('.top-bar a.avatar').click();
	await expect(page).toHaveURL(/\/profile/);
	const card = page.locator('section.card', { has: page.locator('.wallpapers') });
	await expect(card.getByRole('switch', { name: 'Effet de profondeur (parallaxe)' })).toBeVisible();
	await expect(parallaxSwitch(page)).toBeChecked();
	await expect(parallaxSwitch(page)).toBeEnabled();
	await expect(page.getByText('Désactivé : votre système demande de réduire les animations')).toHaveCount(0);

	await parallaxSwitch(page).uncheck();
	await expect(parallaxSwitch(page)).not.toBeChecked();
	expect(await page.evaluate(() => localStorage.getItem('psnes-parallax'))).toBe('off');
	// Le mur, lui, reste celui qu'on a choisi.
	expect(await page.evaluate(() => localStorage.getItem('psnes-wallpaper'))).toBe('nineties');

	// Sans rechargement : retour à la bibliothèque dans l'application.
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);
	expect(await wallOnScreen(page)).toBe('nineties');
	expect(await largestShift(page), 'les calques reviennent au repos').toBe(0);
	expect(await sweep(page), 'requestAnimationFrame, parallaxe coupée').toBe(0);
	expect(await largestShift(page)).toBe(0);

	// Au rechargement, toujours coupée, et jamais la permission d'inclinaison.
	await page.reload();
	expect(await wallOnScreen(page)).toBe('nineties');
	expect(await sweep(page), 'requestAnimationFrame, parallaxe coupée').toBe(0);
	expect(await largestShift(page)).toBe(0);
	expect(await page.evaluate(() => (window as unknown as { __tiltAsks: number }).__tiltAsks)).toBe(0);

	await page.locator('.top-bar a.avatar').click();
	await expect(parallaxSwitch(page)).not.toBeChecked();

	// Et rallumée, elle repart aussitôt.
	await parallaxSwitch(page).check();
	expect(await page.evaluate(() => localStorage.getItem('psnes-parallax'))).toBeNull();
	await page.goBack();
	await wallOnScreen(page);
	await sweep(page);
	expect(await largestShift(page)).toBeGreaterThan(8);
	expect(await page.evaluate(() => (window as unknown as { __tiltAsks: number }).__tiltAsks)).toBe(0);

	await context.close();
});

/* ------------------------------------------------------------------ 5 */

test('sous `prefers-reduced-motion`, l’interrupteur est grisé et dit pourquoi, et les calques ne bougent pas', async ({
	browser
}) => {
	const { context, page } = await signedIn(browser, { reducedMotion: 'reduce' });
	await page.evaluate(() => {
		localStorage.setItem('psnes-wallpaper', 'nineties');
		localStorage.removeItem('psnes-parallax');
	});
	await counting(page);
	await page.reload();
	await wallOnScreen(page);

	// Le réglage dit « allumée », le système l'emporte.
	expect(await sweep(page), 'requestAnimationFrame sous reduced-motion').toBe(0);
	expect(await largestShift(page)).toBe(0);

	await page.locator('.top-bar a.avatar').click();
	await expect(page).toHaveURL(/\/profile/);
	await expect(parallaxSwitch(page)).toBeDisabled();
	await expect(parallaxSwitch(page)).not.toBeChecked();
	await expect(parallaxSwitch(page)).toHaveAccessibleDescription(
		'Désactivé : votre système demande de réduire les animations'
	);

	const card = page.locator('section.card', { has: page.locator('.wallpapers') });
	fs.mkdirSync(SHOTS, { recursive: true });
	const hideBar = await page.addStyleTag({ content: '.top-bar { visibility: hidden !important; }' });
	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.waitForTimeout(300);
		await card.screenshot({ path: path.join(SHOTS, `setting-reduced-motion-${viewport.name}.png`) });
	}
	await hideBar.evaluate((el) => el.remove());

	await context.close();
});

/* ------------------------------------------------------------------ 6 */

/**
 * `count` ROMs sur le compte, par le même scan : la ROM du test, chaque fois
 * avec un octet changé dans une zone qu'elle n'exécute pas, donc autant de
 * jeux distincts que de fichiers. De quoi remplir des étagères bien plus
 * hautes qu'un écran.
 */
async function withManyGames(page: Page, count: number): Promise<void> {
	await page.evaluate(
		async ({ bytes, count }) => {
			const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('roms', { create: true });
			for (let i = 0; i < count; i++) {
				const rom = new Uint8Array(bytes);
				rom[0x7000] = i & 0xff;
				rom[0x7001] = i >> 8;
				const file = await dir.getFileHandle(`psnes-shelf-${String(i).padStart(3, '0')}.sfc`, { create: true });
				const writable = await file.createWritable();
				await writable.write(rom);
				await writable.close();
			}
		},
		{ bytes: [...sramCounterRom()], count }
	);
	await page.getByRole('button', { name: 'Choisir mon dossier de ROMs' }).click();
	await expect(page.getByText(/jeux ajoutés|déjà à jour|correspond déjà/i).first()).toBeVisible({ timeout: 60_000 });
}

/** Deux frames : le défilement demandé est peint. */
async function painted(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Le haut, à l'écran, du mur, d'un calque, d'un objet du décor et d'une étagère. */
async function tops(page: Page) {
	return page.evaluate(() => {
		const top = (el: Element | null) => (el ? el.getBoundingClientRect().top : NaN);
		return {
			wall: top(document.querySelector('.app-layout > .wall')),
			layer: top(document.querySelector('.app-layout > .wall .layer')),
			item: top(document.querySelector('.app-layout > .wall .item')),
			shelf: top(document.querySelector('.games-grid .shelf'))
		};
	});
}

const GAMES = 60;
const SCROLL = 600;

test('le mur défile avec les étagères, pixel pour pixel, et couvre toute la bibliothèque, sur les quatre murs', async ({
	browser
}) => {
	const { context, page } = await signedIn(browser);
	await page.locator('.top-bar a.avatar').click();
	await expect(page).toHaveURL(/\/profile/);
	await withManyGames(page, GAMES);
	fs.mkdirSync(SHOTS, { recursive: true });
	const cdp = await context.newCDPSession(page);
	await cdp.send('Performance.enable');
	const metric = async (name: string) =>
		(await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name)?.value ?? 0;
	const costs: string[] = [];

	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		for (const wall of WALLS) {
			await page.evaluate((id) => localStorage.setItem('psnes-wallpaper', id), wall);
			await page.goto('/');
			expect(await wallOnScreen(page)).toBe(wall);
			await expect(page.locator('.games-grid .game-card')).toHaveCount(GAMES);
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.waitForTimeout(400);
			await painted(page);
			await page.screenshot({ path: path.join(SHOTS, `scroll-${wall}-${viewport.name}-top.png`) });

			// Assez de bibliothèque pour défiler, et le mur jusqu'en bas.
			const room = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
			expect(room, 'la bibliothèque dépasse largement l’écran').toBeGreaterThan(SCROLL * 2);
			const reach = await page.evaluate(() => {
				const wallBox = document.querySelector('.app-layout > .wall')!.getBoundingClientRect();
				const shelves = document.querySelectorAll('.games-grid .shelf');
				const last = shelves[shelves.length - 1].getBoundingClientRect();
				return { wall: wallBox.bottom, shelf: last.bottom, page: document.documentElement.scrollHeight };
			});
			expect(reach.wall, `${wall} : le mur descend sous la dernière étagère`).toBeGreaterThanOrEqual(reach.shelf);
			expect(Math.round(reach.wall), `${wall} : le mur va jusqu'au bas de la page`).toBe(reach.page);

			// N px de défilement : le mur, un calque et un objet du décor bougent de N, comme l'étagère.
			const before = await tops(page);
			await page.evaluate((y) => window.scrollTo(0, y), SCROLL);
			await painted(page);
			const after = await tops(page);
			for (const key of ['wall', 'layer', 'item', 'shelf'] as const) {
				expect(before[key] - after[key], `${wall} ${viewport.name} : ${key}`).toBeCloseTo(SCROLL, 1);
			}
			await page.screenshot({ path: path.join(SHOTS, `scroll-${wall}-${viewport.name}-scrolled.png`) });
			// Tout en bas : la plinthe, ou le lambris, au pied de la dernière étagère.
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			await painted(page);
			await page.screenshot({ path: path.join(SHOTS, `scroll-${wall}-${viewport.name}-bottom.png`) });

			// Le coût : défiler à la molette depuis le haut, en comptant les frames
			// longues, les mises en page et le plus long écart entre deux frames.
			await page.evaluate(() => window.scrollTo(0, 0));
			await painted(page);
			await page.evaluate(() => {
				const w = window as unknown as { __long: number[]; __gaps: number[]; __run: boolean };
				w.__long = [];
				w.__gaps = [];
				w.__run = true;
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) w.__long.push(Math.round(entry.duration));
				}).observe({ type: 'long-animation-frame' });
				let last = performance.now();
				const tick = (now: number) => {
					w.__gaps.push(now - last);
					last = now;
					if (w.__run) requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			const layouts = await metric('LayoutCount');
			await page.mouse.move(viewport.width / 2, viewport.height / 2);
			for (let i = 0; i < 30; i++) {
				await page.mouse.wheel(0, 120);
				await page.waitForTimeout(16);
			}
			await page.waitForTimeout(300);
			const measured = await page.evaluate(() => {
				const w = window as unknown as { __long: number[]; __gaps: number[]; __run: boolean };
				w.__run = false;
				const gaps = w.__gaps.slice(1).sort((a, b) => a - b);
				return {
					long: w.__long,
					frames: gaps.length,
					p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
					max: Math.round(gaps[gaps.length - 1] ?? 0),
					scrolled: window.scrollY
				};
			});
			const cost = {
				wall,
				viewport: viewport.name,
				scrolled: measured.scrolled,
				frames: measured.frames,
				p95Ms: measured.p95,
				maxMs: measured.max,
				longFrames: measured.long,
				layouts: (await metric('LayoutCount')) - layouts
			};
			costs.push(JSON.stringify(cost));
			expect(measured.scrolled, 'la molette a fait défiler').toBeGreaterThan(SCROLL);
			expect(cost.longFrames, `${wall} ${viewport.name} : frames longues pendant le défilement`).toEqual([]);
		}
	}
	await page.evaluate(() => localStorage.removeItem('psnes-wallpaper'));
	fs.writeFileSync(path.join(SHOTS, 'scroll-cost.jsonl'), costs.join('\n') + '\n');
	console.log(costs.join('\n'));

	await context.close();
});
