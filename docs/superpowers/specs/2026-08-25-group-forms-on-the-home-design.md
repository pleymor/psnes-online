# Le groupe se forme sur l'accueil

Conception. Troisième morceau de la suite ouverte par « un salon avant le jeu »
(`2026-08-21-lobby-without-a-game-design.md`) puis « le salon survit à la
partie » (`2026-08-23-lobby-survives-the-room-design.md`). Le premier a détaché
le salon du jeu ; le second l'a détaché du moment. Celui-ci le détache de
**l'écran** : se retrouver ne demande plus d'aller quelque part.

## Pourquoi

L'expérience de groupe est inachevée, et les cinq symptômes n'en font qu'un :
**tout se passe dans la page du salon, et la page du salon est un endroit où il
faut d'abord arriver.**

- L'invitation reçue est enterrée. Elle existe (`TopBar.svelte:227`), mais
  derrière un bouton badge qui ouvre un tiroir dans lequel il faut ensuite
  cliquer « accepter ». Et la `TopBar` n'est montée que sur `/` et `/profile`
  (`routes/+page.svelte:306`, `routes/profile/+page.svelte:236`) : une
  invitation qui arrive ailleurs n'apparaît nulle part.
- Former un duo demande de deviner l'ordre des gestes : créer un salon vide
  (`routes/+page.svelte:147`), y entrer, ouvrir le panneau d'invitation
  (`room/[id]/+page.svelte:749`), inviter, attendre. La liste d'amis, elle, ne
  sait pas inviter du tout.
- Le jeu se choisit à deux endroits — la bibliothèque et le sélecteur du salon
  (`room/[id]/+page.svelte:741`) — dont un seul est visible depuis la page
  d'accueil.
- Rien ne fait bouger le second joueur. Il attend dans son salon qu'un jeu
  apparaisse, ou il attend sur sa bibliothèque sans savoir que son partenaire
  en a choisi un.

La cause commune : **l'accueil ne sait rien de mon salon en direct.** Il lit
`/api/rooms` une fois au montage (`routes/+page.svelte:50`) et ne réécoute plus
jamais rien. Un écran qui ne connaît l'état du groupe qu'à l'instant du
chargement ne peut ni le montrer, ni agir dessus.

## Ce qui est décidé

Sept décisions du propriétaire, prises avant l'écriture, et dont tout le reste
découle.

| Question | Réponse retenue | Ce qui a été écarté |
|---|---|---|
| Nature du groupe | **Le salon existant, sans jeu.** Aucune entité, aucune migration. | Une entité `Group` séparée, qui devrait réapprendre appartenance, présence, cycle de vie. |
| Où atterrit celui qui accepte | **Il reste sur sa bibliothèque.** Le groupe est formé, rien de plus. | Naviguer aussitôt vers le salon, ce qui vide de son sens la navigation déclenchée. |
| Qui choisit le jeu | **N'importe quel membre.** Le dernier clic gagne. | Le créateur seul — l'invité ne pourrait pas proposer un jeu qu'il est le seul à posséder. |
| Le tiroir d'invitations | **Remplacé** par une carte qui s'affiche d'elle-même, partout dans l'application. | Garder les deux : deux endroits pour la même chose, à tenir d'accord. |
| Le bouton « créer un salon » | **Supprimé.** Inviter crée le salon ; la bibliothèque choisit le jeu. | Le garder comme porte vers un salon vide. |
| Clic sur un jeu, seul | **Lancement direct**, sans passer par le lobby. | Le lobby solo, qui n'offre qu'un port et un mode forcé. |
| Clic sur un jeu, partie en cours | **Bouton désactivé**, le bandeau propose le retour au salon. | Laisser partir la demande vers un refus serveur. |

Et une décision prise après la présentation du design : **la `TopBar` reste
montée sur la page du salon**, hors partie. C'est ce qui referme le seul trou
que cette conception ouvrait — ne plus pouvoir réinviter sans revenir à la
bibliothèque.

## Le modèle : le groupe est le salon

Rien à ajouter à `Room`. Un groupe est un salon dont `gameId` est absent —
l'état qu'« un salon avant le jeu » a rendu ordinaire — et ses membres sont
`room.players`. Le plafond de deux joueurs reste celui de `joinRoom`.

Les trois gestes du groupe sont trois événements qui existent déjà :

| Geste | Événement | Effet |
|---|---|---|
| Former le groupe | `room:create {}` puis `lobby:invite` | Un salon vide, une invitation |
| Ouvrir le jeu | `room:choose-game` | Le salon gagne un jeu |
| Quitter le groupe | `room:leave` | Retrait réel du siège, comme aujourd'hui |

Ce qui manque n'est donc pas un modèle. C'est **un signal de navigation** et
**une correction de présence**.

## Les deux ajouts serveur

### `room:opened` — le seul canal de navigation

Nouvel événement, `{ roomId, reason?: 'invitation' }`, qui veut dire exactement
une chose : *va sur la page de ce salon.* Émis à deux endroits :

- `room:choose-game` (`room-handlers.ts:236`), après la mise à jour du salon :
  à **tous** les membres, y compris celui qui vient de choisir. Celui qui
  choisit navigue par le même chemin que l'autre — un seul chemin, donc un seul
  comportement à décrire et à tester.
- `lobby:accept` (`room-handlers.ts:433`), après `joinRoom`, **si et seulement
  si** le salon a déjà un jeu, avec `reason: 'invitation'`. C'est le cas
  « j'invite depuis un salon déjà garni » : l'invité y est emmené, comme
  aujourd'hui, et le `reason` porte ce que le paramètre `?from=invitation`
  portait — de quoi dire « tu arrives dans une partie déjà lancée »
  (`room/[id]/+page.svelte:231`).

Le serveur décide, jamais le client. La tentation était de faire décider la
carte d'invitation d'après le `gameTitle` de l'invitation reçue : c'est faux, et
la course est réelle. A invite B, puis A clique un jeu ; l'invitation que B
détient dans sa carte nomme un salon sans jeu, mais le salon en a un. Seul le
serveur, au moment de l'acceptation, connaît la réponse.

### La présence à la connexion

`markPlayerPresent(io, rooms, userId, getUserSocket)`, exportée par
`room-handlers.ts`, jumelle exacte de `markPlayerAway` (`:801`) : pour chaque
salon dont l'utilisateur est membre, `markOnline` puis les deux diffusions
habituelles. Appelée depuis `handleConnection`, juste avant l'envoi des
invitations en attente (`websocket/index.ts:131`), pour que le `rooms:list` qui
suit reflète déjà la présence.

Sans elle, un membre assis sur l'accueil est marqué **absent** dès qu'il
recharge sa page : la déconnexion du socket appelle `markPlayerAway` (`:176`) et
plus rien ne le remet présent, puisque seul `room:join` le fait et que seule la
page du salon l'émet. Le partenaire le verrait « absent », `isSinglePlayer`
(`room/[id]/+page.svelte:71`) retomberait à vrai et le mode s'effondrerait en
solo — pour quelqu'un qui est là, devant sa bibliothèque.

**Cet ajout ne desserre rien.** `online` veut déjà dire « socket connecté et
assis », pas « sur la page du salon » : depuis « le salon survit à la partie »,
quitter l'écran du salon ne marque personne absent. La garde de `game:start`
contre un partenaire absent (`game-handlers.ts`) garde donc exactement le sens
qu'elle a aujourd'hui.

## Le piège : `io.to(roomId)` ne suffit plus

C'est la partie à ne pas rater, et elle est de la même famille que le
« compter les membres ou compter les présents » du morceau précédent : **deux
manières de parler à un membre, qui ne portent plus au même endroit.**

Un socket n'entre dans le canal socket.io d'un salon que par `room:create`,
`lobby:accept` ou `room:join` — et seule la page du salon émet le troisième.
Donc : un membre assis sur l'accueil **est** dans le canal… jusqu'à son premier
F5, après quoi son nouveau socket n'y est plus, alors qu'il est toujours membre.

| Ce qu'on veut atteindre | Le bon outil |
|---|---|
| Les membres, où qu'ils soient dans l'application | Le socket de chacun, via `getUserSocket` — comme `broadcastRoomUpdate` (`:909`) |
| Les écrans de jeu d'un salon en cours | `io.to(roomId)`, inchangé |

`room:opened` prend donc la première voie. Et l'idée séduisante — faire entrer
tout socket de membre dans le canal à la connexion — est **refusée** : elle
enverrait aussi `room:updated` (le salon brut, avec les mappings de chacun),
`game:started`, et surtout le trafic `znet:*` d'une partie en cours à un onglet
qui affiche une bibliothèque.

## L'accueil

### Un état de salon vivant

`frontend/src/lib/rooms/my-room.ts` : un store qui tient les salons visibles
dans une `Map`, alimenté par `rooms:list` (déjà émis à la connexion,
`websocket/index.ts:140`), `room:update` et `room:destroyed`, semé une fois par
`/api/rooms` pour couvrir le cas où le socket était déjà connecté avant le
montage. Il expose `myRoom` (dérivé de `$user`) et `activeRooms`.

Il remplace `activeRooms` et `loadRooms` de l'accueil (`routes/+page.svelte:27`
et `:50`) — la lecture unique qui rend le bandeau périmé aussitôt affiché — et
alimente la `TopBar` exactement comme le faisait la propriété.

`myRoom.invitation` est déjà porté par la vue publique du salon pour ses
membres (`room-view.ts`), donc l'invitation **sortante** est connue de l'accueil
sans un seul ajout serveur.

### Le bandeau du groupe

À la place du bouton « créer un salon » (`routes/+page.svelte:325`), qui
disparaît. Quatre états, lus dans `myRoom` :

| État | Ce qu'il dit |
|---|---|
| Invitation en attente | *En attente de Bob — 8 min · annuler* |
| Deux membres, pas de jeu | *En groupe avec Bob — choisis un jeu · quitter le groupe* |
| Un jeu, salon en attente | *Zelda · retour au salon · quitter* |
| Salon en partie | *Partie en cours — retour au salon* |

Aucun salon et aucune invitation : rien du tout. Le bandeau n'est pas un
emplacement permanent.

### Le clic sur un jeu : trois cas

Une fonction pure, `frontend/src/lib/rooms/game-click.ts`, répond à
« que fait ce clic ? » à partir de `myRoom` et de mon identifiant :

| Situation | Action | Ce qui part |
|---|---|---|
| Seul (aucun salon, ou salon à un seul membre) | `launch-solo` | `room:create { gameId, gameTitle, autoStart: true }`, puis navigation |
| En groupe (deux membres, salon en attente) | `choose-for-group` | `room:choose-game` — c'est le serveur qui emmène les deux |
| Salon en partie | `blocked` | Rien ; le bouton est désactivé |

Elle est pure et testée à part parce que c'est la seule règle de cette
conception qu'un lecteur pourrait deviner de travers, et la seule dont les trois
branches sont invisibles à l'œil dans le gabarit.

« Seul » inclut le salon à un membre — le résidu d'un groupe que l'autre a
quitté, ou d'une partie solo précédente. `room:create` en abandonne le siège de
lui-même (`leaveCurrentRoom`, déjà couvert par le test « creating a room gives
up the one you were in »), donc rien ne s'accumule et il n'y a pas de cas
particulier à écrire.

Le lancement direct n'ajoute aucun chemin : `autoStart` existe déjà dans
`room:create` (`room-handlers.ts:136`), le salon naît `playing`, la page du
salon reçoit `game:started` en réponse à son `room:join` — le chemin de reprise
déjà documenté — et `SoloRoom` démarre seul (`SoloRoom.svelte:673`). Le seul
écran intermédiaire possible reste le sélecteur de fichier ROM, qui est
l'affaire de `boot()` et ne change pas.

`GameCard` gagne deux propriétés : `playDisabled`, et un libellé de bouton
variable — *Jouer* seul, *Jouer avec Bob* en groupe. Le bouton dit ce qu'il
fait.

Reprendre depuis une sauvegarde suit la même règle : seul, `?save=` sur un
lancement direct, comme aujourd'hui ; en groupe, `room:choose-game` puis
`room:choose-save`. Pour un invité, le serveur refuse la sauvegarde
(`room-handlers.ts:636` — « seul le joueur qui a ouvert le salon peut choisir
une sauvegarde ») : le jeu est choisi, le refus s'affiche tel quel, et rien
n'est désactivé par avance. La règle est celle du serveur, dite par le serveur.

### Inviter depuis la liste d'amis

Chaque ligne de `FriendsList` gagne un bouton, et trois états lus dans
`myRoom` : **Inviter** / *invité… annuler* / *dans ton groupe*. Le bouton
disparaît quand le groupe est plein ou que le salon est en partie.

L'action vit dans `frontend/src/lib/rooms/group.ts` : `inviteToGroup(friendId)`
crée le salon s'il n'en existe pas encore, puis émet `lobby:invite` ;
`leaveGroup()` émet `room:leave`. Une implémentation, appelée par la liste
d'amis et par le bandeau — pas deux copies, ce qui est précisément ce qui a fait
dériver la liste d'amis et l'écran du salon jusqu'ici.

Le salon créé en coulisse n'est pas un détail à cacher : le bandeau apparaît
dans le même geste et le nomme.

## La notification d'invitation

`frontend/src/lib/components/InvitationCard.svelte`, montée dans
`+layout.svelte` à côté de `NotificationToast` — donc **partout**, et plus
seulement sur les deux pages qui portent la `TopBar`. Une carte épinglée qui
apparaît d'elle-même : qui invite, à quoi, dans combien de temps ça expire,
**Accepter** et **Refuser**.

Ce n'est pas un toast : une invitation vaut dix minutes, elle ne s'évanouit pas
au bout de trois secondes. Elle est masquée pendant qu'une partie tourne — un
panneau par-dessus un émulateur n'a pas à voler un clic — et accepter n'est de
toute façon pas ce qu'on veut faire au milieu d'une partie.

La logique quitte `TopBar` pour `frontend/src/lib/lobby/invitations.ts` : la
liste, son remplacement à chaque connexion, l'horloge d'expiration, et
l'attribution des refus serveur au seul envoi en vol — quatre règles écrites
avec soin dans la `TopBar` actuelle, qui **déménagent sans être réécrites**.

Accepter ne navigue plus. Le store oublie l'invitation, la carte se ferme, le
groupe est formé. La navigation, quand elle a lieu, arrive par `room:opened`,
écouté une seule fois dans `+layout.svelte`.

## La page du salon : ce qui part, ce qui reste

La `TopBar` est montée dans la branche `{#if !gameStarted}`, jamais au-dessus
d'une partie. Conséquence CSS à ne pas oublier : `.room-container` est en
`height: 100vh` avec `overflow: hidden` (`room/[id]/+page.svelte:964`) ; la
règle `:has(.lobby)` existante (`:973`) devient `flex: 1` au lieu d'une hauteur
fixe, pour que le lobby occupe ce qui reste sous la barre. La branche de jeu
garde ses `100vh` intacts.

**Ce qui part**, avec toute la plomberie qui n'existait que pour lui :

| Retiré | Ce qui l'accompagne |
|---|---|
| Le sélecteur de jeu (`:741`) | `showGamePicker`, `pickerDecided` (`:222`), `chooseGame` (`:451`) |
| Le panneau d'invitation (`:749`) | `showInvite`, `inviteFriend` (`:476`), `cancelInvitation` (`:488`), `loadFriends` (`:418`), `friends` |
| Le panneau « en attente de X » | `PendingInvitation`, `pendingInvitation`, `liveInvitation` (`:200`), `expiryLabel` (`:210`), `sawRoomView`, `handleRoomView` (`:337`), `seedPendingInvitation` (`:435`), l'écoute de `room:update` (`:598`), l'horloge `now`/`clock` (`:609`) |
| Les trois retours d'invitation | `handleInviteSent`, `handleInviteDeclined`, `handleInviteCancelled` et leurs `on`/`off` (`:602`, `:634`) |

Environ deux cents lignes, et une écoute de socket en moins.

**Ce qui reste**, intact : `RoomPlayers` et le choix des ports, le sélecteur de
mode, la sauvegarde de départ et son panneau (`showSavePicker`, `chooseSave`,
`clearStartingSave`), *Démarrer*, *Quitter le salon* avec sa confirmation, la
reprise d'une partie en cours (`handleRoomUpdated`), `entryFailed`, et les trois
composants d'émulation. `loadMyGames` reste : le store des jeux sert encore à
retrouver ma ligne de bibliothèque pour ce salon (`myGameForRoom`) et ses
sauvegardes.

Le titre « aucun jeu choisi » et l'indice `chooseGameToStart` restent aussi. Ce
n'est plus un état du flux normal, mais une URL tapée à la main y mène encore,
et l'indice renvoie désormais vers la bibliothèque.

## Ce qui est testable, et ce qui ne l'est pas

`backend/test/lobby-protocol.test.ts` conduit déjà quarante tests sur de vrais
sockets ; les trois règles nouvelles s'y écrivent sans échafaudage :

- **`room:opened` atteint les deux membres** quand un membre choisit le jeu — y
  compris celui qui choisit, et y compris un membre dont le socket n'est pas
  entré dans le canal du salon. C'est le test qui interdit la régression
  « `io.to(roomId)` a l'air de marcher ».
- **Accepter dans un salon garni émet `room:opened` avec `reason:
  'invitation'`, et reste muet dans un salon sans jeu.** La course décrite plus
  haut se prouve ici : choisir le jeu *après* l'envoi de l'invitation, puis
  accepter, doit emmener l'invité.
- **Une reconnexion remet le membre présent** dans son salon et le dit à
  l'autre membre.

`core/test/game-click.test.ts` couvre les trois branches de la décision de clic,
sur le modèle de `online-players.test.ts` qui importe déjà un module du frontend
(`core/test/online-players.test.ts:16`). À ajouter au script `test:ui`.

Ce qui n'est pas testé automatiquement, et qu'il faudra regarder à deux
machines : la carte d'invitation qui apparaît d'elle-même, et le fait que le
second joueur se retrouve bien emmené. Deux profils de développement existent
pour ça (`loginDev('1')`, `loginDev('2')`).

Traductions : les nouveaux libellés en `en` et `fr` dans
`frontend/src/lib/i18n/translations.ts`, et retrait de ceux qui n'ont plus de
site d'affichage.

## Ce que cette conception refuse de faire

- **Un groupe à plus de deux.** Le netplay est à deux, `joinRoom` plafonne à
  deux, et un « groupe » de quatre dont deux jouent serait une file d'attente —
  un autre morceau, pas un plus grand nombre ici.
- **Une invitation par lien partageable.** L'invitation reste adressée à un ami.
- **Un salon vide atteignable exprès.** Il n'existe plus que le temps d'une
  invitation.
- **Une notification hors de l'onglet** (Web Push, titre qui clignote). La carte
  est dans l'application ; être prévenu quand l'application est fermée est un
  autre sujet.

## Le risque à surveiller

Le clic sur un jeu fait deux choses différentes selon l'état du groupe :
lancer une partie solo, ou emmener deux personnes dans un salon. C'est ce que
demande le flux, et le libellé du bouton le dit — mais c'est le seul endroit de
l'application où un même bouton a deux sens. Si un doute apparaît à l'usage,
le remède est dans le libellé et le bandeau, pas dans un troisième bouton.

Second point de vigilance : `room:opened` navigue depuis le layout, donc depuis
n'importe quel écran. Il ne doit jamais être émis pour un salon en partie —
`room:choose-game` est déjà refusé dans cet état (`room-handlers.ts:246`), et
c'est cette garde, pas le client, qui empêche d'arracher quelqu'un à sa partie.
