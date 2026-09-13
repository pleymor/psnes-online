/**
 * Un code de refus du serveur, et la phrase qui le dit à un humain.
 *
 * Une table plutôt qu'un `switch` dans le composant : `core/test/
 * invite-copy.test.ts` la parcourt pour vérifier qu'aucun refus ne sort en
 * MAJUSCULES_SOULIGNÉES devant un visiteur, ce qu'un switch ne permettrait pas
 * de vérifier sans monter le composant.
 */
export const SIGNUP_REFUSAL_KEYS: Record<string, string> = {
  ALREADY_SIGNED_IN: 'signupAlreadySignedIn',
  PLATFORM_FULL: 'signupPlatformFull',
  INVITE_UNKNOWN: 'signupInviteUnknown',
  INVITE_REVOKED: 'signupInviteRevoked',
  INVITE_USED: 'signupInviteUsed',
  QUOTA_EXHAUSTED: 'signupQuotaExhausted',
  TOO_MANY_ATTEMPTS: 'signupTooManyAttempts',
  UNKNOWN: 'signupRefused'
};

export function signupRefusalKey(code: string | null | undefined): string {
  return (code && SIGNUP_REFUSAL_KEYS[code]) || SIGNUP_REFUSAL_KEYS.UNKNOWN;
}
