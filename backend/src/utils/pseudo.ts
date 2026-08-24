/**
 * The pseudonym format, and the only place a handle string is taken apart.
 *
 * A handle is `Pseudo#0417`: a pseudonym the player chose, and a four-digit
 * discriminator the server assigned. The pseudonym alone is not unique -- two
 * players may both be `Mario` -- only the pair is, and the unique index in
 * 0004_pseudonymous_users.sql is what enforces that.
 *
 * There is a second copy of the pattern in frontend/src/lib/pseudo.ts, for
 * immediate feedback while typing. This file is the authority; that one is a
 * convenience. They cannot drift apart in silence: backend/test/
 * pseudo-parity.test.ts imports both and demands the same verdict.
 */

/**
 * ASCII only, and that restriction is load-bearing rather than timid.
 *
 * The database folds case with COLLATE NOCASE, which SQLite applies to A-Z and
 * nothing else. Allow `É` and `é#0417` and `É#0417` both become insertable --
 * the index would stop guaranteeing the uniqueness this design claims. The
 * character set and the collation have to agree, or the uniqueness is a
 * fiction. Refusing homoglyph impersonation (Cyrillic `а` against Latin `a`)
 * comes free with it.
 */
const PSEUDO_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;

const DISCRIMINATOR_PATTERN = /^\d{4}$/;

/** The separator. Excluded from PSEUDO_PATTERN so that a handle parses once. */
const SEPARATOR = '#';

/**
 * The words a pseudonym is drawn from when nobody has chosen one yet -- at
 * sign-up, and for every existing account in 0004_pseudonymous_users.sql,
 * which carries the same list in SQL because a .sql file cannot import.
 *
 * Deliberately technical rather than character names: nobody fights over
 * `Scanline`, they do not squat the pseudonyms players will actually want,
 * there is no trademark to worry about, and they read as "assigned
 * automatically, change me".
 */
export const AUTO_PSEUDO_WORDS = [
  'Sprite', 'Scanline', 'Palette', 'Mode7',
  'Cartouche', 'Manette', 'Pixel', 'Bitmap',
  'Tilemap', 'Chiptune', 'Joypad', 'Vblank',
  'Mosaique', 'Parallaxe', 'Arcade', 'Cathode'
] as const;

/** How many discriminators a single pseudonym can carry. */
export const DISCRIMINATOR_SPACE = 10000;

export interface Handle {
  pseudo: string;
  discriminator: string;
}

export function isValidPseudo(pseudo: unknown): boolean {
  return typeof pseudo === 'string' && PSEUDO_PATTERN.test(pseudo);
}

export function isValidDiscriminator(discriminator: unknown): boolean {
  return typeof discriminator === 'string' && DISCRIMINATOR_PATTERN.test(discriminator);
}

/** `0417`, never `417`: the padding is part of the value, not of the display. */
export function padDiscriminator(n: number): string {
  return String(n).padStart(4, '0');
}

export function formatHandle(pseudo: string, discriminator: string): string {
  return `${pseudo}${SEPARATOR}${discriminator}`;
}

/**
 * `"Sprite#0417"` into its two halves, or null if it is not a handle.
 *
 * The split is on the LAST separator, not the first. A pseudonym cannot
 * contain `#`, so splitting last makes `a#b#0001` fail validation -- the
 * left-hand side comes out as `a#b` and is rejected -- rather than quietly
 * parsing as `a` plus a leftover. Splitting first would accept it.
 *
 * Whitespace is trimmed because handles arrive by copy-paste, and a trailing
 * space from a chat client is not a mistake worth an error message.
 */
export function parseHandle(handle: unknown): Handle | null {
  if (typeof handle !== 'string') return null;

  const trimmed = handle.trim();
  const at = trimmed.lastIndexOf(SEPARATOR);
  if (at === -1) return null;

  const pseudo = trimmed.slice(0, at);
  const discriminator = trimmed.slice(at + 1);

  if (!isValidPseudo(pseudo) || !isValidDiscriminator(discriminator)) return null;

  return { pseudo, discriminator };
}
