/**
 * Les captures des fonds, à 390x844 et 1440x900.
 *
 * `node tools/bg-preview/shots.mjs <dossier> [url] [fonds...]`, contre le
 * serveur de dev et `mock-backend.mjs` déjà lancés. Une capture par fond et
 * par largeur, plus une avec la fiche d'un jeu ouverte au-dessus du fond.
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [out = 'shots', base = 'http://localhost:5190', ...wanted] = process.argv.slice(2);
const BGS = wanted.length ? wanted : ['current', 'a', 'b', 'c', 'd'];
const SIZES = [
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop', width: 1440, height: 900 }
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const size of SIZES) {
  const { name, width, height, ...rest } = size;
  const context = await browser.newContext({ viewport: { width, height }, ...rest });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  for (const bg of BGS) {
    await page.goto(`${base}/?bg=${bg}`);
    await page.waitForSelector('.games-grid img');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, `${bg}-${width}x${height}.png`) });
    // La fiche d'un jeu, par-dessus le fond.
    await page.locator('.games-grid .details').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `${bg}-${width}x${height}-fiche.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (bg !== 'current' && name === 'desktop') {
      await page.mouse.move(width * 0.9, height * 0.15, { steps: 5 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `${bg}-${width}x${height}-parallaxe.png`) });
    }
  }
  await context.close();
}
await browser.close();
console.log(`captures dans ${out}`);
