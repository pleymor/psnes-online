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
import type { NoticeShape } from './notice.js';

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
