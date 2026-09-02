import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * Self-signed TLS for the dev server, off unless `VITE_HTTPS=1`.
 *
 * WebXR only exists in a secure context. `localhost` counts as one, so nothing
 * here matters for ordinary development - but a Quest reaches this machine by
 * LAN IP, which does not, and there `navigator.xr` is simply `undefined`. The
 * failure is silent and misleading: `vr/support.ts` reports no headset, the
 * "enter VR" button never renders, and it looks exactly like a bug in the VR
 * code rather than a bug in the transport.
 *
 * Opt-in rather than always-on because turning HTTPS on unconditionally would
 * change every existing dev workflow - the backend proxy targets, the service
 * worker's origin, anyone's bookmarks - to solve a problem that only exists
 * when a headset is involved.
 *
 * Missing certificates are not an error: `frontend/.certs/` is git-ignored, so
 * a fresh clone has none, and failing the whole dev server over an absent file
 * would punish everyone who never asked for HTTPS. It warns and serves plain
 * HTTP, which is what they wanted anyway.
 */
function devHttps() {
  if (process.env.VITE_HTTPS !== '1') return undefined;

  const certDir = resolve(dirname(fileURLToPath(import.meta.url)), '.certs');
  try {
    return {
      key: readFileSync(resolve(certDir, 'dev-key.pem')),
      cert: readFileSync(resolve(certDir, 'dev-cert.pem'))
    };
  } catch {
    console.warn(
      `[vite] VITE_HTTPS=1 but no certificate in ${certDir} - serving plain HTTP.\n` +
        '        Generate one with the openssl.cnf in that directory. WebXR will\n' +
        '        not work over plain HTTP from a headset.'
    );
    return undefined;
  }
}

export default defineConfig({
  define: {
    global: 'globalThis', // Polyfill for Node.js global
    'process.env': {},
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
      events: 'events',
      path: 'path-browserify',
    },
  },
  optimizeDeps: {
    include: ['simple-peer', 'buffer', 'process', 'events', 'ini', 'path-browserify'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
        'process.env': '{}',
      },
    },
  },
  plugins: [
    // SvelteKit compiles and registers src/service-worker.ts on its own, and
    // static/manifest.json is already linked from app.html. @vite-pwa/sveltekit
    // duplicated both: it claimed the same service worker under workbox's
    // injectManifest strategy, which needs a `self.__WB_MANIFEST` the
    // SvelteKit-style worker does not have - so `vite build` failed outright -
    // and its devOptions forced the worker on in dev, where it intercepted the
    // dev server's own navigations.
    sveltekit(),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: devHttps(),
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:3000',
        changeOrigin: true
      },
      '/auth': {
        target: process.env.BACKEND_URL || 'http://localhost:3000',
        changeOrigin: true
      },
      '/socket.io': {
        target: process.env.BACKEND_URL || 'http://localhost:3000',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
