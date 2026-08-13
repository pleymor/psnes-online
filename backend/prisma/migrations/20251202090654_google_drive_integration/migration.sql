/*
  Warnings:

  - You are about to drop the column `romPath` on the `Game` table. All the data in the column will be lost.
  - Added the required column `driveFileId` to the `Game` table without a default value. This is not possible if the table is not empty.
  - Added the required column `driveFileName` to the `Game` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleAccessToken" TEXT;
ALTER TABLE "User" ADD COLUMN "googleRefreshToken" TEXT;
ALTER TABLE "User" ADD COLUMN "googleTokenExpiry" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Game" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "coverUrl" TEXT,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driveFileId" TEXT NOT NULL,
    "driveFileName" TEXT NOT NULL,
    "genre" TEXT,
    "publisher" TEXT,
    "developer" TEXT,
    "releaseDate" TEXT,
    "players" TEXT,
    "region" TEXT,
    "description" TEXT,
    "crc32" TEXT,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Game_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Game" ("coverUrl", "crc32", "description", "developer", "filename", "genre", "id", "players", "publisher", "region", "releaseDate", "title", "uploadedAt", "userId") SELECT "coverUrl", "crc32", "description", "developer", "filename", "genre", "id", "players", "publisher", "region", "releaseDate", "title", "uploadedAt", "userId" FROM "Game";
DROP TABLE "Game";
ALTER TABLE "new_Game" RENAME TO "Game";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
