# Voir son classement

Conception pour l'issue #72. Depuis la fusion de #61, le service enregistre une
ligne par KO et en dérive une cote Elo par joueur et par jeu — et personne ne
peut rien en voir. Cette spec rend ces données visibles dans les deux endroits
où elles servent : le salon, juste avant de lancer, et un écran complet.

Chemins et numéros de ligne : `main` au 2026-09-18.

## Pourquoi maintenant, et pourquoi pas seulement le classement

Le §9 de #61 mettait l'affichage hors périmètre, avec un argument juste : on ne
savait pas encore si les verdicts seraient fiables, et dessiner un écran autour
de données douteuses aurait été à refaire.

Ils sont fiables, mais **personne ne peut le constater**. Vérifier qu'un KO a
été enregistré, et enregistré à l'endroit, demande aujourd'hui une session `ssh`
sur le VPS et une requête SQL contre `prod.db`. C'est le vrai moteur de ce
chantier, et c'est ce qui décide de son contenu : **une cote seule ne suffit
pas**. Un nombre qui passe de 1000 à 1016 ne dit ni quelle partie l'a fait
bouger, ni si le bon joueur a été crédité — précisément le défaut que la
relecture finale de #61 a rattrapé, où le serveur lisait l'identité sur le siège
du salon pendant que la machine émulée jouait selon le rôle hôte/invité.

**L'historique des parties fait donc partie du cœur**, pas des bonus. Une liste
« à telle heure, contre untel, gagné » est ce qui remplace la requête SQL.

## Ce qui existe déjà, et qu'on ne casse pas

| Existant | Ce qu'il devient |
|---|---|
| `Match` et `Rating` (migration 0008) | Inchangées. Cette spec n'écrit rien, elle ne fait que lire. |
| `Rating_gameCrc32_rating_idx` sur `(gameCrc32, rating)` | Sert enfin. Posé pour le voisinage de cote, il trie aussi une page. |
| `ratingFor()` dans `db/matches.ts` | N'était appelé que par les tests. Devient du code vivant. |
| `RoomPlayer` | **Intact.** Voir « le chemin des données » ci-dessous. |
| `toPublicUser()` | Câblé pour la première fois : il existe mais n'est servi nulle part. |

## Les décisions déjà prises

1. **Un classement par jeu**, pas de cote unique tous jeux confondus. Ça
   confirme le §5.6 de #61 : une cote de 1200 sur un jeu et 1200 sur un autre
   décrivent deux populations et ne se comparent pas.
2. **Aucun seuil de parties** pour figurer au classement. Un joueur à une seule
   victoire y sera, en tête, à 1016. C'est assumé : un seuil est un chiffre que
   personne ne saurait défendre dans six mois. **La colonne `matches` est la
   parade**, et elle doit être affichée assez visiblement pour qu'un premier de
   classement à une partie se lise comme tel.
3. **Visible de tout joueur connecté**, pas des visiteurs déconnectés. Les
   routes portent `requireAuth`, comme `friendsRouter`. Aucune route non
   authentifiée n'est ouverte — le dépôt vient d'en refermer une (`43474f3`).
4. **L'historique n'est pas borné à ses propres parties.** On voit les parties
   de tout le monde sur un jeu.
5. **On atteint l'écran depuis le salon**, en cliquant les cotes affichées.

## 1. Le chemin des données

**Deux points d'API appelés à la demande**, et non des cotes qui voyageraient
sur l'objet `Room`.

L'autre option était tentante : le salon reçoit déjà `Room` par socket, donc
attacher la cote à chaque `RoomPlayer` supprimerait tout appel réseau et la
rafraîchirait gratuitement. Elle est écartée pour deux raisons qui se cumulent.
`broadcastRoomUpdate` est appelé à chaque changement de siège et à chaque
arrivée, donc ce serait deux lectures en base sur un chemin fréquent. Et
`RoomPlayer` est un type dont dépendent le lobby VR, les vues de salon et le
protocole de présence : l'élargir pour un affichage est un coût qui se paie
ailleurs.

Rien de ce chantier n'écrit. C'est une surface de lecture, et elle doit le
rester.

## 2. Les routes

Derrière `requireAuth`, sur le modèle de `backend/src/api/friends.ts`, et montées
dans `backend/src/bootstrap/app.ts` (l. 196 pour le patron) :

```
GET /api/ratings/:crc32             le classement du jeu, trié, paginé
GET /api/ratings/:crc32?users=a,b   seulement ces joueurs — ce dont le salon a besoin
GET /api/ratings/:crc32/matches     l'historique, du plus récent au plus ancien, paginé
```

Le tri du classement est servi directement par `Rating_gameCrc32_rating_idx`.

Le montage suit celui de `friendsRouter` : `app.use('/api/ratings', requirePseudo,
ratingsRouter)`. `requirePseudo` en plus de `requireAuth`, pour la même raison
que les amis — un compte encore derrière le portique de pseudonyme n'a pas de
nom à afficher dans un classement, et le laisser passer ferait apparaître une
ligne sans identité.

Chaque ligne rendue porte la forme publique d'un joueur — `id`, `pseudo`,
`discriminator`, `avatar`, ce que `toPublicUser()` produit — plus `rating` et
`matches`. Rien d'autre : ni date de création de compte, ni identifiant Google,
ni quoi que ce soit qui ne serve pas à l'écran.

**Une ligne d'historique nomme les deux joueurs et le vainqueur.** Un joueur
absent — un invité, ou un compte supprimé — se rend `null`, et c'est l'écran qui
décide du mot.

## 3. L'écran, et les deux énumérations qu'il faut tenir

**Route `/classement/[crc32]`, avec `prerender = false`**, exactement comme
`frontend/src/routes/room/[id]/+page.ts`. Elle est servie par le fallback SPA
que l'adaptateur statique écrit.

Ce choix est défensif et il vaut d'être expliqué. `frontend/src/routes/+layout.ts`
pose `prerender = true` pour tout le monde, et `frontend/svelte.config.js` exige
que **chaque route prérendue soit nommée dans `prerender.entries`** — son
commentaire raconte les deux fois où l'oubli a cassé le déploiement, `/profile`
puis `/docs`. Rien dans la boucle locale ne l'attrape : `test:all` ne construit
pas, `svelte-check` ne construit pas, `vite dev` ne prérend pas. Une route
dynamique échappe à ce piège par construction.

En contrepartie, **une énumération reste à tenir** :
`frontend/src/lib/nav/way-back.ts` décide quels écrans portent un lien de retour
libellé dans la barre, et il compare des **chemins exacts** (`PLAIN_NAVIGATION`,
un `Set`). Une route dynamique n'y matchera pas. Il lui faut une règle de
préfixe — un changement petit, et **couvert par `core/test/way-back.test.ts`,
qui existe déjà**.

## 4. Les quatre cas qui décident de l'honnêteté de l'écran

Dans un module **pur**, `frontend/src/lib/ratings/presentation.ts`, testé depuis
`core/test` sur le modèle de `frontend/src/lib/rooms/anonymous-join.ts` : ce sont
des règles, elles doivent se lire seules, et l'écran ne doit pas offrir ce qui
n'existera pas.

| situation | ce qu'on montre | pourquoi |
|---|---|---|
| le salon n'a pas encore de jeu | rien | `Room.gameCrc32` est optionnel, et une cote est par jeu |
| le jeu n'est pas dans `watched-roms.ts` | rien | il ne produira jamais de partie ; deux cotes vides promettraient qu'elles vont se remplir |
| `matches === 0` | « non classé » | « 1000 » ressemble à un résultat, « non classé » dit la vérité |
| l'adversaire est un invité | « invité » | il n'a aucune identité durable, son absence de cote n'est pas un défaut |

## 5. Le salon

`frontend/src/lib/components/RoomPlayers.svelte` affiche déjà les deux sièges,
leur occupant, son pseudonyme et son avatar. La cote s'y pose à côté de chaque
joueur, avec son nombre de parties, et le tout est cliquable vers
`/classement/<crc32>`.

**Un avertissement à respecter.** Ce composant affiche par **siège**
(`p.port === 1`), ce qui est correct pour un lobby : le siège est ce que le
joueur choisit. La cote, elle, est attachée au **compte**, donc il n'y a pas
d'ambiguïté ici — mais c'est exactement l'endroit où la confusion s'installe.
Lire l'en-tête de `rankableAt` dans
`backend/src/websocket/match-handlers.ts`, qui explique pourquoi le serveur ne
dérive jamais une identité d'un `p.port`. **Ne pas introduire une seconde
lecture qui le ferait.**

## 6. Côté client, l'échec doit rester visible

`frontend/src/lib/api/ratings.ts` reprend le patron de
`frontend/src/lib/saves/api.ts` : un résultat en **union discriminée**, pour
qu'un appelant ne puisse pas confondre « je n'ai pas pu demander » avec « il n'y
a rien ». L'en-tête de ce fichier-là raconte le bug que cette confusion avait
déjà produit : une session expirée rendait une liste vide, sans erreur, et une
sauvegarde en écrasait une autre parce que le formulaire croyait le slot libre.

Un classement vide parce que le réseau a hoqueté ne doit pas se lire comme un
classement vide parce que personne n'a joué.

## 7. Le découpage

| fichier | rôle |
|---|---|
| `backend/src/db/matches.ts` | trois lectures : classement, cotes d'une liste de joueurs, historique |
| `backend/src/api/ratings.ts` | **neuf.** Le routeur, sur le modèle de `api/friends.ts` |
| `backend/src/bootstrap/app.ts:196` | monter le routeur, à côté des autres |
| `frontend/src/lib/api/ratings.ts` | **neuf.** Les appels, en union discriminée |
| `frontend/src/lib/ratings/presentation.ts` | **neuf.** Les quatre cas, purs |
| `frontend/src/lib/components/RoomPlayers.svelte` | les deux cotes, cliquables |
| `frontend/src/routes/classement/[crc32]/+page.svelte` et `+page.ts` | **neufs.** `prerender = false` |
| `frontend/src/lib/nav/way-back.ts` | une règle de préfixe pour la route dynamique |
| `frontend/src/lib/i18n/translations.ts` | les deux langues |
| `package.json` | les deux fichiers de test neufs, nommés dans `test:ui` |

## 8. Les tests

- **Les règles de présentation** et **la règle de retour** vont dans des
  fonctions pures testées depuis `core/test`, sous node nu : imports relatifs
  avec extension `.js`, jamais l'alias `$lib`.
- **Le piège du dépôt :** un `core/test/*.test.ts` neuf **ne tourne jamais** tant
  qu'il n'est pas nommé dans le script `test:ui` du `package.json` racine.
  Vérifier que le **nombre de fichiers** augmente, pas seulement la couleur.
  `backend/test/*.test.ts` est un glob et s'auto-énumère : le piège ne concerne
  que `core/test`.
- **Les lectures en base** se testent dans `backend/test/`, avec `migratedDb()`
  et `insertUser()` de `backend/test/helpers.ts` — une vraie base migrée depuis
  la vraie baseline. Le classement doit être trié, et un joueur sans ligne
  `Rating` ne doit pas y apparaître.
- **i18n :** toute chaîne visible dans `frontend/src/lib/i18n/translations.ts`
  dans les deux langues ; `core/test/i18n-parity.test.ts` échoue sinon.
- **Le build est obligatoire** : `cd frontend && bun run build`. `test:all` ne
  construit rien, et c'est la seule chose qui prouve qu'une route neuve ne casse
  pas le déploiement.
- **La page RGPD** (`frontend/src/lib/docs/content.ts`) doit dire que le
  classement est visible des autres joueurs. Elle décrit aujourd'hui ce qui est
  *conservé* ; il faut qu'elle dise ce qui est *montré*. Aucune donnée sensible
  n'est en jeu — ni e-mail ni nom réel n'existent en base depuis la migration
  0004 — mais **ce qui change est l'énumérabilité** : aucune route ne liste les
  joueurs aujourd'hui, `toPublicUser` n'étant câblé nulle part et
  `findUserByHandle` n'étant appelé que par l'ajout d'ami, qui exige le handle
  exact. `core/test/docs-content.test.ts` impose la parité paragraphe par
  paragraphe entre les deux langues, et la date de mise à jour est à bouger.

## 9. Hors périmètre

- **L'appariement par voisinage de cote.** Le schéma le rend possible — c'est à
  ça que sert l'index — mais c'est un autre ticket.
- **Un sélecteur de jeu.** `watched-roms.ts` a une seule ligne, donc l'écran n'a
  qu'un jeu à montrer. Construire des onglets pour une ligne serait du décor ;
  l'en-tête de ce fichier dit que le titre suivant est « une ligne, pas une
  réécriture », et l'écran doit avoir la même propriété.
- **La VR.** `frontend/src/lib/vr/panels/launch.ts` serait l'endroit, mais #62
  rapporte que lancer une partie en casque échoue en production : tout
  affichage VR y serait invérifiable aujourd'hui.
- **L'export des parties et du classement.** La page RGPD dit désormais qu'il ne
  les couvre pas ; l'y ajouter est un travail à part.
