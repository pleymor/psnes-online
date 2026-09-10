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
 * Claims a checksum for an entry, or re-points a claim that was wrong.
 *
 * `crc32` is the primary key, because a CRC32 names an exact dump and so
 * belongs to at most one game - and that invariant is the reason this is an
 * upsert rather than two functions. A player who says a dump is the wrong
 * game has to be able to say otherwise afterwards, and the alternative to
 * replacing the row is a second row the key would refuse anyway.
 *
 * `contributedBy` follows the correction. The row is a live statement about
 * the world, not a record of who said it first, so the credit belongs to
 * whoever is standing behind it now.
 *
 * `createdAt` does not move: it says when this dump was first identified,
 * which stays true across a correction.
 */
export function claimChecksum(
	db: Database,
	input: { crc32: string; metadataId: string; contributedBy: string | null }
): MetadataLink {
	const now = Date.now();
	db.prepare(`
		INSERT INTO "GameMetadataChecksum" (crc32, metadataId, contributedBy, createdAt)
		VALUES (@crc32, @metadataId, @contributedBy, @now)
		ON CONFLICT(crc32) DO UPDATE SET
			metadataId = excluded.metadataId,
			contributedBy = excluded.contributedBy
	`).run({ ...input, now });
	return findLinkByChecksum(db, input.crc32)!;
}
