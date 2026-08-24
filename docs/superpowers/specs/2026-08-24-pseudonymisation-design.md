# Sortir les données personnelles du jeu

Conception. Un joueur n'est plus un nom et une adresse email venus de Google, mais un pseudonyme qu'il choisit et un code qu'il donne à qui il veut. On ne peut plus chercher quelqu'un : on entre son code.

## Pourquoi

L'application stocke aujourd'hui, pour chaque joueur, le nom civil et l'adresse email de son compte Google — récupérés à l'inscription (`auth/passport.ts:47`) et rafraîchis à chaque connexion (`auth/passport.ts:53`). Aucune fonctionnalité n'en a besoin. L'email ne sert qu'à un endroit, `findUserByEmail`, pour l'ajout d'ami ; le nom ne sert qu'à l'affichage.

Ces deux données ne dorment pas tranquillement dans une table. Quatre chemins les diffusent :

1. **La recherche d'utilisateurs.** `GET /api/friends/search` fait un `LIKE '%' || ? || '%'` sur **l'email et le nom** (`db/users.ts:123`). Deux caractères suffisent à interroger l'annuaire, et la liste de résultats affiche l'email en clair (`FriendsList.svelte:361`). N'importe quel compte peut énumérer tous les autres.
2. **La liste d'amis.** `db/friendships.ts:USER_COLUMNS` sélectionne les huit colonnes de `User`, et `api/friends.ts:31` repasse l'objet tel quel. Chaque ami reçoit donc `googleId`, `email` **et** `controlsConfig`. Le commentaire de `services/friends.ts:85` montre que le risque était identifié — la liste de champs y est explicite *exprès* — mais la route REST voisine n'a jamais reçu le même traitement.
3. **`/auth/me`.** `res.json(req.user)` (`api/auth.ts:93`) sérialise la ligne entière : `googleId` et `controlsConfig` partent au navigateur à chaque chargement de page.
4. **Les journaux.** `websocket/index.ts:92` écrit `{ user: displayName, email }` à chaque connexion, et `api/logs.ts:47` place le nom civil dans le champ ECS `user.name` de chaque ligne expédiée par le client.

Le nom Google est par ailleurs un mauvais identifiant : il n'est pas unique, il n'est pas choisi, et il est souvent le nom civil.

## Ce qu'on garde

**Un pseudonyme et un discriminant. Rien d'autre d'humainement identifiant.**

| Donnée | Sort |
|---|---|
| `email` | colonne supprimée ; le scope OAuth est retiré, Google ne nous l'envoie plus |
| `displayName` | colonne supprimée ; remplacée par `pseudo`, choisi par le joueur |
| `avatar` | **conservé** — décision du propriétaire |
| `googleId` | conservé en base, ne sort plus jamais du serveur |
| `controlsConfig` | conservé, ne sort plus vers les autres joueurs |

L'avatar Google reste. C'est un arbitrage explicite : c'est une donnée personnelle, mais elle porte l'essentiel de la reconnaissance visuelle dans la liste d'amis et le salon, et l'alternative — une image générée — a été écartée. Le nom de fichier, en revanche, change (voir « L'empreinte du compte Google »).

## L'identifiant : `Pseudo#1234`

Décision du propriétaire, parmi trois formes pesées : un code opaque de 8 caractères permanent, le même régénérable, ou le discriminant de type Discord. La troisième est retenue.

**Une seule chose à retenir et à donner.** Le pseudo est ce qui s'affiche partout ; le handle complet `Sprite#0417` est ce qu'on copie-colle pour se faire ajouter. Il n'y a pas deux identités à gérer.

Deux conséquences ont été signalées avant le choix et sont assumées :

- **Le pseudo seul n'est pas unique.** Deux joueurs peuvent s'appeler `Mario`. Seul le couple l'est. Une liste d'amis peut donc contenir deux entrées de même nom, distinguées par l'avatar.
- **10 000 discriminants par pseudo, c'est énumérable.** Qui connaît un pseudo peut balayer l'espace. D'où la limitation de débit décrite plus bas — elle n'est pas une précaution générique, elle est la contrepartie directe de ce format.

Le pseudo est **modifiable librement** depuis le profil (décision du propriétaire, contre une limitation à un changement par mois). Un changement réattribue un discriminant : le handle publié auparavant devient caduc. Les amitiés existantes ne bougent pas — elles pointent l'identifiant interne.

### La règle

```
^[A-Za-z0-9_-]{3,16}$
```

L'ASCII strict est porteur, pas frileux. `COLLATE NOCASE` de SQLite ne replie **que** `A-Z` : autoriser `É` ferait cohabiter `é#0417` et `É#0417` dans l'index d'unicité, qui cesserait alors de garantir ce que cette conception affirme. Le jeu de caractères et la collation doivent s'accorder ou l'unicité est une fiction. Bénéfice secondaire : pas d'usurpation par homoglyphe (le `а` cyrillique face au `a` latin).

Le discriminant est quatre chiffres, `0000` à `9999`.

## Le schéma

Migration `backend/migrations/0004_pseudonymous_users.sql`.

```sql
ALTER TABLE "User" ADD COLUMN "pseudo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "discriminator" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "pseudoChosenAt" DATETIME DEFAULT NULL;

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

CREATE UNIQUE INDEX "User_pseudo_discriminator_key"
  ON "User" ("pseudo" COLLATE NOCASE, "discriminator");

DROP INDEX "User_email_key";
ALTER TABLE "User" DROP COLUMN "email";
ALTER TABLE "User" DROP COLUMN "displayName";
```

**Correction du 2026-08-24, trouvée en implémentant.** Ce bloc n'avait pas le `DROP INDEX`, et la section affirmait qu'aucune des deux colonnes n'était indexée. C'est faux : `email` porte `User_email_key` depuis la baseline (`0001_baseline.sql:83`), et SQLite refuse de supprimer une colonne dont dépend un index — la migration échouait sur `error in index User_email_key after drop column`. La sonde manuelle qui avait « validé » la séquence utilisait une table écrite à la main sans cet index ; c'est `backend/test/pseudonymise.test.ts`, qui applique les **vrais fichiers**, qui l'a trouvé. La leçon vaut d'être gardée : une vérification sur une approximation du schéma ne vérifie pas le schéma.

Vérifié en exécutant la séquence complète sur 40 comptes fictifs avant d'écrire cette section : 40 handles distincts, colonnes disparues, et `sprite#0001` rejeté face à `Sprite#0001` en `SQLITE_CONSTRAINT_UNIQUE`. SQLite 3.53 (better-sqlite3 12.9) accepte `DROP COLUMN` sans reconstruction de table, donc rien ici ne tombe sous le refus de `migrate.ts:assertNoPragma`.

### Pourquoi tout le monde est rempli dès la migration

Le premier jet marquait « n'a pas encore choisi » par `pseudo IS NULL`. C'est plus économe et c'est faux : la page de création de salon liste les pseudos des amis, comme `FriendsList`, `RoomPlayers` et le panneau d'invitation de `room/[id]`. Tout compte pas encore reconnecté s'y afficherait vide, et un libellé de repli commun donnerait dix amis nommés « Joueur inconnu ».

Donc `pseudo` et `discriminator` sont `NOT NULL` et remplis pour tout le monde, et le marqueur passe dans `pseudoChosenAt` : `NULL` = attribué d'office, la modale s'ouvre ; renseigné = choisi par le joueur. Un horodatage plutôt qu'un booléen, comme `abandonedAt` et `sramUpdatedAt` ailleurs dans ce schéma.

**Aucun écran n'a donc de cas « pas de pseudo » à traiter** : pas de `?? ''`, pas de `string | null` qui se propage dans les payloads WebSocket, et l'index d'unicité est total plutôt que partiel.

Le `DEFAULT ''` des deux colonnes n'est pas un choix de valeur : SQLite exige un défaut non-`NULL` sur un `ADD COLUMN NOT NULL`. L'`UPDATE` qui suit, dans la même transaction, ne laisse aucune ligne à `''`. Ces instructions ne sont pas séparables.

L'attribution est **déterministe** (`ROW_NUMBER() OVER (ORDER BY createdAt, id)`) : `n % 16` donne le mot, `n / 16 + 1` le discriminant. Aucune collision possible par construction, donc aucune boucle de retry à écrire — ce qu'un fichier `.sql` ne permettrait pas.

Le vocabulaire est technique et non des noms de personnages : personne ne se dispute `Scanline`, ces mots ne squattent pas les pseudos que les joueurs voudront prendre, aucun risque de marque, et ils se lisent comme « attribué automatiquement, à changer ».

## L'onboarding forcé

Décision du propriétaire, contre une redirection vers `/welcome` et contre un pseudo aléatoire sans blocage.

### L'autorité est le serveur

Une modale non fermable est une affirmation du DOM ; elle se contourne avec `curl` et une session valide. La règle vit dans `middleware/auth.ts` :

```ts
export function requirePseudo(req, res, next) {
  const user = req.user as User | undefined;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!user.pseudoChosenAt) return res.status(409).json({ error: 'PSEUDO_REQUIRED' });
  next();
}
```

**409 et non 403** : 403 dirait « tu n'as pas le droit », ce qui est faux — le compte a tous les droits, il lui manque un préalable. 409 dit « l'état de la ressource empêche la requête », et ce code est déjà utilisé par `Friendship already exists`. Le client distingue les cas sur le champ `error`, pas sur le statut.

### Montée au point de montage

Dans `index.ts`, pas dans chaque routeur :

```ts
app.use('/auth', authRouter);
app.use('/api/pseudo', pseudoRouter);                    // la seule porte ouverte
app.use('/api/avatars', avatarsRouter);                  // la modale affiche l'avatar
app.use('/api/games', requirePseudo, gamesRouter);
app.use('/api/friends', requirePseudo, friendsRouter);
app.use('/api/rooms', requirePseudo, roomsRouter);
app.use('/api/user', requirePseudo, userRouter);
app.use('/api/metadata', requirePseudo, metadataRouter);
app.use('/api/covers', requirePseudo, coversRouter);
app.use('/api/logs', requirePseudo, logsRouter);
```

La politique complète tient sur un écran, et ajouter un routeur **oblige à trancher** : on ne peut pas monter une route sans écrire ou omettre `requirePseudo` sous les yeux des huit autres lignes. Éparpillée dans les routeurs, la règle serait invisible au moment où on l'oublie.

`/api/pseudo` est un routeur neuf plutôt qu'une route de `userRouter`, précisément pour que `/api/user` puisse être barré en entier ; sinon la politique se scinde entre une exception au montage et une exception interne.

### Le point d'entrée

`PUT /api/pseudo`, corps `{ pseudo }`, réponse `{ pseudo, discriminator }`.

**Une seule route pour la première saisie et pour le changement ultérieur** : l'opération est identique — valider, allouer un discriminant, écrire, horodater `pseudoChosenAt`. Deux endpoints identiques divergeraient tôt ou tard sur la validation.

Erreurs : `400 PSEUDO_INVALID`, `409 PSEUDO_FULL` (les 10 000 discriminants de ce pseudo sont pris).

### Le WebSocket refuse aussi

`handleConnection` charge déjà l'utilisateur en base — le socket ne passe pas par `deserializeUser`. Il gagne le même verdict :

```ts
if (!user.pseudoChosenAt) {
  socket.emit('auth:pseudoRequired');
  socket.disconnect();
  return;
}
```

L'`emit` avant le `disconnect` n'est pas décoratif : sans lui socket.io reconnecte en boucle sans que le client sache pourquoi. Et sans ce verrou, un compte sans pseudo garde une présence, une place possible dans un salon et les événements `friend:*` pendant que la modale s'affiche.

Côté client, `+layout.svelte` n'initialise plus le socket sur `$user` seul mais sur `$user && !$user.needsPseudo` : on n'ouvre pas une connexion dont on sait qu'elle sera refusée.

### La modale

`PseudoGate.svelte`, monté dans `+layout.svelte` à côté de `NotificationToast`, affiché quand `$user?.needsPseudo`.

L'inertie du reste de la page passe par l'attribut natif **`inert`** sur le conteneur `.app`, pas par un piège à focus maison : `inert` retire le sous-arbre du parcours de tabulation, du pointeur et de l'arbre d'accessibilité en une ligne, là où un piège manuel se fait contourner par le premier `autofocus` oublié.

**Le lien profond survit** : c'est une surcouche, pas une redirection. Qui ouvre `/room/abc123` reçu par message garde cette URL derrière la modale, et la page est déjà là quand il valide. C'est l'argument qui a fait écarter `/welcome`, il est donc vérifié par un test end-to-end et non supposé.

## L'ajout d'ami

### Ce qui disparaît

| Où | Quoi |
|---|---|
| `api/friends.ts` | la route `GET /search` entière |
| `db/users.ts` | `searchUsers()` et `findUserByEmail()` |
| `FriendsList.svelte` | l'input, le dropdown, `searchUsers`, `handleSearchInput`, `selectUser`, `closeDropdown`, le debounce, le spinner, et les états `searchResults` / `showDropdown` / `isSearching` / `friendEmail` |
| `translations.ts` | `searchFriends`, `friendEmail` |

Supprimées, pas dépréciées : une fonction `searchUsers` laissée en place se fera rappeler.

### Le nouveau corps

`POST /api/friends/request` prenait `{ friendEmail }` **ou** `{ friendId }`. Il prend `{ handle }` — une seule chaîne, `"Sprite#0417"`, celle qu'on copie-colle.

**`friendId` disparaît aussi.** Un identifiant interne est un UUID non devinable, donc le garder semble inoffensif — sauf qu'il n'est pas secret : `RoomPlayer.userId` circule dans tous les payloads de salon. Ce chemin permettrait d'ajouter en ami n'importe qui croisé dans une partie sans connaître son code, ce qui viderait la règle de son sens. Son unique appelant, `selectUser(user.id)`, disparaît avec la recherche.

`lobby:invite` continue d'utiliser `friendId` : inviter dans un salon quelqu'un qui est **déjà** ami est un autre chemin, il n'ouvre rien.

Le parsing vit dans `utils/pseudo.ts` avec la regex. `parseHandle("Sprite#0417")` découpe sur le **dernier** `#`, valide la partie gauche contre la regex et la droite contre `^\d{4}$` — donc `a#b#0001` est rejeté, le pseudo ne pouvant pas contenir de `#`. Un seul point d'analyse, donc un seul endroit où le format peut être mal compris.

Réponses : `400 HANDLE_MALFORMED`, `404 HANDLE_NOT_FOUND`.

**Le 404 est volontairement indistinct** : `Sprite#9999` inexistant et `Inexistant#0001` inexistant donnent la même réponse. Sans cela l'API répond à « ce pseudo existe-t-il ? », c'est-à-dire exactement ce qu'on vient de retirer avec la recherche.

### La limitation de débit

Contrepartie du format `Pseudo#1234`. `backend/src/utils/attempt-limit.ts` compte, **par utilisateur authentifié, les seuls échecs** (404) : 20 par heure glissante, au-delà `429 TOO_MANY_ATTEMPTS` jusqu'à la fin de la fenêtre.

Ne compter que les échecs rend le seuil vivable : qui tape un code reçu par message tombe juste, et 20 fautes de frappe par heure ne gênent personne. L'énumération ne produit que des échecs — 20 essais par heure sur 10 000, soit 500 heures pour un seul pseudo.

Compteur par utilisateur et non par IP : atteindre l'endpoint exige déjà une session Google, donc un compte à brûler ; une IP se change.

Le minuteur de purge porte un `unref()`, pour la raison déjà écrite dans `utils/cache.ts` : sans lui, tout test important transitivement le module ne rendrait jamais la main.

**Limite connue** : le compteur est en mémoire. Il repart à zéro à chaque déploiement et ne serait pas partagé entre plusieurs répliques. `docker-compose` n'en lance qu'une, donc c'est exact aujourd'hui — mais c'est une propriété du déploiement, pas du code.

### Le code dans le profil

`profile/+page.svelte:185` affiche aujourd'hui l'email. Cette ligne devient le handle assorti d'un bouton copier — le code prend littéralement la place de la donnée personnelle qu'il remplace. Le champ pseudo éditable s'installe au-dessus et tape sur le même `PUT /api/pseudo` que la modale.

## Les fuites résiduelles

### Une seule projection publique

`USER_COLUMNS` ne sélectionne plus que `id`, `pseudo`, `discriminator`, `avatar`, et `toUserFrom` retourne un `PublicUser`. Les appelants ne peuvent plus divulguer ce qu'ils n'ont jamais reçu : la propriété tient par typage, pas par vigilance.

`UserSummary` est **renommé** `PublicUser` et promu — il ne sert plus la recherche disparue mais les trois chemins qui exposent autrui (liste d'amis, demandes en attente, amis en ligne) :

```ts
/** Tout ce qu'un joueur a le droit d'apprendre d'un autre. Rien de plus. */
export interface PublicUser {
  id: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
}
```

### `/auth/me`

`res.json(req.user)` est remplacé par `toSelf(user)` :

```ts
{ id, pseudo, discriminator, avatar, needsPseudo: user.pseudoChosenAt === null }
```

`needsPseudo` est calculé côté serveur plutôt que d'envoyer `pseudoChosenAt` brut : le client n'a besoin que du verdict, et un booléen ne peut pas être mal interprété. L'interface `User` de `frontend/src/lib/stores/user.ts` s'aligne et perd `googleId` et `email`.

### Les journaux

L'email disparaît de `websocket/index.ts:92`. Le `displayName` y devient le pseudo, ainsi que dans `api/logs.ts:47` (champ ECS `user.name`) et dans la dizaine de `user: user.displayName` des handlers WebSocket. Un pseudonyme est journalisable sans réserve et garde les journaux lisibles.

### L'empreinte du compte Google

`utils/avatar.ts:52` nomme le fichier `md5(googleId).jpg`, et cette URL est servie à tous les amis. Ce n'est pas l'identifiant Google en clair, mais c'est une **empreinte stable** : qui connaît ce Google ID par ailleurs peut confirmer que le compte est le même. C'est le recoupement que ce travail cherche à supprimer.

Correctif : hacher `user.id`, un UUID interne qui n'existe nulle part ailleurs. Cela impose de réordonner `auth/passport.ts`, où l'avatar est aujourd'hui téléchargé **avant** la création du compte : le nouveau flux crée l'utilisateur avec `avatar: null`, télécharge, puis appelle `updateUserAvatar`. Une écriture supplémentaire, une fois, à l'inscription.

Les anciens fichiers deviennent orphelins au fil des reconnexions. Une migration `.sql` ne peut pas toucher au disque, d'où `scripts/prune-orphan-avatars.mjs` : supprime tout fichier de `backend/avatars` qu'aucune ligne `User.avatar` ne référence. Idempotent, relançable, à passer quelques semaines après le déploiement.

### Ce que `DROP COLUMN` n'efface pas

**`ALTER TABLE ... DROP COLUMN` réécrit les lignes, mais les octets d'origine peuvent subsister dans les pages libérées** du fichier `.db` jusqu'à un `VACUUM`. Après la migration, la base contient encore les emails — simplement plus adressables en SQL.

`VACUUM` ne s'exécute pas dans une transaction, et `migrate()` enveloppe chaque migration dans `db.transaction()`. Ce n'est donc pas dans le `.sql` : c'est une **étape obligatoire du runbook**, à la main, après le déploiement. Voir « Déploiement ».

### Ce qui n'est pas touché

Le store de session Redis ne contient que `passport.user`, l'identifiant interne. `googleId` reste en base : c'est la clé de rattachement OAuth, sans elle personne ne se reconnecte ; il ne sort simplement plus du serveur.

## L'inscription

Le scope OAuth passe de `['profile', 'email']` à `['profile']` (`api/auth.ts:21`). Google cesse de nous transmettre l'email : plus rien à supprimer, plus rien à fuir par accident. Le garde `if (!email) return done(new Error(...))` disparaît, et `auth/passport.ts` ne lit plus que `profile.id` et `profile.photos[0]`. `profile.displayName` — le nom civil — n'est plus jamais touché.

`createUser` ne peut plus produire de ligne sans pseudo : une inscription reçoit un handle automatique tiré de la même liste de mots via `allocateDiscriminator`, et `pseudoChosenAt` à `NULL` — donc la modale à la première page. Là, contrairement au `.sql`, deux inscriptions simultanées peuvent viser le même slot : d'où un retry à 3 tentatives sur `SQLITE_CONSTRAINT_UNIQUE`. L'index reste l'arbitre ; un garde applicatif seul finirait par être contourné.

`allocateDiscriminator` **prend son générateur aléatoire en paramètre**. C'est une contrainte de testabilité qui améliore le code : sans injection, le chemin de retry ne serait vérifiable que par chance.

Les comptes de développement sont volontairement asymétriques : `dev-user-1` et `dev-user-2` ont un `pseudoChosenAt` renseigné, **`dev-user-3`** non. Les deux chemins — session normale et porte d'onboarding — sont ainsi à un clic l'un de l'autre, sans bricoler la base.

**Correction du 2026-08-24, trouvée en exécutant.** Cette section prévoyait de laisser `dev-user-2` sans pseudo. Deux choses l'interdisent, découvertes en faisant tourner l'application et non en la relisant :

1. **Tous les tests e2e à deux joueurs ouvrent un socket avec `dev-user-2`**, et le serveur refuse désormais le socket d'un compte sans pseudo choisi. `dev-user-2` doit donc être passé la porte. D'où un **troisième** compte, dédié.
2. **`upsertDevUser` ne rafraîchissait que l'avatar** en cas de conflit — fidèle à l'upsert Prisma qu'il remplaçait. Or la migration met `pseudoChosenAt` à `NULL` sur **toutes** les lignes existantes : après l'avoir appliquée à la base de développement, les deux comptes de dev se sont retrouvés bloqués devant la modale, et rien ne pouvait les en sortir. Symétriquement, un pseudo réclamé une fois par le compte de test aurait survécu, rendant la porte testable exactement une fois par base.

`upsertDevUser` **impose** donc maintenant l'état déclaré — pseudo, discriminant, `pseudoChosenAt` — à chaque connexion. Un compte de dev est un fixture, pas un joueur : être dans un état connu est sa raison d'être. `controlsConfig` reste épargné, parce qu'un mappage de touches posé pendant un test mérite de survivre à une reconnexion et ne fait pas partie de l'identité affirmée ici.

## La duplication de la regex

La regex existera **deux fois** : `backend/src/utils/pseudo.ts` et `frontend/src/lib/pseudo.ts`. Il n'y a pas de module partagé — `core/` est le cœur wasm, et le contexte de build du frontend est épinglé côté infrastructure, donc un import croisé casserait l'image Docker.

Le backend est l'**unique** autorité ; la copie frontend ne sert qu'au retour immédiat. Mais la duplication ne peut pas diverger en silence : les tests s'exécutent depuis la racine du dépôt et `core/test/profile.test.ts` importe déjà `../../frontend/src/lib/...`. Un même test importe donc les deux copies et exige un verdict identique sur une table d'entrées. La séparation des contextes Docker concerne la construction des images, pas l'exécution des tests.

## Tests

### Le backfill ne s'exécute qu'une fois, en production, sur des données réelles

`helpers.ts:migratedDb()` part d'une base **vide** : l'`UPDATE` de backfill y toucherait zéro ligne, et la suite passerait sans jamais l'exécuter.

`backend/test/pseudonymise.test.ts` construit donc le chemin réel : un répertoire temporaire contenant `0001`→`0003` **lus depuis les vrais fichiers**, `migrate()`, insertion de 40 comptes avec emails et noms, puis `0004` déposé dans le même répertoire et `migrate()` à nouveau.

Il vérifie que les 40 lignes ont un pseudo non vide et un discriminant de 4 chiffres ; que `COUNT(DISTINCT pseudo || '#' || discriminator)` vaut 40 ; que `pseudoChosenAt` est `NULL` partout ; que `table_info("User")` ne porte plus ni `email` ni `displayName` ; qu'au-delà de 16 comptes le discriminant passe à `0002` — ce qui teste `n / 16 + 1`, l'expression la plus facile à écrire à un près ; que deux exécutions sur la même entrée donnent la même attribution ; et que l'index rejette `sprite#0001` face à `Sprite#0001`.

### L'ensemble exact des clés

Pour les projections, l'assertion porte sur l'ensemble **exact** des clés :

```ts
assert.deepEqual(Object.keys(friend).sort(), ['avatar', 'discriminator', 'id', 'pseudo']);
```

Le mode de défaillance redouté n'est pas un champ manquant mais un champ **en trop** — un `SELECT *` réintroduit dans six mois, un spread qui remplace la liste explicite. Une assertion champ par champ laisserait passer exactement cela. Appliquée à `listAcceptedFriendshipsWithProfiles`, `listPendingRequestsFor`, `getOnlineFriends` et `toSelf`, c'est le test qui empêche la fuite de revenir — et le commentaire de `services/friends.ts` prouve qu'elle sait revenir.

### Le reste

- **`utils/pseudo.ts`** : la regex sur ses limites (2 et 17 caractères, `Émile`, espace) ; `parseHandle` qui rejette `a#b#0001`, les discriminants à 3 et 5 chiffres, et la chaîne sans `#`.
- **`allocateDiscriminator`** : avec 9 999 slots pris, retourne le seul libre ; avec 10 000, lève `PSEUDO_FULL` ; le retry est vérifié en injectant un générateur qui renvoie d'abord un slot occupé.
- **`requirePseudo`** : fonction pure de `req.user`, testée avec un faux `req`/`res` sans serveur HTTP.
- **`attempt-limit.ts`** : **horloge injectée**, comme `fakeStorage` dans `core/test/profile.test.ts`. 20 échecs passent, le 21ᵉ donne 429, et après la fenêtre le compteur repart. Sans horloge injectable ce test serait une attente d'une heure, c'est-à-dire pas un test.
- **`e2e/pseudo-gate.spec.ts`** : ce que seul un navigateur prouve — `dev-user-3` voit la modale et ne peut ni cliquer ni tabuler ailleurs (attribut `inert`), `/room/abc` reste l'URL derrière la modale puis s'affiche après validation, et l'ajout d'ami ne passe que par le handle.

**Deux dégâts collatéraux sur la suite e2e existante, corrigés :**

`e2e/helpers.ts:befriendDevUsers` liait les deux comptes par `friendId`, chemin supprimé — il passe au handle, comme un vrai joueur. Et `clearFriendships` ne supprimait que les amitiés **acceptées** : une demande envoyée et jamais répondue survivait, le `befriendDevUsers` suivant recevait « Friendship already exists », n'obtenait pas d'identifiant, et laissait silencieusement les deux comptes non-amis — l'échec ressortant alors dans un tout autre test. Il nettoie maintenant les deux états, des deux côtés. Fragilité préexistante, révélée par ce travail.

**Un test qui échouait déjà sur `main`, réparé :** `e2e/app.spec.ts` attendait le titre de la salle d'un ami et un bouton `Join` sur la page d'accueil. Vérifié sur `a311107`, avant que ce travail commence : le tiroir « Friends » est fermé par défaut et rien ne rend la salle d'un ami en dehors ; le bouton `Join`, lui, n'existe nulle part dans le frontend. Le remaniement du profil et de la barre supérieure l'avait laissé derrière lui. Le test ouvre désormais le tiroir et n'exige plus une affordance disparue.

### Le dommage collatéral

`helpers.ts:insertUser` insère `email` et `displayName` et sert toute la suite backend — `friendships.test.ts`, `games.test.ts`, `saves.test.ts`, `presence.test.ts`, `metadata-contrib.test.ts`. Sa signature change, donc **la suite entière cesse de compiler** tant qu'il n'est pas mis à jour. C'est mécanique mais volumineux, et `users.test.ts` est à réécrire : il teste `findUserByEmail`, `searchUsers` et `updateUserProfile`, trois fonctions qui n'existeront plus. C'est une étape du plan, pas un imprévu.

### Hors périmètre

La mise en page de la modale — ce dépôt ne teste pas le CSS, `core/test/profile.test.ts` dit pourquoi. L'aller-retour OAuth réel. Le `VACUUM`, commande manuelle et non du code.

## Déploiement

Fusionner sur `main` déclenche le déploiement ; le dépôt d'infrastructure privé applique les migrations.

Deux étapes **manuelles et obligatoires** après le déploiement :

1. **`VACUUM`** sur `prod.db`, suivi d'un checkpoint WAL tronquant. Sans elle, les emails restent dans les pages libérées du fichier : le travail est à moitié fait.
2. **Les sauvegardes.** Toute copie de `prod.db` antérieure au déploiement contient les emails et les noms Google. La suppression n'est réellement achevée que quand ces sauvegardes ont expiré. Cela ne se code pas : cela se décide, et la décision appartient au propriétaire.

Une troisième, différée de quelques semaines : `scripts/prune-orphan-avatars.mjs`, une fois que chacun s'est reconnecté et que son avatar a été réécrit sous son nouveau nom.

## Ce que cette conception ne fait pas

- **Pas de bouton « ajouter ce joueur » depuis un salon.** Ce serait commode et cela rouvrirait exactement le contournement pour lequel `friendId` est retiré.
- **Pas de suppression de compte.** Elle n'existe pas aujourd'hui ; l'ajouter ici mélangerait deux sujets.
- **Pas de modération des pseudos.** La regex interdit l'usurpation par homoglyphe ; elle n'interdit pas la grossièreté. À l'échelle d'un cercle d'amis, une file de modération coûterait plus qu'elle ne rapporterait.
- **Pas de délai entre deux changements de pseudo.** Écarté explicitement au profit du changement libre.
