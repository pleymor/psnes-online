-- Le résultat d'une partie cesse de mourir avec la page.
--
-- `Match` fait autorité et `Rating` en est entièrement recalculé. C'est ce qui
-- permet de changer la formule, le facteur K ou le classement initial sans
-- perdre l'historique, et de refaire les cotes si un défaut d'enregistrement
-- est découvert. L'inverse - tenir la cote et jeter les parties - ne se
-- rattrape pas.
--
-- ------------------------------------------------------------- gameCrc32
--
-- Et non `gameId`. Un `Game.id` appartient à un compte : les deux joueurs
-- d'une même partie ont deux lignes `Game` distinctes pour la même cartouche
-- (`Game_userId_crc32_key`, 0001). Classer par `gameId` donnerait deux
-- classements pour un jeu. Le checksum est ce que les deux partagent, c'est
-- déjà la clé de `watched-roms.ts`, et c'est sur lui qu'un appariement par
-- voisinage de cote joindra.
--
-- --------------------------------------------------------------- sessionId
--
-- La clé de déduplication porte sur la session de jeu et non sur le salon.
-- Les deux pairs calculent le même verdict et le rapportent tous les deux ;
-- l'index unique est ce qui garde une seule ligne. Mais le compteur d'images
-- repart de zéro à chaque session, et le salon, lui, ne change pas : avec
-- `(roomId, frame)`, deux parties jouées dans le même salon à deux moments
-- différents se confondraient, la seconde rejetée comme un doublon et son
-- vainqueur comparé à celui de la première - donc une fausse alerte de
-- désynchronisation. Le serveur pose `sessionId` quand une partie commence.
--
-- --------------------------------------------------------- les deux FK
--
-- Asymétrie voulue, sur le modèle de `SignupInvite.inviteeId` en 0007. Une
-- partie jouée est un fait qui a eu lieu : elle survit à la suppression d'un
-- compte, d'où SET NULL. Une cote est une propriété de ce compte et n'a plus
-- de sens sans lui, d'où CASCADE.
--
-- Un joueur sans compte n'a pas d'identité durable : sa colonne est écrite
-- NULL dès l'insertion, et non laissée au balayage des anonymes. « Classable »
-- se lit alors `p1UserId IS NOT NULL AND p2UserId IS NOT NULL`, c'est vrai dès
-- l'écriture et ça le reste - aucune colonne `ranked` à tenir en accord avec
-- autre chose.
--
-- Les dates sont des millisecondes epoch écrites par le code appelant. Pas de
-- DEFAULT CURRENT_TIMESTAMP, qui insérerait du texte là où tout ce schéma met
-- des nombres.

CREATE TABLE "Match" (
  "id"        TEXT PRIMARY KEY,
  "playedAt"  INTEGER NOT NULL,
  "gameCrc32" TEXT    NOT NULL,
  "roomId"    TEXT    NOT NULL,
  "sessionId" TEXT    NOT NULL,
  "frame"     INTEGER NOT NULL,
  "p1UserId"  TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "p2UserId"  TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "winner"    INTEGER NOT NULL,
  "p1Health"  INTEGER NOT NULL,
  "p2Health"  INTEGER NOT NULL
);

CREATE UNIQUE INDEX "Match_sessionId_frame_key" ON "Match" ("sessionId", "frame");
CREATE INDEX "Match_gameCrc32_playedAt_idx" ON "Match" ("gameCrc32", "playedAt");

-- `rating` en INTEGER : tout ce schéma met des nombres, et le delta est arrondi
-- une fois puis appliqué en plus à l'un et en moins à l'autre, donc les cotes
-- restent entières sans que la somme dérive.
CREATE TABLE "Rating" (
  "userId"    TEXT    NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "gameCrc32" TEXT    NOT NULL,
  "rating"    INTEGER NOT NULL,
  "matches"   INTEGER NOT NULL,
  PRIMARY KEY ("userId", "gameCrc32")
);

-- L'index du voisinage de cote : c'est celui qu'un appariement lira pour
-- trouver un adversaire de force voisine parmi les possesseurs d'une cartouche.
CREATE INDEX "Rating_gameCrc32_rating_idx" ON "Rating" ("gameCrc32", "rating");
