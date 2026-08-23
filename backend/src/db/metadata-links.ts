/**
 * Which dump is which game.
 *
 * A row here says that the ROM whose CRC32 is `crc32` is the game described by
 * `metadataId`. That is a fact about the world rather than a fact about a
 * player, which is exactly why one player posting it serves everyone who owns
 * the same dump -- and why the resolution happens at read time instead of being
 * copied into each player's own Game row.
 */

import type { Database } from './sqlite.js';

export interface MetadataLink {
  crc32: string;
  metadataId: string;
  contributedBy: string | null;
  createdAt: Date;
}

interface LinkRow {
  crc32: string;
  metadataId: string;
  contributedBy: string | null;
  createdAt: number;
}

function toLink(row: LinkRow): MetadataLink {
  return {
    crc32: row.crc32,
    metadataId: row.metadataId,
    contributedBy: row.contributedBy,
    createdAt: new Date(row.createdAt)
  };
}

export function findLinkByChecksum(db: Database, crc32: string): MetadataLink | null {
  const row = db.prepare(`SELECT * FROM "GameMetadataChecksum" WHERE crc32 = ?`)
    .get(crc32) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

/**
 * Claims a checksum for an entry.
 *
 * Throws on a checksum already claimed: `crc32` is the primary key, because a
 * CRC32 names an exact dump and so belongs to at most one game. Callers read
 * the existing link first and turn the collision into an answer the player can
 * act on, rather than letting this throw reach them.
 */
export function linkChecksum(
  db: Database,
  input: { crc32: string; metadataId: string; contributedBy: string | null }
): MetadataLink {
  const now = Date.now();
  db.prepare(`
    INSERT INTO "GameMetadataChecksum" (crc32, metadataId, contributedBy, createdAt)
    VALUES (@crc32, @metadataId, @contributedBy, @now)
  `).run({ ...input, now });
  return findLinkByChecksum(db, input.crc32)!;
}
