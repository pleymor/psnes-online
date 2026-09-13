/**
 * Ce qui, du centre, traverse un rechargement.
 *
 * Prend son stockage plutôt que d'attraper `localStorage`, comme les
 * préférences de `stores/` : testable sans navigateur, et sans rien à faire
 * du rendu côté serveur.
 *
 * Purge à la LECTURE et non à l'écriture, délibérément : ce qui décide -
 * l'heure qu'il est, les `kind` que cette version connaît - n'est vrai qu'au
 * moment de relire. Une entrée écrite valide peut devenir périmée dans le
 * stockage sans que personne n'ait rien écrit.
 */

import type { Notice } from './notice.js';
import { shapeOf } from './shapes.js';

export const NOTICES_KEY = 'psnes-notices';

/**
 * Exportée pour `session.ts`, qui en a besoin sans importer `localStorage` -
 * nommée à part du `Storage` du DOM, que ce fichier ne connaît pas non plus.
 */
export interface NoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function usable(notice: Notice, now: number): boolean {
  const shape = shapeOf(notice.kind);
  // Un kind que cette version ne connaît plus n'a ni texte ni boutons : la
  // reposer afficherait une ligne vide que rien ne peut fermer.
  if (!shape) return false;
  // Ce qui vit sur une socket n'a plus d'interlocuteur après un rechargement.
  if (shape.live) return false;
  if (notice.expiresAt !== undefined && notice.expiresAt <= now) return false;
  return true;
}

export function readNotices(storage: NoticeStorage, now: number): Notice[] {
  const stored = storage.getItem(NOTICES_KEY);
  if (!stored) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // Effacée plutôt que laissée : une entrée illisible ne le deviendra pas,
    // et la relire à chaque démarrage coûte un try/catch pour rien.
    storage.removeItem(NOTICES_KEY);
    return [];
  }

  if (!Array.isArray(parsed)) {
    storage.removeItem(NOTICES_KEY);
    return [];
  }

  return (parsed as Notice[]).filter((notice) => notice?.kind && usable(notice, now));
}

export function writeNotices(storage: NoticeStorage, notices: readonly Notice[]): void {
  if (notices.length === 0) {
    storage.removeItem(NOTICES_KEY);
    return;
  }
  storage.setItem(NOTICES_KEY, JSON.stringify(notices));
}
