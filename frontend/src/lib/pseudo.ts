/**
 * The pseudonym format, browser side.
 *
 * A deliberate second copy of the rule in backend/src/utils/pseudo.ts, which
 * is the authority: only the server decides whether a pseudonym is acceptable.
 * This exists so the field can say so while it is being typed, instead of
 * after a round trip.
 *
 * There is no shared module to put it in - `core/` is the wasm emulator, and
 * the frontend's Docker build context is pinned by the infrastructure repo, so
 * importing across would break the image. The duplication cannot drift in
 * silence though: backend/test/pseudo-parity.test.ts imports both copies and
 * demands the same verdict on the same table of inputs.
 */

/** ASCII only. See the backend copy for why the character set is load-bearing. */
const PSEUDO_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;

const DISCRIMINATOR_PATTERN = /^\d{4}$/;

export const PSEUDO_MIN = 3;
export const PSEUDO_MAX = 16;

export interface Handle {
  pseudo: string;
  discriminator: string;
}

export function isValidPseudo(pseudo: unknown): boolean {
  return typeof pseudo === 'string' && PSEUDO_PATTERN.test(pseudo);
}

export function formatHandle(pseudo: string, discriminator: string): string {
  return `${pseudo}#${discriminator}`;
}

/** `"Sprite#0417"` into its two halves, or null. Splits on the LAST separator. */
export function parseHandle(handle: unknown): Handle | null {
  if (typeof handle !== 'string') return null;

  const trimmed = handle.trim();
  const at = trimmed.lastIndexOf('#');
  if (at === -1) return null;

  const pseudo = trimmed.slice(0, at);
  const discriminator = trimmed.slice(at + 1);

  if (!isValidPseudo(pseudo) || !DISCRIMINATOR_PATTERN.test(discriminator)) return null;

  return { pseudo, discriminator };
}
