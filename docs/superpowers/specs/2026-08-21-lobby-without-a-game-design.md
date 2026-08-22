# Un salon avant le jeu

Conception. **Morceau B** du découpage commencé avec la barre fine et la page de profil. C'est le morceau invasif : il touche le modèle de salon côté serveur, sa persistance, le vocabulaire socket et un parcours client existant.

## Pourquoi

Aujourd'hui un salon ne peut pas exister sans jeu. `room:create` exige `gameId` et `gameTitle` (`backend/src/websocket/room-handlers.ts:24`), et `Room` les déclare obligatoires (`backend/src/types/index.ts:5`). Le parcours en découle : on choisit un jeu, ce qui crée un salon, et l'ami rejoint ce salon-là.

Ça met la décision la moins importante en premier. Deux personnes qui veulent jouer ensemble se retrouvent d'abord, et choisissent ensuite — pas l'inverse. Et comme le salon naît du jeu de l'hôte, c'est l'hôte qui décide de tout, y compris de qui détient les sauvegardes.

## Le modèle

`gameId` et `gameTitle` deviennent **optionnels**. Rien d'autre ne change dans `Room` : la liste de joueurs, les ports (`port: 1 | 2 | null`, déjà là, `types/index.ts:26`), l'instantané qui restaure les salons au redémarrage, le délai de grâce des départs et la mort d'un salon vide (`room-handlers.ts:307-313`) continuent de fonctionner sans une ligne de plus.

C'est le choix du propriétaire, contre une entité `Lobby` séparée. La raison est que `Room` sait déjà faire tout le difficile — l'appartenance, la présence, la persistance, la reprise après reconnexion — et qu'une seconde entité devrait le réapprendre.

### Le prix, et où il se paie

Dix-huit endroits lisent `room.gameId` ou `room.gameTitle`, et ils ne se traitent pas tous pareil — le compte a été fait plutôt qu'estimé :

| Où | Combien | Ce qu'il faut y faire |
|---|---|---|
| `backend/.../game-handlers.ts` | 10 | **Refuser** : sauvegardes, slots, SRAM n'ont aucun sens sans jeu |
| `backend/.../room-view.ts` | 2 | **Laisser passer** : décrire un salon sans jeu est sa raison d'être |
| `frontend/.../room/[id]/+page.svelte` | 5 | Afficher l'attente au lieu du jeu |
| `frontend/.../FriendsList.svelte` | 1 | Afficher le salon sans titre de jeu |

**Un seul accesseur pour les dix, pas dix gardes.** `requireGame(room)` rend le jeu ou refuse, et les dix appelants passent par lui. Deux raisons de préférer ça à un `if` par site : une garde répétée dix fois sera oubliée à la onzième, et un accesseur unique est une fonction pure qu'un test peut fixer.

**La distinction avec `room-view.ts` est la partie à ne pas rater.** Y mettre la même garde serait une erreur : la vue doit pouvoir décrire un salon sans jeu, sinon le client ne peut rien afficher entre la création et le choix. Refuser et laisser passer sont deux réponses correctes à la même question, et ce sont les fichiers qui les séparent.

Ce que la garde protège n'est pas théorique. Ces dix sites sont des gestionnaires d'événements socket : rien n'empêche un client de demander une sauvegarde dans un salon où aucun jeu n'a encore été choisi. Aujourd'hui la question ne se pose pas ; demain elle se posera.

## Le cycle de vie

| Événement | Qui | Effet |
|---|---|---|
| `room:create` | n'importe qui | Un salon vide, avec son hôte et aucun jeu |
| `lobby:invite { friendId }` | un membre | Crée une invitation, la livre si l'ami est connecté |
| `lobby:accept` / `lobby:decline` | l'invité | Rejoint, ou refuse et l'invitation meurt |
| `room:choose-game { gameId }` | **l'un ou l'autre** | Fixe `gameId`, `gameTitle`, `gameCrc32` ; autant de fois qu'ils veulent avant de lancer |
| `game:start` | **l'un ou l'autre** | Démarre ; **celui qui lance détient les sauvegardes** |

Le choix du jeu est révocable jusqu'au lancement, parce que c'est une conversation entre deux personnes et qu'une décision prise à deux se reprend.

**Qui lance détient les sauvegardes**, décision du propriétaire. Concrètement le `gameId` utilisé pour les sauvegardes et la SRAM est celui du lanceur, résolu par `findOwnedGameId` / `findChecksumOfOwnedGame` (`backend/src/db/games.ts:217` et `:223`) : les deux joueurs possèdent des lignes `Game` distinctes pour la même ROM, et c'est le checksum qui les relie.

## Le solo ne change pas

▶ sur un jeu continue de créer un salon **avec** son jeu et de démarrer aussitôt : `autoStart` existe déjà et met le statut à `playing` sans passer par une salle d'attente (`room-handlers.ts:50` et `:65`).

C'est délibéré et c'est la décision du propriétaire. Faire passer le solo par un salon vide ajouterait deux écrans au cas le plus fréquent, et obligerait à refaire un chemin qui fonctionne. Le salon est la porte du multijoueur, pas de tout.

## Les invitations

Une table, `RoomInvitation` : salon, expéditeur, destinataire, création, expiration, état. Nouvelle migration `0002_*.sql` dans `backend/migrations/`, appliquée par le runner qui lit ce dossier trié et suit ce qu'il a déjà passé dans `schema_migrations`.

**Persistées plutôt que vivantes**, décision du propriétaire : on peut inviter quelqu'un qui n'est pas là, et l'invitation l'attend à sa prochaine connexion. Une invitation en direct uniquement serait plus simple mais se perdrait à la moindre coupure réseau.

**Expiration à dix minutes.** Un salon qui attend n'a pas de raison d'attendre longtemps.

**Et une invitation meurt avec son salon.** C'est la partie qu'il ne faut pas oublier : un salon vide est déjà supprimé, donc une invitation peut désigner un salon qui n'existe plus bien avant ses dix minutes. Elle doit se refuser d'elle-même à l'acceptation plutôt que de compter sur un nettoyage périodique — le nettoyage sert à ne pas accumuler des lignes, pas à garantir la justesse.

## La ROM que l'invité n'a pas

Le salon affiche, par joueur, s'il possède la ROM du jeu choisi. **Le serveur répond lui-même** avec `findGameByChecksum(db, userId, crc32)` (`backend/src/db/games.ts:135`) : c'est une question à laquelle il ne faut pas laisser le client répondre sur son honneur.

**Ce que cet indicateur dit exactement**, parce que la formulation facile serait un mensonge : « ce joueur a enregistré cette ROM dans sa bibliothèque ». Pas « le fichier est accessible maintenant ». Le fichier vit sur sa machine, derrière une permission de dossier qui peut avoir expiré. L'invite de localisation et le transfert de ROM restent donc le filet, exactement comme aujourd'hui.

Et l'indicateur a trois états, pas deux : la colonne `crc32` de `Game` est nullable, donc un jeu enregistré sans checksum donne **inconnu**. Afficher « ne l'a pas » dans ce cas serait faux.

## Ce qui disparaît

Le parcours multijoueur par le jeu, et avec lui la possibilité de **rejoindre le salon d'un ami sans y être invité** — aujourd'hui la liste d'amis montre les salons actifs et on s'y invite soi-même.

Décision du propriétaire, et c'est le point le plus discutable de cette conception : ça retire une commodité qui fonctionne. L'argument pour est qu'avoir deux portes d'entrée vers un salon oblige à répondre deux fois à chaque question — qui peut entrer, ce qui se passe si le salon a déjà deux joueurs, qui est prévenu. L'invitation devient la seule porte, donc la seule à raisonner.

## Ce qui est testable, et ce qui ne l'est pas

**Testable, en fonctions pures :**

- `requireGame(room)` — la garde des dix sites qui doivent refuser, et qui doit *ne pas* être appliquée aux deux de `room-view.ts`.
- La machine à états d'une invitation : `pending` vers `accepted`, `declined` ou `expired`. **L'horloge est un paramètre**, jamais `Date.now()` à l'intérieur : sans ça, aucun test ne peut faire vieillir une invitation, et l'expiration est précisément ce qu'il faut prouver.
- La décision `hasRom` à partir des faits — possède une ligne, le jeu a un checksum — avec ses trois états.

**Non testable ici, et vérifié à la main :** l'écran du salon, l'invitation qui arrive, l'acceptation, la suppression de l'ancien parcours. La liste vient avec le plan.

## Ce que cette conception refuse de faire

**Pas de choix de manette.** Le morceau C. Les fondations existent déjà côté serveur — `port: 1 | 2 | null` et un gestionnaire qui échange les ports quand celui demandé est pris — mais l'exposer est un travail à part, et il dépend de celui-ci parce que le lancement est le moment où ça se décide. Le gestionnaire d'échange est à `room-handlers.ts:139-143` : demander un port occupé déplace l'autre joueur sur le port libre plutôt que de refuser.

**Pas de deux avatars dans la barre.** Morceau D, qui demande B fini.

**Pas de changement d'avatar.** Morceau E, et une surface de fichier non fiable qui mérite sa propre revue.

**Pas de bascule de mode.** Les modes dual, streaming et lockstep restent tels quels — leur suppression a été annulée par le propriétaire le 2026-08-21, et le streaming est le seul chemin pour un invité dont la machine ne fait pas tourner l'émulateur.

## Reporté sciemment : les touches vues par l'autre joueur

Trouvé pendant l'exécution, le 2026-08-22, et **à moitié corrigé**.

`room-view.ts` existe pour retirer le `keyConfig` de chaque joueur avant d'envoyer un salon à un client — « un réglage privé sans usage hors du salon auquel il appartient ». Deux chemins l'ignoraient.

**Corrigé** : `friend:roomCreated` diffusait la salle brute, donc créer un salon envoyait les touches de tous les joueurs à **tous les amis connectés**. Un ami est par définition hors du salon. La notification envoie désormais la vue publique ; la liste d'amis ne lit que l'identifiant, le titre, le statut et les joueurs, donc rien ne change à l'écran.

**Reporté, décision du propriétaire** : les onze émissions de `room:updated` envoient la salle brute aux **membres du salon**, si bien que chaque joueur reçoit les touches de l'autre. Le client n'en lit jamais que les siennes (`room/[id]/+page.svelte`, `currentPlayer?.keyConfig`). C'est donc inutile — mais c'est une personne avec qui on a choisi de jouer, pas une liste d'amis, d'où le report.

Le vrai correctif n'est pas un filtre : c'est de fusionner les deux événements quasi homonymes. `room:updated` porte la salle brute et `room:update` la vue publique, et cette confusion a déjà coûté quelque chose — le champ `rom` ajouté par la tâche 5 était structurellement inatteignable depuis l'écran du salon, qui écoutait le premier, et la tâche 6 a dû le contourner côté client. Les fusionner en un seul événement public, et accuser le changement de touches en salon à son seul auteur, ferme l'exposition et supprime la cause racine du contournement. Onze sites — deux dans `game-handlers.ts`, neuf dans `room-handlers.ts` ; `room:created` n'en fait pas partie, n'allant qu'au créateur avec ses propres touches. Mécanique, mais c'est un remaniement de protocole qui mérite son propre passage.

## Le risque à surveiller

C'est le premier morceau de ce découpage qui **touche la base de production**. Le runner de migrations et le backend voyagent dans la même image, et le service `migrations` du dépôt d'infra bloque le démarrage du backend jusqu'à sa réussite : une migration qui ne correspond pas à l'image publiée ne rate pas un déploiement, elle **arrête la production**, parce que `docker compose up` arrête le conteneur en place avant que son remplaçant démarre.

La migration de ce morceau est une création de table, donc additive et sans réécriture de données. C'est le cas le plus sûr, mais il mérite d'être dit plutôt que supposé.
