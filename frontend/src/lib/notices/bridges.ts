/**
 * Ce qui pose et retire les notifications à boutons.
 *
 * Un pont par source. Chacune garde sa logique - `lobby/invitations.ts`,
 * `stores/sharing.ts`, `roms/keep-offer.ts` sont inchangés - et perd seulement
 * son rendu propre.
 *
 * Navigateur uniquement : c'est ici que les alias `$lib` et la socket entrent,
 * et c'est pourquoi le reste de `notices/` n'en connaît rien.
 */

import { get } from 'svelte/store';
import {
  invitations,
  acceptInvitation,
  declineInvitation,
  invitationError,
  type Invitation
} from '$lib/lobby/invitations';
import { sharing } from '$lib/stores/sharing';
import { myRoom } from '$lib/rooms/my-room';
import { notices } from '$lib/services/notification';
import { registerNoticeActions } from '$lib/notices/actions';

let started = false;

export function startNoticeBridges(): void {
  // Le layout se remonte à chaque navigation côté client ; deux ponts sur une
  // source poseraient chaque notification deux fois.
  if (started) return;
  started = true;

  registerNoticeActions('invitation', [
    { label: 'accept', primary: true, run: (params) => acceptInvitation(String(params.id)) },
    { label: 'decline', run: (params) => declineInvitation(String(params.id)) }
  ]);

  registerNoticeActions('share-offer', [
    { label: 'shareAccept', primary: true, run: () => sharing().accept() },
    { label: 'keepRomNo', run: () => sharing().decline() }
  ]);

  /**
   * Les invitations arrivent en liste, pas une par une.
   *
   * Le serveur pousse `lobby:invitations` à la connexion puis une liste
   * complète à chaque changement. On pose ce qui est nouveau et on retire ce
   * qui n'y est plus - une invitation annulée, acceptée, ou périmée côté
   * serveur.
   *
   * `expiresAt` est retenue à côté du `noticeId` : ré-inviter renvoie le même
   * id avec une échéance repoussée (`lobby/invitations.ts`), et un `posted`
   * qui ne verrait que l'id garderait l'ancienne échéance - `sweep()`
   * pourrait alors retirer une invitation encore valide.
   */
  const posted = new Map<string, { noticeId: string; expiresAt: number }>();

  invitations.subscribe((list: Invitation[]) => {
    const live = new Set(list.map((i) => i.id));

    for (const [invitationId, entry] of posted) {
      if (!live.has(invitationId)) {
        notices.dismiss(entry.noticeId);
        posted.delete(invitationId);
      }
    }

    // Ce que le centre affiche encore réellement : ne pas s'y fier ferait
    // ignorer en silence une ré-invitation dont la notification précédente a
    // déjà quitté l'écran (périmée par `sweep()`, par exemple) sans que ce
    // pont l'ait su - `posted` seul aurait continué de croire qu'elle y était.
    const onScreen = new Set(get(notices.list).map((n) => n.id));

    for (const invitation of list) {
      const expiresAt = new Date(invitation.expiresAt).getTime();
      const existing = posted.get(invitation.id);
      const stillShown = existing ? onScreen.has(existing.noticeId) : false;

      if (existing && stillShown) {
        if (existing.expiresAt === expiresAt) continue;
        notices.dismiss(existing.noticeId);
      }

      const noticeId = notices.post(
        'invitation',
        {
          id: invitation.id,
          name: invitation.fromPseudo,
          title: invitation.gameTitle ?? ''
        },
        { expiresAt }
      );
      posted.set(invitation.id, { noticeId, expiresAt });
    }
  });

  /*
   * Une réponse acceptée n'attend pas le serveur.
   *
   * `acceptInvitation()` émet sur la socket et rend aussitôt : le pont
   * d'invitation ci-dessus retire déjà la notification dès que le serveur
   * confirme (`lobby:accepted` vide la liste). Si le serveur refuse après
   * coup à la place, la liste ne change pas et rien ne le dirait - d'où ce
   * second pont, qui pose une notification `raw` sur `invitationError`.
   */
  invitationError.subscribe((message) => {
    if (message) notices.post('raw', { message, tone: 'error' });
  });

  /** L'offre de jeu : une seule à la fois, donc un seul identifiant à retenir. */
  let offerNotice: string | null = null;

  sharing().offered.subscribe((offer) => {
    if (offerNotice) {
      notices.dismiss(offerNotice);
      offerNotice = null;
    }
    if (!offer) return;

    // Le pseudo vient du salon : le relais ne transporte qu'un identifiant.
    const name =
      get(myRoom)?.players?.find((p: { userId: string }) => p.userId === offer.from)?.pseudo ?? '';

    offerNotice = notices.post('share-offer', { name, title: offer.title });
  });

  // L'horloge des échéances, que `InvitationCard` tenait pour elle seule : une
  // invitation périmée doit quitter l'écran sans qu'aucun message ne l'annonce,
  // puisqu'il ne s'est rien passé sur le serveur.
  setInterval(() => notices.sweep(Date.now()), 15_000);
}
