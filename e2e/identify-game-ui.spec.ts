/**
 * The identify flow as a player meets it.
 *
 * identify-game.spec.ts covers the API. This covers what the API cannot: the
 * badge that starts the whole thing, one click on a search result, and above
 * all `encodeCover` - createImageBitmap, canvas.toBlob and the WebP-or-JPEG
 * fallback, none of which a type checker or a request-level test can execute.
 *
 * The image is deliberately 1400px wide, so the 512px cap has to bite and the
 * bytes that reach the server are the resized ones, not the file that was
 * picked.
 */

import { test, expect, type BrowserContext } from '@playwright/test';
import { loginDev, apiFetch, keepRomOnDevice } from './helpers';
import { makePng } from './png-fixture';

function freshCrc(): string {
	return Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.toUpperCase()
		.padStart(8, '0');
}

/** The session cookie, moved from the API client into the browser. */
async function seatCookie(context: BrowserContext, cookie: string) {
	await context.addCookies(
		cookie.split('; ').map(pair => {
			const [name, ...rest] = pair.split('=');
			return { name, value: rest.join('='), domain: 'localhost', path: '/' };
		})
	);
}

async function addUnidentifiedGame(cookie: string, filename: string) {
	const res = await apiFetch(cookie, '/api/games', {
		method: 'POST',
		body: JSON.stringify({ checksum: freshCrc(), filename })
	});
	expect(res.ok).toBeTruthy();
	return res.json();
}

test.describe('identifying a game in the browser', () => {
	test('the badge leads to a catalogue entry in one click', async ({ page, context }) => {
		const cookie = await loginDev('1');
		const game = await addUnidentifiedGame(cookie, 'zzz-unknown-dump.sfc');
		await seatCookie(context, cookie);
		// The checksum is freshly minted, so nothing on this device can resolve
		// it and the grid would leave the card out. See keepRomOnDevice.
		await keepRomOnDevice(page, game.crc32);

		const problems: string[] = [];
		page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
		page.on('console', m => {
			if (m.type() === 'error') problems.push(m.text());
		});

		try {
			await page.goto('/');

			const card = page.locator('.game-card', { hasText: 'zzz-unknown-dump' });
			await expect(card).toBeVisible();
			await expect(card.locator('.needs-identification')).toBeVisible();

			await card.locator('.cover').click();
			await page.locator('.identify').click();

			// Seeded with the game's own title, so the field is never empty and
			// the ordinary case needs no typing at all.
			await expect(page.locator('input[type="search"]')).toHaveValue(/zzz-unknown-dump/);

			// ActRaiser is the first entry of the shipped catalogue.
			await page.locator('input[type="search"]').fill('ActRaiser');
			const first = page.locator('.result').first();
			await expect(first).toContainText('ActRaiser');
			await first.click();

			const relabelled = page.locator('.game-card', { hasText: 'ActRaiser' });
			await expect(relabelled).toBeVisible();
			await expect(relabelled.locator('.needs-identification')).toHaveCount(0);

			expect(problems, problems.join(' | ')).toEqual([]);
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});

	test('an entry can be written by hand, with an image resized in the browser', async ({
		page,
		context
	}) => {
		const cookie = await loginDev('1');
		const game = await addUnidentifiedGame(cookie, 'yyy-handwritten.sfc');
		await seatCookie(context, cookie);
		// The checksum is freshly minted, so nothing on this device can resolve
		// it and the grid would leave the card out. See keepRomOnDevice.
		await keepRomOnDevice(page, game.crc32);

		const problems: string[] = [];
		page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
		page.on('console', m => {
			if (m.type() === 'error') problems.push(m.text());
		});

		try {
			await page.goto('/');
			await page.locator('.game-card', { hasText: 'yyy-handwritten' }).locator('.cover').click();
			await page.locator('.identify').click();
			await page.locator('.link').click();

			// Only two fields, because every one of them is meant to be optional.
			await page.locator('.fields input').first().fill('Hand Written Game');
			await page.locator('.fields input').nth(1).fill('Shoot em up');

			await page.locator('input[type="file"]').setInputFiles({
				name: 'cover.png',
				mimeType: 'image/png',
				buffer: makePng(1400, 1000)
			});
			await expect(page.locator('.preview')).toBeVisible();

			await page.locator('.primary').click();

			const relabelled = page.locator('.game-card', { hasText: 'Hand Written Game' });
			await expect(relabelled).toBeVisible();
			await expect(relabelled.locator('.needs-identification')).toHaveCount(0);

			// A real <img>, not the placeholder, at a versioned URL.
			const img = relabelled.locator('.cover img');
			await expect(img).toBeVisible();
			expect(await img.getAttribute('src')).toMatch(/^\/api\/covers\/[0-9a-f-]+\?v=\d+$/);

			expect(problems, problems.join(' | ')).toEqual([]);
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});
});
