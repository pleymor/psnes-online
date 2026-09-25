/**
 * La fiche d'un jeu, sur un petit écran et avec des jaquettes de formats différents.
 *
 * Deux défauts que ces tests gardent, deux mesures, et aucune impression :
 *
 * - La jaquette était posée avec `width="512" height="358"`, le format d'une
 *   boîte américaine, et aucune règle ne rendait sa hauteur au navigateur :
 *   une boîte européenne ou japonaise, plus haute que large, était écrasée
 *   dans ce cadre. La mesure est le rapport de la boîte affichée comparé à
 *   celui de l'image elle-même.
 * - Les boutons fermaient la fiche, sous la jaquette, la description et
 *   toutes les métadonnées : en 360x640 il fallait défiler pour les trouver.
 *   La mesure est la position du bouton Salon dans la fenêtre, fiche tout
 *   juste ouverte, sans le moindre défilement.
 *
 * Les jaquettes sont téléversées par l'API, comme le ferait « Compléter la
 * fiche » : c'est le seul chemin qui en produise sans réseau, et c'est celui
 * qui leur donne leur taille réelle - le serveur les ramène à 512 de large et
 * garde leur hauteur.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loginDev, apiFetch, keepRomOnDevice } from './helpers';
import { makePng } from './png-fixture';

/** Les trois formats qu'on trouve dans une bibliothèque de SNES. */
const COVER_SHAPES = {
	// Une boîte européenne ou japonaise : plus haute que large.
	portrait: { width: 512, height: 720 },
	// Une boîte américaine : plus large que haute.
	landscape: { width: 512, height: 358 },
	// Ce que rendent certaines sources récupérées ailleurs.
	square: { width: 480, height: 480 }
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

/**
 * Un jeu identifié, avec une fiche bien remplie et une jaquette du format demandé.
 *
 * La description est longue exprès : c'est elle qui repoussait les boutons
 * hors de l'écran, et une fiche courte aurait laissé passer le défaut.
 */
async function addGameWithCover(
	cookie: string,
	title: string,
	cover: Buffer
): Promise<{ id: string; crc32: string }> {
	const created = await apiFetch(cookie, '/api/games', {
		method: 'POST',
		body: JSON.stringify({ checksum: freshCrc(), filename: `${title}.sfc` })
	});
	expect(created.ok).toBeTruthy();
	const game = await created.json();

	const identified = await apiFetch(cookie, `/api/games/${game.id}/identify`, {
		method: 'POST',
		body: JSON.stringify({
			entry: {
				title,
				genre: 'Action',
				publisher: 'Éditeur',
				developer: 'Studio',
				releaseDate: '1994-11-18',
				players: '1-2',
				region: 'PAL',
				description:
					'Une aventure en plusieurs mondes, avec des niveaux cachés, des ' +
					'combats contre des gardiens et une carte à parcourir. Assez de ' +
					'texte pour occuper plusieurs lignes sur un téléphone, comme les ' +
					'descriptions du catalogue.'
			}
		})
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

/** Ouvre la fiche par l'affordance en coin de la tuile, et attend sa jaquette. */
async function openDetails(page: Page, title: string) {
	await page.locator(`.game-card[title*="${title}"]`).locator('.details').click();
	const cover = page.locator('.modal-content .cover-image');
	await expect(cover).toBeVisible();
	await expect
		.poll(() => cover.evaluate(img => (img as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	// La fiche entre en glissant de 30 px : mesurée pendant, elle déborde de
	// ce qu'elle ne dépassera plus une fois posée.
	await page
		.locator('.modal-content')
		.evaluate(sheet => Promise.all(sheet.getAnimations({ subtree: true }).map(a => a.finished)));
	return cover;
}

test.describe('la fiche d’un jeu', () => {
	test('chaque jaquette garde son propre format', async ({ page, context }) => {
		const cookie = await loginDev('1');
		await seatCookie(context, cookie);
		const games: string[] = [];

		try {
			for (const [shape, size] of Object.entries(COVER_SHAPES)) {
				const title = `Jaquette ${shape} ${freshCrc()}`;
				const game = await addGameWithCover(cookie, title, makePng(size.width, size.height));
				games.push(game.id);
				await keepRomOnDevice(page, game.crc32);

				for (const viewport of [
					{ width: 360, height: 640 },
					{ width: 1440, height: 900 }
				]) {
					await page.setViewportSize(viewport);
					await page.goto('/');
					const cover = await openDetails(page, title);

					const drawn = await cover.evaluate(node => {
						const img = node as HTMLImageElement;
						return {
							box: img.clientWidth / img.clientHeight,
							picture: img.naturalWidth / img.naturalHeight,
							fit: getComputedStyle(img).objectFit
						};
					});
					const where = `${shape} en ${viewport.width}x${viewport.height}`;
					// Ni étirée : la boîte a le rapport de l'image.
					expect(Math.abs(drawn.box / drawn.picture - 1), where).toBeLessThan(0.02);
					// Ni rognée : `cover` couperait ce qui dépasse de la boîte.
					expect(drawn.fit, where).not.toBe('cover');
				}
			}
		} finally {
			for (const id of games) await apiFetch(cookie, `/api/games/${id}`, { method: 'DELETE' });
		}
	});

	test('le bouton Salon est à portée sans défiler', async ({ page, context }) => {
		const cookie = await loginDev('1');
		await seatCookie(context, cookie);
		// Le format le plus haut : c'est lui qui repoussait le plus les boutons.
		const title = `Fiche longue ${freshCrc()}`;
		const { width, height } = COVER_SHAPES.portrait;
		const game = await addGameWithCover(cookie, title, makePng(width, height));
		await keepRomOnDevice(page, game.crc32);

		try {
			for (const viewport of [
				{ width: 360, height: 640 },
				{ width: 1024, height: 600 }
			]) {
				await page.setViewportSize(viewport);
				await page.goto('/');
				await openDetails(page, title);

				const where = `${viewport.width}x${viewport.height}`;
				const room = page.locator('.modal-content .room');
				const box = await room.boundingBox();
				expect(box, where).not.toBeNull();
				expect(box!.y, where).toBeGreaterThanOrEqual(0);
				expect(box!.x, where).toBeGreaterThanOrEqual(0);
				expect(box!.y + box!.height, where).toBeLessThanOrEqual(viewport.height);
				expect(box!.x + box!.width, where).toBeLessThanOrEqual(viewport.width);
				// Une cible qu'un pouce atteint.
				expect(box!.height, where).toBeGreaterThanOrEqual(44);

				// Et rien n'a défilé pour l'y amener : ni la page, ni la fiche.
				expect(await page.evaluate(() => window.scrollY), where).toBe(0);
				const scrolled = await page
					.locator('.modal-content, .modal-content *')
					.evaluateAll(nodes => nodes.some(n => n.scrollTop > 0));
				expect(scrolled, where).toBe(false);

				// La fiche tient dans la fenêtre : rien ne dépasse en bas.
				const sheet = await page.locator('.modal-content').boundingBox();
				expect(sheet!.y + sheet!.height, where).toBeLessThanOrEqual(viewport.height);
			}
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});
});
