/**
 * Ce qu'un joueur sans compte a le droit d'être, et rien de plus.
 *
 * Trois fonctions pures, sans base ni socket, parce que ce sont trois
 * décisions d'autorisation : elles doivent pouvoir être lues et testées seules,
 * pas déduites du chemin qui les appelle.
 *
 * Le mot est `anonymous` et pas `guest` : un `guest` ici est le pair non-hôte
 * d'un salon (`websocket/room-view.ts`, `webrtc/p2p-manager.ts`,
 * `znet/protocol.ts`). `host`/`guest` est un rôle dans un salon, `anonymous`
 * est une identité. Deux axes différents, donc deux mots - c'était toute la
 * raison de ne pas réutiliser le premier.
 */

import 'express-session';
import { isValidPseudo } from '../utils/pseudo.js';

/**
 * Le code d'erreur qu'un anonyme reçoit d'une route de compte.
 *
 * Distinct de `PSEUDO_REQUIRED` : celui-là annonce une condition que le
 * demandeur peut remplir, celui-ci une porte qui ne s'ouvrira pas. Le client
 * les sépare sur le champ `error`, comme il le fait déjà pour les 409.
 */
export const ANONYMOUS_FORBIDDEN = 'ANONYMOUS_FORBIDDEN';

/** La clé que la session porte, et le seul droit qu'elle accorde. */
export interface AnonymousSession {
  /** L'unique salon dans lequel cette session peut prendre un siège. */
  anonymousRoomId?: string;
}

/**
 * La porte est-elle ouverte dans ce déploiement.
 *
 * Volontairement pas une valeur d'`AUTH_MODE`. `env-guard.ts` refuse de
 * démarrer en production sur `AUTH_MODE === 'dev'` par une égalité stricte :
 * un `AUTH_MODE=dev+anonymous` passerait à travers ce test et rouvrirait
 * `/auth/dev/login` en production. Ajouter une valeur à cette variable, c'est
 * relâcher une garantie existante par effet de bord ; une variable à part n'a
 * pas ce défaut.
 *
 * Ouverte par défaut : c'est la fonctionnalité même, un lien de salon qui
 * marche pour quelqu'un qui n'a pas de compte. `ANONYMOUS_JOIN=off` la referme
 * sans redéploiement de code.
 */
export function anonymousJoinEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ANONYMOUS_JOIN ?? 'on').toLowerCase() !== 'off';
}

/**
 * Le salon que cette session nomme, ou null.
 *
 * Lu depuis la session du serveur, jamais depuis la charge utile : c'est ce qui
 * fait qu'un anonyme entre dans le salon dont il a reçu le lien et dans
 * aucun autre, même en émettant `room:join` sur un identifiant qu'il a vu
 * passer ailleurs.
 */
export function anonymousRoomOf(session: unknown): string | null {
  const roomId = (session as AnonymousSession | undefined)?.anonymousRoomId;
  return typeof roomId === 'string' && roomId.length > 0 ? roomId : null;
}

/**
 * Cet anonyme peut-il prendre un siège dans ce salon.
 *
 * Répond `false` pour un compte, et ce n'est pas un refus : la question ne le
 * concerne pas. Un compte entre par l'invitation, et laisser cette fonction
 * répondre pour lui en ferait une seconde autorisation d'entrée qu'il faudrait
 * tenir en accord avec la première.
 */
export function mayEnterRoom(
  user: { isAnonymous: boolean },
  session: unknown,
  roomId: string | undefined
): boolean {
  if (!user.isAnonymous) return false;
  if (!roomId) return false;
  return anonymousRoomOf(session) === roomId;
}

/** Pourquoi la porte s'est refermée. Le client sépare les cas sur ce champ. */
export type DoorRefusal =
  | 'ANONYMOUS_DISABLED'
  | 'ALREADY_SIGNED_IN'
  | 'ROOM_NOT_FOUND'
  | 'PSEUDO_INVALID'
  | 'TOO_MANY_ATTEMPTS';

export type DoorDecision =
  | { ok: true; pseudo?: string }
  | { ok: false; status: number; error: DoorRefusal };

/**
 * Faut-il ouvrir la porte, et l'ordre dans lequel on refuse.
 *
 * Une fonction pure, séparée de la route, parce que l'ordre des refus *est* la
 * décision de sécurité et qu'il doit pouvoir être lu et épinglé sans monter un
 * serveur.
 *
 * Trois choses s'y jouent :
 *
 * - La limite d'essais passe avant la lecture du salon. C'est une route sans
 *   authentification qui crée des lignes : sans cet ordre, la limite
 *   arriverait après l'information qu'elle protège, et chaque tentative
 *   bloquée resterait un test d'existence gratuit.
 * - « Salon inexistant » et « salon plein » sont la même réponse, comme
 *   partout ailleurs dans ce dépôt : un identifiant de salon circule, et
 *   confirmer l'existence d'un salon à qui en tient l'identifiant lui apprend
 *   quelque chose qu'il n'a pas à savoir. Ici c'est pire qu'ailleurs, la route
 *   étant ouverte à n'importe qui.
 * - Une session existante est refusée plutôt que remplacée : effacer la
 *   session d'un joueur connecté parce qu'il a cliqué sur un lien de salon lui
 *   coûterait son compte le temps d'une partie.
 */
export function anonymousDoorDecision(input: {
  enabled: boolean;
  signedIn: boolean;
  blocked: boolean;
  room: { players: number } | null | undefined;
  pseudo?: unknown;
}): DoorDecision {
  if (!input.enabled) {
    return { ok: false, status: 403, error: 'ANONYMOUS_DISABLED' };
  }
  if (input.signedIn) {
    return { ok: false, status: 409, error: 'ALREADY_SIGNED_IN' };
  }
  if (input.blocked) {
    return { ok: false, status: 429, error: 'TOO_MANY_ATTEMPTS' };
  }
  if (!input.room || input.room.players >= 2) {
    return { ok: false, status: 404, error: 'ROOM_NOT_FOUND' };
  }
  if (input.pseudo !== undefined && input.pseudo !== null && input.pseudo !== '') {
    if (!isValidPseudo(input.pseudo)) {
      return { ok: false, status: 400, error: 'PSEUDO_INVALID' };
    }
    return { ok: true, pseudo: input.pseudo as string };
  }
  return { ok: true };
}

/**
 * La clé que porte la session côté serveur.
 *
 * Déclarée ici, à côté des fonctions qui la lisent, plutôt que dans un fichier
 * de types à part : c'est le seul champ que ce projet ajoute à la session, et
 * ce qu'il autorise se lit deux fonctions plus haut.
 */
declare module 'express-session' {
  interface SessionData {
    anonymousRoomId?: string;
  }
}
