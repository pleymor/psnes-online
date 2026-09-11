/**
 * La barre en largeur de téléphone.
 *
 * Ce que ces tests gardent est une mesure, pas une impression : le contenu
 * de la barre faisait 393 px de large, donc sur un écran de 390 la page se
 * mettait à défiler latéralement et la marque était rognée en un trait.
 * Rien dans la suite ne voyait ça - on peut cliquer tous les boutons d'une
 * page qui déborde.
 *
 * `document.scrollWidth` est la mesure juste : elle vaut la largeur de la
 * fenêtre quand rien ne dépasse, et davantage dès que quelque chose sort.
 * Elle attrape aussi bien la barre que la page en dessous, ce qui a servi -
 * le bloc d'identité du profil débordait pour une raison entièrement
 * différente, et c'est ce chiffre qui l'a dit.
 */

import { test, expect } from '@playwright/test';
import { loginDev, apiFetch, keepRomOnDevice } from './helpers';

const PHONES = [430, 390, 360, 320];

test.describe('la barre sur un écran étroit', () => {
	test('aucune page ne déborde en largeur de téléphone', async ({ page, context }) => {
		const cookie = await loginDev('1');
		await context.addCookies(
			cookie.split('; ').map(pair => {
				const [name, ...rest] = pair.split('=');
				return { name, value: rest.join('='), domain: 'localhost', path: '/' };
			})
		);
		await page.goto('/');
		const res = await apiFetch(cookie, '/api/games', {
			method: 'POST',
			body: JSON.stringify({ checksum: 'FE000001', filename: 'Chrono Trigger (USA).sfc' })
		});
		await keepRomOnDevice(page, (await res.json()).crc32);

		for (const width of PHONES) {
			await page.setViewportSize({ width, height: 780 });
			for (const route of ['/', '/profile', '/docs']) {
				await page.goto(route);
				await page.waitForLoadState('networkidle');
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
				expect(overflow, `${route} à ${width}px`).toBeLessThanOrEqual(width);
			}
		}
	});

	test('le champ prend la barre quand on y entre, et la refermer efface la requête', async ({ page, context }) => {
		const cookie = await loginDev('1');
		await context.addCookies(
			cookie.split('; ').map(pair => {
				const [name, ...rest] = pair.split('=');
				return { name, value: rest.join('='), domain: 'localhost', path: '/' };
			})
		);
		await page.goto('/');
		for (const [i, title] of ['Chrono Trigger (USA)', 'Super Mario Kart (Europe)'].entries()) {
			const res = await apiFetch(cookie, '/api/games', {
				method: 'POST',
				body: JSON.stringify({
					checksum: (0xfe100000 + i).toString(16).toUpperCase(),
					filename: `${title}.sfc`
				})
			});
			await keepRomOnDevice(page, (await res.json()).crc32);
		}

		await page.setViewportSize({ width: 390, height: 780 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await expect(page.locator('.game-card')).toHaveCount(2);

		// Le champ est là tout le temps, et il prend toute la place que les
		// autres ne prennent pas - il avait d'abord été réduit à la largeur de
		// sa loupe, ce qui en faisait un bouton déguisé avec 250 px de vide à
		// côté.
		const field = page.locator('.library-search');
		await expect(field).toBeVisible();
		const collapsed = (await field.boundingBox())!.width;
		expect(collapsed).toBeGreaterThan(150);

		await field.click();
		// Entrer dedans efface le reste de la barre, donc il gagne leur place.
		await expect(page.locator('.friends')).toBeHidden();
		expect((await field.boundingBox())!.width).toBeGreaterThan(collapsed);

		await field.fill('mario');
		await expect(page.locator('.game-card')).toHaveCount(1);

		await page.keyboard.press('Escape');
		// Refermer efface : une bibliothèque filtrée sans champ visible serait
		// un mode caché, et personne ne saurait pourquoi il manque des jeux.
		await expect(page.locator('.game-card')).toHaveCount(2);
		// Et la barre rend leur place à Amis et à l'avatar.
		await expect(page.locator('.friends')).toBeVisible();
	});
});
