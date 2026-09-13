-- On n'entre plus sans y être invité.
--
-- `code` est en clair, contrairement aux jetons de mail du chantier suivant.
-- Ce n'est pas un oubli : l'inviteur doit pouvoir rouvrir son profil et
-- recopier son lien, et un secret qu'il faut réafficher ne peut pas être
-- haché. Ce que ce code donne est borné -- le droit de créer un compte, pas
-- d'en prendre un.
--
-- `inviteeId` est en ON DELETE SET NULL et non CASCADE. Si le filleul supprime
-- son compte, l'invitation reste consommée : avec CASCADE, un inviteur
-- recyclerait ses deux places indéfiniment en faisant tourner des comptes.
--
-- Les trois dates sont des millisecondes epoch, écrites explicitement par le
-- code appelant. Pas de DEFAULT CURRENT_TIMESTAMP : il insérerait du texte là
-- où tout ce schéma met des nombres, et SQLite étant typé dynamiquement
-- personne ne s'en plaindrait avant qu'une comparaison de dates soit fausse.

CREATE TABLE "SignupInvite" (
  "id"           TEXT PRIMARY KEY,
  "code"         TEXT NOT NULL UNIQUE,
  "inviterId"    TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "inviteeId"    TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "grantedByCli" INTEGER NOT NULL DEFAULT 0,
  "createdAt"    INTEGER NOT NULL,
  "usedAt"       INTEGER,
  "revokedAt"    INTEGER
);

CREATE INDEX "SignupInvite_inviterId_idx" ON "SignupInvite" ("inviterId");
