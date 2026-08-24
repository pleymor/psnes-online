-- A player stops being a name and an email from Google, and becomes a
-- pseudonym they chose plus a four-digit discriminator.
--
-- Two columns are dropped here. SQLite has allowed ALTER TABLE ... DROP COLUMN
-- since 3.35, and this repo runs 3.53 through better-sqlite3 12.9, so neither
-- drop needs the create-copy-drop-rename rebuild that migrate.ts:assertNoPragma
-- refuses outright.
--
-- SQLite will not drop a column an index depends on, and "email" carries
-- User_email_key from the baseline (0001_baseline.sql:83), so that index goes
-- first. "displayName" has none. This is not hypothetical tidiness: without
-- the DROP INDEX below, the migration fails with "error in index
-- User_email_key after drop column" -- found by backend/test/
-- pseudonymise.test.ts, which runs the real files rather than a hand-written
-- approximation of them.
--
-- Order matters and is not stylistic: the backfill below reads no dropped
-- column, but the unique index must exist before anything can rely on it, and
-- the drops must come last so that a failure anywhere above rolls the whole
-- migration back with the old data still in place. migrate() wraps this file
-- in a single transaction.

-- NOT NULL with a DEFAULT '' is the only shape SQLite accepts for ADD COLUMN
-- NOT NULL -- it has to have something to write into the existing rows. The
-- UPDATE below, in this same transaction, leaves no row holding ''. These two
-- statements are not separable.
ALTER TABLE "User" ADD COLUMN "pseudo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "discriminator" TEXT NOT NULL DEFAULT '';

-- NULL means "assigned by this migration, the player has not chosen yet", and
-- it is what opens the onboarding gate. A timestamp rather than a boolean, to
-- match abandonedAt and sramUpdatedAt elsewhere in this schema.
ALTER TABLE "User" ADD COLUMN "pseudoChosenAt" DATETIME DEFAULT NULL;

-- Everyone is filled in, not just future sign-ups.
--
-- The first draft of this design marked "has not chosen yet" with pseudo IS
-- NULL, which is cheaper and wrong: the lobby, the friends list, RoomPlayers
-- and the room invitation panel all render a friend's pseudo, so every account
-- that had not signed in again would show blank to everybody else -- and a
-- shared fallback label would give ten friends the same name.
--
-- The assignment is deterministic rather than random: n % 16 picks the word,
-- n / 16 + 1 the discriminator. Two rows cannot collide by construction, which
-- matters because a .sql file has nowhere to put a retry loop.
--
-- The vocabulary is deliberately technical rather than character names: nobody
-- fights over "Scanline", these words do not squat the pseudonyms players will
-- actually want, there is no trademark to worry about, and they read as
-- "assigned automatically, change me".
WITH names(i, word) AS (
  VALUES (0,'Sprite'),(1,'Scanline'),(2,'Palette'),(3,'Mode7'),
         (4,'Cartouche'),(5,'Manette'),(6,'Pixel'),(7,'Bitmap'),
         (8,'Tilemap'),(9,'Chiptune'),(10,'Joypad'),(11,'Vblank'),
         (12,'Mosaique'),(13,'Parallaxe'),(14,'Arcade'),(15,'Cathode')
),
numbered AS (
  SELECT id, (ROW_NUMBER() OVER (ORDER BY createdAt, id)) - 1 AS n FROM "User"
)
UPDATE "User"
   SET pseudo = (SELECT word FROM names WHERE names.i = numbered.n % 16),
       discriminator = substr('0000' || (numbered.n / 16 + 1), -4)
  FROM numbered
 WHERE "User".id = numbered.id;

-- COLLATE NOCASE is what makes Mario#0417 and mario#0417 the same handle, and
-- it is also why utils/pseudo.ts restricts pseudonyms to ASCII: SQLite's
-- NOCASE folds A-Z and nothing else, so allowing accented letters would let
-- e#0417 and E#0417 both exist and this index would stop guaranteeing what the
-- design claims it guarantees.
CREATE UNIQUE INDEX "User_pseudo_discriminator_key"
  ON "User" ("pseudo" COLLATE NOCASE, "discriminator");

-- The point of the whole migration. Note that dropping a column rewrites the
-- rows but can leave the old bytes in freed pages of the .db file: a VACUUM is
-- a required manual step after deployment, and it cannot live here because
-- VACUUM refuses to run inside a transaction.
DROP INDEX "User_email_key";
ALTER TABLE "User" DROP COLUMN "email";
ALTER TABLE "User" DROP COLUMN "displayName";
