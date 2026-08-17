-- Drops the stored Google OAuth tokens.
--
-- They were only ever there to call Drive on a player's behalf. With ROMs
-- staying on their machine there is nothing to call, and an encrypted refresh
-- token nobody uses is a standing liability. Losing them costs nothing: signing
-- in issues a fresh access token every time.
--
-- The table is rebuilt keeping `id`, so every row that points at a user - their
-- games, saves and friendships - stays attached.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatar" TEXT,
    "controlsConfig" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatar", "controlsConfig", "createdAt", "displayName", "email", "googleId", "id", "updatedAt") SELECT "avatar", "controlsConfig", "createdAt", "displayName", "email", "googleId", "id", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
