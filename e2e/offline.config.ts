import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * The offline suite, against a production build.
 *
 * Its own config because it needs neither the backend nor the dev server the
 * main suite waits for in `global-setup.ts` - and cannot use the dev server at
 * all: SvelteKit registers the service worker only in a build, and the whole
 * point here is what that worker serves once the network is gone.
 *
 * `vite preview` serves the build as it will be deployed, prerendered pages
 * and fallback included. Its `/api` and `/auth` proxy points at a backend that
 * is not there, which is fine: the first visit only has to install the worker.
 */
const PORT = Number(process.env.E2E_OFFLINE_PORT || 4173);

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  testIgnore: undefined,
  testMatch: /offline\.spec\.ts$/,
  use: {
    ...baseConfig.use,
    baseURL: `http://localhost:${PORT}`,
    // Recorded for the pull request: the offline home and the game, at the
    // two widths the brief names.
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: `bun run build && bunx vite preview --port ${PORT} --strictPort`,
    cwd: '../frontend',
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI
  }
});
