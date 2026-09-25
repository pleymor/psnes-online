/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, prerendered, version } from '$service-worker';
import { cacheableResponse, networkOnly, SHELL, shellFallback } from '$lib/pwa/cache-policy';

const sw = self as unknown as ServiceWorkerGlobalScope;

/*
 * One cache per deployment, named after the build.
 *
 * `version` changes on every build, so a deploy opens a fresh cache and the
 * `activate` below deletes every other one. That is what keeps the emulator's
 * glue and its wasm from different builds apart: served together, a new glue
 * and a stale wasm give "offset is out of bounds" and blame the core.
 */
const CACHE = `psnes-${version}`;

/*
 * Everything the app needs to open and play with no network: the built app
 * (`build`, the wasm core included - it is in `static/psnes-core`, so in
 * `files`), and the prerendered pages, which are the shell a navigation falls
 * back on. `ssr = false` makes every one of them the same empty shell that
 * boots the client router, so '/' can stand in for any route.
 */
const ASSETS = [...build, ...files, ...prerendered];
const PRECACHED = new Set(ASSETS);

sw.addEventListener('install', (event) => {
  async function addFilesToCache() {
    const cache = await caches.open(CACHE);
    // `cache: 'reload'` so the install never copies a stale file out of the
    // HTTP cache into a cache that is then served, unrevalidated, until the
    // next deploy. The core's files were the ones that paid for it.
    await cache.addAll(ASSETS.map((path) => new Request(path, { cache: 'reload' })));
  }

  event.waitUntil(addFilesToCache());

  /*
   * Take over immediately instead of waiting for every tab to close.
   *
   * Assets are served cache-first and never revalidated, so whatever this
   * cache holds is what visitors get until a new worker activates. A worker
   * that waits means a deploy fixing a bad asset cannot reach anyone who
   * already has the page open - which is exactly how a wrong Content-Type on
   * the emulator core survived the deploy that fixed it, on every browser that
   * had already cached it.
   */
  sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  // Remove previous cached data from disk, then drive the pages that are
  // already open. Without claim() they would keep talking to the worker they
  // loaded with, and the fresh cache would not be used until a reload.
  async function takeOver() {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await sw.clients.claim();
  }

  event.waitUntil(takeOver());
});

sw.addEventListener('fetch', (event) => {
  // Note: SvelteKit does not register this worker in dev. It used to run there
  // anyway, because @vite-pwa/sveltekit forced it on through devOptions - and
  // it then intercepted the dev server's own navigations, turning any hiccup
  // into a hard failure that reloaded the page and tore down a running game.
  // That plugin is gone; see frontend/vite.config.ts.

  // ignore POST requests etc
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  /*
   * The API, the session and the socket never touch the cache, in either
   * direction: not read from it, not written to it. A cached `/api/...` answer
   * served to the next person on this browser after a logout is somebody
   * else's library, friends and saves. Returning without `respondWith` hands
   * the request back to the browser untouched.
   */
  if (networkOnly(url, sw.location.origin)) return;

  async function respond(): Promise<Response> {
    const cache = await caches.open(CACHE);

    // `build`/`files`/`prerendered` can always be served from the cache
    if (url.origin === sw.location.origin && PRECACHED.has(url.pathname)) {
      const response = await cache.match(url.pathname);
      if (response) return response;
    }

    // for everything else, try the network first, but
    // fall back to the cache if we're offline
    try {
      const response = await fetch(event.request);

      // if we're offline, fetch can return a value that is not a Response
      // instead of throwing - and we can't pass this non-Response to respondWith
      if (!(response instanceof Response)) {
        throw new Error('invalid response from fetch');
      }

      // Navigations are still never stored: one per room URL, never replayed,
      // the cache would fill with entries that can only be served stale. The
      // shell is precached instead, and stands in for all of them below.
      if (event.request.mode !== 'navigate' && cacheableResponse(response)) {
        cache.put(event.request, response.clone());
      }

      return response;
    } catch (err) {
      const response = await cache.match(event.request);
      if (response) return response;

      /*
       * The navigation fallback, and the reason this app opens offline.
       *
       * Any route - `/`, `/local?rom=…`, a room link - gets the app shell, and
       * the client router takes it from there. Without this the browser shows
       * its own offline page, which is what `/` did until #70.
       */
      if (shellFallback(event.request.mode, url, sw.location.origin)) {
        const shell = await cache.match(SHELL);
        if (shell) return shell;
      }

      // if there's no cache, then just error out
      // as there is nothing we can do to respond to this request
      throw err;
    }
  }

  event.respondWith(respond());
});

// Handle messages from the client
sw.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
});
