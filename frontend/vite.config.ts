import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    global: 'globalThis', // Polyfill for Node.js global
    'process.env': {},
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
      stream: 'stream-browserify',
      events: 'events',
      util: 'util/',
      path: 'path-browserify',
    },
  },
  optimizeDeps: {
    include: ['simple-peer', 'buffer', 'process', 'events', 'util', 'stream-browserify', 'ini', 'path-browserify'],
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
