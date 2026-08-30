import { writable } from 'svelte/store';
import { browser } from '$app/environment';
// The key and the reader live in the configuration module, which cannot import
// this file: it reaches for `$app/environment` and would drag a SvelteKit build
// into the tests. One definition either way, and the export reads exactly what
// this store writes.
import { LANGUAGE_KEY, parseLanguage } from '$lib/config/portable-config';

export type Language = 'en' | 'fr';

// Get initial language from localStorage or use browser language
function getInitialLanguage(): Language {
  if (!browser) return 'en';

  const stored = parseLanguage(localStorage.getItem(LANGUAGE_KEY));
  if (stored) {
    return stored;
  }

  // Detect browser language
  const browserLang = navigator.language.split('-')[0];
  return browserLang === 'fr' ? 'fr' : 'en';
}

function createLanguageStore() {
  const { subscribe, set } = writable<Language>(getInitialLanguage());

  return {
    subscribe,
    set: (lang: Language) => {
      if (browser) {
        localStorage.setItem(LANGUAGE_KEY, lang);
      }
      set(lang);
    },
    /**
     * Re-reads the stored language.
     *
     * For the configuration import, which writes the storage through
     * `applyConfig` and has no other way to make the running page follow.
     */
    refresh: () => set(getInitialLanguage())
  };
}

export const language = createLanguageStore();
