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
      /*
       * EVERY route has to be named here, and that follows from `ssr = false`
       * in `+layout.ts`: a prerendered page is then an empty shell, so the
       * crawler that starts at '/' finds no link to follow - not even one
       * written plainly in the markup. Nothing else in the local loop catches
       * an omission either: `test:all` runs no build, `svelte-check` type-checks
       * without building, and `vite dev` never prerenders. The first thing to
       * notice is the deploy, which fails with "marked as prerenderable, but
       * were not prerendered because they were not found while crawling".
       *
       * '/profile' was the first to pay for it - its only link is the avatar in
       * the top bar, which renders only for a signed-in user - and '/docs' the
       * second, on 2026-09-08, whose only link sits in the home page's footer.
       */
      entries: ['/', '/profile', '/docs']
    }
  }
};

export default config;
