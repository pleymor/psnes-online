/**
 * Ce qu'est une notification : une donnée, jamais un composant.
 *
 * C'est la persistance qui l'impose. Le centre survit au rechargement, donc
 * une notification s'écrit dans le stockage, donc elle ne peut pas contenir
 * ses actions - une fonction ne se sérialise pas. Elle les nomme, par son
 * `kind`, et `actions.ts` sait ce que ce nom veut dire.
 *
 * Aucun import de valeur ici : ce fichier doit pouvoir être lu par n'importe
 * quel module du projet sans en réveiller un autre.
 */

import type { TranslationKey } from '../i18n/translations';

export type NoticeTone = 'info' | 'success' | 'error' | 'warning';

/** Tout ce qu'une notification transporte doit tenir dans du JSON. */
export type NoticeParams = Record<string, string | number>;

export interface Notice {
  readonly id: string;
  readonly kind: string;
  readonly params: NoticeParams;
  /** Quand elle est née, pour l'ordre et pour la purge. */
  readonly at: number;
  /** Après quoi elle ne vaut plus rien. Absent = pas d'échéance. */
  readonly expiresAt?: number;
}

export interface NoticeAction {
  readonly label: TranslationKey;
  readonly primary?: boolean;
  run(params: NoticeParams): void | Promise<void>;
}

export interface NoticeShape {
  /** Le texte, dans la langue courante. */
  text(params: NoticeParams, lang: 'en' | 'fr'): string;
  readonly tone: NoticeTone;
  /**
   * Dépend d'une session vivante - une socket, une offre en cours - donc
   * purgée au démarrage : au rechargement elle n'a plus d'interlocuteur.
   */
  readonly live?: boolean;
  /**
   * Peut s'afficher pendant une partie.
   *
   * Faux par défaut, et c'est la règle qu'`InvitationCard` portait : un
   * panneau au-dessus d'un émulateur vole un clic, et accepter ferait sortir
   * le joueur du match.
   */
  readonly duringGame?: boolean;
  /**
   * Secondes à l'écran. 0 = jusqu'à réponse.
   *
   * Zéro n'existe que pour `keep-rom`, qui naît pendant une partie : la barre
   * du haut - donc la cloche - disparaît en plein écran, et une notification
   * qui s'efface serait alors sans recours.
   */
  readonly seconds?: number;
}
