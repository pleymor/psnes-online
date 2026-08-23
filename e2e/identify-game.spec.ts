/**
 * A contribution to the shared catalogue.
 *
 * The assertion that matters here is the one no unit test can carry: a *second*
 * account, which did nothing, sees the title the first account posted. That is
 * the whole reason the link lives in its own table and is resolved at read time
 * instead of being copied into each player's row.
 */

import { test, expect } from '@playwright/test';
import { loginDev, apiFetch } from './helpers';
import { makePng } from './png-fixture';

/**
 * A CRC32 nothing has ever claimed, fresh for every test that needs one.
 *
 * It cannot be a constant. A link is a fact about a dump, not about a player's
 * copy, so deleting the games at the end of a test deliberately leaves the link
 * standing -- which means a shared checksum would be claimed by whichever test
 * ran first, and a second run against the same database would find every
 * checksum already taken. Learned by writing it the other way.
 */
function freshCrc(): string {
	return Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase().padStart(8, '0');
}

async function addGame(cookie: string, checksum: string, filename: string) {
	const res = await apiFetch(cookie, '/api/games', {
		method: 'POST',
		body: JSON.stringify({ checksum, filename })
	});
	expect(res.ok).toBeTruthy();
	return res.json();
}

async function libraryEntry(cookie: string, gameId: string) {
	const games = await (await apiFetch(cookie, '/api/games')).json();
	return games.find((g: { id: string }) => g.id === gameId);
}

test.describe('completing the games database', () => {
	test('one player identifies a ROM and both players see it', async () => {
		const one = await loginDev('1');
		const two = await loginDev('2');

		// The same dump, held by two players under two different filenames.
		const dump = freshCrc();
		const gameOne = await addGame(one, dump, 'mystery-rom.sfc');
		const gameTwo = await addGame(two, dump, 'same-dump-different-name.sfc');

		try {
			// Nothing recognises this dump, so the library says so rather than
			// pretending the filename is a title.
			expect((await libraryEntry(one, gameOne.id)).needsIdentification).toBe(true);

			const identified = await apiFetch(one, `/api/games/${gameOne.id}/identify`, {
				method: 'POST',
				body: JSON.stringify({
					entry: { title: 'Umihara Kawase', genre: 'Puzzle-Platform', publisher: 'TNN' }
				})
			});
			expect(identified.status).toBe(200);
			const { metadataId } = await identified.json();

			const forOne = await libraryEntry(one, gameOne.id);
			expect(forOne.title).toBe('Umihara Kawase');
			expect(forOne.genre).toBe('Puzzle-Platform');
			expect(forOne.needsIdentification).toBe(false);

			// The point of the whole feature: player two contributed nothing and
			// changed nothing, and their library is now correct too.
			const forTwo = await libraryEntry(two, gameTwo.id);
			expect(forTwo.title).toBe('Umihara Kawase');
			expect(forTwo.metadataId).toBe(metadataId);
			expect(forTwo.needsIdentification).toBe(false);

			// And the entry is findable by everyone, not just by its author.
			const found = await (await apiFetch(two, '/api/metadata/search?q=Umihara')).json();
			expect(found.map((m: { id: string }) => m.id)).toContain(metadataId);
		} finally {
			await apiFetch(one, `/api/games/${gameOne.id}`, { method: 'DELETE' });
			await apiFetch(two, `/api/games/${gameTwo.id}`, { method: 'DELETE' });
		}
	});

	test('a dump already claimed answers with what it is, not with a failure', async () => {
		const one = await loginDev('1');
		const two = await loginDev('2');
		const dump = freshCrc();
		const gameOne = await addGame(one, dump, 'claimed.sfc');
		const gameTwo = await addGame(two, dump, 'claimed-too.sfc');

		try {
			await apiFetch(one, `/api/games/${gameOne.id}/identify`, {
				method: 'POST',
				body: JSON.stringify({ entry: { title: 'First Answer' } })
			});

			const second = await apiFetch(two, `/api/games/${gameTwo.id}/identify`, {
				method: 'POST',
				body: JSON.stringify({ entry: { title: 'Second Answer' } })
			});

			expect(second.status).toBe(409);
			const payload = await second.json();
			// The client can say "already identified as X" instead of showing an
			// error the player cannot act on.
			expect(payload.metadata.title).toBe('First Answer');
		} finally {
			await apiFetch(one, `/api/games/${gameOne.id}`, { method: 'DELETE' });
			await apiFetch(two, `/api/games/${gameTwo.id}`, { method: 'DELETE' });
		}
	});

	test('a cover is stored, served back byte for byte, and visible to everyone', async () => {
		const cookie = await loginDev('1');
		const other = await loginDev('2');
		const game = await addGame(cookie, freshCrc(), 'illustrated.sfc');
		const png = makePng(16, 16);

		try {
			const { metadataId } = await (
				await apiFetch(cookie, `/api/games/${game.id}/identify`, {
					method: 'POST',
					body: JSON.stringify({ entry: { title: 'Illustrated Game' } })
				})
			).json();

			const put = await apiFetch(cookie, `/api/metadata/${metadataId}/cover`, {
				method: 'PUT',
				headers: { 'Content-Type': 'image/png' },
				body: png
			});
			expect(put.status).toBe(200);
			const { coverUrl } = await put.json();

			// The URL carries the write's timestamp, which is what lets the
			// response be cached hard without a replacement going unseen.
			expect(coverUrl).toMatch(/^\/api\/covers\/[0-9a-f-]+\?v=\d+$/);

			// The library now offers it as the game's cover, through the same
			// coverUrl field the cards already read.
			const listed = await libraryEntry(cookie, game.id);
			expect(listed.coverUrl).toBe(coverUrl);

			// Any signed-in player can fetch it, and the bytes are unchanged.
			const got = await apiFetch(other, coverUrl);
			expect(got.status).toBe(200);
			expect(got.headers.get('content-type')).toBe('image/png');
			expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});

	test('an oversized cover is refused as too large, not as a server fault', async () => {
		const cookie = await loginDev('1');
		const game = await addGame(cookie, freshCrc(), 'oversized.sfc');

		try {
			const { metadataId } = await (
				await apiFetch(cookie, `/api/games/${game.id}/identify`, {
					method: 'POST',
					body: JSON.stringify({ entry: { title: 'Oversized' } })
				})
			).json();

			// A real PNG header followed by padding, comfortably over the 400 KB
			// body limit. A large *picture* would not do: these fixtures are
			// smooth gradients, and a 700x700 one deflates to about 50 KB. The
			// padding is never inspected either way -- the body limit trips
			// before any handler sees the bytes, which is the point being tested.
			const huge = Buffer.concat([makePng(8, 8), Buffer.alloc(500 * 1024)]);
			expect(huge.length).toBeGreaterThan(400 * 1024);

			const refused = await apiFetch(cookie, `/api/metadata/${metadataId}/cover`, {
				method: 'PUT',
				headers: { 'Content-Type': 'image/png' },
				body: huge
			});

			// Answering 500 here would tell the player "internal server error"
			// for a picture that is merely too big, and they would retry it
			// unchanged. This is the assertion that keeps that from returning.
			expect(refused.status).toBe(413);
			expect((await refused.json()).error).toBe('That file is too large');
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});

	test('a file that is not an image is refused as a cover', async () => {
		const cookie = await loginDev('1');
		const game = await addGame(cookie, freshCrc(), 'cover-test.sfc');

		try {
			const identified = await apiFetch(cookie, `/api/games/${game.id}/identify`, {
				method: 'POST',
				body: JSON.stringify({ entry: { title: 'Cover Test' } })
			});
			expect(identified.status).toBe(200);
			const { metadataId } = await identified.json();

			const refused = await apiFetch(cookie, `/api/metadata/${metadataId}/cover`, {
				method: 'PUT',
				headers: { 'Content-Type': 'image/png' },
				body: Buffer.from('<svg onload="alert(1)"></svg>')
			});

			// The declared type said PNG. The bytes decide.
			expect(refused.status).toBe(415);
		} finally {
			await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
		}
	});
});
