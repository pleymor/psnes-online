# Compléter le catalogue à plusieurs

Conception. Un joueur dont la ROM n'est reconnue par rien peut la rattacher à une entrée du catalogue, ou en créer une — et la correction sert à tout le monde, y compris à ceux qui ont la même ROM depuis un mois.

## Pourquoi

Le catalogue vient d'un fichier. `backend/metadata/snes-metadata.json` porte 94 entrées, chargées au démarrage (`services/metadata-loader.ts:74`), et un jeu dont le titre ne tombe pas dans l'appariement approximatif de `normalizeTitle` n'a ni genre, ni éditeur, ni description, ni jaquette. Le joueur voit un nom de fichier et un émoji manette.

Ce qui bloque n'est pas la donnée, c'est le chemin pour l'apporter. La seule façon d'ajouter une entrée aujourd'hui est de modifier un fichier dans l'image et de redéployer, ce qui n'est ouvert qu'à une personne. Or celui qui sait de quel jeu il s'agit, c'est celui qui a la cartouche sous les yeux.

Trois obstacles concrets, trouvés en lisant le code plutôt qu'en supposant :

1. **Le catalogue s'écrase lui-même à chaque démarrage.** `refreshGameMetadata` fait un `DELETE` sans clause (`metadata-loader.ts:223`) puis réinsère le JSON.

   **Correction du 2026-08-23, en cours d'implémentation : cette phrase disait « au premier refresh », ce qui sous-estimait la portée.** `refreshGameMetadata` est appelé inconditionnellement au démarrage (`index.ts:278`) — vérifié dans les journaux d'un backend lancé à la main. Ce n'est donc pas une action d'administration occasionnelle : sans la clause `WHERE source = 'catalogue'`, **tout redémarrage du backend effacerait l'intégralité des contributions**, y compris un simple redéploiement. Le correctif est sur le chemin le plus fréquent qui existe, pas sur un cas limite.
2. **Le catalogue n'a aucun checksum.** Vérifié dans le JSON : pas un seul `crc32`, pas un seul `md5`. `findGameMetadataByChecksum` ne trouve donc jamais rien, et l'appariement se fait en pratique par titre — `api/games.ts:71` essaie le checksum d'abord et retombe toujours sur le titre. De plus `GameMetadata.crc32` est **une** colonne, quand un même jeu a autant de dumps que de régions.
3. **Rien ne relie `Game` à `GameMetadata`.** `api/games.ts:73` **recopie** les champs dans la ligne `Game` à la création. Il n'existe aucun moyen de savoir qu'une ROM n'est pas identifiée, et une correction arrivée après coup ne touche personne.

## Le modèle de confiance

**Immédiat, attribué, réversible.** Décision du propriétaire. Une contribution s'applique tout de suite pour tout le monde ; chaque entrée et chaque liaison garde son auteur et sa date ; les lignes communautaires sont distinguées de celles du catalogue, donc corrigeables sans toucher au JSON.

Pas de file de modération : l'échelle est celle d'un cercle d'amis, et une contribution qui n'a pas d'effet visible n'est pas faite. Pas de wiki non plus — **on ne modifie pas une entrée existante**, on en crée ou on s'y rattache. Corriger une liaison erronée posée par quelqu'un d'autre se fait en SQL côté serveur ; c'est le sens de « réversible » ici, et c'est une limite assumée, pas un oubli.

Pas de quota ni de rate-limit sur les contributions. L'application n'en a aucun aujourd'hui ; en ajouter un ici serait le premier, pour un risque qui n'existe pas à cette échelle.

## La liaison est un fait global

C'est la décision qui commande tout le reste. Trois façons de propager une contribution ont été pesées :

| Approche | Effet rétroactif | Coût |
|---|---|---|
| **Table CRC → entrée, résolue à la lecture** | oui, sans script | le chemin de lecture de la bibliothèque change |
| Recopie dans les lignes `Game` à la contribution | oui, une fois | donnée dupliquée en N exemplaires, chaque correction future redemande un balayage, et on écrase ce que d'autres voient |
| Ne rien propager | non | celui qui a la ROM depuis un mois ne verra jamais rien |

**La première est retenue.** Une liaison CRC32 → jeu est un fait sur le monde, pas un fait sur un joueur : c'est littéralement la raison pour laquelle tout le monde en profite. Elle se pose une fois et se résout à chaque lecture, donc une correction ultérieure de l'entrée se propage seule, sans rattrapage.

Elle modélise aussi enfin le fait qu'un jeu a plusieurs dumps, ce que la colonne `GameMetadata.crc32` unique ne peut pas exprimer.

Le prix est réel et localisé : `listGamesWithSaveSummaries` (`db/games.ts:84`) est modifié. Ce chemin est couvert par `backend/test/games.test.ts`, donc il est modifiable sans naviguer à vue. Le chemin « room » n'est **pas** touché — vérifié : `websocket/room-view.ts`, `rooms/require-game.ts` et `rooms/own-game.ts` ne lisent que l'identité et le `crc32`, jamais le genre ni la jaquette.

## Le schéma

Migration `backend/migrations/0003_community_metadata.sql`, appliquée par le runner qui lit ce dossier trié et suit ce qu'il a déjà passé dans `schema_migrations`.

### Provenance sur `GameMetadata`

```sql
ALTER TABLE "GameMetadata" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'catalogue';
ALTER TABLE "GameMetadata" ADD COLUMN "contributedBy" TEXT DEFAULT NULL
  REFERENCES "User" ("id") ON DELETE SET NULL;
ALTER TABLE "GameMetadata" ADD COLUMN "cover" BLOB;
ALTER TABLE "GameMetadata" ADD COLUMN "coverMime" TEXT;
```

Le `DEFAULT 'catalogue'` étiquette correctement les 94 lignes existantes sans backfill. Le `DEFAULT NULL` sur `contributedBy` n'est pas un détail de style : SQLite refuse un `ADD COLUMN` porteur d'un `REFERENCES` dont le défaut ne serait pas `NULL`.

### La table de liaison

```sql
CREATE TABLE "GameMetadataChecksum" (
    "crc32" TEXT NOT NULL PRIMARY KEY,
    "metadataId" TEXT NOT NULL,
    "contributedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameMetadataChecksum_metadataId_fkey" FOREIGN KEY ("metadataId")
      REFERENCES "GameMetadata" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GameMetadataChecksum_contributedBy_fkey" FOREIGN KEY ("contributedBy")
      REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "GameMetadataChecksum_metadataId_idx" ON "GameMetadataChecksum"("metadataId");
```

**`crc32` en clé primaire**, et c'est le point à ne pas rater : un CRC32 désigne un dump exact, donc au plus un jeu. La liaison devient idempotente gratuitement, et deux joueurs ne peuvent pas rattacher la même ROM à deux entrées différentes — le conflit est refusé par le schéma, pas par une garde applicative qu'on oublierait.

`ON DELETE SET NULL` sur `contributedBy` : un compte supprimé ne doit pas emporter sa contribution. La donnée sert encore, l'attribution seule disparaît.

Les colonnes `GameMetadata.crc32` et `md5` restent en place — vides dans les faits, et `findGameMetadataByChecksum` continue de les lire. La nouvelle table prime.

## Trois invariants existants à corriger

Sans ces trois-là, la contribution s'évapore silencieusement.

| Où | Aujourd'hui | Demain |
|---|---|---|
| `metadata-loader.ts:223` | `DELETE FROM "GameMetadata"` | `WHERE source = 'catalogue'` |
| `metadata-loader.ts:74` | `countGameMetadata(db)` décide du « déjà chargé, on saute » | ne compte que `source = 'catalogue'` |
| `metadata-loader.ts:92,154,232` | `metadataCache` en mémoire | invalidé à chaque contribution |

Le deuxième mérite son explication : sur une base neuve où la lecture du JSON a échoué mais où un joueur a contribué, un compteur qui compte tout verrait « 1 » et sauterait le chargement du catalogue à jamais.

Le troisième aussi : `metadataCache` alimente l'appariement par titre **et** la recherche décrite plus bas. Sans invalidation, une entrée fraîchement créée n'existerait qu'au prochain redémarrage du conteneur.

## La jaquette

**En BLOB dans SQLite.** Décision du propriétaire, contre un fichier sur disque à la manière de `avatars/`. La raison est le chemin de déploiement : un fichier demande un volume `backend-covers` déclaré dans `docker-compose.prod.yml` **et** dans le dépôt d'infrastructure privé, et s'il est oublié là, les jaquettes s'effacent au déploiement suivant. Un BLOB est sauvegardé et migré avec `prod.db`, donc il ne peut pas disparaître.

Le coût est de l'ordre de 40 à 80 Ko par jaquette, à côté de savestates de 823 Ko déjà stockés en BLOB dans `Save.data`. Invisible.

**Le champ `coverUrl` fait le pont.** `coverUrl = '/api/covers/<id>'` est écrit par la requête qui dépose les octets, une fois leur signature validée — pas à la création de l'entrée, qui n'a encore aucune image à annoncer. `GameCard.svelte` et `GameDetailsModal.svelte` affichent déjà `game.coverUrl` : ils reçoivent la jaquette sans qu'une ligne y soit touchée.

**`toMetadata` doit apprendre les nouvelles colonnes.** Ce mapper (`db/game-metadata.ts`) énumère les champs un par un plutôt que d'étaler la ligne ; `source`, `contributedBy` et la présence d'une jaquette n'en sortiraient pas sans y être ajoutés, et la recherche décrite plus bas ne pourrait pas distinguer une entrée communautaire d'une entrée du catalogue. Les octets eux-mêmes n'y passent jamais : `cover` ne sort que par sa route dédiée.

**Et `listGameMetadata` doit cesser de faire `SELECT *`.** Le mapper laisse tomber le BLOB, mais la requête le charge quand même : cette fonction est ce qui remplit `metadataCache` (`metadata-loader.ts:92,154,232`), donc `SELECT *` reviendrait à garder toutes les jaquettes en mémoire, et à les relire à chaque invalidation. Les colonnes y sont désormais énumérées, sans `cover`.

## L'API

### `GET /api/metadata/search?q=…`

Nouveau routeur `backend/src/api/metadata.ts`, monté à côté des autres (`index.ts:214-219`), derrière `requireAuth`.

Au plus 20 entrées : `id, title, altTitle, region, publisher, releaseDate, coverUrl, source`. **Pas de nouveau SQL** : `metadataCache` est déjà en mémoire et `normalizeTitle` existe déjà — la recherche est un filtre sur le cache, classé préfixe exact d'abord, puis « contient ».

Le client amorce `q` avec le titre actuel du jeu. Dans le cas courant, la bonne entrée est donc en tête sans que le joueur ait tapé quoi que ce soit.

### `POST /api/games/:gameId/identify`

Un seul endpoint, deux corps possibles :

```
{ "metadataId": "…" }                          → lie à une entrée existante
{ "entry": { title?, altTitle?, genre?, … } }  → crée une entrée puis la lie
```

Le tout en une transaction. Un endpoint plutôt que deux parce que créer une fiche sans la lier n'a aucun usage : la fiche existe *parce qu'*une ROM la cherchait.

| Code | Quand |
|---|---|
| `400` | le jeu n'a pas de `crc32` — il faut d'abord lier la ROM, `LinkRom.svelte` fait déjà ça |
| `403` | le jeu n'appartient pas à l'appelant |
| `404` | `metadataId` inconnu |
| `409` | ce CRC est déjà lié à une **autre** entrée ; la réponse porte l'entrée en question |
| `200` | y compris pour une relance vers le même `metadataId` — idempotent |

**Tous les champs de `entry` sont optionnels.** `GameMetadata.title` étant `NOT NULL`, un titre absent retombe sur le titre courant du jeu, lui-même dérivé du nom de fichier. « Tout optionnel » est ainsi tenu sans laisser une ligne bancale en base.

### `PUT /api/metadata/:metadataId/cover`

Les octets bruts, pas une data URI dans du JSON. Trois raisons :

- `app.use(express.json())` est monté globalement **avant** les routeurs (`index.ts:124`), donc une data URI de 400 Ko serait rejetée en 413 avant d'atteindre la route ;
- un `express.raw({ type: ['image/png','image/jpeg','image/webp'], limit: '400kb' })` monté sur cette seule route est ignoré par le parseur JSON global, qui ne réclame que `application/json` ;
- on évite les +33 % du base64.

Le `Content-Type` est **vérifié contre les octets d'en-tête** du fichier, jamais cru sur parole. `415` si la signature n'est ni PNG, ni JPEG, ni WebP. `403` si l'appelant n'est pas le `contributedBy` de l'entrée.

Conséquence assumée : créer une fiche avec image, c'est deux requêtes. L'ordre est création-puis-image, donc un échec sur l'image laisse une fiche **valide et liée** — le joueur retente l'image seule, il ne perd pas sa saisie.

### `GET /api/covers/:metadataId`

Sert le BLOB avec le `coverMime` validé. Derrière `requireAuth`, contrairement aux avatars : c'est du contenu uploadé par un joueur, et un `<img>` de même origine envoie le cookie de session, donc l'authentification ne coûte rien à l'affichage.

**L'URL porte la date de l'écriture** — `coverUrl = /api/covers/<id>?v=<millis>` — ce qui permet un `Cache-Control: public, max-age=31536000, immutable`. Sans cette version, la seule valeur de cache honnête serait courte : remplacer une jaquette laisserait tous les clients l'ayant déjà chargée sur l'ancienne image jusqu'à expiration. Le suffixe coûte cinq caractères et supprime le problème.

## La résolution à la lecture

`listGamesWithSaveSummaries` (`db/games.ts:84`) gagne deux `LEFT JOIN` : `GameMetadataChecksum` sur `g.crc32`, puis `GameMetadata` sur `metadataId`.

La fusion part dans un module à part, `backend/src/db/game-identity.ts`, qui exporte deux fonctions **pures** :

```
mergeIdentity(gameRow, metaRow) -> Game
needsIdentification(gameRow, metaRow) -> boolean
```

Pures et isolées parce que c'est la partie qui peut être fausse sans que personne ne le voie, et parce que `db/games.ts` fait déjà 272 lignes de mapping de lignes où la règle de fusion ne serait qu'un détail noyé.

**La règle : la métadonnée gagne champ par champ quand elle n'est pas nulle**, la colonne de `Game` servant de repli. L'asymétrie est délibérée — une liaison CRC est une preuve exacte posée par un humain, une colonne de `Game` est le résultat d'un appariement de titre approximatif. Aucun risque de piétiner une saisie du joueur : il n'existe pas de fonction « renommer un jeu » dans l'application.

**`needsIdentification`** est calculé côté serveur et renvoyé dans la liste, plutôt que recomposé dans un template : vrai quand aucune liaison n'existe pour ce CRC **et** qu'aucune métadonnée n'a été trouvée. C'est cette seconde condition qui évite de coller un badge sur quarante cartes déjà renseignées par appariement de titre.

## L'UI

Trois fichiers touchés, deux nouveaux.

**`GameCard.svelte`** — un badge « À identifier » à côté du `needs-rom` existant (`GameCard.svelte:46-51`), qui réutilise sa mise en forme de pastille mais en bleu plutôt qu'en ambre. Les deux états sont différents et peuvent coexister sur la même carte.

**`GameDetailsModal.svelte`** — un bouton discret en bas de la fiche, présent dès que le jeu a un `crc32`. « Identifier ce jeu » quand rien n'est connu, « Compléter la fiche » sinon : même action, phrasé honnête.

**`IdentifyGame.svelte`** (nouveau) — une modale, deux états.

- **Chercher**, l'état par défaut. Un champ pré-rempli avec le titre actuel, une liste de résultats en dessous : titre, région, éditeur, année, vignette. Un clic sur un résultat lie et ferme. Dans le cas courant — la bonne entrée est en tête — c'est **un clic**.
- **Créer**, atteint par un lien « Aucun ne correspond — créer une fiche ». Tous champs optionnels, titre pré-rempli depuis le nom de fichier, sélecteur d'image avec aperçu. Bouton « Créer et lier ».

**`frontend/src/lib/games/cover.ts`** (nouveau) — le redimensionnement, sur le modèle de `saves/thumbnail.ts` : largeur max 512 px, WebP avec repli JPEG. Le même piège s'y applique et doit y être traité : `canvas.toDataURL('image/webp')` ne lève **pas** sur un navigateur incapable d'encoder du WebP, il rend silencieusement un PNG dix fois plus gros. Le format est donc relu dans le résultat, comme `imageFormatOf` le fait déjà pour les vignettes.

**i18n** — nouvelles clés en `en` et en `fr` dans `frontend/src/lib/i18n/translations.ts`, aux deux endroits : les deux dictionnaires sont côte à côte dans le même fichier.

## Les erreurs

### Le 409 n'est pas un échec

Sa lecture naïve est fausse. Si le CRC est déjà lié, la métadonnée est **déjà** appliquée globalement, donc le joueur devrait déjà la voir. Un `409` ne peut arriver qu'avec une UI périmée ou dans une course entre deux joueurs. L'UI dit « Cette ROM vient d'être identifiée comme *Super Metroid* » et recharge la bibliothèque, au lieu de présenter un échec que le joueur ne peut pas corriger.

### Un mensonge actif dans le gestionnaire d'erreurs

`errorHandler` répond `500 Internal server error` à tout ce qui remonte (`middleware/error.ts:35`). Or `express.raw({ limit: '400kb' })` rejette une image trop grosse avec une erreur portant `type: 'entity.too.large'` et un `status` 413 : en l'état, le joueur reçoit « erreur interne du serveur » pour une image trop lourde, et va réessayer à l'identique.

`errorHandler` est donc étendu pour mapper les erreurs de body-parser (`err.type` en `entity.*`) sur leur vrai code, avec un message JSON propre. C'est du code qu'on touche de toute façon, et le défaut est actif.

## Les tests

En TDD, dans l'ordre où le code s'écrit.

### Fonctions pures, sans base

C'est là que vit le risque silencieux.

- `mergeIdentity` : la métadonnée gagne champ par champ ; le repli tient quand elle est nulle.
- `needsIdentification` : vrai sans liaison **et** sans métadonnée ; faux quand un appariement de titre a rempli la fiche.
- le renifleur d'octets d'en-tête : accepte PNG/JPEG/WebP, refuse un `Content-Type` qui mentirait sur le contenu.
- le classement de `searchCatalogue` : préfixe exact avant « contient ».

### Couche base — `backend/test/metadata-contrib.test.ts` (nouveau)

- une liaison se crée et se retrouve ;
- une seconde liaison du même CRC vers une autre entrée est refusée par la clé primaire ;
- supprimer une entrée emporte ses liaisons en cascade ;
- supprimer un utilisateur passe `contributedBy` à `NULL` **sans** perdre la contribution ;
- la jaquette fait l'aller-retour en BLOB intacte ;
- `listGameMetadata` ne ramène **pas** les octets de la jaquette — la seule assertion qui empêche un futur `SELECT *` de remettre toutes les images dans le cache mémoire.

`npm run test:backend` ramasse `backend/test/*.test.ts` au glob : le fichier est pris sans toucher au script.

### Régressions sur l'existant

Dans `backend/test/game-metadata.test.ts` : un refresh réécrit les lignes du catalogue et **laisse** les lignes communautaires ; le compteur ne compte que le catalogue.

Dans `backend/test/games.test.ts` : la liste résout titre, genre et jaquette à travers la liaison CRC ; `needsIdentification` ne sort vrai que quand rien n'est connu.

Ces deux fichiers sont le filet qui rend les trois invariants modifiables sans naviguer à vue.

### Front — `core/test/cover.test.ts` (nouveau)

Sur le modèle de `core/test/thumbnail.test.ts`. À **ajouter au script `test:ui`** du `package.json` racine, qui énumère ses fichiers un par un.

### E2E — `e2e/identify-game.spec.ts` (nouveau)

Le chemin heureux, avec le harnais existant (`loginDev`, et `e2e/local-roms.spec.ts` montre déjà comment enregistrer une ROM depuis le navigateur) : une ROM inconnue arrive dans la bibliothèque avec son badge, un joueur la lie à une entrée, **un second compte voit le titre** sans avoir rien fait.

C'est l'assertion qui prouve la phrase de départ — tous les joueurs en profitent — et aucun test unitaire ne peut la porter.

## Ce que cette conception ne fait pas

- **Modifier une entrée existante.** Créer et rattacher, rien d'autre. Un wiki demanderait un historique pour être récupérable.
- **Modérer.** Les contributions s'appliquent immédiatement ; la correction se fait après coup, en SQL.
- **Limiter le débit des contributions.** Aucun rate-limit dans l'application aujourd'hui, et pas de raison d'en faire le premier ici.
- **Toucher le chemin « room ».** Vérifié : il ne lit pas les métadonnées.
- **Renseigner les checksums du catalogue JSON.** Les 94 entrées livrées restent sans CRC ; ce sont les liaisons posées par les joueurs qui les leur donnent, une ROM à la fois.
