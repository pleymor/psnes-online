# Le salon survit à la partie

Conception. Suite directe de « un salon avant le jeu » (`2026-08-21-lobby-without-a-game-design.md`), qui a détaché le salon du jeu. Ce morceau-ci le détache du **moment**.

## Pourquoi

Le morceau précédent a rendu possible de se retrouver d'abord et de choisir le jeu ensuite. Il n'a pas rendu possible de se retrouver **une fois**. Aujourd'hui, quitter l'écran de salle défait le duo, et il faut ré-inviter.

La cause tient en une ligne. Le `onDestroy` de l'écran de salle émet `room:leave` (`frontend/src/routes/room/[id]/+page.svelte:517`). Naviguer vers la bibliothèque, c'est donc *partir pour de bon* : côté serveur, `handleLeaveRoom` (`backend/src/websocket/room-handlers.ts:775`) retire le joueur de `room.players`, et si c'était le dernier, détruit le salon et supprime ses invitations. Il n'a jamais existé de « partir un instant ».

Le reste du système est cohérent avec cette ligne, et c'est ce qui rend le symptôme total : `room:join` n'accepte qu'un membre, l'invitation est la seule porte d'entrée depuis le morceau précédent, et un salon vide n'existe pas assez longtemps pour qu'on y revienne. Un joueur parti est donc un joueur qu'il faut réinviter, même si son partenaire est resté assis dans le salon.

## Ce qui est décidé

Quatre décisions du propriétaire, prises avant l'écriture, et dont tout le reste découle :

| Question | Réponse retenue | Ce qui a été écarté |
|---|---|---|
| Nature du lobby durable | **Le salon cesse de mourir.** Pas de seconde entité. | Une entité `Lobby` séparée, qui devrait réapprendre appartenance, présence et reprise. |
| Durée de vie d'un salon vide | **Quelques heures.** Instantané Redis, aucune migration. | La persistance SQLite indéfinie, qui toucherait la base de production. |
| Sens de « quitter » | **On reste membre, marqué absent.** Dissolution par un geste explicite. | Deux listes, membres durables et présents — deux endroits à tenir d'accord. |
| Multiplicité | **Un seul salon à la fois.** | Plusieurs salons listés sur l'accueil. |

Le refus d'une seconde entité reprend l'argument du morceau précédent : `Room` sait déjà faire l'appartenance, la présence, la persistance et la reprise après reconnexion, et une seconde entité devrait tout réapprendre.

## Le modèle

`RoomPlayer` (`backend/src/types/index.ts:26`) gagne **`online: boolean`**. Une déconnexion socket le met à `false` et diffuse ; elle ne retire plus personne. `Room` gagne **`abandonedAt?: Date`**, posé à l'instant où le dernier membre passe hors ligne, effacé dès que quelqu'un revient.

C'est tout le modèle. Un booléen et une date.

### Ce que « quitter » veut dire, maintenant

Deux gestes, deux effets, et la distinction est le cœur de ce morceau :

| Geste | Effet |
|---|---|
| Fermer l'onglet, naviguer ailleurs, perdre le réseau | `online = false`. Le siège reste. |
| Cliquer « quitter le salon » | Retrait réel de `room.players`, comme aujourd'hui. |

Le `onDestroy` de l'écran de salle **cesse d'émettre `room:leave`** ; il se contente de se désabonner. Le serveur apprend l'absence par la déconnexion du socket — ou ne l'apprend pas, si l'onglet reste ouvert ailleurs dans l'application, ce qui est correct : ce joueur est toujours là.

`room:leave` garde exactement sa sémantique actuelle. Il change seulement d'émetteur : un bouton, avec confirmation, au lieu d'un cycle de vie de composant. C'est ce qui permet aux quatre fichiers Playwright qui l'émettent pour ranger derrière eux — `resilience`, `rom-transfer`, `room-authz`, `znet-relay` — de continuer à fonctionner sans retouche.

### La mort d'un salon abandonné

Un salon qui ne meurt plus quand il se vide doit mourir d'autre chose, sinon il fuit.

Un balayeur détruit les salons dont l'`abandonedAt` dépasse **douze heures**. La décision est une fonction pure prenant l'instant en paramètre — jamais `Date.now()` à l'intérieur. C'est la même exigence que pour la machine à états des invitations, et pour la même raison : sans horloge injectée, aucun test ne peut faire vieillir un salon, et l'expiration est précisément ce qu'il faut prouver.

**Douze heures couvre le vrai cas** — on quitte, on change de jeu, on dîne, on revient. Sa conséquence doit être connue avant l'usage plutôt que découverte : **revenir le lendemain soir ne marchera pas.** Le salon aura expiré et il faudra ré-inviter une fois. C'est le prix assumé du choix « pas de migration ». Le passage à une persistance durable est un morceau séparé, pas une rustine à ajouter ici.

## Le piège : compter les membres, ou compter les présents

C'est la partie à ne pas rater, et elle est de la même famille que la distinction `requireGame` / `room-view.ts` du morceau précédent : **deux réponses justes à la même question, séparées par le site qui la pose.**

Quatre endroits comptent aujourd'hui `room.players` et devront compter les **présents** :

| Où | Ce qui casse sans le changement |
|---|---|
| `game-handlers.ts:42` — la garde de `game:start` | Une partie lockstep lancée contre un partenaire absent : deux écrans qui s'attendent pour toujours. |
| `game-handlers.ts:74` — `allReady` dans `game:ready` | Un absent qui détient un port ne sera jamais `emulationReady`, donc `game:go` n'est **jamais** émis. Panne silencieuse, sans message d'erreur nulle part. |
| `room/[id]/+page.svelte:71` — `isSinglePlayer` | Un partenaire absent ferait croire au client qu'il est en réseau ; `effectiveEmulationMode` (`:74`) en découle directement. |
| La liste d'amis, via `isRoomVisibleTo` (`room-view.ts:143`) | Un ami paraîtrait « en salon » toute la nuit, dans un salon où personne n'est assis. |

Et **deux endroits doivent continuer de compter les membres** :

- La garde du panneau d'invitation (`room/[id]/+page.svelte:625` et `:688`, `room.players.length < 2`). Le siège d'un absent lui appartient toujours. « Un seul salon à la fois » veut dire qu'on dissout avant d'inviter quelqu'un d'autre — pas qu'un partenaire aux toilettes se fait remplacer.
- La capacité dans `joinRoom` (`room-handlers.ts`, le `room.players.length >= 2`). Même raison, et c'est ce qui empêche un tiers de prendre le siège d'un absent.

**Un accesseur par côté, pas quatre comparaisons.** `onlinePlayers(room)` rend les joueurs présents. Il en faut **deux exemplaires, un par processus** : `backend/src/rooms/online-players.ts` pour les trois sites serveur, et son équivalent côté client pour `isSinglePlayer`. Ces deux mondes ne partagent aucun module — le prétendre ici produirait une tâche impossible au moment de l'écrire. La duplication est de trois lignes et le type `RoomPlayer` existe des deux côtés ; c'est le prix, et il est plus petit que celui d'un paquet partagé créé pour l'occasion.

Deux raisons de préférer un accesseur à des comparaisons dispersées, et ce sont les mêmes que pour `requireGame` : une comparaison répétée quatre fois sera oubliée à la cinquième, et un accesseur unique est une fonction pure qu'un test peut fixer.

## Les portes

**Rentrer ne demande rien de neuf.** `room:join` passe déjà par `getMemberRoom`, qui accepte quiconque figure dans `room.players`. Puisqu'un absent y reste, la porte de retour s'ouvre d'elle-même, et la branche « joueur existant » de `joinRoom` (`room-handlers.ts:604`) fait déjà exactement le bon travail — elle posera `online = true` en plus.

C'est aussi, sans une ligne de plus, le **correctif du défaut nº2** relevé au morceau précédent : « passé 45 secondes, un membre est enfermé dehors d'un salon qui existe encore, sans chemin de retour ». Il n'y a plus de quarante-cinq secondes, et plus de dehors.

**Un seul salon à la fois.** `room:create` et `lobby:accept` commencent par dissoudre la place du demandeur dans son salon courant, par le chemin de `room:leave`. Sans ça, un joueur accumule des salons que plus rien ne détruit tout seul — la conséquence directe d'avoir retiré la mort automatique.

**La porte sur l'écran principal.** L'accueil reçoit déjà ses salons : `loadRooms()` lit `/api/rooms` (`frontend/src/routes/+page.svelte:37`) et `rooms:list` en fait autant sur la socket. Il suffit d'y chercher le salon dont on est membre et d'afficher, à la place du bouton « créer un salon », un « reprendre le salon avec X ». **Aucun événement nouveau, aucun champ nouveau côté protocole.**

## Ce qui est supprimé

Ce morceau retire plus de code qu'il n'en ajoute, et c'est son meilleur argument.

Toute la machinerie temporelle des départs s'en va : `pendingDepartures`, `armDeparture`, `scheduleLeaveRoom`, `cancelScheduledLeave`, `holdRestoredSeat`, `DISCONNECT_GRACE_MS`, `RESTART_GRACE_MS`. Elle existait pour tenir un siège pendant qu'un joueur pouvait encore revenir ; il n'y a plus de siège à tenir, seulement un booléen qui bascule.

- `websocket/index.ts:159` n'arme plus rien : il marque hors ligne, et pose `abandonedAt` si c'était le dernier.
- `restoreRooms` n'a plus besoin de son rappel `holdSeat`. Après un redémarrage, tout le monde est hors ligne par définition — désormais un état ordinaire au lieu d'une urgence à cinq minutes.

Le commentaire de `RESTART_GRACE_MS` raconte une panne en chaîne : siège libéré, salon vidé, salon détruit, instantané vide, et le joueur qui revient reçoit « Room not found » sur un écran figé sur « connexion ». Cette panne devient **structurellement impossible**, pas seulement moins probable.

**Une perte à consigner plutôt qu'à laisser disparaître d'un rapport de couverture.** Le relevé de vérification précédent décrit une sentinelle : un test qui arme les vraies quarante-cinq secondes et les laisse armées, pour que la suite détecte elle-même la disparition du `unref` au lieu de simplement ralentir. Elle part avec le mécanisme qu'elle surveillait. C'est justifié — elle gardait du code qui n'existera plus — mais le `unref` reste une exigence vivante pour l'intervalle de l'instantané, et rien ne le garde une fois cette sentinelle partie.

## L'instantané Redis

Un salon durable au repos est **exactement l'état que le mécanisme actuel laisse expirer en silence**. Deux corrections, et un déplacement d'autorité.

### Le défaut

`writeSnapshot` fait `if (body === lastWritten) return false` (`room-snapshot.ts:131`). Un monde qui ne change pas cesse donc de réécrire la clé, et le `EX: 3600` (`:10`) finit par l'expirer. Aujourd'hui c'est peu visible : un salon vide est détruit, et un salon habité bouge sans arrêt. Un salon abandonné, lui, ne produit plus une seule écriture — et c'est précisément ce qu'on veut préserver.

Tant que le processus vit, la mémoire fait autorité et la clé disparue ne se voit pas. Elle se voit au redémarrage suivant, où tous les salons durables ont disparu.

### Les deux corrections

1. **Rafraîchir sans réécrire.** `writeSnapshot` garde son court-circuit mais compte ses passages : tous les **3600 tics** sans écriture — une heure, à un tic par seconde (`:11`) — il appelle `expire(KEY, TTL)`. Un **compteur de tics plutôt qu'une horloge** : compter est déterministe, et un test le pilote en appelant la fonction 3600 fois avec le talon `Store` qui existe déjà, sans faire avancer le temps. `Store` gagne une méthode `expire`.

   Une heure contre vingt-quatre laisse une marge de vingt-trois : la clé survit à vingt-deux rafraîchissements manqués d'affilée avant d'expirer. Le compteur se remet à zéro à chaque écriture réelle, de sorte qu'un salon actif ne paie jamais l'appel supplémentaire.

2. **`TTL_SECONDS` passe de une heure à vingt-quatre.**

### Le déplacement d'autorité

Le commentaire actuel du TTL — « un garde-fou, pour qu'une longue panne ne ressuscite pas un monde périmé » — décrit un travail que le TTL faisait mal, parce qu'il confond *stocké depuis longtemps* et *abandonné depuis longtemps*.

`restoreRooms` **balaie immédiatement après avoir lu**. Un salon abandonné au-delà de ses douze heures meurt au démarrage, quel que soit l'âge de la clé. Le balayeur devient la seule autorité sur la péremption, le TTL redevient une simple borne de stockage, et les deux cessent de se disputer la même question.

## Ce qui est testable, et ce qui ne l'est pas

**Testable, en fonctions pures :**

- `onlinePlayers(room)`, des deux côtés — l'accesseur des quatre sites qui doivent compter les présents, et qui doit *ne pas* être appliqué aux deux qui comptent les membres. Les deux exemplaires méritent chacun leur test : ils ne partagent pas de code, donc rien ne les empêche de diverger.
- La décision d'abandon, à partir d'`abandonedAt` et d'un instant, **borne exacte comprise** — comme l'expiration d'invitation a la sienne, et comme elle c'est le `<=` qui doit être prouvé.
- La transition de présence : le dernier membre qui passe hors ligne pose `abandonedAt`, le premier qui revient l'efface.
- Le rafraîchissement de l'instantané : N tics sans changement déclenchent un `expire` et aucun `set`.

**Testable contre un vrai serveur socket**, dans la veine des vingt-neuf tests de protocole existants — ils tournent déjà sur du TCP réel avec les gestionnaires de production, donc ceci s'y ajoute sans nouveau harnais :

- Une déconnexion laisse le joueur dans `room.players`, marqué hors ligne, et **ne détruit pas** le salon même s'il était seul.
- Il rentre par `room:join` **sans invitation**, et repasse en ligne.
- `room:leave` explicite retire bel et bien, et vide le salon si c'était le dernier.
- `game:start` **refuse** quand le partenaire est hors ligne. C'est la garde qui compte le plus : sans elle, deux écrans s'attendent pour toujours.
- `room:create` et `lobby:accept` dissolvent la place précédente du demandeur.

**Non testable ici, et vérifié à la main :** l'affichage « absent », le bouton de dissolution et sa confirmation, la porte « reprendre le salon avec X » sur l'accueil, et le fait qu'un ami hors ligne cesse de paraître en salon.

**Et lancé explicitement, pas déduit du vert :** `npm run test:e2e`. Le relevé précédent a appris que `test:all` ne lance pas Playwright, et que huit tâches sont passées au vert pendant que quatre fichiers bout-en-bout devenaient faux. Le contrôle qui aurait dû le dire n'était pas dans la boucle.

## Ce que cette conception refuse de faire

**Pas de persistance SQLite.** Décidé : douze heures en Redis, aucune migration, la base de production n'est pas touchée. Le morceau précédent notait que toucher cette base est le risque à surveiller ; celui-ci s'en abstient entièrement.

**Pas de fusion de `room:updated` et `room:update`.** Toujours reporté, toujours documenté dans la spec du morceau précédent avec ses deux pièges. Ce morceau ajoute onze émissions de plus à la dette, il ne la rembourse pas.

**Pas de correction du défaut nº1** — l'invitation qui n'est visible que si l'invité se trouve sur l'accueil ou son profil à cet instant précis. C'est le défaut qui gêne le plus à l'usage, et il mérite son propre passage. Il faut noter qu'il **s'aggrave légèrement ici** : un joueur qui attend dans son salon durable est encore plus susceptible d'y être au moment où on l'invite ailleurs. Cela dit, « un seul salon à la fois » réduit la portée du problème, puisqu'accepter une invitation dissout de toute façon le salon courant.

**Pas de badges ROM cliquables.** Défaut nº3, inchangé.

## Le risque à surveiller

Aucune migration : le risque n'est pas dans la base, il est dans l'invariant.

**Un salon qui ne meurt plus tout seul est un salon qui peut fuir.** Trois chemins posent ou lèvent `abandonedAt` et ne doivent jamais se contredire : la déconnexion, la dissolution explicite, et la reprise au démarrage. Un `abandonedAt` jamais posé donne un salon immortel, invisible et impossible à dissoudre puisque personne n'y entre plus ; posé à tort, un salon qui disparaît sous deux joueurs actifs.

C'est ce que les tests de transition de présence ciblent en premier, et c'est la raison pour laquelle la pose et la levée vivent dans une seule fonction plutôt qu'aux trois sites qui la déclenchent.
