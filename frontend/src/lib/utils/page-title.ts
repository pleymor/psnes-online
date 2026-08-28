import { browser } from '$app/environment';
import { t } from '$lib/i18n/translations';

/**
 * The tab's name.
 *
 * `app.html` carries the fallback, and it is deliberately a real <title> rather
 * than a `<svelte:head>` one: `ssr = false`, so a crawler that does not run our
 * JavaScript gets the shell and nothing else, and an untitled shell is what
 * Lighthouse was failing on for both accessibility and SEO.
 *
 * Which is also why this assigns `document.title` instead of rendering a second
 * <title> from a page. Two of them in one head is not an override - the
 * document keeps the first in tree order, so the shell's title would win and
 * every per-page title would be silently discarded.
 */
export const SITE_NAME = 'PSNES';

/** Pass the page's own name, or nothing on a screen that is just the site. */
export function setPageTitle(lang: 'en' | 'fr', page?: string | null) {
  if (!browser) return;
  document.title = page
    ? `${page} · ${SITE_NAME}`
    : `${SITE_NAME} - ${t(lang, 'playWithFriends')}`;
}
