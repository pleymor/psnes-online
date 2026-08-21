import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: false
    }),
    prerender: {
      handleMissingId: 'warn',
      handleHttpError: 'warn',
      // '/profile' has to be named: the crawler starts at '/' and the only
      // link to the profile is the avatar in the top bar, which renders only
      // when a user is signed in - and there is no session while prerendering.
      entries: ['/', '/profile']
    }
  }
};

export default config;
