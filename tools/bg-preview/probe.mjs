/**
 * Ce que coûte la parallaxe, mesuré plutôt que promis.
 *
 * `node tools/bg-preview/probe.mjs` contre le serveur de dev : la souris
 * bouge, on lit le déplacement de chaque calque, puis on compte les
 * `requestAnimationFrame` demandés pendant 1,5 s d'immobilité - zéro attendu.
 * Deux fois : sans préférence, puis avec `prefers-reduced-motion: reduce`, où
 * tous les calques doivent rester à zéro.
 */
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
for (const reducedMotion of ['no-preference', 'reduce']) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion })).newPage();
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__rafs = 0;
    window.requestAnimationFrame = (cb) => { window.__rafs++; return raf(cb); };
  });
  await page.goto('http://localhost:5190/?bg=d');
  await page.waitForSelector('.games-grid img');
  await page.mouse.move(1400, 100, { steps: 4 });
  await page.waitForTimeout(1500);
  const moved = await page.evaluate(() => [...document.querySelectorAll('.wall [data-depth]')].map((e) => e.style.transform || 'none'));
  const before = await page.evaluate(() => window.__rafs);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__rafs);
  console.log(reducedMotion, JSON.stringify(moved), 'rAF au repos sur 1,5 s :', after - before);
}
await browser.close();
