/*
 * Rasterises the icon SVGs in frontend/static with the Chromium that Playwright
 * already installed for the e2e suite, so no image toolchain (sharp,
 * ImageMagick, Pillow) becomes a dependency of the repo.
 *
 *   node scripts/generate-icons.mjs
 *
 * Every PNG below is derived - edit the SVG, re-run this, never hand-edit a PNG.
 */
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = process.env.ICON_DIR
  ? resolve(process.env.ICON_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'static');

/*
 * favicon.svg is the label alone: below 48px the 1.511 cassette face leaves its
 * label 10 x 6 px, so the shell only appears from icon.svg upwards. The Apple
 * source is square and opaque because iOS masks it itself and composites alpha
 * onto black; the maskable source drops the shell because Android's circular
 * crop would cut both ends off a landscape cassette.
 */
const TARGETS = [
  { src: 'favicon.svg', out: 'favicon-16.png', size: 16 },
  { src: 'favicon.svg', out: 'favicon-32.png', size: 32 },
  { src: 'favicon.svg', out: 'favicon.png', size: 32 },
  { src: 'favicon.svg', out: 'favicon-48.png', size: 48 },
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon-apple.svg', out: 'apple-touch-icon.png', size: 180 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

const cache = new Map();
async function source(name) {
  if (!cache.has(name)) {
    const svg = await readFile(join(STATIC, name));
    cache.set(name, `data:image/svg+xml;base64,${svg.toString('base64')}`);
  }
  return cache.get(name);
}

const browser = await chromium.launch();
try {
  for (const { src, out, size } of TARGETS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}
       img{display:block;width:${size}px;height:${size}px}</style>
       <img src="${await source(src)}">`,
    );
    await page.locator('img').waitFor();
    const png = await page.screenshot({ omitBackground: true });
    await writeFile(join(STATIC, out), png);
    await page.close();
    console.log(`${out.padEnd(24)} ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} B  <- ${src}`);
  }
} finally {
  await browser.close();
}
