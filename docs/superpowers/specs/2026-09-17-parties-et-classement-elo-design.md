# Enregistrer les parties, et classer les joueurs à l'Elo

Conception pour l'issue #61. Le guetteur de combat sait déjà dire qui a gagné ; il ne le dit qu'à une notification qui meurt avec la page. Cette spec lui donne une table, une cote par jeu, et — avant tout le reste — la garde sans laquelle il enregistrerait des mensonges.

Chemins et numéros de ligne : `main` au 2026-09-17.

## Pourquoi maintenant

`frontend/src/lib/rooms/match-report.ts` porte dans son en-tête la décision que cette spec revisite :

> *nothing in the schema records a match result, and inventing a table for the first game whose memory layout has been read would be a migration paid for one row of addresses*

L'argument était juste et ne l'est plus tout à fait : `watched-roms.ts` a toujours une ligne, mais son en-tête dit que le titre suivant est une ligne et non une réécriture, et une table qui attend le deuxième jeu pour naître naîtra mal — le classement doit être **par jeu dès le premier jour**, sinon il est à refaire à la deuxième ligne d'adresses.

L'autre raison est la suite : deux joueurs qui possèdent la même cartouche pourront plus tard se rencontrer par voisinage de cote. Rien ici ne construit cet appariement, mais tout ici est fait pour qu'il soit une requête et non une reprise.

## Ce qui existe déjà, et qu'on ne casse pas

| Existant | Ce qu'il devient |
|---|---|
| `MatchObserver` et sa machine à un bit (`armed`) | Gagne une garde d'activité par port. La machine à états elle-même ne change pas. |
| `MatchVerdict` | Inchangé. Le vainqueur reste un **port**. |
| `verdictMessage()` / la notification | Inchangée, mais elle ne se déclenche plus quand la garde refuse. |
| `watched-roms.ts` | Intouché. Une seule ligne, et c'est très bien. |
| Le mode solo | **Cesse d'armer le guetteur.** Voir « La solo room » ci-dessous. |
| Les modes dual et streaming | Inchangés : ils font tourner la pile RetroArch, qui n'expose aucune work RAM. Il n'y a pas de verdict là-bas, et c'est écrit dans l'en-tête de `match-watch.ts`. |

## 1. La garde d'activité, qui passe avant tout

Il n'existe aujourd'hui **aucune garde de mode**. `createMatchWatch()` s'arme sur une seule condition — `watcherFor(gameCrc32)`, « est-ce cette ROM » — et trois situations produisent donc un verdict qui ne veut rien dire :

1. **La solo room.** Une notification annonce un vainqueur à quelqu'un qui joue seul.
2. **Le mode histoire.** Les deux barres de vie existent aussi contre le processeur ; le guetteur y voit un combat.
3. **Le joueur 2 qui ne joue pas.** Deux joueurs lancent, seul le premier touche sa manette, il gagne — et le système enregistrerait une victoire de 1 sur 2. C'est la pire des trois : les deux premières font du bruit, celle-ci **fabriquerait une donnée**.

### Pourquoi les entrées, et pas la RAM de santé

Un port qui n'a pressé aucun bouton du combat n'a pas perdu. En mode histoire le port 2 est silencieux, l'adversaire étant le processeur. Une garde « les deux ports ont joué pendant ce combat » traite donc les cas 2 et 3 ensemble.

Sa seconde qualité est décisive, et elle est architecturale : les entrées sont exactement ce que le lockstep garantit identique chez les deux pairs. C'est la propriété qui permet au verdict d'être calculé des deux côtés sans rien émettre, posée par l'en-tête de `core/test/match-watch.test.ts` :

> *both peers read the same bytes, so both reach the same verdict without exchanging a word. Nothing here may send, receive, or write - a watcher that touched the machine would be a second input path into a lockstep session, which is the one thing the netcode cannot survive.*

Une garde fondée sur les entrées préserve cette propriété. Une garde fondée sur l'état d'un composant ou sur une décision serveur obligerait à comparer deux états qui n'ont aucune raison d'être les mêmes.

### Où elle vit, et pourquoi pas ailleurs

**Dans `MatchObserver`**, pas dans un filtre posé après coup sur le verdict. Deux raisons, toutes deux contraignantes :

- **L'activité doit être accumulée à chaque image.** `observe()` ne lit la work RAM qu'une image sur 30 (`DEFAULT_SAMPLE_EVERY`), et un appui peut tomber entre deux échantillons. Il faut donc une entrée par image, distincte de l'échantillonnage.
- **La fenêtre est celle du combat, et seul l'observateur sait où elle commence** : c'est son bit `armed`. L'activité doit donc être remise à zéro au moment où il s'arme, ce qu'un filtre extérieur ne peut pas faire.

### La forme

```ts
/**
 * Les boutons avec lesquels on se bat.
 *
 * START et SELECT en sont exclus : ils servent à passer les écrans et à
 * mettre en pause, jamais à frapper. Les garder ferait passer la garde à un
 * joueur 2 qui pianote pour sauter un dialogue, ce qui est exactement le faux
 * positif qu'elle existe pour attraper.
 *
 * Tout le reste compte, gâchettes comprises : dans Super Butouden 2, L et R
 * sont des boutons de combat.
 */
const FIGHT_BUTTONS = ~(PAD.SELECT | PAD.START);
```

Trois ajouts à la classe :

- `note(pad1: PadMask, pad2: PadMask): void`, appelée **à chaque image, avant `observe(frame)`**. Deux `|=` sur des entiers masqués par `FIGHT_BUTTONS` : c'est tout le coût sur la boucle chaude, et c'est ce qui la rend sûre à appeler là où le renderer dessine. L'ordre compte à l'image du verdict — un appui de cette image-là doit être compté avant d'être jugé.
- Deux bits d'activité, remis à zéro **dans la branche qui arme**.
- Dans la branche du verdict, la condition est **`activeP1 && activeP2`** — les deux ports, pas l'un ou l'autre — et elle passe avant `wins++` **et** avant `onVerdict`. Un combat que les deux ports n'ont pas joué ne produit ni ligne, ni notification, ni point au score courant. Le bit `armed` se libère quand même : le combat est fini quelle que soit la valeur de la garde.

La remise à zéro dans la branche qui arme a un effet secondaire heureux. Cette branche se reprend à chaque échantillon où les deux camps sont à pleine vie — c'est déjà, par construction, la sortie d'un combat décidé, le jeu réécrivant `max` et `current` au round suivant. L'activité ne compte donc qu'à partir du **dernier** instant de pleine vie, et les appuis dans les menus qui précèdent le round sont écartés gratuitement.

### Le seuil est un fait, pas un réglage

« Zéro appui du port 2 sur tout le combat » est un fait. « Moins de N appuis » est un chiffre que personne ne saura défendre dans six mois. On commence par le fait, et on n'ajoute pas de constante réglable.

### Ce que cette garde ne fait pas

Un joueur 2 qui pianote pendant que le joueur 1 avance dans son mode histoire la passerait. **Ce n'est pas un détecteur de mode, c'est un détecteur de rencontre.** Pour une certitude il faudrait l'octet de mode du jeu, donc une seconde session de recherche mémoire : hors périmètre, et c'est un travail de recherche à part entière.

### La solo room

Elle cesse d'armer. C'est le plus simple et c'est ce qui est demandé.

À noter tout de même, pour qui rouvrirait la question : `SoloRoom.svelte` calcule **déjà** de quoi distinguer un vrai versus à deux manettes, dans `pad2: allowLocalPlayer2 && isPlayerActive(assignments.p2) ? collector2!.read() : 0`. C'est un versus légitime, mais il n'y a personne à qui annoncer le vainqueur, et pour l'Elo c'est un seul compte pour deux ports — donc non classable. Si la notification revient un jour en solo, c'est cette condition-là qui la garde, et pas une autre.

## 2. Comment les pads arrivent au guetteur

`session.ts:833` appelle `this.onFrame(this.frame)`, et `pad1`/`pad2` sont déjà dans la portée douze lignes plus haut (l. 820-821). Élargir `onFrame` à `(frame, pad1, pad2)` touche quatre lignes : 173 (le type d'option), 297 (le champ), 405 (le défaut), 833 (l'appel). Tout le reste en découle.

**`solo.ts` n'est pas touché.** L'issue lui réserve une ligne dans sa carte du code, mais puisque la solo room cesse d'armer, plus rien ne consomme les pads sur ce chemin. `MatchObserver` n'est importé qu'à deux endroits aujourd'hui — `LockstepRoom.svelte:30` et `SoloRoom.svelte:35` — et le second disparaît.

## 3. Trois présentations, un seul câblage

L'issue décrit deux sites d'appel. **Il y en a trois.**

`VrShell.svelte:116` utilise `createLockstepEngine` (`rooms/lockstep-engine.ts`), un câblage distinct de celui de `LockstepRoom.svelte`. L'en-tête de ce fichier dit pourquoi il existe :

> *`LockstepRoom.svelte` holds this inside 1814 lines of component. A VR shell wanting the same sequence would have to copy it, and the next SRAM or handshake fix would then reach only one of the two copies.*

Son `onFrame(core, frame)` est déclaré l. 80 et relayé l. 149-151. Tel que l'issue est écrite, **un versus joué en VR ne serait pas enregistré et personne ne s'en apercevrait.**

D'où la forme retenue : le guetteur, la notification et le rapport vivent dans **un** module, `frontend/src/lib/games/match-recorder.ts`, que les deux câblages lockstep appellent. Ça supprime la duplication dont l'issue se plaint déjà — `createMatchWatch()` est aujourd'hui recopié à l'identique — et la VR est couverte par la même ligne. C'est exactement le raisonnement de `rooms/match-report.ts`, qui existe pour que les deux salons ne disent pas la même chose en deux formulations qui dérivent.

Réserve à écrire dans l'en-tête du module : la couverture VR est **juste par construction et non par observation**, #62 rapportant que le lancement d'une partie en casque échoue en production.

## 4. La forme des données

Migration **`0008`**. L'issue dit 0006 ; `main` a depuis pris 0006 et 0007.

```sql
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

CREATE TABLE "Rating" (
  "userId"    TEXT    NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "gameCrc32" TEXT    NOT NULL,
  "rating"    INTEGER NOT NULL,
  "matches"   INTEGER NOT NULL,
  PRIMARY KEY ("userId", "gameCrc32")
);

CREATE INDEX "Rating_gameCrc32_rating_idx" ON "Rating" ("gameCrc32", "rating");
```

**Une ligne par KO.** Pas par rencontre : rien dans le jeu ne dit quand une rencontre se termine — les joueurs enchaînent ou s'arrêtent sans que la RAM en porte la trace — et enregistrer les KO pour agréger plus tard est réversible, alors que l'inverse ne l'est pas.

**`gameCrc32` et non `gameId`.** Un `Game.id` appartient à un compte : les deux joueurs d'une même partie ont deux lignes `Game` distinctes pour la même cartouche (`Game_userId_crc32_key`, `0001_baseline.sql:79`). Classer par `gameId` donnerait deux classements pour un jeu. Le checksum est ce que les deux partagent, c'est déjà la clé de `watched-roms.ts`, et c'est ce sur quoi l'appariement joindra.

**`Match_sessionId_frame_key` unique : c'est la déduplication elle-même**, pas une protection posée à côté. Voir §5.

**Et la clé est `sessionId`, pas `roomId` — sinon elle a un trou.** Le compteur d'images est monotone dans une session : `resetTimeline` réassigne `this.frame` à lui-même (`session.ts:1032`, l. 1037), donc un resync ne le remet pas à zéro. Mais une session **suivante**, dans le même salon, repart de zéro. Deux parties jouées dans le même salon à deux moments différents peuvent donc tomber sur le même numéro d'image, et `(roomId, frame)` les confondrait : la seconde serait rejetée comme un doublon, et son vainqueur comparé à celui de la première produirait une fausse alerte de désynchronisation.

`sessionId` est posé **par le serveur**, pas par le client, quand le salon entre en `playing` — les deux pairs héritent donc du même sans rien s'échanger, et personne ne peut le forger.

**Il doit être posé en un seul endroit**, dans une fonction que les trois transitions appellent : `game-handlers.ts:70`, `game-handlers.ts:127` et `room-handlers.ts:106` écrivent aujourd'hui `status = 'playing'` chacune de leur côté. C'est exactement la configuration de `rooms/presence.ts`, dont l'en-tête explique la règle qu'on reprend ici :

> *Set and cleared in exactly one place [...] because three call sites trigger the transition and a room whose flag disagrees with its occupants either lives for ever or vanishes under two players.*

Un `sessionId` oublié à l'une des trois transitions donnerait un salon dont les parties se rattachent à la session précédente — donc rejetées comme doublons. La même erreur, et la même parade.

**`ON DELETE SET NULL` sur `Match`, `CASCADE` sur `Rating`.** Asymétrie voulue, et c'est le raisonnement de `SignupInvite.inviteeId` en 0007 : une partie jouée est un fait qui a eu lieu et survit à la suppression d'un compte ; une cote est une propriété de ce compte et n'a plus de sens sans lui.

**Les invités n'ont pas d'id, dès l'insertion.** Un anonyme (`users.isAnonymous`) n'a pas d'identité durable : la colonne est écrite `NULL` immédiatement, et non laissée à `sweepAnonymousUsers` (`db/users.ts:272`) qui supprime ces lignes. « Classable » se lit alors `p1UserId IS NOT NULL AND p2UserId IS NOT NULL`, c'est vrai dès l'écriture et ça le reste — aucune colonne `ranked` à tenir en accord avec autre chose, et aucun test `isAnonymous` disséminé qui s'oubliera.

**`rating` en INTEGER.** Tout ce schéma met des nombres et non du texte, pour la raison écrite dans l'en-tête de 0007. L'arrondi ne s'accumule pas : le recalcul repart de `Match` (§6).

**Les dates sont des millisecondes epoch écrites par le code appelant.** Pas de `DEFAULT CURRENT_TIMESTAMP`, qui insérerait du texte là où tout ce schéma met des nombres.

## 5. Le chemin d'un verdict

### Ce que le client envoie, et ce qu'il n'envoie pas

```ts
socket.emit('match:report', { roomId, frame, winner, p1Health, p2Health });
```

**Pas de `userId`, pas de `gameCrc32`, pas de `sessionId`.** Le serveur les dérive tous les trois du salon : `gameCrc32` et `sessionId` sont sur `Room`, et le port devient un joueur en lisant `RoomPlayer.port` **au moment du rapport** — les ports se réassignent en cours de session, donc la correspondance ne peut pas être lue ailleurs.

`Room.gameCrc32` est optionnel (`backend/src/types/index.ts`). Un salon qui n'en porte pas ne peut pas être classé : le rapport est ignoré, avec une ligne de journal. Ça ne devrait pas arriver — le guetteur ne s'arme que sur un CRC32 connu — et c'est exactement pour ça que le silence serait le mauvais comportement.

Ça resserre une décision de l'issue sans rien coûter. On croit le client sur parole pour *qui a gagné* : c'est inévitable, le verdict vient de sa RAM, et entre amis c'est acceptable — mais il vaut mieux l'écrire maintenant que le découvrir le jour où le classement comptera pour quelqu'un. On ne le croit pas sur *qui jouait* : sinon n'importe qui pourrait s'attribuer la victoire de n'importe qui, ce qui n'est plus un classement mais un formulaire.

### Les deux pairs rapportent

Le verdict est calculé des deux côtés indépendamment, et **les deux l'envoient**. Le second se heurte à `Match_sessionId_frame_key`, et c'est à ce refus qu'on compare son `winner` à celui déjà en base : identiques, on ne dit rien ; différents, une ligne de journal. Un désaccord n'est pas une erreur à écraser, c'est le signal d'une désynchronisation.

Le double rapport a un second bénéfice, qui n'est pas gratuit à obtenir autrement : **un socket mort ne perd plus la partie.** Un `emit` sur un socket coupé disparaît sans erreur et rien ne le rejoue — les écouteurs socket.io ne se rejouent pas à la reconnexion. Avec deux rapporteurs indépendants, il faut que les deux tombent au même instant pour perdre la ligne.

### L'écriture, en une transaction

1. Résoudre `gameCrc32` et `sessionId` depuis le salon, et les deux ports en joueurs ; `NULL` pour un anonyme comme pour un port vacant (spectateur, joueur parti).
2. Insérer le `Match`.
3. Si les deux `userId` sont non nuls, **rejouer tout l'historique de ce `gameCrc32`** dans l'ordre `(playedAt, frame)` et réécrire les lignes `Rating` concernées.

## 6. La formule, et pourquoi on la rejoue entière

Elo standard. **1000 au départ, K = 32, le double KO vaut 0,5 à chacun.**

K = 32 est le choix des petites populations : à une poignée de joueurs, un K faible met des centaines de parties à séparer qui que ce soit. Le nul à 0,5 est l'Elo que tout le monde connaît, et un double KO reste une partie jouée.

**Le recalcul est complet à chaque insertion**, sur le seul `gameCrc32` concerné. C'est plus simple qu'un delta incrémental et c'est aussi plus juste :

- `Rating` ne peut pas dériver de `Match`, puisqu'il en est recalculé à chaque écriture. La propriété « entièrement recalculable » n'est pas une promesse tenue à la main, c'est le seul chemin d'écriture.
- Une partie qui arrive **en retard** — un pair qui rapporte après une reconnexion — se range à sa place dans l'ordre au lieu d'être repliée à la fin. Elo est un pliage séquentiel : l'ordre change le résultat.
- Le coût est nul à cette échelle. À quelques milliers de lignes par jeu, rejouer le pliage est une fraction de milliseconde en SQLite. Le jour où ça coûte, on passe à l'incrémental **sans changer le schéma** — ce qui est précisément pourquoi `Match` reste la source de vérité.

Garder les parties comme source de vérité permet aussi de changer la formule, le facteur K ou le classement initial sans perdre l'historique, et de recalculer après coup si un défaut d'enregistrement est découvert.

### Les joueurs sans cote

Un joueur qui possède le jeu mais n'a jamais joué de partie classée n'a **pas de ligne** dans `Rating`, et c'est voulu : la table ne contient que ceux qui ont joué. L'appariement futur partira des propriétaires (`SELECT userId FROM "Game" WHERE crc32 = ?`), joindra `Rating` à gauche, et **l'absence de ligne vaudra 1000** — une constante partagée avec la formule, pas une ligne fantôme à pré-créer.

## 7. Le découpage

| fichier | rôle |
|---|---|
| `frontend/src/lib/games/match-watch.ts` | l'activité par port sur la fenêtre du combat, et la garde qui en découle |
| `frontend/src/lib/games/match-recorder.ts` | **nouveau.** Le câblage guetteur + notification + rapport, pour les trois présentations |
| `frontend/src/lib/znet/session.ts` | `onFrame` élargi aux deux masques (l. 173, 297, 405, 833) |
| `frontend/src/lib/rooms/lockstep-engine.ts` | `onFrame` élargi de même (l. 80, 149-151) |
| `frontend/src/lib/components/LockstepRoom.svelte` | appelle le module partagé au lieu de son `createMatchWatch()` local |
| `frontend/src/lib/components/VrShell.svelte` | idem, par `lockstep-engine.ts` |
| `frontend/src/lib/components/SoloRoom.svelte` | n'arme plus (l. 545, 567, 786) |
| `frontend/src/lib/rooms/match-report.ts` | son en-tête à corriger : le schéma enregistre désormais |
| `backend/migrations/0008_match_ratings.sql` | les deux tables |
| `backend/src/ratings/elo.ts` | **nouveau.** La formule, pure |
| `backend/src/db/matches.ts` | **nouveau.** L'accès, sur le modèle de `db/users.ts` |
| `backend/src/websocket/match-handlers.ts` | **nouveau.** L'événement, sur le modèle de `room-handlers.ts` |
| `backend/src/types/index.ts` | `Room` gagne `playSessionId` |
| les trois transitions vers `playing` | `game-handlers.ts:70`, `:127`, `room-handlers.ts:106` passent par la fonction qui pose `playSessionId` |

Le découpage pur / impur n'est pas une préférence de style : c'est celui d'`auth/anonymous.ts` et de `saves/import-plan.ts`, et leurs en-têtes disent pourquoi — rien de tout ça ne peut piloter un handler Express dans un test, donc une règle écrite dans une route est une règle que personne ne peut prouver.

## 8. Les tests

**La garde**, dans `core/test/match-watch.test.ts`, qui existe déjà et est déjà nommé dans `test:ui`. Il pince la machine à états sur de la work RAM **fabriquée** — `ram(p1max, p1, p2max, p2)`, 128 Ko, adresses réelles — et une manette silencieuse s'y simule aussi facilement qu'une barre de vie. Les trois situations du §1 y sont couvertes intégralement, sans ROM et sans navigateur.

**La formule**, dans un nouveau `backend/test/elo.test.ts`. Une précision sur le piège d'énumération : **il ne s'applique pas ici.** `test:backend` est un glob (`backend/test/*.test.ts`), donc un fichier neuf y tourne tout seul. C'est `core/test` qui exige d'être nommé à la main dans `test:ui`, et un fichier oublié là n'y tourne jamais — vérifier que le **nombre de fichiers** augmente, pas seulement que la couleur est verte.

**Avec la ROM**, `core/test/match-watch-rom.test.ts` vérifie les adresses contre le vrai dump et se saute s'il est absent (`PSNES_TEST_ROM`, ou `backend/roms/`, ou `core/test/roms/`). Il n'est présent sur aucune machine de développement par défaut : ne pas compter dessus pour une boucle de travail.

**Migrations :** `bun src/db/migrate-cli.ts` depuis `backend/` (script `db:migrate`). Pas de `npx tsx`, qui échoue depuis le passage à Bun.

**i18n :** rien de nouveau. La garde *supprime* des notifications, elle n'en ajoute pas, et l'affichage est hors périmètre. Si une chaîne visible apparaît malgré tout, elle va dans `frontend/src/lib/i18n/translations.ts` dans les deux langues, sans quoi `core/test/i18n-parity.test.ts` échoue.

## 9. Hors périmètre

- **L'affichage** sous toutes ses formes : tableau des scores, badge sur le profil, classement dans le lobby VR. Un second ticket, une fois que les données existent et qu'on sait ce qu'elles valent.
- **La détection du mode par la RAM.** Une garde certaine demanderait l'octet de mode du jeu, donc une session de recherche mémoire — méthode dans l'en-tête de `watched-roms.ts`, et le harnais de `match-watch-rom.test.ts` sait déjà démarrer dans un combat P1 vs P2.
- **L'appariement par Elo**, que ce schéma rend possible sans le construire : index `Rating_gameCrc32_rating_idx` pour le voisinage de cote, et les propriétaires d'une cartouche déjà trouvables par `Game.crc32`.
- **L'agrégation en rencontres.** Réversible depuis les KO, et c'est la raison d'enregistrer les KO.
