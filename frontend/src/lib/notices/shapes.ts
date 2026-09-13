/**
 * Le texte et le ton de chaque sorte de notification.
 *
 * Pur, et sans alias : c'est la moitié du système qui se teste sous Bun. Les
 * boutons vivent dans `actions.ts`, parce qu'eux ont besoin de la socket.
 *
 * Ajouter une notification au projet, c'est ajouter une entrée ici. Le
 * compilateur exige alors `text` et `tone`, et `notices.test.ts` exige un
 * texte non vide dans les deux langues.
 */

import { t } from '../i18n/translations.js';
import type { Notice, NoticeShape } from './notice.js';

export const NOTICE_SHAPES: Record<string, NoticeShape> = {
  /**
   * Le message déjà traduit, tel que `notifications.show()` le reçoit.
   *
   * Le pont de compatibilité : ses dix appelants passent une chaîne, pas une
   * clé, et les réécrire serait un second chantier.
   */
  raw: {
    text: (params) => String(params.message ?? ''),
    tone: 'info'
  }
};

export function shapeOf(kind: string): NoticeShape | null {
  return NOTICE_SHAPES[kind] ?? null;
}

/** Six secondes : de quoi lire une phrase sans avoir à la relire. */
export const DEFAULT_SECONDS = 6;

/**
 * Combien de temps une notification reste à l'écran. Zéro = jusqu'à réponse.
 *
 * Un temps d'écran, et non une durée de vie : passé ce délai la notification
 * quitte le toast et reste dans le centre. Confondre les deux viderait le
 * centre de tout ce qu'il est censé rattraper.
 */
export function screenSeconds(notice: Pick<Notice, 'kind' | 'params'>): number {
  const declared = notice.params.seconds ?? shapeOf(notice.kind)?.seconds ?? DEFAULT_SECONDS;
  return Number(declared);
}
