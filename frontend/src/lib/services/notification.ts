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

import { get, readable, writable } from 'svelte/store';
import { createNotices } from '$lib/notices/store';
import { hasActions } from '$lib/notices/actions';
import { startNoticeSession } from '$lib/notices/session';
import { isOnScreen, toneOf } from '$lib/notices/shapes';

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface Notification {
  id: string;
  message: string;
  type: NotificationType;
}

/** Le centre de cette session. Un seul, contrairement à la fabrique. */
export const notices = createNotices({ hasActions });

/**
 * Combien de surfaces « en partie » sont montées en ce moment.
 *
 * Un salon qui passe en plein écran doit peindre les notifications qui se
 * répondent pendant une partie DANS son élément plein écran - l'API
 * Fullscreen ne peint que celui-là et ses descendants. Mais rien n'oblige un
 * salon à le faire, et l'oublier ne produit aucune erreur : juste une
 * question qui n'apparaît nulle part.
 *
 * D'où ce compte. Quand il est à zéro, la surface de page reprend ces
 * notifications à son compte : on retrouve alors le comportement d'avant ce
 * chantier - visible en fenêtré, masquée en plein écran - au lieu de les
 * perdre partout. Le défaut par omission redevient le moindre des deux.
 */
export const inGameSurfaces = writable(0);

/**
 * Les notifications dont une action est en vol, partagé entre le toast et le
 * centre.
 *
 * Les deux peuvent montrer la même notification à boutons hors partie - un
 * clic sur l'une et un clic sur l'autre enverraient chacun une réponse si cet
 * état n'était pas commun, le même défaut qu'à la tâche 5, réparti cette fois
 * sur deux composants plutôt qu'un.
 */
export const actionsInFlight = writable<Set<string>>(new Set());

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
 * Seules les notifications de `kind` `'raw'` ENCORE À L'ÉCRAN y figurent :
 * `'raw'` est la forme que cette API sait décrire, et le bandeau VR n'a que
 * faire d'une invitation qu'il ne peut pas peindre. « À l'écran » est ce qui
 * manquait : `VrShell` n'a ni cloche ni bouton pour fermer quoi que ce soit,
 * donc sans cette borne le dernier message resterait peint sur le pupitre
 * pour le reste de la session immersive - et une `raw` revenue du stockage
 * après un rechargement resurgirait, message d'une session précédente compris.
 *
 * Un `derived` seul ne suffit pas : le temps d'écran s'écoule même quand la
 * liste ne change pas, il faut une horloge qui tourne à côté. `readable` avec
 * fonction de démarrage la fait tourner SEULEMENT tant qu'un abonné existe -
 * `VrShell` aujourd'hui - au lieu de battre pour rien tant que personne ne
 * regarde le casque.
 */
const onScreen = readable<Notification[]>([], (set) => {
  function recompute(): void {
    const now = Date.now();
    set(
      get(notices.list)
        .filter((notice) => notice.kind === 'raw' && isOnScreen(notice, now))
        .map((notice) => ({
          id: notice.id,
          message: String(notice.params.message ?? ''),
          // `toneOf`, pas `params.tone` cru : c'est elle qui valide le champ
          // (absent, mal orthographié) et retombe sur `'info'` sinon.
          type: toneOf(notice)
        }))
    );
  }

  recompute();
  const unsubscribe = notices.list.subscribe(recompute);
  const clock = setInterval(recompute, 500);

  return () => {
    clearInterval(clock);
    unsubscribe();
  };
});

export const notifications = {
  subscribe: onScreen.subscribe,

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
