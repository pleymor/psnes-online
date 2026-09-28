/**
 * Ce que montre le badge du poignet, décidé sans three.
 *
 * Le badge est la réponse à « l'état du micro est visible à tout moment » : il
 * vit sur la manette gauche, en partie comme au lobby, et ce module dit ce
 * qu'il porte. Séparé du dessin pour la raison habituelle de ce dossier -
 * three ne tourne pas sous Bun, et « un micro refusé s'affiche comme un micro
 * ouvert » est exactement le genre de défaut qu'aucun casque ne rapporte.
 */
import type { MicState } from './spatial';

export type BadgeTone = 'ready' | 'asking' | 'live' | 'speaking' | 'muted' | 'denied';

export function badgeTone(mic: MicState, selfSpeaking: boolean): BadgeTone {
  switch (mic) {
    case 'denied':
      return 'denied';
    case 'muted':
      return 'muted';
    case 'asking':
      return 'asking';
    case 'live':
      return selfSpeaking ? 'speaking' : 'live';
    case 'idle':
      return 'ready';
  }
}

/** Le fond du badge. Rouge pour ce qui ne part pas, vert pour ce qui part. */
export const BADGE_COLORS: Record<BadgeTone, string> = {
  ready: '#3a4a6a',
  asking: '#8a6a1a',
  live: '#1f7a45',
  speaking: '#2fd070',
  muted: '#b3261e',
  denied: '#b3261e'
};

/** Barré quand rien ne part. */
export function badgeCrossed(tone: BadgeTone): boolean {
  return tone === 'muted' || tone === 'denied';
}
