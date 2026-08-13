import { defineConfig } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Playwright ships a pinned browser revision. Rather than requiring a
 * `playwright install` download, reuse whichever chromium build is already in
 * the local cache. Override with E2E_CHROMIUM if needed.
 */
function findChromium(): string | undefined {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;

  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;

  const candidates = fs
    .readdirSync(cache)
    .filter(d => d.startsWith('chromium-'))
    .sort()
    .reverse()
    .map(d => path.join(cache, d, 'chrome-linux64', 'chrome'))
    .filter(p => fs.existsSync(p));

  return candidates[0];
}

const executablePath = findChromium();

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  fullyParallel: false, // tests share one backend and its in-memory room state
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_APP_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath, args: ['--no-sandbox'] } } : {})
  }
});
