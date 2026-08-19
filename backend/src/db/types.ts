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
  email: string;
  displayName: string;
  avatar: string | null;
  controlsConfig: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the friend search and the online-friends list are allowed to expose. */
export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
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
  createdAt: Date;
  updatedAt: Date;
}
