import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  resolve: {
    alias: {
      // Point $lib to the frontend source
      '$lib': resolve(__dirname, '../frontend/src/lib'),
      buffer: 'buffer/',
      stream: 'stream-browserify',
      events: 'events',
      util: 'util/',
      path: 'path-browserify',
    },
  },
  optimizeDeps: {
    include: ['buffer', 'process', 'events', 'util', 'stream-browserify', 'ini', 'path-browserify'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
        'process.env': '{}',
      },
    },
  },
  server: {
    port: 9999,
    open: false,
  },
});
