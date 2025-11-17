import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Language = 'en' | 'fr';

// Get initial language from localStorage or use browser language
function getInitialLanguage(): Language {
  if (!browser) return 'en';

  const stored = localStorage.getItem('language') as Language | null;
  if (stored && (stored === 'en' || stored === 'fr')) {
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
        localStorage.setItem('language', lang);
      }
      set(lang);
    }
  };
}

export const language = createLanguageStore();
