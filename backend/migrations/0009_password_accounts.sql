-- Google cesse d'être la seule porte (#68).
--
-- L'adresse ne retourne PAS dans "User". La migration 0004 l'en a sortie en
-- argumentant longuement, et db/users.ts fait un SELECT * : l'y remettre
-- exposerait une adresse à chaque lecture d'utilisateur, et rendrait à toSelf()
-- et à USER_COLUMNS (db/friendships.ts) la possibilité de la fuiter par
-- accident. Dans une table à part, un compte Google n'a simplement pas de
-- ligne.
--
-- COLLATE NOCASE est sur l'INDEX et pas sur la colonne, comme le fait
-- 0004_pseudonymous_users.sql pour le handle. C'est ce qui fait de
-- Alice@x.fr et alice@x.fr un seul compte -- sans quoi la même personne
-- pourrait avoir deux comptes, et son « mot de passe oublié » atteindrait le
-- mauvais. La colonne, elle, garde la casse tapée : c'est ce qui part dans le
-- champ To:.
--
-- Rappel de 0004 : SQLite NOCASE ne replie que A-Z. Une adresse contenant des
-- lettres accentuées avant l'arobase échapperait donc à l'unicité. C'est
-- assumé, et c'est déjà la limite acceptée pour les pseudonymes.
--
-- Numérotée 0009 alors que 0010 existe déjà : le numéro était réservé à ce
-- chantier (voir l'en-tête de 0010_offline_sync.sql). Le registre des
-- migrations est un ensemble de noms, pas un curseur, donc un fichier plus
-- petit qu'un fichier déjà appliqué s'applique normalement.

CREATE TABLE "Credential" (
  "userId"       TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt"    INTEGER NOT NULL,
  "updatedAt"    INTEGER NOT NULL
);

CREATE UNIQUE INDEX "Credential_email_key" ON "Credential" ("email" COLLATE NOCASE);

-- Une inscription qui attend son mail de confirmation.
--
-- Elle porte le hash du mot de passe, pas le mot de passe : entre le
-- formulaire et le clic, il peut se passer vingt-quatre heures, et rien ne
-- justifie de garder un secret en clair pendant ce temps-là.
--
-- Elle RETIENT son invitation : tant qu'une ligne non expirée pointe un lien,
-- ce lien répond INVITE_HELD. C'est ce qui empêche un lien partagé à deux
-- personnes de produire deux comptes. La retenue est l'absence de ligne
-- expirée, pas une colonne à nettoyer -- rien à balayer, rien à oublier de
-- balayer.
--
-- ON DELETE CASCADE depuis SignupInvite : une invitation qui disparaît emporte
-- l'inscription qui l'attendait. Une invitation RÉVOQUÉE, elle, garde sa ligne
-- (`revokeInvite` ne pose que `revokedAt`) : c'est la porte, reconsultée à la
-- confirmation, qui refuse alors INVITE_REVOKED.

CREATE TABLE "PendingSignup" (
  "id"           TEXT PRIMARY KEY,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "inviteId"     TEXT NOT NULL REFERENCES "SignupInvite"("id") ON DELETE CASCADE,
  "tokenHash"    TEXT NOT NULL UNIQUE,
  "createdAt"    INTEGER NOT NULL,
  "expiresAt"    INTEGER NOT NULL
);

CREATE INDEX "PendingSignup_inviteId_idx" ON "PendingSignup" ("inviteId");

-- Le jeton est stocké HACHÉ, contrairement au code d'invitation.
-- Celui-ci voyage dans une boîte mail et donne un compte ; rien ne le
-- réaffiche, donc rien n'empêche de le hacher.

CREATE TABLE "PasswordReset" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "usedAt"    INTEGER
);

CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset" ("userId");
