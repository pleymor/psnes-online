/**
 * L'accord sur la licence, lu une fois avant le premier envoi d'un jeu.
 *
 * Envoyer une copie à quelqu'un est une REDISTRIBUTION, et c'est une autre
 * règle que celle que le reste du projet énonce. `keepRomLegal` - « ne garde
 * un jeu que si tu possèdes la cartouche » - couvre la détention, qui est ce
 * que fait celui qui reçoit ; posséder la cartouche n'a jamais autorisé
 * personne à en distribuer une copie. Seule la licence du jeu le permet :
 * homebrew, freeware, domaine public. Celui qui envoie ne lisait rien.
 *
 * Une fois et pas à chaque envoi, parce que le propriétaire l'a demandé
 * ainsi : l'avertissement porte sur la règle, que l'on n'apprend qu'une fois.
 * La ligne qui reste sous le bouton après l'accord porte, elle, le rappel par
 * envoi - la légalité dépend de CHAQUE jeu, et personne ne relit un dialogue
 * qui ne revient plus.
 *
 * Prend son stockage plutôt que d'attraper `localStorage`, comme les
 * préférences de `stores/` : testable sans navigateur, et sans rien à faire
 * du rendu côté serveur.
 */

import type { PreferenceStorage } from '$lib/stores/shader-preference';

export const SHARE_CONSENT_KEY = 'psnes-share-consent';

/**
 * La version du texte auquel l'accord se rapporte.
 *
 * À incrémenter en même temps que `shareLegal` : un accord donné sur une
 * phrase qui n'existe plus ne couvre rien, et le laisser valoir reviendrait à
 * tenir pour lu un avertissement que personne n'a jamais vu.
 */
export const SHARE_CONSENT_VERSION = '1';

/** L'accord a-t-il été donné sur le texte que cette version affiche ? */
export function hasShareConsent(storage: PreferenceStorage): boolean {
  const stored = storage.getItem(SHARE_CONSENT_KEY);
  if (stored === SHARE_CONSENT_VERSION) return true;
  // Effacée plutôt que laissée : une version périmée est un accord qui ne
  // vaut plus, et la garder ferait lire à un futur lecteur du stockage un
  // consentement là où il n'y en a pas.
  if (stored !== null) storage.removeItem(SHARE_CONSENT_KEY);
  return false;
}

/** Enregistre l'accord pour le texte courant. */
export function grantShareConsent(storage: PreferenceStorage): void {
  storage.setItem(SHARE_CONSENT_KEY, SHARE_CONSENT_VERSION);
}
