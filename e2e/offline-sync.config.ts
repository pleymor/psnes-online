import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Hors-ligne d'abord avec un compte (#71), sur un build de production et un
 * vrai backend.
 *
 * Sa propre configuration pour les deux raisons de `offline.config.ts` - seul
 * un build enregistre le service worker, et c'est ce qu'il sert sans réseau
 * qui est testé - plus une troisième : ici il faut un compte, donc un serveur.
 * Pas celui de `docker compose` : `sync-stack.ts` lance le vrai
 * `backend/src/index.ts` sur une base neuve, et `redis-server` tourne à côté.
 * `E2E_REDIS_SERVER` désigne le binaire s'il n'est pas dans le PATH.
 *
 * `vite preview` relaie `/api`, `/auth`, `/covers` et `/socket.io` vers ce
 * backend (`preview.proxy` reprend `server.proxy`), donc la page, sa session
 * et sa socket sont sur une seule origine, comme en production derrière nginx.
 *
 * `offline-saves.spec.ts` tourne sur la même pile : les sauvegardes prises en
 * ligne, retrouvées hors-ligne dans le même menu.
 *
 * `bun run test:e2e:sync`. Les captures vont dans `e2e/offline-shots/`.
 */
const APP_PORT = Number(process.env.E2E_SYNC_APP_PORT || 4176);
const API_PORT = Number(process.env.E2E_SYNC_API_PORT || 3107);
const REDIS_PORT = Number(process.env.E2E_SYNC_REDIS_PORT || 6397);
const REDIS = process.env.E2E_REDIS_SERVER || 'redis-server';

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  testIgnore: undefined,
  testMatch: /offline-(sync|layout|saves)\.spec\.ts$/,
  timeout: 120_000,
  use: {
    ...baseConfig.use,
    baseURL: `http://localhost:${APP_PORT}`
  },
  webServer: [
    {
      command: `"${REDIS}" --port ${REDIS_PORT} --save "" --appendonly no`,
      port: REDIS_PORT,
      timeout: 30_000,
      reuseExistingServer: false
    },
    {
      command: 'bun e2e/sync-stack.ts',
      cwd: '..',
      url: `http://localhost:${API_PORT}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        E2E_SYNC_API_PORT: String(API_PORT),
        E2E_SYNC_REDIS_PORT: String(REDIS_PORT),
        E2E_SYNC_APP_PORT: String(APP_PORT)
      }
    },
    {
      command: `bun run build && bunx vite preview --port ${APP_PORT} --strictPort`,
      cwd: '../frontend',
      url: `http://localhost:${APP_PORT}`,
      timeout: 300_000,
      reuseExistingServer: false,
      env: { BACKEND_URL: `http://localhost:${API_PORT}` }
    }
  ]
});
