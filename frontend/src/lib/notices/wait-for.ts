/**
 * Attendre qu'un store satisfasse un prédicat.
 *
 * Écrit pour `bridges.ts` : `acceptInvitation`/`declineInvitation` rendent la
 * main dès que l'émission part sur la socket, avant toute réponse du
 * serveur. Le pont a besoin d'une promesse qui, elle, ne se résout qu'à la
 * vraie réponse - c'est elle que `NoticeToast`/`NoticeCentre` attendent avant
 * de retirer la notification et de réactiver leurs boutons.
 *
 * Pur, donc testable sous Bun sans rien d'autre que `svelte/store`.
 */

import type { Readable } from 'svelte/store';

/**
 * Se résout dès que `predicate(value)` est vrai - tout de suite si c'est déjà
 * le cas à l'appel, sinon à la première émission qui le devient.
 *
 * `timeoutMs` borne l'attente : si la réponse n'arrive jamais - une coupure
 * réseau, par exemple - la promesse se résout quand même, plutôt que de
 * laisser un bouton désactivé pour le reste de la session.
 */
export function waitFor<T>(
  store: Readable<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Différé d'une micro-tâche : `subscribe` appelle son callback tout de
      // suite, avec la valeur courante, AVANT que cette fonction n'ait reçu
      // ce que `subscribe` est en train de rendre. Appeler `unsubscribe` ici
      // sans ce détour attraperait encore le bouchon posé juste au-dessus.
      queueMicrotask(() => unsubscribe());
      resolve();
    }

    const timer = setTimeout(finish, timeoutMs);

    unsubscribe = store.subscribe((value) => {
      if (predicate(value)) finish();
    });
  });
}
