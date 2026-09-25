/**
 * La grille de la bibliothèque, avec des jaquettes de tous les formats.
 *
 * La carte imposait un cadre 10/7, le format d'une boîte américaine, et
 * l'image le remplissait : une boîte japonaise, debout, y flottait entre deux
 * bandes, et la boîte de l'image n'avait plus rien à voir avec l'image. Trois
 * mesures, et aucune impression :
 *
 * - la boîte de chaque image affichée a le rapport de l'image elle-même, à
 *   1 % près - ni étirée, ni rognée ;
 * - elle est posée au pied de sa cellule, centrée, et touche la cellule par
 *   un côté au moins - aucune boîte ne rapetisse parce qu'elle est petite ;
 * - chaque cellule garde le format fixe de la grille, jaquette chargée ou
 *   non, et toutes les cartes d'une rangée ont la même hauteur.
 *
 * Le contexte du navigateur est neuf, donc la grille ne montre que les jeux
 * de ce test : elle ne liste que ceux dont la ROM est sur l'appareil.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loginDev, apiFetch, keepRomOnDevice } from './helpers';
import { makePng } from './png-fixture';

/** Le format de la cellule, celui de `GameCard.svelte`. */
const CELL_RATIO = 10 / 7;

/** La jaquette elle-même, et non sa copie floue derrière. */
const COVER_IMAGE = '.game-card .cover > img:not(.backdrop)';

/** Ce qu'on trouve dans le catalogue, mesuré, et les deux extrêmes des sources récupérées. */
const COVER_SHAPES = {
	// Une boîte japonaise, debout : 0,55, un quart du catalogue.
	japan: { width: 512, height: 928 },
	// Une européenne récupérée de face, sans tranche.
	portrait: { width: 512, height: 720 },
	// Une américaine, tranche comprise : 1,41, la moitié du catalogue.
	landscape: { width: 512, height: 358 },
	// Presque carrée, comme certaines sources.
	square: { width: 480, height: 470 },
	// Les scans larges, boîte dépliée : 1,83.
	wide: { width: 512, height: 280 },
	// Un petit scan, que le serveur n'agrandit pas.
	small: { width: 200, height: 280 }
} as const;

function freshCrc(): string {
	return Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.toUpperCase()
		.padStart(8, '0');
}

async function seatCookie(context: BrowserContext, cookie: string) {
	await context.addCookies(
		cookie.split('; ').map(pair => {
			const [name, ...rest] = pair.split('=');
			return { name, value: rest.join('='), domain: 'localhost', path: '/' };
		})
	);
}

/** Un jeu identifié, avec une jaquette téléversée - ou sans, quand `cover` manque. */
async function addGame(
	cookie: string,
	title: string,
	cover?: Buffer
): Promise<{ id: string; crc32: string }> {
	const created = await apiFetch(cookie, '/api/games', {
		method: 'POST',
		body: JSON.stringify({ checksum: freshCrc(), filename: `${title}.sfc` })
	});
	expect(created.ok).toBeTruthy();
	const game = await created.json();
	if (!cover) return game;

	const identified = await apiFetch(cookie, `/api/games/${game.id}/identify`, {
		method: 'POST',
		body: JSON.stringify({ entry: { title } })
	});
	expect(identified.ok).toBeTruthy();
	const { metadataId } = await identified.json();

	const uploaded = await apiFetch(cookie, `/api/metadata/${metadataId}/cover`, {
		method: 'PUT',
		headers: { 'Content-Type': 'image/png' },
		body: cover
	});
	expect(uploaded.ok).toBeTruthy();
	return game;
}

/** Fait défiler chaque carte à l'écran - les jaquettes sont `lazy` - et attend son image. */
async function loadEveryCover(page: Page) {
	const arts = page.locator(COVER_IMAGE);
	await expect(arts).toHaveCount(Object.keys(COVER_SHAPES).length);
	for (const art of await arts.all()) {
		await art.scrollIntoViewIfNeeded();
		await expect
			.poll(() => art.evaluate(img => (img as HTMLImageElement).naturalWidth))
			.toBeGreaterThan(0);
	}
	// Le format connu au chargement, la carte le reporte : un tour de rendu de plus.
	await page.evaluate(
		() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
	);
	await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe('la grille de la bibliothèque', () => {
	test('chaque jaquette à son format, posée au pied de sa cellule', async ({ page, context }) => {
		const cookie = await loginDev('1');
		await seatCookie(context, cookie);
		const run = freshCrc();
		const games: string[] = [];

		try {
			for (const [shape, size] of Object.entries(COVER_SHAPES)) {
				const game = await addGame(cookie, `Grille ${shape} ${run}`, makePng(size.width, size.height));
				games.push(game.id);
				await keepRomOnDevice(page, game.crc32);
			}
			// Et un jeu sans jaquette : son étiquette doit tenir la même cellule.
			const bare = await addGame(cookie, `Grille sans jaquette ${run}`);
			games.push(bare.id);
			await keepRomOnDevice(page, bare.crc32);

			for (const viewport of [
				{ width: 360, height: 640 },
				{ width: 390, height: 844 },
				{ width: 1440, height: 900 }
			]) {
				const where = `${viewport.width}x${viewport.height}`;
				await page.setViewportSize(viewport);
				await page.goto('/');
				await expect(page.locator('.game-card')).toHaveCount(games.length);

				// La place est réservée avant qu'aucune image n'arrive : chaque
				// cellule est au format de la grille, image chargée ou non.
				const cells = await page.locator('.game-card .cover').evaluateAll(nodes =>
					nodes.map(n => ({ w: n.clientWidth, h: n.clientHeight }))
				);
				for (const cell of cells) {
					expect(Math.abs(cell.w / cell.h / CELL_RATIO - 1), `cellule en ${where}`).toBeLessThan(0.01);
				}

				await loadEveryCover(page);

				const drawn = await page.locator(COVER_IMAGE).evaluateAll(nodes =>
					nodes.map(node => {
						const img = node as HTMLImageElement;
						const cell = img.parentElement!;
						const box = img.getBoundingClientRect();
						const frame = cell.getBoundingClientRect();
						const style = getComputedStyle(cell);
						// L'intérieur de la cellule, bord d'encre exclu.
						const inner = {
							left: frame.left + parseFloat(style.borderLeftWidth),
							right: frame.right - parseFloat(style.borderRightWidth),
							top: frame.top + parseFloat(style.borderTopWidth),
							bottom: frame.bottom - parseFloat(style.borderBottomWidth)
						};
						return {
							title: img.closest('.game-card')!.getAttribute('title'),
							box: box.width / box.height,
							picture: img.naturalWidth / img.naturalHeight,
							fit: getComputedStyle(img).objectFit,
							width: box.width,
							height: box.height,
							innerWidth: inner.right - inner.left,
							innerHeight: inner.bottom - inner.top,
							gapBottom: inner.bottom - box.bottom,
							gapTop: box.top - inner.top,
							gapLeft: box.left - inner.left,
							gapRight: inner.right - box.right
						};
					})
				);

				for (const d of drawn) {
					const which = `${d.title} en ${where}`;
					// Ni étirée : la boîte a le rapport de l'image.
					expect(Math.abs(d.box / d.picture - 1), which).toBeLessThan(0.01);
					// Ni rognée.
					expect(d.fit, which).not.toBe('cover');
					// Posée au pied de la cellule, et dedans.
					expect(Math.abs(d.gapBottom), which).toBeLessThanOrEqual(1);
					expect(d.gapTop, which).toBeGreaterThanOrEqual(-1);
					// Centrée.
					expect(Math.abs(d.gapLeft - d.gapRight), which).toBeLessThanOrEqual(1);
					expect(d.gapLeft, which).toBeGreaterThanOrEqual(-1);
					// Et aussi grande que la cellule le permet : un côté la touche.
					const touches =
						Math.abs(d.width - d.innerWidth) <= 1 || Math.abs(d.height - d.innerHeight) <= 1;
					expect(touches, which).toBe(true);
				}

				// Toutes les cartes d'une rangée ont la même hauteur, étiquette comprise.
				const cards = await page.locator('.game-card').evaluateAll(nodes =>
					nodes.map(n => {
						const r = n.getBoundingClientRect();
						return { top: Math.round(r.top + window.scrollY), height: r.height };
					})
				);
				const rows = new Map<number, number[]>();
				for (const card of cards) rows.set(card.top, [...(rows.get(card.top) ?? []), card.height]);
				for (const [top, heights] of rows) {
					expect(Math.max(...heights) - Math.min(...heights), `rangée à ${top} en ${where}`).toBeLessThanOrEqual(0.5);
				}
				// Et la grille en a bien, des rangées de plusieurs cartes, en large.
				if (viewport.width >= 1024) expect(Math.max(...[...rows.values()].map(r => r.length))).toBeGreaterThan(1);
			}
		} finally {
			for (const id of games) await apiFetch(cookie, `/api/games/${id}`, { method: 'DELETE' });
		}
	});
});
