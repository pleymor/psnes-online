# On cherche la manette dès l'arrivée

Conception. Petit morceau, une seule page. Demande du propriétaire :
« pour la manette, ce serait bien qu'une détection se lance dès la navigation
vers `/profile` ».

## Pourquoi

Aujourd'hui, arriver sur `/profile` ne cherche rien.
`ControlsSettings.onMount` appelle `refreshPads()` **une fois**
(`ControlsSettings.svelte:76`), puis s'en remet à `gamepadconnected`. Le reste
du temps, la seule chose qui interroge le navigateur est le sondage de
`PlayerControls`, et il ne tourne que pendant une capture, une détection, ou
quand la table affichée est celle d'une manette **déjà assignée**
(`PlayerControls.svelte:402-403`).

La cause qui rend ça visible n'est pas dans ce dépôt : **le navigateur ne révèle
une manette qu'après un appui sur un de ses boutons.** `navigator.getGamepads()`
renvoie des trous jusque-là, et `gamepadconnected` ne part qu'à ce premier appui.
Donc une manette branchée avant l'ouverture de la page, et non touchée, n'existe
pas pour l'application : la liste déroulante n'offre que Clavier et Aucun, et
**rien ne dit au joueur qu'il suffit d'appuyer.**

Il faut cliquer « Détecter la manette » pour qu'on l'invite enfin à appuyer — un
bouton qui, en plus, **assigne** la manette au joueur, et donc lui coupe le
clavier (`assignmentFor({ kind: 'pad' })` renvoie `keyboard: false`).

Et un trou de plus, propre à cette page : la carte des contrôles est derrière
`{#if controlsConfig}` (`profile/+page.svelte:287`), donc pendant l'aller-retour
vers `/api/user/controls` il n'y a même pas d'écouteur `gamepadconnected`.

## Ce qui est décidé

| Question | Réponse retenue | Ce qui a été écarté |
|---|---|---|
| Ce que « détecter » veut dire ici | **Constater et le dire.** La page cherche, et annonce ce qu'elle trouve. | Lancer la détection existante, qui *assigne*. |
| Assigner automatiquement la manette trouvée | **Non.** | Oui — voir ci-dessous, ça coupe le clavier. |
| Quand la recherche commence | **À la navigation vers `/profile`**, pas au rendu de la carte. | Au montage de `ControlsSettings`, qui attend un aller-retour HTTP. |
| Comment on cherche | `gamepadconnected` **et** un sondage, tant que rien n'est connu. | L'événement seul, qu'un montage tardif peut manquer. |

**Pourquoi ne rien assigner.** Le joueur 1 est sur `'auto'` par défaut, ce qui
veut dire « le clavier **et** toute manette libre » : une manette qui apparaît
est donc déjà jouable, sans que rien ne soit assigné. L'assigner explicitement
écrirait `keyboard: false` et **couperait le clavier du joueur 1** parce qu'il a
effleuré une manette sur une page de réglages. Et si le joueur a délibérément
choisi Clavier, une détection qui écrase ce choix est un réglage qui se défait
tout seul. La détection renseigne ; c'est le bouton existant qui décide, et il
reste là pour ça.

Conséquence assumée, à dire plutôt qu'à découvrir : **arriver, appuyer sur un
bouton, jouer** marche pour un joueur sur `'auto'` — le cas par défaut et de
loin le plus courant. Un joueur qui a fixé Clavier verra la manette apparaître
dans la liste et devra la choisir, ou cliquer « Détecter ». C'est le prix du
respect d'un choix explicite.

## Le modèle : une veille partagée, comptée

`frontend/src/lib/controls/pad-watch.ts`. Une veille unique, dont le nombre
d'abonnés décide de la vie :

```ts
export const pads: Readable<PadInfo[]>;
export function watchPads(): () => void;   // rend son propre arrêt
```

- Le premier abonné branche `gamepadconnected` / `gamepaddisconnected` et arme
  le sondage. Le dernier à partir débranche tout. **Aucun minuteur ne survit à
  son dernier abonné** : un minuteur oublié a déjà fait passer la suite de tests
  de 0,9 s à 48 s dans ce dépôt, deux fois.
- Le sondage ne tourne **que pendant qu'aucune manette n'est connue**. Dès qu'il
  y en a une, il s'arrête : `gamepaddisconnected` suffit ensuite, et un sondage
  permanent sur une page de réglages ne se justifie pas. Il repart si la
  dernière manette s'en va.
- Deux appelants : la page `/profile`, qui appelle `watchPads()` dans son propre
  `onMount` — c'est ce qui répond littéralement à « dès la navigation » — et
  `ControlsSettings`, qui en fait autant pour son autre lieu de montage, le menu
  pause. Deux abonnés, un seul minuteur, un seul jeu d'écouteurs.

`ControlsSettings` cesse de tenir son propre `pads` et ses deux écouteurs : il
lit le store. C'est trois lignes en moins et un endroit de moins où la liste
peut être périmée.

## Ce que la page dit

Une ligne au-dessus des deux joueurs, dans `ControlsSettings`, avec deux états
et rien d'autre :

| État | Ce qui est dit |
|---|---|
| Aucune manette connue | *Recherche d'une manette — appuyez sur un bouton* |
| Au moins une | *Manette détectée : 8BitDo SN30* |

La première phrase est la vraie nouveauté du morceau : elle nomme la seule chose
que le joueur doit faire et que rien ne lui disait. La seconde confirme, et
nomme la manette parce que « détectée » sans nom ne se vérifie pas — deux
manettes branchées, on veut savoir laquelle a parlé.

## Ce qui est testable

`createPadWatcher(deps)` prend son `navigator`, son `addEventListener` et son
horloge en paramètres, comme `invitationState` prend son instant. Cinq
comportements, dans `core/test/pad-watch.test.ts` :

1. Les manettes déjà connues sont rapportées dès le premier abonné.
2. Une manette qui n'apparaît **que** plus tard est trouvée par le sondage,
   sans qu'aucun événement ne soit émis — c'est le cas que l'écouteur seul rate.
3. Le sondage s'arrête dès qu'une manette est connue, et repart quand la
   dernière s'en va.
4. Deux abonnés ne font qu'un minuteur et qu'un jeu d'écouteurs.
5. Le dernier départ arrête le minuteur et retire les écouteurs.

Le reste — que le navigateur exige un appui avant d'admettre la manette — n'est
pas testable ici : c'est la règle du navigateur, et c'est précisément la raison
d'être de la phrase affichée.

## Ce que cette conception refuse de faire

- **Assigner quoi que ce soit tout seul.** Voir plus haut.
- **Sonder en permanence.** Le sondage s'arrête dès qu'il a trouvé.
- **Chercher ailleurs que sur les deux écrans de réglages.** Une partie qui
  tourne a son propre sondage, et une manette y est par construction déjà connue.
- **Prétendre trouver une manette non touchée.** Aucun code ne peut le faire ;
  ce morceau le dit au joueur au lieu de le laisser deviner.
