-- AlterTable
ALTER TABLE "Game" ADD COLUMN "crc32" TEXT;
ALTER TABLE "Game" ADD COLUMN "description" TEXT;
ALTER TABLE "Game" ADD COLUMN "developer" TEXT;
ALTER TABLE "Game" ADD COLUMN "genre" TEXT;
ALTER TABLE "Game" ADD COLUMN "players" TEXT;
ALTER TABLE "Game" ADD COLUMN "publisher" TEXT;
ALTER TABLE "Game" ADD COLUMN "region" TEXT;
ALTER TABLE "Game" ADD COLUMN "releaseDate" TEXT;

-- CreateTable
CREATE TABLE "GameMetadata" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "altTitle" TEXT,
    "genre" TEXT,
    "publisher" TEXT,
    "developer" TEXT,
    "releaseDate" TEXT,
    "players" TEXT,
    "region" TEXT,
    "description" TEXT,
    "coverUrl" TEXT,
    "crc32" TEXT,
    "md5" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "GameMetadata_title_idx" ON "GameMetadata"("title");

-- CreateIndex
CREATE INDEX "GameMetadata_crc32_idx" ON "GameMetadata"("crc32");
