/**
 * The row shapes, written by hand now that no generator writes them.
 *
 * Dates are `Date` here and integers on disk: SQLite has no date type, and
 * Prisma stored every DATETIME column as milliseconds since the epoch. The
 * conversion lives in the row converters of each repository module, nowhere
 * else.
 */

export interface User {
  id: string;
  googleId: string;
  /**
   * Chosen by the player, and unique only together with `discriminator` -- two
   * players may both be `Mario`. Never null: every row is filled in, either by
   * the player or by the automatic assignment at sign-up.
   */
  pseudo: string;
  /** Four digits, zero-padded. `'0417'`, never `417`. */
  discriminator: string;
  /**
   * When the player chose their own pseudonym, or null if the one they carry
   * was assigned for them. Null is what opens the onboarding gate, which is
   * why this is a timestamp and not a second source of truth alongside
   * `pseudo`.
   */
  pseudoChosenAt: Date | null;
  avatar: string | null;
  controlsConfig: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Everything one player is allowed to learn about another. Nothing more.
 *
 * Every query that reaches across users projects to this shape at the source,
 * so a caller cannot leak what it never received -- the property holds by
 * typing rather than by vigilance. The friends list used to hand out whole
 * `User` rows, googleId and controlsConfig included.
 */
export interface PublicUser {
  id: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
}

export interface Friendship {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  initiatorId: string;
  receiverId: string;
}

export interface Game {
  id: string;
  title: string;
  filename: string;
  coverUrl: string | null;
  uploadedAt: Date;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  crc32: string | null;
  sram: Buffer | null;
  sramUpdatedAt: Date | null;
  userId: string;
}

export interface Save {
  id: string;
  name: string;
  slotNumber: number;
  data: Buffer;
  screenshot: string | null;
  createdAt: Date;
  updatedAt: Date;
  gameId: string;
}

/** The subset of a Save that the library listing sends: never the blob. */
export interface SaveSummary {
  id: string;
  name: string;
  slotNumber: number;
  screenshot: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Who owns a catalogue row: the shipped JSON file, or a player. */
export type MetadataSource = 'catalogue' | 'community';

export interface GameMetadata {
  id: string;
  title: string;
  altTitle: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
  crc32: string | null;
  md5: string | null;
  source: MetadataSource;
  contributedBy: string | null;
  /**
   * Whether a cover image is stored. The bytes themselves never travel with
   * the row: they are megabytes in aggregate, and only the cover route wants
   * them.
   */
  hasCover: boolean;
  createdAt: Date;
  updatedAt: Date;
}
