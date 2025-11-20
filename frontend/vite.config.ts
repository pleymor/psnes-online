import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

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
    sveltekit(),
    SvelteKitPWA({
      srcDir: './src',
      mode: 'development',
      strategies: 'injectManifest',
      filename: 'service-worker.ts',
      manifest: {
        name: 'PSNES Online',
        short_name: 'PSNES',
        description: 'Play SNES games online with friends',
        start_url: '/',
        display: 'standalone',
        background_color: '#1a1a1a',
        theme_color: '#667eea',
        orientation: 'any',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ],
        categories: ['games', 'entertainment']
      },
      injectManifest: {
        globPatterns: ['client/**/*.{js,css,ico,png,svg,webp,woff,woff2}']
      },
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: '/'
      }
    })
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://backend:3000',
        changeOrigin: true
      },
      '/auth': {
        target: 'http://backend:3000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://backend:3000',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
