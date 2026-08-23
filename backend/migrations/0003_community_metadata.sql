-- Community contributions to the shared catalogue.
--
-- Two things are added here. First, provenance on "GameMetadata": the JSON
-- catalogue owns the rows it shipped and rewrites them wholesale on every
-- refresh, so a row a player contributed has to be distinguishable from one
-- the file owns, or the next refresh deletes it. Second, the link table, which
-- is what actually carries a contribution to other players.
--
-- The DEFAULT NULL on contributedBy is not stylistic: SQLite refuses an
-- ADD COLUMN carrying a REFERENCES clause unless its default is NULL, and
-- foreign-key enforcement is switched on for every connection in
-- db/sqlite.ts. (Naming the statement that does it would trip
-- migrate.ts:assertNoPragma, which scans the file's text and does not
-- exempt comments -- a false positive its author chose over parsing SQL.)
--
-- createdAt keeps the baseline's DATETIME DEFAULT CURRENT_TIMESTAMP for
-- consistency with every other table here, but nothing relies on it: the code
-- always writes an explicit Date.now(), because every date in this schema is
-- stored as milliseconds since the epoch.

ALTER TABLE "GameMetadata" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'catalogue';
ALTER TABLE "GameMetadata" ADD COLUMN "contributedBy" TEXT DEFAULT NULL REFERENCES "User" ("id") ON DELETE SET NULL;
ALTER TABLE "GameMetadata" ADD COLUMN "cover" BLOB;
ALTER TABLE "GameMetadata" ADD COLUMN "coverMime" TEXT;

-- crc32 is the primary key, and that is the load-bearing decision: a CRC32
-- names an exact dump, so it belongs to at most one game. The link is
-- idempotent for free, and two players cannot attach the same ROM to two
-- different entries -- the schema refuses it, rather than an application guard
-- that would eventually be forgotten at a new call site.
CREATE TABLE "GameMetadataChecksum" (
    "crc32" TEXT NOT NULL PRIMARY KEY,
    "metadataId" TEXT NOT NULL,
    "contributedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameMetadataChecksum_metadataId_fkey" FOREIGN KEY ("metadataId") REFERENCES "GameMetadata" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GameMetadataChecksum_contributedBy_fkey" FOREIGN KEY ("contributedBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "GameMetadataChecksum_metadataId_idx" ON "GameMetadataChecksum" ("metadataId");
CREATE INDEX "GameMetadata_source_idx" ON "GameMetadata" ("source");
