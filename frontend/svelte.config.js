import { execSync } from 'node:child_process';

import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/*
 * Which build a page is running, shipped in the telemetry as `build`.
 *
 * It answers a question that cost several exchanges on 2026-09-19: after a
 * deploy, a tab that was not reloaded keeps its old JavaScript and nothing in
 * the logs says so, which is indistinguishable from a fix that does not work.
 *
 * `.git/` is in `.dockerignore`, so the commit is not reachable from the
 * production image and the timestamp is what it falls back to - enough to
 * compare a running page against the time of a deploy, which is the question.
 * BUILD_REF is there for the infra repo to pass a real ref whenever it wants
 * to; until it does, nothing needs changing on that side.
 */
function buildName() {
  if (process.env.BUILD_REF) return process.env.BUILD_REF;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return String(Date.now());
  }
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    version: { name: buildName() },
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
