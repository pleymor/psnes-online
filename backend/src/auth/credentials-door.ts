/**
 * La deuxième porte, et ce qu'elle refuse.
 *
 * `PASSWORD_AUTH` est une variable À PART, et pas une valeur d'`AUTH_MODE`.
 * C'est la leçon écrite dans auth/anonymous.ts (`anonymousJoinEnabled`) :
 * `env-guard.ts` refuse de démarrer en production sur `AUTH_MODE === 'dev'` par
 * une ÉGALITÉ STRICTE, et cette égalité est ce qui tient `POST /auth/dev/login`
 * -- une route non authentifiée qui distribue de vraies sessions -- hors du
 * web. Ajouter une valeur à cette variable relâcherait la garantie par effet
 * de bord ; une variable à part n'a pas ce défaut.
 */

import { passwordAcceptable } from './password.js';

/**
 * La porte est-elle ouverte dans ce déploiement.
 *
 * Ouverte par défaut, `PASSWORD_AUTH=off` la referme. Sauf en production sans
 * `SMTP_URL` : le mailer journaliserait alors chaque lien de réinitialisation
 * au lieu de l'envoyer -- un jeton de reprise de compte dans `docker logs`, et
 * un joueur qui ne reçoit jamais rien. Fermer la porte plutôt que refuser de
 * démarrer : un déploiement qui n'a pas encore ses identifiants SMTP garde
 * Google, au lieu de perdre tout le site.
 */
export function passwordAuthEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  if ((env.PASSWORD_AUTH ?? 'on').toLowerCase() === 'off') return false;
  if (env.NODE_ENV === 'production' && !env.SMTP_URL) return false;
  return true;
}

export type CredentialRefusal =
  | 'PASSWORD_AUTH_DISABLED'
  | 'EMAIL_MALFORMED'
  | 'PASSWORD_TOO_SHORT'
  | 'EMAIL_TAKEN';

/**
 * Volontairement laxiste.
 *
 * La seule validation qui compte est le mail de confirmation, qui arrive ou
 * n'arrive pas. Une expression régulière stricte refuserait des adresses
 * légitimes -- les TLD longs, le `+`, les sous-domaines -- pour ne rien
 * garantir de plus. Celle-ci n'écarte que ce qui ne peut pas être une adresse.
 */
export function looksLikeEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function signupFormDecision(input: {
  enabled: boolean;
  email: unknown;
  password: unknown;
  emailTaken: boolean;
}):
  | { ok: true; email: string; password: string }
  | { ok: false; status: number; error: CredentialRefusal }
{
  // 404 et non 403 : quand la porte est fermée, cette route n'existe pas.
  if (!input.enabled) {
    return { ok: false, status: 404, error: 'PASSWORD_AUTH_DISABLED' };
  }
  if (!looksLikeEmail(input.email)) {
    return { ok: false, status: 400, error: 'EMAIL_MALFORMED' };
  }
  if (!passwordAcceptable(input.password)) {
    return { ok: false, status: 400, error: 'PASSWORD_TOO_SHORT' };
  }
  // Ce refus est un oracle : il dit à qui détient une invitation qu'une
  // adresse a déjà un compte ici. Assumé -- l'alternative, accepter
  // silencieusement puis envoyer « vous avez déjà un compte », consommerait
  // l'invitation du filleul pour rien. La porte d'invitation borne déjà qui
  // peut poser la question.
  if (input.emailTaken) {
    return { ok: false, status: 409, error: 'EMAIL_TAKEN' };
  }
  return { ok: true, email: input.email, password: input.password };
}
