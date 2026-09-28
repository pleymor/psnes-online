import { test, expect, type Browser, type Page } from '@playwright/test';

/*
 * La voix VR entre deux navigateurs, au niveau du salon.
 *
 * AU NIVEAU DU SALON, ET C'EST UNE LIMITE ASSUMÉE. Un Chromium sans casque ne
 * peut pas ouvrir de session immersive, donc la scène - l'avatar, son anneau,
 * le badge du poignet - n'est pas atteignable d'ici. Ce fichier pilote le vrai
 * `VoiceChat` comme `VrShell` le pilote, sur le vrai relais `vr-voice.ts` :
 * tout ce qui décide qui entend qui, et si le son passe, est ce qui tourne.
 *
 * Les niveaux sont lus sur les `AnalyserNode` du module lui-même : « Bob
 * entend Alice » veut dire que la piste d'Alice arrive chez Bob et porte du
 * signal, pas qu'un évènement a été émis.
 */

interface Harness {
  connected(): boolean;
  join(roomId: string | null): void;
  leave(): void;
  mute(on: boolean): void;
  state(): { mic: string; peers: { id: string; connected: boolean }[] };
  probe(): { self: number; peers: Record<string, number>; micTracks: string[] };
  micTracks(): string[];
}

declare global {
  interface Window {
    harness: Harness;
  }
}

async function open(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.text().startsWith('[voice]')) console.log(`${user}: ${m.text()}`);
  });
  await page.goto(`/?user=${user}`);
  await page.waitForFunction(() => window.harness?.connected());
  return page;
}

/** Le niveau le plus fort de `from` chez `page` sur une fenêtre d'une seconde et demie. */
async function loudest(page: Page, from: string): Promise<number> {
  return page.evaluate(async (id) => {
    let max = 0;
    for (let i = 0; i < 30; i += 1) {
      max = Math.max(max, window.harness.probe().peers[id] ?? 0);
      await new Promise((r) => setTimeout(r, 50));
    }
    return max;
  }, from);
}

async function connectedTo(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (peer) => window.harness.state().peers.some((p) => p.id === peer && p.connected),
    id,
    { timeout: 20_000 }
  );
}

test('deux amis au lobby VR s\'entendent, et couper le micro coupe ce qui part', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  const bob = await open(browser, 'bob');

  // Seul, on ne demande pas le micro : aucun flux n'est ouvert.
  await alice.evaluate(() => window.harness.join(null));
  await alice.waitForTimeout(500);
  expect(await alice.evaluate(() => window.harness.micTracks())).toEqual([]);
  expect(await alice.evaluate(() => window.harness.state().mic)).toBe('idle');

  await bob.evaluate(() => window.harness.join(null));
  await connectedTo(alice, 'bob');
  await connectedTo(bob, 'alice');
  expect(await alice.evaluate(() => window.harness.state().mic)).toBe('live');

  // Une piste audio connectée, et qui porte le son du micro factice.
  await expect.poll(() => loudest(bob, 'alice'), { timeout: 15_000 }).toBeGreaterThan(0.005);
  await expect.poll(() => loudest(alice, 'bob'), { timeout: 15_000 }).toBeGreaterThan(0.005);

  // Alice coupe : chez Bob, son niveau tombe à zéro. Et Bob, lui, s'entend toujours.
  await alice.evaluate(() => window.harness.mute(true));
  expect(await alice.evaluate(() => window.harness.state().mic)).toBe('muted');
  await expect.poll(() => loudest(bob, 'alice'), { timeout: 10_000 }).toBeLessThan(0.0005);
  expect(await loudest(alice, 'bob')).toBeGreaterThan(0.005);

  // Et rouvre : le son revient sans renégocier.
  await alice.evaluate(() => window.harness.mute(false));
  await expect.poll(() => loudest(bob, 'alice'), { timeout: 10_000 }).toBeGreaterThan(0.005);

  // Partir rend le micro : chaque piste qu'il a donnée est arrêtée, et l'autre
  // côté voit le pair disparaître - puis rend le sien, puisqu'il est seul.
  await alice.evaluate(() => window.harness.leave());
  const aliceTracks = await alice.evaluate(() => window.harness.micTracks());
  expect(aliceTracks.length).toBeGreaterThan(0);
  expect(aliceTracks.every((s) => s === 'ended')).toBe(true);
  await bob.waitForFunction(() => window.harness.state().peers.length === 0);
  await bob.waitForFunction(() => window.harness.micTracks().every((s) => s === 'ended'));
  expect(await bob.evaluate(() => window.harness.state().mic)).toBe('idle');

  await alice.context().close();
  await bob.context().close();
});

test('une inconnue dans le même lobby n\'entend personne et n\'est entendue de personne', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  const bob = await open(browser, 'bob');
  const carol = await open(browser, 'carol');

  await carol.evaluate(() => window.harness.join(null));
  await alice.evaluate(() => window.harness.join(null));
  await bob.evaluate(() => window.harness.join(null));
  await connectedTo(alice, 'bob');

  await carol.waitForTimeout(1500);
  expect(await carol.evaluate(() => window.harness.state().peers)).toEqual([]);
  // Carol n'a jamais eu personne à qui parler : son micro n'a même pas été demandé.
  expect(await carol.evaluate(() => window.harness.micTracks())).toEqual([]);
  expect((await alice.evaluate(() => window.harness.state().peers)).map((p) => p.id)).toEqual(['bob']);

  for (const page of [alice, bob, carol]) await page.context().close();
});

test('pendant une partie à deux, la voix suit le salon et quitte le lobby', async ({ browser }) => {
  const alice = await open(browser, 'alice');
  const bob = await open(browser, 'bob');

  // Alice lance la partie, Bob est encore au lobby : ils ne sont plus au même endroit.
  await alice.evaluate(() => window.harness.join('salon-ab'));
  await bob.evaluate(() => window.harness.join(null));
  await bob.waitForTimeout(1000);
  expect(await bob.evaluate(() => window.harness.state().peers)).toEqual([]);

  // Bob la rejoint dans le salon : ils s'entendent.
  await bob.evaluate(() => window.harness.join('salon-ab'));
  await connectedTo(alice, 'bob');
  await expect.poll(() => loudest(alice, 'bob'), { timeout: 15_000 }).toBeGreaterThan(0.005);

  await alice.evaluate(() => window.harness.leave());
  await bob.evaluate(() => window.harness.leave());
  expect((await bob.evaluate(() => window.harness.micTracks())).every((s) => s === 'ended')).toBe(true);

  await alice.context().close();
  await bob.context().close();
});
