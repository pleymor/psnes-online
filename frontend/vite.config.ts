import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
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
        ws: true
      }
    }
  }
});
