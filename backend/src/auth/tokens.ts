import { createHash, randomBytes } from 'node:crypto';

/**
 * Les jetons qui voyagent dans une boîte mail.
 *
 * Hachés en base, contrairement au code d'invitation. Deux différences le
 * justifient : ceux-ci passent par un canal qu'on ne maîtrise pas, et ils
 * donnent un compte plutôt que le droit d'en créer un. Rien ne les réaffiche,
 * donc rien n'empêche de les hacher.
 *
 * SHA-256 nu, et pas argon2 : ce sont 128 bits d'aléa, pas un secret
 * devinable. L'étirement de clé n'ajouterait qu'une latence à chaque clic sur
 * un lien de récupération.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString('base64url');
  return { token, hash: hashToken(token) };
}
