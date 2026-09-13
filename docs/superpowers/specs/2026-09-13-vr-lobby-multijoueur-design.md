# Voir ses amis dans le lobby VR

**Statut :** validé section par section le 2026-09-13, approche A retenue.
**S'appuie sur :** `2026-09-04-vr-multijoueur-design.md`, qui a appris au casque
à **lancer** une partie lockstep à deux. Celle-ci ne le touche pas : elle ajoute
une présence *avant* la partie, et s'efface quand la partie commence.
**Base :** `origin/main` à `8c18f79`, qui vient d'apporter la marche dans le
repère du décor, le saut et les tuyaux. Cette conception en dépend directement —
voir la section 2.

## Le besoin, dans les mots du demandeur

> rendons le lobby VR multi-joueurs. l'idée est de voir l'avatar de tous ses
> amis connectés et ayant ouvert la VR room. cela ouvrira la voie à des
> expériences multi dans le lobby. bien-sûr, chaque joueur verra pour l'instant
> son propre lobby VR indépendant. seules les positions des autres joueurs
> seront partagées.

Puis, interrogé sur le chevauchement au départ :

> position initiale, chevauchement accepté, et les autres deviennent invisibles
> quand on se chevauche pour ne pas se gener

## 0. Ce que ce lot livre, et ce qu'il ne livre pas

Il livre : **des amis visibles et mobiles dans le lobby**, et la mention « en
VR » partout où l'on regarde une liste d'amis.

Il ne livre pas : la voix, les gestes, la collision entre joueurs, la moindre
interaction, et aucun partage d'état du décor. Chacun garde son lobby, comme
demandé. C'est une fondation, et le critère de réussite est qu'elle soit exacte
plutôt que riche : deux joueurs doivent être d'accord sur qui se tient où, à
50 cm près, sinon rien de ce qui viendra ensuite ne pourra s'y poser.

## 1. Les quatre décisions prises avec le demandeur

| Question | Réponse retenue |
|---|---|
| Le chevauchement au départ | Positions brutes. Tout le monde démarre au même point, et **un ami trop proche s'efface** plutôt que de gêner. Aucun allocateur de places côté serveur. |
| La silhouette | **Tête + deux mains**, en pixel-art, pseudo au-dessus. On ne montre que ce qu'on mesure : le casque et les manettes. Pas de jambes inventées, donc pas de patinage. |
| Pendant une partie | **Je quitte le lobby partagé.** Je n'émets plus et je n'affiche plus personne ; chez mes amis mon avatar s'efface, et le panneau Amis dit « en partie ». |
| Qui est au courant | « En VR » devient un état d'ami comme « en ligne » : visible **dans le casque et sur la page à plat**. Sans ça, personne ne sait qu'il y a quelqu'un à rejoindre. |

Le rejet le plus utile : on n'attribue **pas** de place de départ. Une place
attribuée donnerait un repère sans chevauchement, mais au prix d'un allocateur
serveur et d'un comptoir qui n'est plus en face en entrant. La règle
d'effacement règle le même problème pour trois lignes d'arithmétique, et elle
sert aussi au cas qui compte vraiment : un ami qui vient se coller à vous.

## 2. Le repère, et pourquoi il est gratuit depuis le 12 septembre

C'est le point qui décide de tout le reste, et il vient de devenir simple.

`e3b1250` (« Faire tourner le monde autour de la tête, et marcher dans le repère
du décor ») a déplacé `playerAt` **dans le repère local du décor** — celui où
`decor/placement.ts` pose ses tuyaux. Le commit l'a fait pour une autre raison
(on traversait les tuyaux pendant qu'un mur invisible attendait ailleurs), mais
la conséquence nous concerne directement :

> Il existe désormais, dans ce code, un repère que tous les clients partagent
> par construction. « Deux mètres à gauche du comptoir » y désigne le même
> endroit pour tout le monde.

C'est le repère du fil. Rien n'est inventé pour l'occasion.

### La seule conversion, et elle n'est écrite par personne

Les avatars distants sont ajoutés au groupe `room` par `addDecor`. Leurs
coordonnées **sont** des coordonnées décor : rien ne les convertit, donc rien ne
peut s'y tromper.

Reste ma propre pose, que le runtime XR donne en espace de référence. Une
conversion, une seule, et confiée à three :

```ts
room.updateMatrixWorld(true);
room.worldToLocal(v);     // v : caméra XR, ou gripSpace d'une manette
```

Ce n'est pas une préférence de style. `scene.ts:place()` écrit l'aller à la
main, et son propre commentaire raconte ce qu'a coûté le centre de rotation mal
placé ; `decor/box.ts` en garde deux autres (`FRONT_NORMAL`, `boxYaw`) ; le
dépôt en a payé quatre en tout. Écrire le retour à la main serait la cinquième.
`worldToLocal` traverse la matrice que three tient déjà, **donc il porte
gratuitement `walkAt`, `walkYaw`, `setPlayerHeight` et l'accroupissement** — les
quatre termes qu'une formule manuscrite devrait recomposer sans se tromper de
signe. Un joueur perché sur un tuyau apparaît en haut du tuyau sans une ligne de
code de plus.

Le `updateMatrixWorld(true)` n'est pas décoratif : la lecture a lieu dans
`onFrame`, donc **avant** le rendu qui rafraîchit les matrices. Sans lui la pose
émise est celle de l'image précédente.

Nouvelle méthode sur `VrScene` :

```ts
/** Ma tête et mes mains dans le repère du décor — celui de `addDecor`. */
poseInRoom(): { head: Pose; left: Pose | null; right: Pose | null } | null
```

Tête lue sur la caméra XR (comme `headPosition`, pour ne pas être en retard
d'une image), mains sur le `gripSpace` des `inputSources`. Rend `null` hors
image ou tant que le suivi n'est pas prêt — ce que l'appelant traite comme
« redemande », jamais comme « pas de pose », exactement comme `poseIn`.

### La hauteur est comparable, et c'est voulu

`roomAnchor` écarte délibérément le `y` de l'ancre : le groupe `room` a son
origine à la hauteur de référence de la session pour tout le monde. Une tête est
donc directement comparable d'un joueur à l'autre, et un ami assis apparaît plus
bas que vous. C'est **vrai**, et ça doit se voir.

## 3. Le protocole

| Message | Sens | Contenu |
|---|---|---|
| `vr:enter` | client → serveur | rien |
| `vr:pose` | client → serveur, ~15 Hz | `{ head, left, right }` |
| `vr:lobby` | serveur → client, 15 Hz | `{ peers: [{ id, head, left, right }] }` |
| `vr:leave` | client → serveur | rien |

Une pose est `[x, y, z, qx, qy, qz, qw]`, ou `null` pour une main absente.

L'instantané envoyé à un joueur **ne le contient jamais lui-même** : on ne
dessine pas sa propre tête, et l'exclusion se fait côté serveur plutôt que
côté client, pour que la règle soit énoncée une fois. Et `vr:enter` reçu deux
fois est sans effet : entrer est un état, pas un événement.

Trois décisions sont dans ce tableau, et chacune supprime une classe de défauts
plutôt qu'une ligne de code :

**`vr:pose` n'est jamais relayé.** Il écrit dans une carte, point. C'est le
battement qui parle. Un client ne peut donc pas, en émettant plus vite,
augmenter la charge que ses amis reçoivent.

**Un ami absent de `peers` est parti.** Il n'y a pas de `vr:left` diffusé, donc
il n'y a pas de course entre « il est parti » et « voici sa pose » — les deux
sont le même message.

**`peers` ne porte pas le pseudo.** Le client le résout depuis son magasin
d'amis, déjà peuplé par `friends:online`. Le message chaud reste petit, et
surtout : **un identifiant que je ne connais pas comme ami n'est pas dessiné**
(il est journalisé). C'est la garantie de dernier recours qu'on n'affiche jamais
un inconnu, même si le serveur se trompait.

**Pas d'estampille temporelle dans l'instantané.** Socket.io est sur TCP :
l'ordre est déjà garanti, et deux horloges qui ne se sont jamais parlé ne
peuvent pas dater le même instant. L'interpolation se fait sur l'arrivée locale
(§5). Un champ `t` n'aurait servi à rien, et aurait invité à s'en servir.

Enfin, `friends:online` et `friend:statusChanged` gagnent `inVr: boolean`. C'est
ce que lisent la page à plat et le panneau Amis.

## 4. Le serveur — `backend/src/websocket/vr-lobby.ts`

Un module, trois états : la carte `userId → pose`, le cache `userId →
Set<idsAmis>`, et le battement.

**Le cache d'amis est lu à l'entrée, jamais dans le chemin chaud.**
`listAcceptedFriendshipsWithProfiles` touche la base ; l'appeler quinze fois par
seconde et par joueur serait le défaut de performance que ce module existe pour
ne pas avoir. Une lecture à `vr:enter`, invalidée à la sortie.

**Le `setInterval` n'existe pas tant que la carte est vide.** Armé au premier
`vr:enter`, désarmé au dernier départ. Un serveur au repos ne doit pas battre
quinze fois par seconde pour personne.

**`vr:pose` est plafonné à ~25/s par socket.** Au-delà, on ignore ; on ne
déconnecte pas. Sans plafond, un client modifié inonde la carte.

**L'ensemble des destinataires est calculé par le serveur**, jamais fourni par
le client, et aucune pose n'est persistée.

**La sortie a trois portes** : `vr:leave`, `disconnect`, et le cas que
`presence.ts` documente déjà — une reconnexion tardive dont le `unregister`
rend `false` ne doit **pas** retirer la présence de la connexion neuve. C'est
exactement le défaut qui avait fait disparaître des joueurs de la liste d'amis ;
il ne sera pas réintroduit ici.

## 5. Le frontend

### Les modules purs — `frontend/src/lib/vr/lobby/`, testés sous Bun

**`roster.ts`** — le cœur, et le seul endroit qui a une horloge.

Les instantanés arrivent à 15 Hz, on dessine à 72 ou 90. Sans interpolation,
chaque tête saute six fois par seconde. Donc : on garde les **deux** derniers
instantanés par ami et on dessine à `maintenant − 100 ms`, entre les deux qui
encadrent cet instant. Un retard d'un battement et demi — invisible sur une
tête, et suffisant pour absorber une image réseau perdue.

Deux détails qui décident de la justesse :

- L'horloge est **l'arrivée locale**. Voir §3 : dater avec une horloge serveur
  serait dater avec une horloge qu'on n'a jamais réglée.
- Les orientations s'interpolent en **slerp**, avec le retournement de signe qui
  prend l'arc court. Sans lui, un ami qui tourne de 190° fait le tour dans
  l'autre sens sur 170°. Invisible en lisant, évident en casque, et attrapé par
  un test de trois lignes.

**`proximity.ts`** — la règle du demandeur.

```
opacity = clamp((d − 0,5) / (1,2 − 0,5))
```

`d` est la distance tête à tête. En deçà de 50 cm l'ami est entièrement absent,
au-delà de 1,20 m entièrement solide, et un fondu entre les deux plutôt qu'une
bascule : une disparition sèche se remarque davantage qu'une transparence.

Sous le seuil bas, le module rend `visible: false`, **pas** `opacity: 0`. Un
objet transparent invisible coûte quand même son tri, et ce dépôt a déjà payé un
basculement d'ordre de rendu sur une surface transparente.

Une seule opacité pour la tête, les mains **et** la plaque de pseudo : un nom
qui flotte sans visage est pire que pas de nom.

**`avatar-art.ts`** — les pixels, au format de `decor/pixels.ts` : une grille de
caractères, une palette nommée dans `decor/palette.ts`. Une face avant avec les
yeux, des faces latérales, une main. Diffable, modifiable sans outil, testable
sans GPU.

### Le module three — `lobby/avatars.ts`

Mince, comme `decor/build.ts`. Il fabrique les boîtes avec `decor/box.ts` — donc
avec `FRONT_NORMAL` vers −Z et `boxYaw`, la convention qui a déjà tourné tout le
décor de 180° le jour où sa ligne a été recopiée depuis celle d'un quad —, les
ajoute par `addDecor`, et applique chaque image ce que `roster` et `proximity`
ont décidé. **Aucune décision dedans.**

La plaque de pseudo s'oriente avec `headPosition()`, la méthode qui existe déjà
pour les billboards.

### Le raccordement dans `VrShell.svelte`

- `enter()` : `vr:enter` et écoute de `vr:lobby`, **sans `await` bloquant**. Pas
  de socket, pas de lobby partagé, et le reste de la VR fonctionne.
- Chaque image, à côté de `walkFrame` : lire `poseInRoom()`, émettre au plus
  quinze fois par seconde, puis mettre à jour les avatars.
- Départ et retour de partie : accrochés **au fondu du rideau vers `'dark'`**,
  pas à `panelsVisible(false)`. Ce dernier a six sites d'appel dont la plupart
  n'ont rien à voir avec une partie — s'y accrocher ferait disparaître les amis
  en ouvrant un menu.
- `teardown()` : `vr:leave`, désabonnement, `dispose`.

### La page à plat

`FriendsList.svelte` et `vr/panels/friends.ts` lisent le même `inVr`. Nouvelles
clés i18n en **`en` et `fr`** : `core/test/i18n-parity.test.ts` refuse un seul
des deux.

## 6. Les erreurs

| Cas | Réponse |
|---|---|
| Pas de socket, ou socket coupé | Le lobby se tait. La VR solo est intacte. |
| Identifiant absent de mon magasin d'amis | Ignoré, journalisé. C'est aussi ce qui garantit qu'on ne dessine jamais un inconnu. |
| `poseInRoom()` rend `null` | On saute l'envoi de cette image. C'est « redemande », pas une erreur. |
| Pose malformée reçue par le serveur | Rejetée à la forme : sept nombres finis, ou rien. |
| Un ami cesse d'émettre sans partir | Il reste à sa dernière pose tant que le serveur le tient présent. Sa sortie viendra du `disconnect`. |

## 7. Les tests

- `core/test/vr-lobby-roster.test.ts` — interpolation entre deux instantanés,
  ami qui disparaît, instantané en retard, slerp par l'arc court.
- `core/test/vr-lobby-proximity.test.ts` — la courbe, et le seuil
  `visible: false` sous 50 cm.
- `core/test/vr-lobby-art.test.ts` — les pixels, sur le modèle de
  `vr-decor-art.test.ts`.
- `backend/test/vr-lobby.test.ts` — vraies sockets, sur le modèle de
  `lobby-protocol.test.ts` : deux amis se voient ; **un non-ami est invisible
  des deux côtés** ; un départ est une absence dans l'instantané suivant ; une
  déconnexion aussi ; le plafond de débit ; le battement armé au premier entrant
  et désarmé au dernier sortant ; et la reconnexion tardive qui ne doit pas
  retirer la présence neuve.
- `core/test/vr-panel-friends.test.ts` — la ligne « en VR ».

**Chaque nouveau fichier doit être nommé dans `test:ui`**, qui énumère ses
fichiers un par un. Ce piège est déjà tombé dans ce dépôt : un test absent de
cette liste ne tourne jamais, et le vert ne veut alors rien dire. Vérifier le
**total** de tests avant et après, pas la couleur.

## 8. Ce qui reste ouvert pour la suite

Rien n'est bloqué par ce lot, mais deux choses sont sciemment laissées :

- **Les avatars ne collisionnent pas.** On se traverse. La règle d'effacement
  fait que ça ne se voit pas, et une collision entre joueurs demanderait un
  accord sur qui recule — donc une autorité, donc une autre conception.
- **Rien n'attire le regard vers un ami qui arrive.** Les pupitres sont à
  soixante degrés du centre et le même trou existe déjà pour les invitations
  (`panels/friends.ts` le dit). Annoncer une arrivée au milieu du champ est une
  question spatiale, et elle mérite sa propre décision.
