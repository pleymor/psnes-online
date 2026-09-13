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
import type { Notice, NoticeShape, NoticeTone } from './notice.js';

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
  },

  /** « Bob t'invite sur Umihara Kawase ». Dix minutes, puis elle s'en va seule. */
  invitation: {
    text: (params, lang) =>
      params.title
        ? t(lang, 'invitationWithGame', { name: String(params.name), title: String(params.title) })
        : t(lang, 'invitationNoGame', { name: String(params.name) }),
    tone: 'info',
    live: true
  },

  /** « Bob veut t'envoyer Umihara Kawase ». La phrase que `ShareOffer` portait. */
  'share-offer': {
    text: (params, lang) =>
      t(lang, 'shareOffer', { name: String(params.name), title: String(params.title) }),
    tone: 'info',
    live: true,
    /*
     * La règle du PARTAGE, et non celle de la détention.
     *
     * Posée avant l'envoi : c'est le moment où elle peut encore changer la
     * réponse, et `ShareOffer` la portait avec ce commentaire même. Mais elle
     * disait `keepRomLegal` - « ne garde un jeu que si tu possèdes la
     * cartouche » - qui parle de DÉTENTION. Recevoir une copie est une
     * redistribution : posséder la cartouche n'y autorise personne, seule la
     * licence du jeu le fait.
     *
     * Ces deux lignes ont failli se croiser sans se voir : la branche du
     * disclaimer a corrigé la phrase DANS `ShareOffer`, et celle-ci a supprimé
     * `ShareOffer`. Le rebase a posé la question - fichier modifié d'un côté,
     * supprimé de l'autre - et c'est ici que la correction se reporte.
     */
    legal: 'shareLegalShort'
  },

  /**
   * « Le garder sur cet appareil ? », posée pendant que la partie tourne.
   *
   * `seconds: 0` et `duringGame` vont ensemble : la cloche n'existe pas en
   * plein écran, donc une question qui s'efface là serait sans recours.
   */
  'keep-rom': {
    text: (params, lang) =>
      `${params.title ? `${params.title} — ` : ''}${t(lang, 'keepRom')}`,
    tone: 'info',
    live: true,
    duringGame: true,
    seconds: 0,
    legal: 'keepRomLegal'
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

/**
 * Cette notification est-elle encore dans son temps d'écran ? Zéro = toujours.
 *
 * Extrait de `NoticeToast`, qui la calculait en ligne, parce que
 * `services/notification.ts` en a désormais besoin lui aussi : c'est ce qui
 * borne la durée de vie du bandeau VR, qui n'a ni cloche ni bouton pour
 * fermer quoi que ce soit.
 */
export function isOnScreen(notice: Pick<Notice, 'kind' | 'params' | 'at'>, now: number): boolean {
  const seconds = screenSeconds(notice);
  return seconds === 0 || now < notice.at + seconds * 1000;
}

const VALID_TONES: readonly NoticeTone[] = ['info', 'success', 'error', 'warning'];

function isNoticeTone(value: unknown): value is NoticeTone {
  return typeof value === 'string' && (VALID_TONES as readonly string[]).includes(value);
}

/**
 * Le ton affiché, `params` avant la forme.
 *
 * `raw` fige son ton dans la forme - toujours `'info'` - mais chaque appel
 * peut poser le sien dans `params.tone` : `notifications.show()` le fait déjà,
 * et `services/notification.ts` le lit pour peindre le bandeau VR. Le toast
 * et le centre lisaient `shape.tone` seul, donc un `tone: 'error'` posé par un
 * appelant s'affichait quand même en bleu - un refus d'invitation, par
 * exemple. Un `params.tone` invalide (absent, mal orthographié, d'un ancien
 * kind) retombe sur celui de la forme, puis sur `'info'`.
 */
export function toneOf(notice: Pick<Notice, 'kind' | 'params'>): NoticeTone {
  const declared = notice.params.tone;
  if (isNoticeTone(declared)) return declared;
  return shapeOf(notice.kind)?.tone ?? 'info';
}
