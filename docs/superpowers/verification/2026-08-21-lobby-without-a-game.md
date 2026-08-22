# Vérification — un salon avant le jeu

Branche `lobby-without-a-game`, 20 commits, 32 fichiers, +3683 / −215. Ce relevé sépare ce qu'une machine a vérifié de ce que personne n'a encore regardé, et nomme précisément ce qu'aucune des deux ne couvre.

## Ce qui est vérifié mécaniquement

Lancé sur `e4b2a1c` :

```
npm run test:all                      37 / 11 / 112 / 108  — 0 échec, 31 s
npm run check --workspace frontend    0 erreur, 16 avertissements
npm run build --workspace frontend    exit 0
npx tsc --noEmit -p backend/tsconfig.json   exit 0
```

La suite backend est passée de **66 à 108 tests** pendant ce morceau. Avant lui, la couche websocket n'en avait **aucun** — non par nature, mais parce qu'un `setInterval` de nettoyage de cache n'était pas `unref()` et bloquait indéfiniment tout runner qui importait ces fichiers. Une ligne l'a débloquée.

### Ce que les tests prouvent réellement

Les 25 tests du protocole de salon tournent contre un **vrai** `http.Server` et une **vraie** paire client/serveur socket.io sur du TCP, avec les gestionnaires de production. Ce n'est pas un appel de fonction déguisé.

Une seule chose y est court-circuitée : le serveur réel lit l'identité dans la session Express, alors que le harnais l'injecte dans la poignée de main. **Le chemin cookie / session / Passport n'est donc couvert par aucun test automatique** — et cette limite n'est pas née avec ce morceau, elle a toujours existé pour ce fichier.

### Les gardes prouvées capables d'échouer

Chacune a été cassée exprès, vue rouge, puis restaurée :

| Garde | Ce qui tombe quand on la casse |
|---|---|
| L'état décidé d'une invitation | 2 tests (acceptée **et** refusée) |
| L'expiration à l'instant exact (`<=`) | 1 test, et lui seul |
| Les trois états de disponibilité de ROM | 2 tests |
| L'existence du salon à l'acceptation | 1 test |
| Le refus d'`autoStart` sans jeu | 1 test |
| Le nettoyage des invitations d'un salon mort | 1 test |
| Le filtrage des salons disparus à la connexion | 1 test |
| La conversion des dates au retour de la base | 1 test |
| La colonne ROM dans la vue | 2 tests |
| La nouvelle porte de `room:join` | 1 test |
| **Le `unref` des minuteurs de départ** | la suite passe de 0,9 s à 48 s **et** échoue |

La dernière est une sentinelle : elle arme les vraies 45 secondes et les laisse armées, pour que la suite détecte elle-même la disparition du `unref` au lieu de simplement ralentir.

## Le mode opératoire à deux joueurs, en local

C'est ce que le propriétaire a demandé explicitement.

### Monter la pile

Le backend doit tourner sur `3000` et le frontend sur `5173`, **avec le code de cette branche**. Attention : des conteneurs `psnes-*` peuvent déjà tourner depuis des jours avec du code antérieur — auquel cas ils ne testent pas cette branche. Vérifier que `http://localhost:3000/health` répond avant de conclure quoi que ce soit.

### Être deux personnes sur une seule machine

La session est un cookie, donc deux fenêtres du même profil sont **la même personne**. Il faut deux profils de navigateur, ou une fenêtre normale et une fenêtre privée.

En mode dev (`AUTH_MODE=dev`), l'accueil déconnecté affiche deux boutons, « Dev User 1 » et « Dev User 2 ». Un clic différent dans chaque fenêtre suffit. Les deux comptes doivent être **amis** pour s'inviter : si la liste d'amis est vide, faire la demande depuis l'un et l'accepter depuis l'autre.

### Le parcours

- [ ] Depuis la bibliothèque, **créer un salon** — le bouton dédié, pas ▶ sur un jeu.
- [ ] Le salon s'affiche **sans jeu**, avec un état d'attente. Il ne doit **pas** dire « chargement » : ce serait attendre quelque chose qui n'arrivera jamais.
- [ ] Le bouton de lancement est **désactivé** tant qu'aucun jeu n'est choisi.
- [ ] **Inviter l'autre joueur.** L'invitation apparaît dans sa barre du haut, sans rechargement.
- [ ] Il **accepte** : il rejoint le salon, les deux le voient à deux joueurs.
- [ ] **Chacun à son tour choisit un jeu.** Le choix est révocable jusqu'au lancement, et le picker ne doit proposer que **ses propres** jeux.
- [ ] L'indicateur de ROM apparaît à côté de chaque joueur. **Deux états atteignables à la main** : possédée et absente. Le troisième, *inconnue*, n'est pas produisible depuis l'interface — le sélecteur désactive les jeux sans checksum — donc ne pas le chercher ; il est couvert par les tests.
- [ ] **Lancer depuis l'un**, jouer, sauvegarder, quitter. **Relancer depuis l'autre** : les sauvegardes doivent suivre **celui qui a lancé**.
- [ ] Recharger la page d'un joueur : son siège est conservé (délai de grâce de 45 s) et l'indicateur de ROM **revient** au lieu de rester vide.

### Les chemins d'échec, à provoquer exprès

- [ ] **Refuser** une invitation : elle disparaît des deux côtés.
- [ ] **Laisser expirer** une invitation. Dix minutes, ou modifier `expiresAt` en base pour aller plus vite.
- [ ] **Accepter une invitation vers un salon disparu** : quitter le salon des deux côtés après avoir invité, puis accepter. Doit être refusé avec un message qui le dit, pas planter.
- [ ] **Accepter une invitation dans un salon déjà lancé** : l'écran doit annoncer qu'on rejoint une partie en cours, et l'annoncer **une seule fois** — pas à chaque rechargement.
- [ ] **Choisir un jeu que l'autre ne possède pas**, et vérifier que son indicateur le dit avant le lancement.
- [ ] **Tenter d'entrer sans invitation** : ouvrir l'URL d'un salon dont on n'est pas membre. Doit être refusé.

### Ce qui ne doit **pas** avoir changé

- [ ] **▶ sur un jeu mène toujours à l'écran de salle avec ce jeu déjà choisi**, où l'on presse démarrer. Ne pas s'attendre à un lancement immédiat : le client envoie `autoStart: false` et l'a toujours fait. La spec disait le contraire ; elle avait tort, et c'est corrigé.
- [ ] Se reconnecter après une coupure réseau **rend le siège**, mais seulement **dans les 45 secondes** — c'est le délai de grâce. Recharger la page passe dessous sans peine ; couper le réseau une minute entière ne passe pas, et il n'y a alors **aucun chemin de retour** : il faut une nouvelle invitation. C'est la conséquence directe de la porte qu'on vient de fermer, et il faut savoir si elle est acceptable avant de fusionner.
- [ ] La liste d'amis reste cliquable pour ouvrir la fiche d'un ami, même si le bouton « rejoindre » a disparu.
- [ ] Un ami qui crée un salon puis choisit son jeu : la ligne de statut doit apprendre le titre, pas rester figée.

### Les tests bout-en-bout, qui n'ont pas pu être lancés ici

Quatre fichiers Playwright asseyaient un invité par un `room:join` brut, ce que la nouvelle porte refuse. Trois ont été réparés pour passer par l'invitation ; **ils n'ont pas pu être exécutés** — le backend joignable localement faisait tourner du code antérieur à cette branche, et redémarrer l'environnement du propriétaire était hors limites.

- [ ] Lancer `npm run test:e2e` contre une pile à jour. C'est le **seul** endroit qui exercera la nouvelle porte à travers la vraie session et Passport.
- [ ] `e2e/probe-lockstep.mjs` est laissé cassé sciemment : script manuel, dans aucun script npm ni aucune CI. Il échouera à son étape d'entrée d'invité.

### Trois défauts connus, à ne pas redécouvrir

La revue finale les a trouvés après l'écriture de ce relevé. Ils sont écrits ici pour que la passe manuelle serve à trouver ce que personne n'a vu, pas à retrouver ceux-là.

- **Une invitation n'est visible que si l'invité se trouve sur l'accueil ou son profil à cet instant précis**, et elle est perdue dès qu'il navigue ailleurs. La liste n'est envoyée qu'à la connexion du socket, et la barre du haut n'existe pas sur l'écran de salle. Quelqu'un qui attend dans son propre salon vide ne verra jamais l'invitation qu'on lui envoie.
- **Passé 45 secondes, un membre est enfermé dehors** d'un salon qui existe encore, sans chemin de retour.
- **`game:start` est la onzième garde oubliée** : rien ne vérifie qu'un jeu est choisi. Inatteignable depuis l'interface (le bouton est désactivé), mais un client bricolé produit un salon dont les deux écrans sont blancs et dont on ne sort qu'en éditant l'URL. En cours de correction avec le défaut de sauvegarde.

## Reporté sciemment

- **Les touches vues par l'autre joueur.** Les onze émissions de `room:updated` envoient la salle brute aux membres, donc chaque joueur reçoit celles de l'autre. La fuite sérieuse — vers **tous les amis connectés** — est fermée. Le reste est détaillé dans la spec, avec les deux pièges à connaître avant de fusionner les événements.
- **Aucun `tsconfig` ne couvre `e2e/`.** Ces fichiers ne sont typés par aucun contrôle habituel ; il a fallu une invocation ponctuelle. Un répertoire de tests que rien ne compile est un répertoire où un renommage pourrit en silence.
- **Les badges « absente » et « inconnue » sont des culs-de-sac** : ils désignent le problème sans offrir de chemin pour aller lier le fichier, ni de rafraîchissement.
- **Le cas de deux acceptations simultanées n'a pas de test**, et n'en aura pas d'honnête : le correctif a supprimé la fenêtre de course, donc un test devrait recréer une situation qui n'existe plus.

## Ce que ce morceau a appris sur ses propres contrôles

**`test:all` ne lance pas Playwright.** Les huit tâches sont passées au vert pendant que quatre fichiers bout-en-bout devenaient faux. Le contrôle qui aurait dû le dire n'était pas dans la boucle — comme le build ne l'était pas au morceau précédent.

**Un type qui ment vaut un contrôle absent.** Le frontend déclarait `gameId` et `gameTitle` obligatoires alors que le serveur pouvait déjà les omettre, et `svelte-check` annonçait zéro erreur. Rendre le type honnête a transformé « chercher les sites en lisant » en « le compilateur les nomme ». Même famille : `createdAt` déclaré `Date` mais reçu en chaîne ISO, inoffensif seulement parce que personne ne l'utilisait comme une date.

**Une correction peut rendre visible le problème suivant.** Le `unref` du cache a débloqué les tests de la couche websocket — et a du même coup fait passer un test de déconnexion de « bloqué pour toujours » à « 45 secondes », ce qui se serait lu comme une machine lente. C'est la sentinelle qui a transformé ça en échec franc.
