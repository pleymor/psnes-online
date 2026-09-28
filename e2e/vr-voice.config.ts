import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * La voix VR, au niveau du salon : deux navigateurs, de vrais micros factices.
 *
 * Une config à part parce qu'elle n'a besoin ni du backend complet ni du
 * serveur de dev : `vr-voice/server.ts` sert le vrai module de voix et le vrai
 * relais, et rien d'autre. Chromium fabrique le micro (`--use-fake-device-…`)
 * et accepte la permission sans boîte de dialogue (`--use-fake-ui-…`).
 */
const PORT = Number(process.env.E2E_VOICE_PORT || 4391);
const launch = baseConfig.use?.launchOptions ?? {};

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  testIgnore: undefined,
  testMatch: /vr-voice\.spec\.ts$/,
  use: {
    ...baseConfig.use,
    baseURL: `http://localhost:${PORT}`,
    launchOptions: {
      ...launch,
      args: [
        ...(launch.args ?? []),
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
      ]
    }
  },
  webServer: {
    command: 'bun vr-voice/server.ts',
    cwd: '.',
    url: `http://localhost:${PORT}`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI
  }
});
