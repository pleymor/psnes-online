/**
 * L'API que dix fichiers appellent, au-dessus du centre.
 *
 * Elle ne bouge pas : `show(message, type, duration)` rend un identifiant,
 * `dismiss` le reprend, et le store reste un tableau d'objets portant `id`,
 * `message` et `type` - c'est ce que `VrShell` lit pour peindre le bandeau du
 * casque, et aucun test ne verrait cette forme se casser.
 *
 * Ce qui change est dessous : le message devient une notification de `kind`
 * `'raw'`, retenue par le centre après que le toast a disparu.
 */

import { derived, get } from 'svelte/store';
import { createNotices } from '$lib/notices/store';
import { hasActions } from '$lib/notices/actions';
import { startNoticeSession } from '$lib/notices/session';
import type { Notice } from '$lib/notices/notice';

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface Notification {
  id: string;
  message: string;
  type: NotificationType;
}

/** Le centre de cette session. Un seul, contrairement à la fabrique. */
export const notices = createNotices({ hasActions });

/** Le stockage, ou rien quand il est refusé - navigation privée, par exemple. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let started = false;

/**
 * Ce que le rechargement a laissé. Appelée une fois, depuis le layout.
 *
 * L'ordre - hydrater puis seulement écrire - est la garantie de
 * `session.ts`, pas la sienne : un `writable` Svelte tire son abonné
 * immédiatement avec la valeur courante, donc l'inverse effaçait le
 * stockage avant que cette fonction ait pu le lire.
 */
export function restoreNotices(): void {
  if (started) return;
  started = true;
  startNoticeSession(notices, storage(), Date.now());
}

/**
 * Le tableau que les appelants historiques lisent.
 *
 * Seules les notifications de `kind` `'raw'` y figurent : c'est la forme que
 * cette API sait décrire, et le bandeau VR n'a que faire d'une invitation
 * qu'il ne peut pas peindre.
 */
export const notifications = {
  subscribe: derived(notices.list, (list: Notice[]) =>
    list
      .filter((notice) => notice.kind === 'raw')
      .map((notice) => ({
        id: notice.id,
        message: String(notice.params.message ?? ''),
        type: (notice.params.tone ?? 'info') as NotificationType
      }))
  ).subscribe,

  /**
   * `duration` est un temps d'ÉCRAN, et non une durée de vie.
   *
   * C'est le seul endroit où ce plan corrige le sens d'un paramètre existant,
   * et il faut le dire : `show()` retirait la notification après sa durée.
   * Garder ce comportement viderait le centre de tout ce qu'il est censé
   * rattraper - une notification effacée trois secondes après sa naissance
   * n'est jamais lue par quelqu'un qui regardait ailleurs.
   *
   * Le compte à rebours appartient donc au toast, qui cesse de la peindre ;
   * elle, reste jusqu'à la fermeture du centre.
   */
  show(message: string, type: NotificationType = 'info', duration: number = 3000): string {
    return notices.post('raw', { message, tone: type, seconds: duration / 1000 });
  },

  dismiss(id: string): void {
    notices.dismiss(id);
  },

  clear(): void {
    for (const notice of get(notices.list)) notices.dismiss(notice.id);
  }
};
