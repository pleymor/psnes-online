# Deux joueurs sur un canapé

Conception. Le menu d'assignation des touches devient celui de **deux** joueurs locaux, sur un dessin de manette SNES, et le port 2 se met enfin à jouer.

## Pourquoi

Trois manques qui n'en font qu'un.

**Le port 2 local n'existe pas.** `SoloRoom.svelte:411` passe `pad2: 0` en dur, sous un commentaire qui annonce sa propre relève : « la paire est dans la signature pour qu'une seconde manette change cette ligne et rien d'autre ». Le core (`PsnesCore.runFrame(pad1, pad2)`) et `SoloSession` acceptent les deux masques depuis toujours ; `core/test/solo.test.ts:157` vérifie déjà que `pad2` atteint le core. Il n'a jamais manqué que la source.

**La config ne connaît qu'un joueur.** `User.controlsConfig` contient une `KeyConfig` unique, et `ControlsSettings.svelte` la présente comme une grille de douze lignes « libellé → touche ». Rien dans cette forme ne laisse la place à un second joueur.

**Deux manettes sont indistinguables.** Une liaison manette s'écrit `Gamepad0Button2` : l'index du périphérique est *dans* la liaison. L'ordre de branchement USB fait donc tomber le mappage, et `gamepadSource: 'auto'` fusionne tous les pads connectés — ce qui est juste pour un joueur seul et faux dès qu'il y en a deux, puisqu'une seule manette piloterait les deux ports.

Et un quatrième, découvert en écrivant cette spec, qui recadre le modèle : **`InputCollector.readGamepad()` (`frontend/src/lib/znet/input.ts:143`) ignore la config.** Il applique `GAMEPAD_BITS`, une table codée en dur, et ne consulte jamais `codeToBit`. Dans la pile znet — solo et lockstep, la pile vivante — les liaisons manette n'ont donc jamais été lues. Seule la pile RetroArch (`ClientEmulator`, modes streaming et dual) les honore. C'est ce qui interdit de ranger clavier et manette dans une seule table de douze : aujourd'hui les deux fonctionnent simultanément, et une table unique forcerait à choisir.

## Ce qui est décidé

Cinq décisions prises avant l'écriture, et dont tout le reste découle.

| Question | Réponse retenue | Ce qui a été écarté |
|---|---|---|
| Périmètre | **Le menu à deux joueurs, et `pad2` réellement alimenté en solo.** | Le netplay : en lockstep chaque machine n'envoie qu'un pad. Chantier séparé. |
| Identité d'une manette | **Le pad est assigné au joueur ; les liaisons sont relatives à « ma » manette.** | L'index dans la liaison, que le branchement USB casse. |
| Modèle de config | **Deux mappages complets, un par joueur.** | Un mappage partagé, qui interdit deux joueurs au clavier — le cas local le plus courant. |
| Activation du J2 | **Par son périphérique.** Aucun interrupteur. | Une case « 2 joueurs en local », deuxième état à tenir d'accord avec l'assignation. |
| Écran étroit | **Bascule en onglets J1/J2.** | Deux pads empilés minuscules, ou élargir le menu pause. |

Le refus de l'interrupteur mérite son mot : « le J2 est-il actif » et « quelle manette tient le J2 » sont la même question. Posée une fois, elle ne peut pas se contredire.

## Le modèle

### Le vocabulaire des liaisons

Deux familles de codes, jamais mélangées dans la même table :

- **clavier** : `event.code`, comme aujourd'hui — `KeyX`, `ArrowUp`, `ShiftRight`. La chaîne vide vaut *non lié*.
- **manette**, relatives au pad du joueur : `PadButton2`, `PadAxis0Minus`. Aucun index de périphérique dedans.

`PadConfig` a exactement les douze mêmes clés que `KeyConfig` — `up`…`select` — mais ses valeurs sont des **listes** de codes, `string[]`, là où `KeyConfig` garde une chaîne unique.

La raison est dans le mappage standard, et elle est concrète : aujourd'hui `readGamepad()` traite **à la fois** les boutons 12 à 15 (la croix) **et** les axes 0 et 1 (le stick gauche) comme la croix directionnelle. Une manette XInput rapporte les deux, et les deux fonctionnent. Avec un code unique par emplacement, matérialiser le mappage standard obligerait à choisir, et le stick cesserait de faire avancer le personnage — une régression que beaucoup de joueurs remarqueraient. `up` vaut donc `['PadButton12', 'PadAxis1Minus']`, et la liste dit la vérité au lieu de la cacher dans une règle magique.

`KeyConfig` reste à valeur unique : c'est sa forme actuelle, et toute l'histoire de rétro-compatibilité en dépend.

Formes courtes affichées sur le dessin : `B2` pour `PadButton2`, `A0−` et `A0+` pour `PadAxis0Minus` et `PadAxis0Plus`, et un discret `+1` quand la liste en contient davantage — l'`aria-label` les énonce toutes. Une capture **remplace** la liste par le seul code capturé : c'est le comportement prévisible, et les seules listes à plusieurs codes sont celles du mappage standard.

Les anciennes valeurs `Gamepad<i>Button<n>` et `Gamepad<i>Axis<n><Dir>` sont réécrites en lecture vers `PadButton<n>` et `PadAxis<n><Dir>`, et **déplacées** de la table clavier vers la table manette, où elles forment une liste d'un seul code ; l'emplacement clavier libéré devient non lié. Jeter l'index est sans risque : `0` est la seule valeur qu'on pouvait réalistement produire.

### Deux tables par joueur

```ts
interface PlayerControls {
  keys: KeyConfig;   // 12 codes clavier, '' = non lié
  pad:  PadConfig;   // 12 listes de codes PadButton*/PadAxis*, [] = non lié
}

interface ControlsConfig {
  version: 2;
  p1: PlayerControls;
  p2: PlayerControls;
}
```

Les deux tables sont **indépendantes et toutes deux actives** : `a` peut valoir `KeyX` au clavier *et* `PadButton1` à la manette, et les deux fonctionnent. C'est le comportement actuel de la pile znet, préservé au lieu d'être sacrifié.

Une seule table `pad` par joueur, pas une par modèle de manette. Un joueur qui change de pad rebinde, ou repart du mappage standard d'un clic.

### Défauts

`p1.keys` garde les défauts actuels — flèches, `X Z S A`, `Q W`, `⏎`, `⇧D`. `p2.keys` prend un jeu sans aucune intersection avec eux, décrit par position physique (les `event.code` sont indépendants de la disposition, et aucun des codes choisis n'est touché par la permutation AZERTY) :

```
  T Y          U I O          T=L  Y=R      I=haut  J=gauche
  G H          J K L          G=Y  H=X      K=bas   L=droite
  B N                         B=B  N=A      U=Select  O=Start
```

`p1.pad` et `p2.pad` prennent le **mappage standard** — la table `GAMEPAD_BITS` actuelle, matérialisée en douze codes `PadButton*` visibles et modifiables. C'est ce qui garantit qu'une manette branchée joue sans configuration, exactement comme aujourd'hui, mais cette fois en le disant à l'écran.

### Sur le compte, et la compatibilité

`User.controlsConfig` reste une colonne JSON : **aucune migration SQL**. Le backend normalise en lecture — une `KeyConfig` nue (la forme actuelle) devient un `ControlsConfig` v2 complet, codes legacy migrés. `isValidKeyConfig` devient `isValidControlsConfig` et accepte **les deux formes en écriture**, donc un onglet resté ouvert sur l'ancien front continue de sauvegarder sans rien casser.

Le déploiement se fait par fusion sur `main`, front et back ensemble ; la seule fenêtre de risque est l'onglet périmé, et elle est couverte.

### Sur la machine, pas sur le compte

« Quelle manette physique appartient à quel joueur » est une propriété du **poste**, pas de l'utilisateur : le même compte sur le PC du salon et sur le portable n'a pas les mêmes pads branchés. Cette moitié-là va donc dans le `localStorage`, clé `psnes-input-devices` :

```ts
type GamepadRef = { id: string; index: number };
type Assignment = { keyboard: boolean; gamepad: 'auto' | GamepadRef | null };

{ p1: { keyboard: true,  gamepad: 'auto' },   // le comportement solo actuel, à l'identique
  p2: { keyboard: false, gamepad: null } }    // inactif : pad2 reste à 0
```

`psnes-gamepad-source`, la clé actuelle, est migrée à la première lecture (`'auto'`→`'auto'`, `'off'`→`null`, `N`→`{ index: N, id: '' }`) puis supprimée.

**Le J2 est actif si et seulement si `keyboard || gamepad !== null`.** C'est toute l'activation. Un joueur seul ne voit aucun changement : son J2 n'a pas de périphérique, `pad2` vaut 0, et rien ne bouge.

## La résolution des périphériques

Nouveau module `frontend/src/lib/znet/devices.ts`. Une fonction, `resolve(player) → { keyboard: boolean; padIndices: number[] }`, recalculée sur `gamepadconnected` et `gamepaddisconnected`.

La résolution se fait en deux temps, et l'ordre est ce qui l'empêche d'être circulaire :

1. **Les revendications explicites d'abord**, indépendamment l'une de l'autre. Un `GamepadRef` désigne le premier pad connecté portant cet `id` ; à défaut, celui à cet `index`. `null` ne désigne rien.
2. **Puis `'auto'`** : tous les pads connectés, moins ceux que l'étape 1 a attribués à l'autre joueur.

L'`id` avant l'`index`, parce que l'`id` survit au rebranchement et que l'`index` non. L'`index` en repli, parce que deux manettes identiques partagent le même `id` et qu'il faut bien les séparer.

Deux revendications explicites peuvent tomber sur le même pad — deux manettes identiques dont une est débranchée, par exemple. Aucune n'est arbitrée : les deux joueurs le lisent, et les règles de conflit ci-dessous le signalent à l'écran, ce qui est le bon endroit pour le dire. Une résolution qui trancherait en silence donnerait un joueur muet sans explication.

La redéfinition d'`'auto'` est le cœur du morceau : pour un joueur seul, « tous les pads non réclamés » est exactement « tous les pads », donc le comportement actuel au bit près ; dès qu'un J2 réclame un pad, celui-ci sort du champ du J1. C'est ce qui empêche une manette de piloter deux ports.

`'auto'` n'est proposé **qu'au J1** dans l'écran de config. Pour un second joueur c'est un piège : les deux liraient le même ensemble.

## `InputCollector`, et le mappage standard comme repli

Le constructeur passe de `(keyConfig, gamepadSource)` à `(controls: PlayerControls, resolver, player)`. Le collecteur ne lit le clavier que si son joueur a le clavier, ne lit que ses `padIndices`, et **honore enfin les codes `Pad*`** au lieu de la table en dur.

Deux collecteurs écoutent `window` en parallèle sans se gêner ; chacun ne réagit qu'aux codes de sa propre table. `sanitise()` — le refus des directions opposées simultanées — est inchangé et s'applique aux deux masques.

`SoloRoom.svelte:411` devient la ligne que son commentaire annonçait :

```ts
readLocalInput: () => ({ pad1: c1.read(), pad2: c2?.read() ?? 0 })
```

## Le piège : un conflit n'existe que dans une source partagée

C'est la partie à ne pas rater, et c'est aussi la raison d'être du modèle par périphérique.

Aujourd'hui, un conflit est simple : deux boutons, un même code, dans une seule table. Avec deux joueurs, la même égalité de codes peut être un conflit ou ne pas l'être, et **c'est la source qui tranche** :

| Cas | Conflit ? |
|---|---|
| Deux boutons du même joueur, même code, même table | oui — comme aujourd'hui |
| `p1.keys` et `p2.keys` partagent un code, les deux joueurs ont le clavier | oui |
| `p1.keys` et `p2.keys` partagent un code, le J2 n'a pas le clavier | non — inatteignable |
| `p1.pad` et `p2.pad` partagent `PadButton0`, sur **deux manettes différentes** | **non** — et c'est tout l'intérêt |
| `p1.pad` et `p2.pad` partagent `PadButton0`, ensembles de pads qui s'intersectent | oui |

La détection prend donc les deux tables **et** la résolution des périphériques. Une fonction pure, dans `binding.ts`, testable sans DOM. La sauvegarde reste bloquée tant qu'un conflit subsiste, comme aujourd'hui.

## L'écran

### Le dessin

`SnesPad.svelte`, purement présentationnel. Props : `bindings` (les 12 codes à afficher), `capturing`, `pressed` (les boutons enfoncés en direct), `conflicts`, `interactive`. Émet `select(button)`.

Un SVG de manette SNES — croix directionnelle à gauche, les quatre boutons colorés en losange à droite (X bleu en haut, Y vert à gauche, A rouge à droite, B jaune en bas), L et R sur les gâchettes, Select et Start en pastilles inclinées au centre. **Chaque bouton porte sa liaison**, en forme courte : `X`, `↑`, `⏎`, `B2`. Le dessin *est* la config ; il n'y a pas de liste à côté, et l'ancienne grille « libellé → touche » disparaît — je ne maintiendrai pas deux mises en page.

Chaque bouton est un `<g role="button" tabindex="0">` dont l'`aria-label` porte la forme longue (« bouton A, lié à la touche X » / « bouton A, lié au bouton 2 de la manette ») : ce que le dessin abrège, l'accessibilité l'énonce. Pendant une capture, l'activation clavier du `<g>` est coupée — sinon lier `⏎` à Start relancerait la capture du bouton sous le focus.

### La largeur

Deux pads côte à côte au-dessus de **46 rem** (le `viewBox` fait 520 unités ; il en faut deux fois ~22 rem), onglets J1/J2 en dessous. Donc : côte à côte sur la page de profil, onglets dans le panneau de pause. Le composant interroge déjà sa propre largeur par `container-type: inline-size` plutôt que celle de la fenêtre, pour la raison consignée dans son CSS actuel — monté dans trois conteneurs de largeurs très différentes, la fenêtre est la mauvaise question.

Les libellés passent à `font-size: 18` dans le `viewBox` de 520, soit ~3,5 % de la largeur : environ 10 px en gras monospace dans les 280 px utiles du panneau de pause, pour des liaisons qui font une ou deux lettres. Si cela se révèle trop petit à l'usage, l'échappatoire n'exige aucun code neuf : `--pause-panel-width` est déjà une variable CSS (`PauseMenu.svelte:432`).

### Les deux lignes de chrome, par joueur

**Sources** — une case `Clavier`, un `<select>` des pads connectés par leur vrai nom (`gamepad.id` débarrassé de son `Vendor: 057e Product: 2009`), et un bouton **Détecter** : « appuie sur un bouton de la manette du joueur 2 », qui assigne le pad ayant répondu. C'est la réponse directe à « distinguer les deux manettes » : on ne lit pas un index, on presse un bouton.

**Table en cours d'édition** — un sélecteur `[Clavier | Manette]` qui dit laquelle des deux tables le dessin affiche et capture. Le côté `Manette` est masqué quand le joueur n'a aucun pad assigné, et propose « repartir du mappage standard » pour réécrire les douze codes d'un clic.

### Le retour en direct

Tant que le panneau est ouvert, les pads sont sondés à 50 ms et le dessin de chaque joueur **allume les boutons réellement enfoncés par ses sources à lui**. Tu appuies, tu vois lequel des deux pads à l'écran répond : c'est la vérification que tu tiens la bonne manette, et elle ne coûte rien de plus que la boucle de capture qui existe déjà.

Pendant une capture, seuls les pads du joueur concerné sont écoutés. Appuyer sur la manette du J1 en configurant le J2 ne fait plus rien — conséquence gratuite du modèle par périphérique.

### La capture

`CaptureGate` (`frontend/src/lib/controls/capture-gate.ts`) est réutilisée **telle quelle** : elle empêche qu'un appui maintenu remplisse tous les emplacements restants d'une série. La séquence « tout reconfigurer » reste, par joueur et par table, avec `Échap` pour annuler et `Tab` pour passer un bouton — y compris son rétablissement de la config d'avant en cas d'abandon en cours de route.

Les pads virtuels (`gamepad.id` contenant `Virtual Gamepad`) restent exclus de la capture, comme aujourd'hui. Et le sondage s'arrête à la destruction du composant : le panneau peut être fermé en pleine capture — le menu pause est à un clic — et la boucle tournerait sinon pour la vie de la page. C'est déjà le cas et ça reste vrai avec deux joueurs.

### Ce que « réinitialiser » remet

`POST /api/user/controls/reset` rend la config par défaut **complète** : les deux joueurs, les deux tables. C'est le geste large, derrière la confirmation qui existe déjà. Le geste fin est ailleurs et ne passe pas par le serveur : « repartir du mappage standard » ne réécrit que la table `pad` du joueur affiché.

## Le découpage en fichiers

La logique sort des `.svelte`, parce que le dépôt teste avec `node --import tsx --test` sur `core/test/*.test.ts` et n'a aucun harnais de test de composant. Ce qui n'est pas dans un `.ts` n'est pas testable ici.

| Fichier | Rôle |
|---|---|
| `frontend/src/lib/controls/binding.ts` *(nouveau)* | vocabulaire des codes, `shortLabel`/`longLabel`, migration legacy, `normaliseControlsConfig`, détection de conflits |
| `frontend/src/lib/znet/devices.ts` *(nouveau)* | assignation et résolution des périphériques, migration du `localStorage` |
| `frontend/src/lib/components/SnesPad.svelte` *(nouveau)* | le dessin SVG, sans état |
| `frontend/src/lib/components/PlayerControls.svelte` *(nouveau)* | la colonne d'un joueur : sources, table éditée, pad, machine à états de capture |
| `frontend/src/lib/components/ControlsSettings.svelte` | devient la coquille : chargement, deux `PlayerControls`, conflits globaux, sauvegarde et reset. De 727 lignes à ~200 |
| `frontend/src/lib/znet/input.ts` | `InputCollector` prend `PlayerControls` + résolveur, honore les codes `Pad*` |
| `frontend/src/lib/components/SoloRoom.svelte` | deux collecteurs, `pad2` alimenté |
| `frontend/src/routes/profile/+page.svelte`, `frontend/src/routes/room/[id]/+page.svelte` | chargent `/api/user/controls` : leur état passe de `KeyConfig` à `ControlsConfig` |
| `frontend/src/lib/components/PauseMenu.svelte` | passe la `ControlsConfig` entière à `ControlsSettings` ; sa largeur, elle, ne change pas |
| `backend/src/utils/key-config.ts` | `getDefaultControlsConfig`, `normaliseControlsConfig`, `isValidControlsConfig` |
| `backend/src/api/user.ts`, `backend/src/services/user-config.ts` | normalisation en lecture, validation des deux formes en écriture |
| `frontend/src/lib/i18n/translations.ts` | les nouvelles clés, en anglais et en français |

### La couture de compatibilité

`ClientEmulator.svelte`, `DualClientEmulator.svelte` et `GameCanvas.svelte` reçoivent une `KeyConfig` simple et la traduisent pour RetroArch. Ils ne changent pas : la page de salle leur passe `controls.p1.keys`. Même chose pour `RoomPlayer.keyConfig`, `room:updateKeyConfig` et `LockstepRoom`, qui continuent de véhiculer une seule `KeyConfig` — celle du J1. Toute la nouveauté s'arrête à cette couture.

## Hors périmètre, explicitement

- **Le netplay.** En lockstep, chaque machine n'envoie qu'un pad ; y greffer un second joueur local demande de décider ce que devient le port 2 quand un pair distant l'occupe. Autre morceau.
- **Les modes streaming et dual** (pile RetroArch) : ils continuent de fonctionner sur `p1.keys`, sans J2 local.
- **Le pad tactile** (`virtual-gamepad.ts`) : inchangé.
- **Des profils de contrôles nommés** : YAGNI.

## Tests

Nouveaux fichiers dans `core/test/`, ajoutés au script `test:ui`. Le harnais de faux pads sur `globalThis.navigator` existe déjà dans `core/test/input.test.ts:193` et se réutilise.

1. **`controls-config.test.ts`** — normalisation : une `KeyConfig` nue devient un v2 complet ; `Gamepad0Button2` migre vers `p1.pad` en `PadButton2` et libère l'emplacement clavier ; les clés manquantes sont complétées ; la saleté est rejetée. Et les cinq cas de conflit du tableau ci-dessus, un test chacun — celui qui compte étant « deux manettes différentes, même code, aucun conflit ».
2. **`input-devices.test.ts`** — `'auto'` exclut le pad réclamé par l'autre joueur ; un `GamepadRef` se résout par `id` d'abord et par `index` en repli ; un pad débranché donne l'ensemble vide ; la migration de `psnes-gamepad-source` couvre ses trois formes.
3. **`input.test.ts`** *(étendu)* — les codes `Pad*` produisent le bon masque ; un joueur sans clavier ignore `keydown` ; deux collecteurs sur deux pads produisent des masques indépendants ; le mappage standard matérialisé donne le même masque que la table en dur qu'il remplace, pour les seize boutons **et** pour les deux axes du stick gauche — c'est le test qui prouve l'absence de régression.
4. **`backend/test/`** — `isValidControlsConfig` accepte les deux formes, rejette le reste ; `normaliseControlsConfig` est idempotente.

## Vérification dans l'app

Aucun test n'atteint le câblage `.svelte` : `SoloRoom` doit être vu tourner. Depuis le worktree (voir la recette de lancement — liens symboliques `node_modules`, `frontend/node_modules` réel et inscriptible, `fs.allow` élargi, ports 3100 et 5273) :

1. Page de profil : le J2 passe sur `Clavier`, les deux pads s'affichent côte à côte.
2. Une partie solo sur un jeu à deux, et les touches `IJKL` bougent **le second** joueur.
3. Une manette branchée, `Détecter` sur le J2 : le dessin du J2 s'allume quand on presse ses boutons, celui du J1 non.
4. Menu pause en cours de partie : les onglets J1/J2, et une liaison modifiée qui prend effet à la reprise.

Captures d'écran à l'appui, dans les deux langues.
