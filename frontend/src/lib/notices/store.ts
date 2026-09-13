/**
 * La liste des notifications, et la lecture du centre.
 *
 * Une fabrique et non un singleton, pour la raison que `keep-offer.ts` donne
 * pour la sienne : deux centres ne coexistent pas, mais deux tests si. Le
 * singleton de l'application vit dans `services/notification.ts`.
 *
 * Aucune connaissance des boutons ici - seulement de leur existence, par
 * `hasActions`, injectée. C'est ce qui garde ce fichier sous Bun.
 */

import { derived, get, writable, type Readable } from 'svelte/store';
import type { Notice, NoticeParams } from './notice.js';

export interface NoticesDeps {
  /** Ce kind porte-t-il des boutons ? Décide de ce que la fermeture consomme. */
  hasActions?(kind: string): boolean;
  /** L'horloge, pour que les tests n'aient pas à attendre. */
  now?(): number;
}

export interface PostOptions {
  readonly expiresAt?: number;
}

export interface Notices {
  readonly list: Readable<Notice[]>;
  readonly open: Readable<boolean>;
  readonly count: Readable<number>;
  post(kind: string, params: NoticeParams, options?: PostOptions): string;
  dismiss(id: string): void;
  openCentre(): void;
  closeCentre(): void;
  /** Retire ce qui a passé son échéance. Appelée par une horloge, et testable. */
  sweep(now: number): void;
  /** Remet en place ce qui revient du stockage, sans rien notifier. */
  hydrate(notices: readonly Notice[]): void;
}

export function createNotices(deps: NoticesDeps = {}): Notices {
  const hasActions = deps.hasActions ?? (() => false);
  const now = deps.now ?? (() => Date.now());

  const list = writable<Notice[]>([]);
  const open = writable(false);
  let sequence = 0;

  function post(kind: string, params: NoticeParams, options: PostOptions = {}): string {
    const id = `${now()}-${sequence++}`;
    const notice: Notice = { id, kind, params, at: now(), expiresAt: options.expiresAt };
    list.update((current) => [...current, notice]);
    return id;
  }

  function dismiss(id: string): void {
    list.update((current) => current.filter((n) => n.id !== id));
  }

  function closeCentre(): void {
    open.set(false);
    // Ce qui porte des boutons reste : il attend une réponse, et la pastille
    // doit continuer de dire qu'il y a quelque chose à faire.
    list.update((current) => current.filter((n) => hasActions(n.kind)));
  }

  return {
    list: { subscribe: list.subscribe },
    open: { subscribe: open.subscribe },
    count: derived(list, (current) => current.length),
    post,
    dismiss,
    openCentre: () => open.set(true),
    closeCentre,
    sweep(at: number) {
      list.update((current) => current.filter((n) => n.expiresAt === undefined || n.expiresAt > at));
    },
    hydrate(notices) {
      list.set([...get(list), ...notices]);
    }
  };
}
