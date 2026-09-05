# Remapper ses contrôles depuis la VR

**Statut :** validé question par question le 2026-09-05.
**Revient sur :** `2026-09-02-vr-meta-quest-design.md`, dont la conclusion sur
les contrôles était que les deux presets suffisaient.

## Le besoin, dans les mots du demandeur

> Finalement je pense qu'il faudrait pouvoir remap ses contrôles même en mode VR.

---

## 1. Ce que cette décision annule

L'en-tête de `frontend/src/lib/vr/panels/profile.ts` porte aujourd'hui :

> *What is deliberately absent: [...] and per-button rebinding (the issue's own
> line, and the presets are the whole of the rectification).*

Et `frontend/src/lib/vr/pad-scheme.ts` :

> *The issue said not to offer controls settings at all. Choosing between two
> presets is not rebinding button by button [...] That is the whole of the
> rectification.*

Ces deux phrases deviennent fausses et doivent être réécrites, pas supprimées :
elles expliquent pourquoi les presets existent, et les presets survivent comme
points de départ. Ce qui change est la conclusion, pas le raisonnement.

## 2. Ce qui existe et ne bouge pas

Vérifié dans le code avant toute décision. **Le serveur n'a besoin d'aucune
modification, et aucune migration n'est nécessaire.**

**Les entrées physiques sont déjà nommées.** `vr/pad.ts` porte les indices
`xr-standard` en constantes : `TRIGGER = 0`, `SQUEEZE = 1`, `STICK_CLICK = 3`,
`FACE_LOWER = 4`, `FACE_UPPER = 5`, et le stick sur les axes 2 et 3. Le
commentaire dit pourquoi elles sont nommées : *« `buttons[5]` at a call site is
how the two face buttons end up swapped by someone counting from the wrong
end. »*

**Le vocabulaire de la page plate ne peut pas être réutilisé, et son en-tête
dit pourquoi.** `controls/binding.ts`'s `STANDARD_PAD` parle le mapping
`standard`, où le stick gauche est sur les axes 0 et 1. Un Touch parle
`xr-standard`, où ces axes appartiennent à un pavé tactile qu'il n'a pas.
Réutiliser cette table *« gives a dead d-pad with no error and no warning »*.
Les deux tables restent séparées.

**Et la page plate ne peut pas configurer les Touch.** Les manettes n'émettent
rien hors session immersive. La capture doit donc avoir lieu dans le casque —
ce n'est pas un choix d'ergonomie, c'est la seule possibilité.

**`CaptureGate` est réutilisable tel quel.** `controls/capture-gate.ts` est une
classe sans dépendance, testée sous Bun (`core/test/capture-gate.test.ts`), dont
la règle est exactement celle dont la VR a besoin : *« an input already consumed
cannot be consumed again until it has been let go »*.

**L'écran courbe peut tenir contre un jeu qui tourne.** Précédent établi par
`8acea38`, « Let the launch screen hold the screen against a running game ».

**Le compte des entrées est serré.** Cinq boutons par manette — gâchette, grip,
clic de stick, deux boutons de face — soit dix. Le clic du stick droit est le
seul « menu » possible : le bouton Quest est réservé par le système et ne
délivre rien à la page (`vr/pad.ts`, `menuPressed`). Les deux sticks font la
croix. **Restent neuf entrées assignables pour huit boutons SNES.**

## 3. Le modèle

Le format stocké passe d'un preset à une permutation complète.

```ts
export type XrInput =
  | 'XrLeftTrigger'   | 'XrRightTrigger'
  | 'XrLeftSqueeze'   | 'XrRightSqueeze'
  | 'XrLeftFaceUpper' | 'XrRightFaceUpper'
  | 'XrLeftFaceLower' | 'XrRightFaceLower'
  | 'XrLeftStickClick';

export type VrButton = 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'start' | 'select';

export type VrPadMap = Record<VrButton, XrInput>;
```

Les sticks et le clic du stick droit **ne sont pas dans le modèle**. C'est ce
qui les rend inaltérables par construction plutôt que par une garde qu'un
lecteur peut oublier de respecter.

`readVrPad` prend une `VrPadMap` au lieu d'un `VrPadScheme`. La table `FACE`
disparaît au profit d'une recherche inversée `XrInput → PadMask`, construite une
fois par appel.

**Les presets deviennent deux constantes** `LETTERS_MAP` et `THUMB_MAP`,
offertes dans le panneau comme « recharger ce preset ». Leur raison d'être ne
change pas : le pliage du losange SNES sur deux paires verticales n'est jamais
gratuit, et les deux réponses restent les deux bonnes réponses par défaut.

### Stockage

`localStorage`, sous la clé `psnes-vr-pad` **déjà utilisée**. La discipline de
`pad-scheme.ts` est conservée telle quelle : une valeur égale au défaut est
*retirée* plutôt que stockée, *« so no reader has to treat '' and absent as the
same thing »*.

`pad-scheme.ts` devient `pad-map.ts`, et ses deux fonctions exportées
`readPadScheme` / `writePadScheme` deviennent `readPadMap` / `writePadMap`. Le
renommage est délibéré plutôt que cosmétique : garder le nom « scheme » pour une
valeur qui n'est plus un preset est la sorte d'inexactitude qu'un lecteur croit
sur parole. Les deux appelants sont `VrShell` et les tests.

**Les valeurs héritées doivent survivre.** Des joueurs ont aujourd'hui la chaîne
`'letters'` ou `'thumb'` sous cette clé. `readPadMap` les résout vers la
constante correspondante au lieu de les rejeter. Une valeur illisible est
retirée et remplacée par le défaut, comme aujourd'hui.

Rien côté compte : pas de version 3 de `ControlsConfig`, pas de normaliseur à
étendre, pas d'export portable à modifier, pas de déploiement couplé au dépôt
infra. **Le coût assumé est deux casques, deux réglages** — le même que celui
que `pad-scheme.ts` assume déjà, et il a été pesé contre la portée nouvelle.

### Conflits : échange

Assigner à `a` une entrée que `r` détient donne à `r` l'entrée que `a` avait.
L'invariant est que **la map est toujours une permutation injective** : aucun
bouton SNES ne peut se retrouver sans entrée. C'est la seule règle des trois
examinées qui garantit ça, et un bouton injouable est précisément la panne qu'un
casque ne sait pas diagnostiquer — pas de console, pas de logs lisibles.

Quand l'entrée visée est la neuvième, libre, rien n'est déplacé.

## 4. Les trois pièges de la capture

Aucun n'existe sur la page plate. Ce sont les vraies difficultés du projet.

**Presser un bouton pour le lier le presserait aussi dans le jeu — et c'est
déjà résolu.** Les deux appels à `readVrPad` (`VrShell.svelte:694` pour le solo,
`:1014` pour le lockstep) sont gardés par `!scene.arePanelsVisible()`, avec la
raison écrite sur place : *« Zero while the panels are up: the trigger is the
pointer then, and letting both read it at once would make a menu press also
register as SNES R. »*

La capture n'est atteignable que panneaux levés — elle s'ouvre depuis le pupitre
profil, et le clic du stick droit annule la capture au lieu de basculer les
panneaux tant qu'une ligne écoute (piège suivant). Donc *capture armée* implique
*panneaux levés* implique *masque nul*.

**Aucun argument `capturing` n'est donc ajouté à `readVrPad`.** Une première
version de ce spec en proposait un ; la garde existante le rend inutile, et un
second verrou pour la même porte est un verrou que personne ne saura lequel
ouvre. Ce que le plan ajoute est un **test qui épingle la garde existante** :
elle n'en a aujourd'hui aucun, et rien n'empêcherait un futur appelant de
l'oublier.

**Aucun bouton ne peut annuler, puisque tous sont capturables.** Le seul recours
est l'entrée hors modèle : le clic du stick droit. Tant qu'une ligne écoute, il
annule la capture au lieu de rappeler les panneaux.

**La gâchette sert à cliquer la ligne.** Cliquer « A » avec la gâchette droite
la lierait instantanément à A. C'est exactement ce que `CaptureGate` empêche :
le code est déjà consommé au moment du clic et ne pourra l'être à nouveau
qu'après relâchement. Une seconde pression de la gâchette la lie donc bien à A,
ce qui est voulu.

Une nouvelle fonction `activeXrInputs(sources): XrInput[]` dans `vr/pad.ts`
fournit à `CaptureGate.tick` les entrées tenues. Elle est distincte de
`readVrPad` parce qu'elle répond à une autre question : non pas « quel masque
SNES » mais « quelles entrées physiques », et les deux ne coïncident que par
accident.

## 5. Le panneau

Un nouveau module `frontend/src/lib/vr/panels/controls.ts`, de la même forme que
`panels/launch.ts` : `layoutControlsPanel` rend des régions, `drawControlsPanel`
les consomme, et tout est vérifiable sous Bun.

Sur l'écran courbe, `1024 × 768`, la surface du panneau de lancement. Ouvert
depuis une nouvelle région `remap` du pupitre profil, **y compris pendant une
partie** : c'est en jouant qu'on découvre qu'un mapping est mauvais. `Retour au
jeu` le referme, comme pour l'écran de lancement.

Le libellé de cette région ne peut pas être la clé `controls` : elle existe déjà
dans `ProfileLabels` et titre le rappel des touches fixes du pupitre. Il en faut
une nouvelle, `vrRemap`, sans quoi un même mot désignerait un titre et un bouton
sur le même panneau.

Huit lignes, une par bouton SNES, chacune portant son nom et le libellé humain
de l'entrée assignée. La ligne qui écoute est marquée par autre chose qu'une
couleur — même règle que la sauvegarde choisie sur l'écran de lancement, et pour
la même raison : deux états ne différant que par un remplissage produisent un
jeu de `fillText` identique, et le test « l'état est visible » n'aurait rien à
comparer.

Deux boutons de preset dessous, et le rappel des entrées non assignables
(croix → les deux sticks, menu → clic du stick droit) — elles sont hors modèle,
mais un joueur qui ne les voit nulle part les croit cassées.

Neuf libellés humains à traduire en deux langues, plus le titre, l'invite
« pressez un bouton », et les deux presets.

## 6. Ce qui reste hors périmètre

- **Les sticks et le menu.** Hors modèle, section 3.
- **Le compte.** Section 3, décidé et pesé.
- **Le second joueur.** `readVrPad` produit un seul masque, celui du joueur
  local ; l'autre arrive par le transport lockstep. Il n'y a pas de « p2 » à
  configurer dans un casque.
- **Le clavier.** Il n'y en a pas en session immersive.

## 7. Tests

Tout sous Bun, aucun test backend — rien ne bouge côté serveur.

`core/test/vr-pad-map.test.ts` (nouveau)
- l'échange préserve l'injectivité, sur les huit lignes et les neuf entrées
- assigner une entrée libre ne déplace rien
- `'letters'` et `'thumb'` hérités se résolvent vers leur map
- une valeur illisible est retirée et rend le défaut
- une map égale au défaut est retirée plutôt qu'écrite

`core/test/vr-panel-controls.test.ts` (nouveau)
- aucune région hors panneau, aucun chevauchement, sur les huit lignes
- la ligne qui écoute est visible autrement que par une couleur
- les entrées non assignables sont nommées quelque part

`core/test/vr-pad.test.ts` (étendu)
- `activeXrInputs` rend les entrées tenues et rien d'autre
- une map non-défaut produit le masque attendu, là où le preset le produisait
- une map où deux boutons SNES partagent une entrée — impossible par
  construction, mais `readVrPad` ne doit pas la traiter en silence
