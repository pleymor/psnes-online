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

	/**
	 * Le centre de notifications ouvert, en largeur de téléphone.
	 *
	 * Le panneau était accroché à la CLOCHE (`right: 0` mesuré depuis elle) et
	 * large de `min(24rem, 100vw - 2rem)`. La cloche ouvre le groupe de droite,
	 * donc son bord droit tombe vers 285 px sur un écran de 390 : le panneau
	 * commençait à **-83 px**, une ligne sur cinq lisible et la colonne des tons
	 * hors écran. Rien ne voyait ça - `document.scrollWidth` non plus, puisque
	 * ce qui sort par la GAUCHE ne fait pas défiler la page.
	 *
	 * Deux mesures, donc, et pas une impression :
	 *
	 * - le panneau tient dans l'écran, bord à bord ;
	 * - son haut tombe sur le bas de la barre, à un pixel près. Ce nombre-là
	 *   est fragile par nature : le panneau est un DESCENDANT de la barre, donc
	 *   il peint par-dessus son fond quoi qu'on fasse - contrairement au tiroir
	 *   des amis, qui est un frère et passe dessous. Trop haut il rogne les
	 *   boutons et mange le liseré d'or, trop bas il laisse passer la page en un
	 *   cheveu. Si la barre change de hauteur, c'est ici que ça se dit.
	 */
	test('le centre de notifications tient dans un écran de téléphone', async ({ page, context }) => {
		const cookie = await loginDev('1');
		await context.addCookies(
			cookie.split('; ').map(pair => {
				const [name, ...rest] = pair.split('=');
				return { name, value: rest.join('='), domain: 'localhost', path: '/' };
			})
		);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		// Par le stockage, qui est le chemin réel d'une notification qui survit
		// à un rechargement (`notices/persist.ts`). Les deux formes à boutons
		// sont `live`, donc purgées au démarrage : elles ne se posent pas ici.
		await page.evaluate(() => {
			const born = Date.now() - 60_000;
			localStorage.setItem(
				'psnes-notices',
				JSON.stringify([
					{ id: 'n1', kind: 'raw', params: { message: 'Chrono Trigger a été ajouté à ta bibliothèque', tone: 'success' }, at: born },
					{ id: 'n2', kind: 'raw', params: { message: 'Le serveur de jeu est injoignable, nouvelle tentative dans 10 s', tone: 'error' }, at: born + 1 },
					{ id: 'n3', kind: 'raw', params: { message: 'Sauvegarde rapide enregistrée', tone: 'info' }, at: born + 2 }
				])
			);
		});
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const bell = page.locator('.bell');
		await expect(page.locator('.badge')).toHaveText('3');
		await bell.click();

		const panel = page.locator('.panel');
		await expect(panel).toBeVisible();

		const box = (await panel.boundingBox())!;
		expect(box.x, 'le bord gauche du panneau').toBeGreaterThanOrEqual(0);
		expect(box.x + box.width, 'le bord droit du panneau').toBeLessThanOrEqual(390);

		const bar = (await page.locator('.top-bar').boundingBox())!;
		expect(box.y, 'le haut du panneau contre le bas de la barre').toBeGreaterThan(
			bar.y + bar.height - 3
		);
		expect(box.y, 'le haut du panneau contre le bas de la barre').toBeLessThanOrEqual(
			bar.y + bar.height
		);

		// La cloche reste atteignable au-dessus : c'est le seul geste qui referme
		// le centre sur un téléphone - ni Échap, ni dehors où cliquer - et c'est
		// la fermeture qui consomme la liste.
		await bell.click();
		await expect(panel).toBeHidden();
		await expect(page.locator('.badge')).toHaveCount(0);
	});
});
