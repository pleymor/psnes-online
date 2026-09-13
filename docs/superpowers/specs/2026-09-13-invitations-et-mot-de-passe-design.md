# Fermer la porte, et en ouvrir une deuxième

Conception. On n'entre plus sur la plateforme sans y être invité par quelqu'un qui y est déjà, et le nombre de places est borné. En parallèle, Google cesse d'être la seule façon de se connecter : un compte peut naître d'une adresse e-mail et d'un mot de passe, avec la récupération qui va avec.

Deux chantiers, une seule spec, parce qu'ils se croisent en un point précis : l'inscription par e-mail n'existe que derrière l'invitation, et la porte d'invitation doit refuser Google exactement comme elle refuse un formulaire.

## Pourquoi

**La charge.** N'importe qui peut aujourd'hui créer un compte : `/auth/google` accepte tout profil Google et `auth/passport.ts` crée la ligne à la volée si le `googleId` est inconnu. Le serveur ne fait pas tourner d'émulateur — le coût par joueur est faible — mais il porte les sauvegardes, les jaquettes, le relais lockstep et une base SQLite sur un VPS unique. La croissance non bornée est le risque qu'on veut retirer maintenant, tant qu'il est théorique.

**Google comme seule porte.** Des joueurs ne veulent pas s'authentifier chez Google, et il n'y a rien à leur proposer. L'application n'a pourtant aucune raison technique d'en dépendre : `auth/passport.ts` ne lit du profil que l'identifiant et la photo, ne demande plus le scope `email` et ne conserve aucun jeton. Google est un fournisseur d'identité interchangeable, pas une brique d'architecture.

## Ce qui existe déjà, et qu'on ne casse pas

| Existant | Ce qu'il devient |
|---|---|
| Comptes actuels | Exemptés. Ils existent, ils restent ; chacun reçoit ses 2 invitations. |
| `AUTH_MODE=google\|dev` | **Ne change pas.** La porte à mot de passe s'ouvre par une variable à part, `PASSWORD_AUTH` (voir ci-dessous). |
| La porte anonyme (`POST /auth/anonymous`) | **Inchangée.** Un lien de salon ouvre toujours sans invitation, et ces lignes ne consomment aucune place. |
| Le portique de pseudonyme (`needsPseudo`) | Inchangé. Un compte né d'un mot de passe y tombe comme un compte né de Google. |
| `Invitation` / table `RoomInvitation` | Inchangée. C'est « rejoins mon salon », un autre concept. |

## `AUTH_MODE` ne bouge pas

La première rédaction de cette spec faisait d'`AUTH_MODE` une liste (`google,password`). C'est une erreur, et le dépôt l'avait déjà écartée en toutes lettres. `auth/anonymous.ts:anonymousJoinEnabled` :

> *« Volontairement pas une valeur d'`AUTH_MODE`. `env-guard.ts` refuse de démarrer en production sur `AUTH_MODE === 'dev'` par une égalité stricte : un `AUTH_MODE=dev+anonymous` passerait à travers ce test et rouvrirait `/auth/dev/login` en production. Ajouter une valeur à cette variable, c'est relâcher une garantie existante par effet de bord ; une variable à part n'a pas ce défaut. »*

`POST /auth/dev/login` est une route **non authentifiée qui distribue de vraies sessions**. L'égalité stricte de `env-guard.ts:29` est ce qui la tient hors de production, et `docker-compose.yml` s'appuie dessus par écrit.

Donc : **`PASSWORD_AUTH`**, exactement sur le modèle d'`ANONYMOUS_JOIN`, dans `backend/src/auth/credentials-door.ts` :

```ts
export function passwordAuthEnabled(env = process.env): boolean {
  return (env.PASSWORD_AUTH ?? 'on').toLowerCase() !== 'off';
}
```

`AUTH_MODE` garde ses deux valeurs et son égalité stricte. Rien à modifier dans `env-guard.ts` de ce côté — il ne gagne que l'exigence de `SMTP_URL`.

`GET /auth/mode` renvoie désormais `{ mode, anonymousJoin, passwordAuth }` : un champ de plus, pas une rupture de forme.

## Le vocabulaire

`Invitation` est pris. Le nouveau concept s'appelle **`SignupInvite`** : ce qui fait naître un compte. Aucun fichier, aucune table, aucune chaîne d'interface ne doit réutiliser le mot nu « invitation » sans préciser lequel des deux.

---

# Chantier 1 — L'invitation

## La règle

**Deux comptes par compte, à vie. Cent comptes en tout.**

Le quota compte les places, pas les liens :

```
restant = 2 − compte(invitations de ce joueur où grantedByCli = 0
                      et revokedAt IS NULL)
```

Une invitation non révoquée compte, qu'elle soit déjà consommée ou encore vivante. Révoquer un lien non consommé rend la place ; révoquer n'est possible **que** sur un lien non consommé, donc une place rendue n'est jamais une place déjà occupée par quelqu'un.

Ce calcul est le cœur de la décision, et il n'est pas cosmétique. L'alternative — n'émettre aucune limite de liens et refuser à la consommation — déplace le refus sur le filleul : trois amis sur cinq cliqueraient un lien pour lire « invitation invalide », sans avoir rien fait de mal. Ici le refus tombe sur l'inviteur, au moment où il frappe le troisième lien, et il est actionnable : révoquer, ou attendre.

Les liens **n'expirent pas**. Ils sont révocables, ce qui suffit, et une expiration serait un état de plus à afficher, à tester et à expliquer.

## Le plafond

`MAX_USERS`, dans `backend/.env`, par défaut `100`. Une variable et non une constante : remonter le plafond ne doit pas demander un commit et un déploiement.

Compté sur `isAnonymous = 0`. **Les invités anonymes ne consomment pas de place** : leur ligne est éphémère (`deleteAnonymousUser` à la déconnexion, `sweepAnonymousUsers` en filet), elle ne porte ni bibliothèque, ni ami, ni sauvegarde. La compter reviendrait à laisser une soirée à quatre invités fermer la porte à quatre vrais joueurs.

Le plafond est vérifié **à la consommation**, pas à l'émission : entre la frappe d'un lien et son usage, des semaines peuvent passer. Un lien émis n'est donc pas une réservation de place.

## L'échappatoire

Pas de rôle `isAdmin`, pas d'écran `/admin`. Une route privilégiée exposée au web est une surface d'attaque permanente pour un besoin occasionnel.

À la place, `backend/src/db/invite-cli.ts`, dans l'idiome déjà en place (`migrate-cli.ts`, `catalogue-cli.ts`) :

```
bun src/db/invite-cli.ts grant Sprite#0417      # frappe une invitation hors quota
bun src/db/invite-cli.ts list                   # l'état des places
bun src/db/invite-cli.ts revoke <code>
```

Une invitation frappée par le CLI porte `grantedByCli = 1` et **ne compte pas dans le quota de l'inviteur** — c'est précisément ce qui la rend utile le jour où quelqu'un a perdu son lien.

## Le modèle

Migration `0006_invite_only_signup.sql`.

```sql
CREATE TABLE "SignupInvite" (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  inviterId     TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  inviteeId     TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  grantedByCli  INTEGER NOT NULL DEFAULT 0,
  createdAt     INTEGER NOT NULL,
  usedAt        INTEGER,
  revokedAt     INTEGER
);
CREATE INDEX "SignupInvite_inviterId_idx" ON "SignupInvite" ("inviterId");
```

`createdAt` / `usedAt` / `revokedAt` sont des **millisecondes epoch**, écrites explicitement, jamais laissées à un `DEFAULT CURRENT_TIMESTAMP` — c'est la convention de tout le dépôt et l'erreur que `db/invitations.ts` documente en long.

`inviteeId` en `ON DELETE SET NULL` et non `CASCADE` : si un filleul supprime son compte, l'invitation reste consommée. Sinon un inviteur pourrait recycler ses places indéfiniment en faisant tourner des comptes.

**Le `code` est stocké en clair**, contrairement aux jetons du chantier 2. Raison : l'inviteur doit pouvoir rouvrir son profil et recopier son lien. Un secret qu'il faut réafficher ne peut pas être haché. Le risque assumé est borné — ce que ce code donne, c'est le droit de créer un compte, pas d'en prendre un.

128 bits d'aléa, encodés en base64url (22 caractères), depuis `crypto.randomBytes`.

## La porte

`backend/src/auth/signup-door.ts`, une **fonction pure** `signupDoorDecision()`, calquée sur `anonymousDoorDecision` (`backend/src/auth/anonymous.ts`) : l'ordre des refus est une décision d'autorisation, elle doit être lisible et testable sans monter un serveur.

Entrées : le plafond et le nombre de comptes, l'invitation trouvée (ou non), l'état du quota de l'inviteur, le fait que l'appelant soit déjà connecté.

Sorties, dans cet ordre :

| Refus | Statut | Pourquoi cet ordre |
|---|---|---|
| déjà connecté | 400 | rien à décider |
| `PLATFORM_FULL` | 503 | avant même de regarder le code : un code valide ne doit pas laisser croire qu'il reste une place |
| `INVITE_UNKNOWN` | 404 | |
| `INVITE_REVOKED` | 410 | distingué de « inconnu » : le porteur du lien a le droit de savoir que le lien a existé |
| `INVITE_USED` | 410 | |
| `INVITE_HELD` | 409 | une inscription est en cours sur ce lien (voir chantier 2) |

`PLATFORM_FULL` **avant** la validation du code est délibéré. L'inverse serait un compteur de places restantes offert à qui détient un lien mort.

## Google passe par la même porte

`GET /auth/google?invite=CODE` pose le code dans `req.session.pendingInvite` avant la redirection. La stratégie prend `passReqToCallback: true` ; quand `findUserByGoogleId` ne trouve rien, elle appelle `signupDoorDecision` au lieu de créer la ligne, et un refus repart en `done(null, false)` vers `/?error=<code du refus>`.

Un `googleId` **connu** ne consulte jamais la porte : se reconnecter n'est pas s'inscrire.

## Les routes

`backend/src/api/invites.ts`, monté `app.use('/api/invites', requirePseudo, invitesRouter)` dans `bootstrap/app.ts` — un anonyme n'invite personne, et `requirePseudo` le refuse déjà.

| Route | Réponse |
|---|---|
| `GET /api/invites` | `{ quota, remaining, invites: [{ id, code, url, usedAt, inviteePseudo }] }` |
| `POST /api/invites` | l'invitation frappée, ou 403 `QUOTA_EXHAUSTED` / 503 `PLATFORM_FULL` |
| `DELETE /api/invites/:id` | 204 ; 409 si déjà consommée ; 404 si elle n'est pas à vous |

Et une route publique, sur `/auth` parce qu'elle précède toute session :

`GET /auth/invite/:code` → `{ ok: true }` ou le refus. **Limitée par IP** via `AttemptLimit`, chaque appel compté qu'il réussisse ou non — comme la porte anonyme, et pour la même raison : sans plafond, c'est un oracle d'énumération de codes gratuit.

## L'écran

Une section « Mes invitations » dans `/profile` : les places restantes, un bouton pour frapper un lien, chaque lien avec un bouton copier et un bouton révoquer, et le pseudonyme des filleuls arrivés.

---

# Chantier 2 — Le mot de passe

## Où vit l'adresse

**Pas dans `User`.** Table séparée `Credential`.

La migration `0004_pseudonymous_users.sql` a sorti `email` de `User` en argumentant longuement ; l'y remettre exposerait une adresse à chaque `SELECT *`, et le dépôt en fait un (`db/users.ts:SELECT`). Dans une table à part, `toSelf()` ne peut pas la fuiter par accident, `USER_COLUMNS` de `friendships.ts` ne peut pas l'emporter vers un ami, et un compte Google n'a simplement pas de ligne.

Migration `0007_password_accounts.sql` :

```sql
CREATE TABLE "Credential" (
  userId        TEXT PRIMARY KEY REFERENCES "User"(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  passwordHash  TEXT NOT NULL,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL
);
CREATE UNIQUE INDEX "Credential_email_key" ON "Credential" ("email" COLLATE NOCASE);

CREATE TABLE "PendingSignup" (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  inviteId    TEXT NOT NULL REFERENCES "SignupInvite"(id) ON DELETE CASCADE,
  tokenHash   TEXT NOT NULL UNIQUE,
  createdAt   INTEGER NOT NULL,
  expiresAt   INTEGER NOT NULL
);
CREATE INDEX "PendingSignup_inviteId_idx" ON "PendingSignup" ("inviteId");

CREATE TABLE "PasswordReset" (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  usedAt    INTEGER
);
CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset" ("userId");
```

`COLLATE NOCASE` sur l'index d'unicité, et **pas** sur la colonne : c'est la forme retenue par `0004` pour le handle, et elle rend `Alice@x.fr` et `alice@x.fr` un seul compte. Sans elle, deux comptes pour la même personne, et un « mot de passe oublié » qui atteint le mauvais.

L'adresse est stockée **telle que tapée**, la comparaison seule est insensible à la casse : c'est ce qui part dans le champ `To:`, et normaliser en minuscules casserait les rares serveurs à casse significative.

## Le hachage

**`Bun.password`, argon2id, zéro dépendance nouvelle.** Le backend démarre sous Bun (`bun dist/index.js`, `backend/package.json`) et `@types/bun` est déjà là. Paramètres par défaut de Bun ; le hash porte son propre préfixe, donc un changement de coût plus tard reste vérifiable sur les anciens.

`Bun.password.verify` est constant en temps par construction. Le chemin « adresse inconnue » doit malgré tout **coûter un hachage factice**, sinon la durée de réponse distingue un compte existant d'un compte absent.

Politique : **10 caractères minimum, aucune autre règle.** Pas de classe de caractères obligatoire — c'est la recommandation NIST, et une règle de composition produit surtout des `Password1!`.

## Les jetons

Ceux du chantier 2 sont **hachés en SHA-256** en base, contrairement au code d'invitation. Deux différences justifient le traitement différent : ils voyagent dans une boîte mail, et ils donnent un compte plutôt que le droit d'en créer un. Rien ne les réaffiche, donc rien n'empêche de les hacher.

SHA-256 nu et non argon2 : ce sont 128 bits d'aléa, pas un secret devinable ; l'étirement de clé n'y ajouterait qu'une latence.

| Jeton | Durée | Usage |
|---|---|---|
| confirmation d'inscription | 24 h | unique — la ligne `PendingSignup` disparaît |
| réinitialisation | 1 h | unique — `usedAt` |

Une demande de réinitialisation **invalide les précédentes** du même compte. Sinon un ancien lien, encore dans une boîte mail, reste une clé vivante.

## L'inscription, pas à pas

L'e-mail **est** la vérification : aucune ligne `User` non vérifiée n'existe jamais, donc aucun état « compte non confirmé » à porter dans le reste de l'application.

1. `/signup?invite=CODE` — le front interroge `GET /auth/invite/:code` et affiche le refus s'il y en a un.
2. `POST /auth/signup` `{ code, email, password }` — la porte est reconsultée côté serveur (le contrôle de l'étape 1 est un confort, pas une autorisation), le mot de passe est haché, une `PendingSignup` est écrite, le mail part.
3. **L'invitation est retenue.** Tant qu'une `PendingSignup` non expirée pointe une invitation, celle-ci répond `INVITE_HELD` — un lien partagé à deux personnes ne peut pas produire deux comptes. À l'expiration, la place revient d'elle-même : la retenue est l'absence de ligne expirée, pas une colonne à nettoyer.
4. `GET /auth/signup/confirm?token=…` — crée `User` (`pseudoChosenAt = null`) et `Credential`, marque l'invitation consommée avec `inviteeId`, supprime la `PendingSignup`, `req.login`, redirige vers `FRONTEND_URL`.

Les quatre écritures de l'étape 4 se font **dans une seule transaction SQLite**. Le plafond et la porte sont revérifiés à l'intérieur : 24 h ont pu passer, la centième place a pu partir.

Le joueur atterrit sur le portique de pseudonyme existant. Rien de neuf à écrire de ce côté.

## La connexion et la récupération

`POST /auth/login` `{ email, password }` — `AttemptLimit` par IP **et** par adresse, les deux comptés sur échec. Session régénérée avant `req.login`, comme le fait `/auth/anonymous` (un champ posé avant `req.login` est perdu sans un bruit).

`POST /auth/forgot` `{ email }` — **répond toujours 200, avec le même corps**, adresse connue ou non. Une réponse différenciée est un test d'existence de compte gratuit. Limité par IP.

`POST /auth/reset` `{ token, password }` — vérifie le hash du jeton, la fraîcheur, le non-usage ; réécrit `passwordHash`, marque `usedAt`, **détruit toutes les sessions du compte** puis connecte. Détruire les sessions est le point : « mot de passe oublié » est aussi ce qu'on fait quand on pense être compromis.

Un compte Google n'a pas de `Credential`, donc `POST /auth/forgot` ne trouve rien pour lui — et répond 200 comme pour tout le monde. Sa récupération, c'est Google.

## Le mailer

`backend/src/services/mailer.ts`. **`nodemailer` est la seule dépendance nouvelle de toute la spec.**

Configuration : `SMTP_URL` (une URL unique, `smtps://user:pass@host:465`, pour que changer de fournisseur ne touche pas au code) et `MAIL_FROM`.

**Si `SMTP_URL` est absent, le mailer écrit le lien dans le log au lieu d'envoyer.** Ce n'est pas un repli de confort : c'est ce qui rend les deux parcours testables de bout en bout sans identifiants, et le mode dev utilisable hors ligne. `env-guard.ts` exige `SMTP_URL` en production, à côté de `SESSION_SECRET`.

Deux messages, en texte brut et en français, chacun avec son lien et sa durée de validité. Pas de gabarit HTML : un lien de récupération de compte n'a pas besoin d'être joli, et un mail texte passe mieux les filtres.

---

# Ce qui change côté front

Trois routes nouvelles. **Chacune doit être ajoutée à `entries` dans `frontend/svelte.config.js`** (`entries: ['/', '/profile', '/docs']` aujourd'hui) : `prerender = true` est global, et une route absente de la liste fait échouer le build de production, pas les tests.

| Route | Contenu |
|---|---|
| `/signup?invite=CODE` | validation du code, puis e-mail + mot de passe, puis « regardez votre boîte mail » |
| `/login` | connexion, avec « mot de passe oublié » **dépliant dans la même page** |
| `/reset?token=…` | le jeton en query et non en segment dynamique, pour que la page reste prérendable |

`/` garde le bouton Google et gagne un lien discret vers `/login`. `+page.svelte` fait déjà 1477 lignes ; les formulaires vont dans leurs propres routes et composants, pas là.

`/profile` gagne la section « Mes invitations ».

`GET /auth/mode` gagne un champ : `{ mode, anonymousJoin, passwordAuth }`. Le front affiche la porte à mot de passe si et seulement si le serveur l'annonce — il ne la devine pas depuis `mode`.

Toutes les chaînes en `en` **et** `fr` : `core/test/i18n-parity.test.ts` échoue sinon.

---

# Les tests

`test:backend` tourne sur un glob (`backend/test/*.test.ts`) : aucun fichier à énumérer, contrairement à `test:ui`.

| Fichier | Ce qu'il tient |
|---|---|
| `signup-door.test.ts` | la fonction pure, chaque refus et leur ordre |
| `credentials-door.test.ts` | `passwordAuthEnabled` par défaut et coupé par `PASSWORD_AUTH=off`, et le refus de la porte quand elle est fermée |
| `invites.test.ts` | 2 à vie, liens vivants comptés, révocation qui rend la place, `grantedByCli` hors quota, plafond 100, anonymes non comptés |
| `credentials.test.ts` | argon2id, unicité NOCASE, connexion, coût constant sur adresse inconnue |
| `pending-signup.test.ts` | l'invitation retenue puis rendue à l'expiration, la transaction de confirmation |
| `password-reset.test.ts` | jeton haché, 1 h, usage unique, invalidation des précédents, sessions détruites, pas d'oracle sur `/forgot` |

`migrate.test.ts` couvre les deux migrations nouvelles en rejouant les vrais fichiers.

# Ce que cette spec ne fait pas

- **Un compte Google ne peut pas ajouter de mot de passe**, ni l'inverse. Une méthode par compte. Lier les deux demande un écran de rattachement et une vérification de propriété d'adresse ; ce sera un chantier à part si le besoin se présente.
- **Pas de changement de mot de passe depuis le profil.** Le parcours « oublié » le couvre, et l'ajouter demande une page de plus pour un besoin que personne n'a exprimé.
- **Pas d'invitation par e-mail** : le lien se partage à la main. Décision prise en conception — la plateforme n'a alors aucune adresse de non-inscrit à stocker.
- **Pas d'expiration des liens d'invitation.**
- **Pas d'écran d'administration.** Le CLI, en ssh.

# Le déploiement

Dans l'ordre :

1. `SMTP_URL`, `MAIL_FROM` et `MAX_USERS` dans le `.env` de production **avant** le déploiement — `env-guard.ts` refuse de démarrer sans les deux premiers.
2. Les migrations `0006` et `0007` passent par le service `db-migration` habituel.
3. Aucun `VACUUM` requis : ces migrations n'effacent aucune colonne. En revanche, la base contient désormais des adresses e-mail — le jour où un compte est supprimé, le raisonnement de `0004` redevient d'actualité.
