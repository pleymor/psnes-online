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
 *
 * The last two cover the way back out. Identifying used to be a one-way door -
 * the server answered 409 to anything about a dump already claimed - so a
 * wrong answer was permanent, and the client made it worse by closing the
 * window on the message explaining why. Both halves of the way out are here:
 * pointing the dump at a different entry, and correcting the entry itself.
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

	test('a dump named as the wrong game can be pointed at the right one', async ({
		page,
		context
	}) => {
		const cookie = await loginDev('1');
		const game = await addUnidentifiedGame(cookie, 'xxx-mistaken.sfc');
		// Identified through the API: what this test is about is the second
		// answer, not the first.
		const wrong = await apiFetch(cookie, `/api/games/${game.id}/identify`, {
			method: 'POST',
			body: JSON.stringify({ entry: { title: 'Wrongly Named Game' } })
		});
		expect(wrong.ok).toBeTruthy();
		await seatCookie(context, cookie);
		await keepRomOnDevice(page, game.crc32);

		try {
			await page.goto('/');
			await page.locator('.game-card', { hasText: 'Wrongly Named Game' }).locator('.cover').click();
			await page.locator('.identify').click();

			await page.locator('input[type="search"]').fill('ActRaiser');
			const first = page.locator('.result').first();
			await expect(first).toContainText('ActRaiser');
			await first.click();

			// This is the click that used to come back 409 and close the window
			// without a word, leaving the card exactly as it was.
			await expect(page.locator('.game-card', { hasText: 'ActRaiser' })).toBeVisible();
			await expect(page.locator('.game-card', { hasText: 'Wrongly Named Game' })).toHaveCount(0);
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});

	test('an entry that is right but wrong can be corrected in place', async ({ page, context }) => {
		const cookie = await loginDev('1');
		const game = await addUnidentifiedGame(cookie, 'www-typo.sfc');
		const written = await apiFetch(cookie, `/api/games/${game.id}/identify`, {
			method: 'POST',
			body: JSON.stringify({ entry: { title: 'Umihra Kawase', genre: 'Platform' } })
		});
		expect(written.ok).toBeTruthy();
		const { metadataId } = await written.json();
		await seatCookie(context, cookie);
		await keepRomOnDevice(page, game.crc32);

		try {
			await page.goto('/');
			await page.locator('.game-card', { hasText: 'Umihra Kawase' }).locator('.cover').click();
			await page.locator('.identify').click();

			await page.getByRole('button', { name: 'Correct this entry' }).click();

			// Filled in with what the entry says today. A form that opened empty
			// would blank every field the player did not retype.
			await expect(page.locator('.fields input').first()).toHaveValue('Umihra Kawase');
			await expect(page.locator('.fields input').nth(1)).toHaveValue('Platform');

			await page.locator('.fields input').first().fill('Umihara Kawase');
			await page.locator('.primary').click();

			await expect(page.locator('.game-card', { hasText: 'Umihara Kawase' })).toBeVisible();

			// The id did not change: correcting is not creating. Everything
			// already attached to this entry - its cover, its credit, the other
			// players' games - stays attached.
			const after = await apiFetch(cookie, '/api/games');
			const mine = (await after.json()).find((g: { id: string }) => g.id === game.id);
			expect(mine.metadataId).toBe(metadataId);
			expect(mine.title).toBe('Umihara Kawase');
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});
});
