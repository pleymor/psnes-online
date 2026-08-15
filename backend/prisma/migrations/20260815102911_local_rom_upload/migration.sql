-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Game" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "coverUrl" TEXT,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driveFileId" TEXT,
    "driveFileName" TEXT,
    "localPath" TEXT,
    "genre" TEXT,
    "publisher" TEXT,
    "developer" TEXT,
    "releaseDate" TEXT,
    "players" TEXT,
    "region" TEXT,
    "description" TEXT,
    "crc32" TEXT,
    "sram" BLOB,
    "sramUpdatedAt" DATETIME,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Game_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Game" ("coverUrl", "crc32", "description", "developer", "driveFileId", "driveFileName", "filename", "genre", "id", "players", "publisher", "region", "releaseDate", "sram", "sramUpdatedAt", "title", "uploadedAt", "userId") SELECT "coverUrl", "crc32", "description", "developer", "driveFileId", "driveFileName", "filename", "genre", "id", "players", "publisher", "region", "releaseDate", "sram", "sramUpdatedAt", "title", "uploadedAt", "userId" FROM "Game";
DROP TABLE "Game";
ALTER TABLE "new_Game" RENAME TO "Game";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
