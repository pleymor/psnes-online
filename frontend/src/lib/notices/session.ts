/**
 * Hydrater, PUIS ouvrir l'écriture. Jamais l'inverse.
 *
 * Cet ordre est la seule chose que ce module existe pour garantir, et il a
 * déjà été faux une fois : l'abonnement d'écriture, établi au niveau module,
 * tirait immédiatement avec une liste vide et effaçait la clé avant que
 * quiconque ait pu la lire. Ici il est testable, donc il ne peut plus se
 * casser en silence.
 */

import type { Notices } from './store.js';
import { readNotices, writeNotices, type NoticeStorage } from './persist.js';

export function startNoticeSession(
  notices: Notices,
  storage: NoticeStorage | null,
  now: number
): () => void {
  if (storage) notices.hydrate(readNotices(storage, now));

  return notices.list.subscribe((list) => {
    if (!storage) return;
    try {
      writeNotices(storage, list);
    } catch {
      // Quota à zéro en navigation privée : ne pas retenir vaut mieux que
      // faire remonter une exception dans les dix appelants de `show()`.
    }
  });
}
