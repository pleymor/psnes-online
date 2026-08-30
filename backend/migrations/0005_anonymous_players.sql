-- Un joueur peut désormais exister sans compte : ni Google, ni rien qui
-- survive à sa session. C'est l'identité que 0004 avait laissée en creux -
-- « pseudonyme » veut dire un handle stable que le joueur a choisi, « anonyme »
-- veut dire aucune identité persistante du tout.
--
-- Le mot est `anonymous` et pas `guest` : dans ce dépôt un `guest` est le pair
-- non-hôte d'un salon (websocket/room-view.ts, webrtc/p2p-manager.ts,
-- znet/protocol.ts). `host`/`guest` est un rôle dans un salon, ceci est une
-- identité : deux axes, deux mots, et aucune ambiguïté dans les fichiers où se
-- tromper désynchronise une partie.

-- ------------------------------------------------------------------ googleId
--
-- `googleId` était TEXT NOT NULL (0001_baseline.sql:3). Un anonyme n'a aucun
-- identifiant Google à y mettre, et lui en fabriquer un - le tour que joue
-- /auth/dev/login avec `dev-google-id-1` - reviendrait à garder un espace de
-- noms inventé sous un index unique, en production.
--
-- SQLite ne sait pas relâcher un NOT NULL par ALTER. La reconstruction de
-- table que Prisma écrirait à sa place est précisément ce que
-- db/migrate.ts:assertNoPragma refuse : chaque migration tourne dans une
-- transaction, la directive qui désarme les clés étrangères y est ignorée en
-- silence, et le DROP TABLE "User" déclencherait tous les ON DELETE CASCADE de
-- Game et Friendship - la bibliothèque et les amitiés de tout le monde, sans
-- une erreur. (Ce fichier évite jusqu'au mot : assertNoPragma le cherche par
-- expression régulière, y compris dans un commentaire, et assume ce
-- faux positif plutôt que de parser du SQL.)
--
-- D'où ces cinq pas, qui ne touchent jamais à la table elle-même : une colonne
-- nullable est ajoutée à côté, recopiée, l'ancienne disparaît, et la nouvelle
-- prend son nom. Aucune ligne n'est réécrite dans une autre table, aucune
-- cascade ne peut partir. L'ordre est indissociable : l'index doit tomber
-- avant sa colonne (SQLite refuse de supprimer une colonne indexée), et le
-- UPDATE doit précéder le DROP sous peine de perdre la clé de connexion de
-- tous les comptes existants.
ALTER TABLE "User" ADD COLUMN "googleIdNullable" TEXT;
UPDATE "User" SET "googleIdNullable" = "googleId";
DROP INDEX "User_googleId_key";
ALTER TABLE "User" DROP COLUMN "googleId";
ALTER TABLE "User" RENAME COLUMN "googleIdNullable" TO "googleId";

-- Reconstruit à l'identique. Un index UNIQUE de SQLite laisse passer autant de
-- NULL qu'on veut - c'est ce qui permet à mille anonymes de coexister - tout
-- en refusant toujours deux fois le même identifiant Google, qui est la seule
-- chose que cet index a jamais eu à garantir.
CREATE UNIQUE INDEX "User_googleId_key" ON "User" ("googleId");

-- --------------------------------------------------------------- isAnonymous
--
-- Une colonne explicite plutôt que `googleId IS NULL`, et ce n'est pas de la
-- redondance : « pas d'identifiant Google » et « pas de compte » sont vrais
-- ensemble aujourd'hui parce qu'il n'existe qu'un fournisseur. Le jour où il y
-- en a un second, la dérivation classerait ses comptes comme anonymes - donc
-- les priverait de leur bibliothèque en silence, ce qui est exactement le
-- genre de garantie qu'on relâche par effet de bord. La colonne dit ce qu'elle
-- décide.
--
-- 0 par défaut : toute ligne existante est un compte. db/users.ts est le seul
-- endroit qui écrit 1, dans createAnonymousUser.
ALTER TABLE "User" ADD COLUMN "isAnonymous" INTEGER NOT NULL DEFAULT 0;

-- Ce que balaie sweepAnonymousUsers : les sessions sans compte que personne ne
-- reprendra. Sans cet index le balayage horaire est un scan complet de la
-- table des joueurs.
CREATE INDEX "User_isAnonymous_createdAt_idx"
  ON "User" ("isAnonymous", "createdAt");
