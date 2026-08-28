# La bibliothèque appartient à l'appareil

Conception. Demande du propriétaire : « comme il est possible de jouer, avec un
même compte, depuis plusieurs devices qui n'ont pas les mêmes roms, il serait
bien d'avoir la notion de bibliothèque par device ». Puis, sur la gêne réelle :
*« quand on switch c'est horrible »*.

## Pourquoi

Les octets d'une ROM **ne quittent jamais la machine du joueur**. Le serveur
tient l'identité d'un jeu — titre, jaquette, sauvegardes — indexée par le
checksum, et jamais le fichier (`roms/local-library.ts`, en-tête). Les octets
viennent d'un dossier que le joueur désigne une fois, dont le handle survit dans
IndexedDB, et `roms/provider.ts` transforme un checksum en fichier au lancement.

Le modèle est donc **déjà par appareil pour les octets**. Ce qui est resté par
compte, c'est la *liste* : `routes/+page.svelte:48` récupère `/api/games`,
remplit le store `games` (`:53`), et la grille (`:330`) comme le compteur
(`:279`) affichent tout ce que le compte possède.

D'où la gêne. Sur le téléphone, l'écran promet deux cents jeux dont il ne peut
en ouvrir aucun. Rien ne casse — `provider.ts` retombe sur « désignez le fichier
maintenant » — mais **chaque lancement demande un geste que la liste n'avait pas
annoncé**, et c'est ce qui rend le changement d'appareil pénible.

Ce n'est donc pas « il manque une notion de device ». C'est **la liste qui ment
sur ce que cet appareil peut tenir**.

## Ce qui a été décidé

Quatre questions, quatre réponses du propriétaire :

1. **La gêne** — la liste ment, *et* il veut réellement curer par appareil.
2. **La curation** — « le dossier fait foi ». La bibliothèque d'un appareil est
   ce que son dossier contient ; curer, c'est choisir ce qu'on met dedans.
3. **Les octets obtenus autrement** — on garde ce que le joueur **désigne**, on
   ne garde pas ce qu'un hôte **envoie**. *Recevoir n'est pas posséder.*
4. **Les absents** — invisibles. La forme la plus simple, assumée.

## Conception

### 1. Une vue dérivée, pas un nouveau modèle

Aucune entité *device* côté serveur, aucune migration. La bibliothèque d'un
appareil est une **fonction pure** :

```
bibliothèqueAppareil(identitésDuCompte, checksumsRésolublesIci)
  = identités ∩ checksums
```

Les identités continuent de venir de `/api/games` : les sauvegardes et les
jaquettes y sont accrochées et doivent le rester. Seul l'affichage change.

`routes/+page.svelte` gagne un store dérivé — appelons-le `deviceGames` — que
consomment la grille et le compteur. Le store `games` brut reste, pour la ligne
de comptage du profil (§4).

### 2. Ce qu'un appareil sait résoudre

Deux sources, réunies :

- **le dossier**, via l'index `checksum → filename` que `scanDirectory`
  (`local-library.ts:126`) construit déjà et que `registerGame` (`:204`)
  alimente ;
- **les fichiers désignés à la main**, dans un nouveau store IndexedDB
  `files: checksum → bytes`.

La conservation se fait **dans `offerFile`** (`provider.ts:76`), qui est le seul
chemin par lequel un joueur désigne un fichier, et seulement après que le
checksum a été recalculé et validé — garder une ROM qui ne correspond pas au jeu
demandé la rendrait résoluble et injouable. Rien d'autre n'écrit dans ce store :
`sendRom`/`ChunkAssembler`, qui portent le transfert depuis l'hôte, n'y touchent
pas, ce qui est la traduction en code de « recevoir n'est pas posséder ».

`provider.ts` a déjà un ordre de résolution en trois temps ; les octets gardés
s'y insèrent en deuxième :

```
mémoire de session → octets gardés → dossier → demander le fichier
```

**C'est ce store qui sauve les navigateurs sans `showDirectoryPicker`.**
`source-state.ts` distingue quatre états, et son en-tête avertit que se tromper
sur `unsupported` « leaves Firefox and Safari with an empty library and no way
to add anything ». Sans octets gardés, « le dossier fait foi » ferait exactement
ça. Avec, un appareil qui ne peut pas désigner de dossier se remplit au fil des
parties.

> **Point ouvert, sans conséquence sur la conception.** Le propriétaire affirme
> que son Android sait désigner un dossier ; le commentaire de
> `RomSourcePanel.svelte:11` dit que `showDirectoryPicker` « only Chromium
> has ». Chrome Android *est* Chromium, donc c'est plausible et non vérifié. La
> réponse change le *remplissage* en pratique, pas le mécanisme : les deux
> sources sont réunies dans tous les cas.

### 3. La vérité, réparée là où elle coûte

L'index vaut ce que vaut le dernier scan : une ROM retirée du dossier y reste.
Deux options ont été écartées et une retenue :

- vérifier le disque à chaque affichage — toujours vrai, mais deux cents accès
  au système de fichiers par ouverture de page, et une permission évaporée
  déclenche une demande au pire moment. **Écarté.**
- ne rien faire — la liste ment à nouveau, en plus petit. **Écarté.**
- **retenu** : un lancement qui ne trouve pas son fichier **retire l'entrée de
  l'index**. La liste se corrige au seul moment où l'erreur a un coût pour le
  joueur, et l'affichage reste gratuit.

### 4. Les quatre états d'appareil

| état | bibliothèque affichée |
|---|---|
| `folder` | dossier ∩ compte, plus les fichiers gardés |
| `folder-stale` | idem, **plus la demande de ré-autorisation en évidence** |
| `no-folder` | les fichiers gardés seulement |
| `unsupported` | les fichiers gardés seulement |

`folder-stale` mérite son traitement à part : les octets sont là, il ne manque
qu'un geste. Vider la liste parce qu'une permission a expiré serait la punir
d'un problème que le joueur règle en un clic — et `romSourceState` sépare déjà
cet état de `no-folder` pour cette raison.

**Le panneau ROM du profil dit le compte**, en une ligne : « 195 jeux de votre
compte ne sont pas sur cet appareil », avec le bouton d'ajout de fichier
dessous. La bibliothèque reste propre, et la vérité existe à l'endroit où l'on
vient déjà configurer ses ROMs. *Proposé au propriétaire, non contesté.*

**Créer une room ne propose que des jeux jouables ici.** Conséquence assumée du
filtre : on ne lance pas une partie qu'on ne peut pas tenir. *Proposé au
propriétaire, non contesté.*

### 5. Ce qui ne doit pas bouger

Rejoindre la partie d'un ami sur un jeu qu'on ne possède pas, le transfert de
ROM depuis l'hôte, les sauvegardes par checksum : **intacts**. Filtrer *sa*
liste ne doit jamais fermer *la partie de l'autre* — ce serait casser le mode
principal pour ranger un écran. Un test épingle explicitement ce parcours.

## Tests

Le dossier `roms/` est déjà testé sans DOM (`core/test/rom-provider.test.ts`,
`rom-transfer.test.ts`), et la conception s'y range :

- **le filtre** est une fonction pure sur deux listes — cas nominal, appareil
  vide, compte vide, checksum présent des deux côtés ;
- **le store d'octets gardés** est injectable, sur le modèle de
  `readDirectionMode` dans `controls/touch.ts` : un faux suffit, et les échecs
  de stockage (navigation privée) doivent dégrader sans lever ;
- **l'ordre de résolution** de `provider.ts` : les octets gardés passent avant
  le dossier et après la mémoire de session ;
- **l'auto-réparation** : un lancement qui échoue retire l'entrée, et le
  suivant ne la propose plus ;
- **le parcours d'invité** : un jeu absent de la bibliothèque de l'appareil se
  rejoint quand même, et le transfert depuis l'hôte fonctionne. C'est le test
  qui garde la conception honnête.

## Hors périmètre

Délibérément non construit, parce que rien dans la demande ne l'exige :

- pas de notion d'appareil côté serveur, donc pas de migration ;
- pas d'appareils nommés ni d'écran de gestion ;
- pas de synchronisation de bibliothèques entre appareils ;
- pas de liste de curation indépendante des fichiers présents — le propriétaire
  a explicitement choisi que le dossier fasse foi ;
- pas de conservation des ROMs reçues d'un hôte.
