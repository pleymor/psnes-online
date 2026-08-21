# Faire passer le solo sur la pile znet

Conception. Premier des deux morceaux d'un découpage : celui-ci fait tourner le solo sur `znet`, un second supprimera l'ancienne pile.

## Pourquoi

L'observation qui a lancé ce travail est de son propriétaire : « lancer une partie multi en lockstep offre une meilleure experience qu'en solo ». Deux constats plus précis sont venus après, et ce sont les deux mêmes causes.

En solo, un encart **« LATENCE »** s'affiche. Il vient de `ClientEmulator.svelte:945-947`, dont le commentaire dit littéralement *« always visible »*, et il est rendu dès que l'émulateur tourne — y compris en mode `SINGLE`. Il mesure la latence d'entrée et entrée-plus-image, des grandeurs locales donc pas absurdes, mais il a été conçu pour comparer les modes streaming et dual. En solo il ne compare plus rien.

En solo, **la barre d'outils du bas manque** : lignes de balayage, net/lissé, ajusté/étiré, plein écran, shader, statistiques. Elle appartient à `LockstepRoom.svelte`, que le solo ne rend jamais.

Ces deux faits ne sont pas des bugs distincts. Ce sont deux symptômes d'une scission : le solo passe par `P2PRoom` → `ClientEmulator` → RetroArch, le lockstep par `$lib/znet`. Tout ce qui a été construit récemment — les deux menus de sauvegarde, les vignettes WebP, le menu pause, le rendu WebGL — a été construit d'un seul côté.

La bascule était bloquée par une seule chose : `znet` rendait en 2D, donc y faire passer le solo lui coûtait ses shaders. Le rendu WebGL a levé ce blocage, et c'est pourquoi cet ordre avait été choisi.

## Ce que le solo est réellement

Une découverte qui change la forme de la solution : **le solo n'est pas une entrée séparée, c'est un salon avec un seul joueur**. `frontend/src/routes/room/[id]/+page.svelte:71` en fait un mode dérivé — `effectiveEmulationMode = isSinglePlayer ? EmulationMode.SINGLE : room?.emulationMode` — et le mode effectif est ensuite verrouillé, parce qu'en changer en cours de partie détruisait le composant rendu et redémarrait la partie.

Il n'y a donc pas de page solo à réécrire. Il y a une branche de rendu à changer dans la page de salon.

## Le contrat, mesuré et non supposé

`FrameGovernor` est le seul possesseur de timer de cette pile, et de la session il n'appelle que **deux** méthodes : `session.pump()` à `governor.ts:142` et `session.tick()` à `governor.ts:154`. Rien d'autre. Il déclare pourtant une dépendance sur le type concret `NetplaySession` (`governor.ts:10` et `:26`).

C'est le seul changement que cette bascule impose à l'existant, et il est purement élargissant :

```ts
export interface TickSource {
	pump(): void;
	tick(): TickResult;
}
```

`NetplaySession` la déclare — elle a déjà les deux méthodes, avec les bonnes signatures — et `FrameGovernor` en dépend. Aucun comportement existant ne change. Le lockstep ne remarque rien.

## La session solo

`frontend/src/lib/znet/solo.ts`, une classe minuscule dont l'intérêt est ce qu'elle **n'a pas** : ni transport, ni poignée de main, ni délai d'entrée, ni tampon de manettes distantes, ni sommes de contrôle périodiques, ni détection de désynchronisation, ni resynchronisation par savestate.

`NetplaySession` fait 957 lignes parce que deux machines doivent rester identiques. Aucune de ces lignes n'a de sens quand il n'y en a qu'une. Faire passer le solo par `NetplaySession` en simulant un pair serait la mauvaise réponse : ça garderait tout le coût et tous les modes de défaillance sans aucun des bénéfices.

```ts
export interface SoloOptions {
	core: NetplayCore;
	readLocalInput(): number;
	onFrame?(): void;
}

export class SoloSession implements TickSource {
	tick(): TickResult;   // lit la manette, avance d'une image, notifie, rend toujours 'ran'
	pump(): void;         // rien : il n'y a personne à relancer
	get currentFrame(): number;
}
```

`tick()` ne rend jamais `'stalled'` — c'est le sens même du solo : rien n'attend personne. Il ne rend jamais `'idle'` non plus. Cette invariance est ce qui rend la classe testable en une ligne, et elle est assez importante pour être testée explicitement plutôt que supposée.

Elle dépend de `NetplayCore`, l'interface que `FakeCore` implémente déjà dans `core/test/fake-core.ts`. **Cette partie est donc entièrement testable sous Node**, contrairement au rendu WebGL — et c'est une différence qu'il faut souligner : la leçon du travail précédent est qu'un code non testable doit être réduit au minimum, pas accepté par habitude.

## Le composant

`frontend/src/lib/components/SoloRoom.svelte`, qui compose les mêmes primitives que `LockstepRoom` moins le réseau : le cœur, le rendu — `CanvasRenderer` ou `WebglRenderer` avec les shaders et le même repli —, `FrameGovernor`, `InputCollector`, `AudioSink`, les deux menus de sauvegarde avec leurs vignettes, le menu pause, la barre d'affichage.

Le solo gagne donc exactement ce dont l'absence a été constatée, et perd l'encart hérité.

### Ce qui est délibérément conservé de l'ancien solo

**Les sauvegardes de pile.** C'est la sauvegarde *dans le jeu*, celle que fait le joueur depuis le menu de la cartouche, et la perdre serait une régression grave. Le solo la charge aujourd'hui par socket — `game:loadSram` puis l'événement `game:sramLoaded` — et le lockstep la persiste toutes les 30 secondes avec `game:saveSram` (`LockstepRoom.svelte:534`). `SoloRoom` fait les deux, à la même cadence, par les mêmes événements. Rien de nouveau côté serveur.

**Le turbo.** `FrameGovernor.setTurbo` existe déjà et n'a aucune contrainte en solo.

### Ce qui est délibérément abandonné

**Le ralenti et l'indicateur de vitesse.** Décision explicite du propriétaire. Le gouverneur sait accélérer mais pas ralentir, et l'ajouter demanderait un facteur de vitesse qu'aucun autre mode n'utiliserait. C'est une régression visible pour qui s'en servait, et elle est assumée plutôt que masquée.

**L'encart « LATENCE ».** C'était l'objet du signalement.

### Un risque ouvert que je ne peux pas trancher d'ici

Le solo actuel pourrait accepter **deux manettes physiques sur la même machine**, pour jouer à deux sur un canapé. La configuration RetroArch pose `input_player2_joypad_index: '1'` (`ClientEmulator.svelte:218`), ce qui associe la seconde manette au joueur 2 par le propre mécanisme de RetroArch.

`znet` ne sait pas faire cela : `InputCollector` détient une seule source (`input.ts:78`) et `read()` rend un seul masque. En lockstep c'est correct — le second port vient du réseau. En solo, ça voudrait dire perdre le jeu à deux en local.

Je ne peux pas vérifier si cette capacité fonctionne réellement aujourd'hui : il faut deux manettes branchées, et ce n'est pas testable ici. Je refuse donc de trancher dans les deux sens — affirmer que ça marche et le préserver à grands frais, ou affirmer que ça ne marche pas et le supprimer en silence.

**La mesure retenue coûte une ligne et garde la porte ouverte.** `SoloOptions.readLocalInput` rend une paire plutôt qu'un masque :

```ts
readLocalInput(): { pad1: number; pad2: number };
```

`SoloRoom` la remplit avec le masque de l'`InputCollector` en `pad1` et zéro en `pad2`. Le comportement d'aujourd'hui n'est pas modifié, la classe n'a aucune forme à changer si une seconde manette est ajoutée plus tard, et la vérification manuelle porte un point explicite : brancher deux manettes et constater ce que fait l'ancien solo, pour savoir si une régression a eu lieu.

## Flux de données

Identique au lockstep, moins le réseau.

Le gouverneur tient l'unique horloge et décide combien d'images une tranche de temps réel mérite. Il appelle `tick()`. La session lit la manette locale, avance le cœur d'exactement une image, et notifie. `onFrame` pousse l'image au rendu et les échantillons au puits audio. Le rendu ne pilote rien — c'est la règle du travail précédent et elle vaut ici aussi, même sans second joueur à désynchroniser, parce qu'un rendu qui influence le cadencement rend le jeu dépendant de la carte graphique.

Sauvegarder lit la machine sans la modifier. Charger applique l'état directement : contrairement au lockstep, où le chargement traverse la session pour que les deux pairs atterrissent sur la même machine, il n'y a ici personne à synchroniser.

## Traitement des erreurs

Trois pannes possibles, chacune avec une issue nommée.

**Pas de ROM.** Même chemin que le lockstep : chercher localement, puis demander au joueur. Il n'y a pas d'hôte à qui demander, donc l'étape intermédiaire disparaît — ce qui simplifie, et supprime au passage la classe de panne dont le propriétaire a cru voir un symptôme.

**Le cœur ne charge pas.** Écran d'erreur, comme aujourd'hui.

**Le rendu WebGL échoue.** Repli sur le 2D avec un avis, exactement comme le lockstep : quatre cas, deux canvas dont un caché, parce qu'un canvas ne lie qu'un seul type de contexte pour toute sa vie.

## Vérification

**Testable, et testé :** `SoloSession`. Qu'une séquence de manettes produise les mêmes octets qu'un `runFrame` direct sur le même cœur — c'est la propriété qui dit que la session n'ajoute rien de caché. Que `tick()` rende toujours `'ran'`. Que `pump()` soit sans effet. Et qu'aucun timer ne vive dans le fichier, vérifié par le même grep que le rendu WebGL.

**Testable, et testé :** que `FrameGovernor` accepte les deux implémentations. Un test qui le pilote avec une `SoloSession` et un `FakeCore` prouve que l'élargissement de sa dépendance est réel et pas seulement déclaré.

**Non testable ici, et je le dis plutôt que de le maquiller :** `SoloRoom.svelte`. Même limite que `LockstepRoom` — pas de contexte WebGL sous Node, aucun harnais navigateur qui charge une ROM. La vérification est manuelle et sa liste sera écrite comme telle.

La différence avec le travail précédent mérite d'être notée : là-bas, l'essentiel du code était intestable. Ici, la logique est dans une classe pure de quelques dizaines de lignes et le composant n'est que du câblage. C'est le bon rapport, et c'est délibéré.

## Ce que cette conception refuse de faire

**Pas de bascule de mode en cours de partie.** Un salon qui démarre en solo et gagnerait un pair sans redémarrer était l'autre option envisagée ; elle a été écartée pour ce morceau. `NetplaySession` exige que les deux pairs adoptent le même savestate depuis une poignée de main, et si le chemin de resynchronisation rend la chose concevable, c'est une fonctionnalité à part entière et non un effet de bord de cette bascule.

**Pas de suppression ici.** `ClientEmulator`, `P2PRoom`, `DualClientEmulator` et le module émulateur restent en place. Leur suppression est le second morceau du découpage, et elle dépend de celui-ci : on ne supprime pas l'implémentation actuelle du solo avant que la nouvelle fonctionne.

**Pas de réécriture de la page de salon.** Une branche de rendu change. Le verrouillage du mode, la reprise après reconnexion et le reste de sa logique ne sont pas touchés.

## Ce qui vient après

> **Décision annulée le 2026-08-21.** Le propriétaire a changé d'avis après
> avoir vu les modes en service : dual et streaming restent, et avec eux
> `ClientEmulator`, `P2PRoom`, `DualClientEmulator`, le module émulateur et
> `simple-peer`. **Ne pas exécuter la suppression décrite ci-dessous.** Le
> paragraphe est conservé plutôt que supprimé parce qu'il explique l'ordre des
> morceaux et parce que ses deux conséquences restent vraies — en particulier
> que le streaming est le seul chemin pour un invité incapable de faire
> tourner l'émulateur, ce qui est une raison de le garder.

La suppression de l'ancienne pile, décidée par le propriétaire : `ClientEmulator`, `P2PRoom`, `DualClientEmulator`, le module émulateur et `simple-peer`, avec les modes dual et streaming.

Deux conséquences de cette suppression, notées ici parce qu'elles se décident en connaissance de cause. Elle retire le seul chemin pour un invité **incapable de faire tourner l'émulateur** — c'est à cela que servait le streaming. Et elle supprime `options.ts`, qui détient le commit épinglé des shaders que `preset.ts` référence en double : la duplication signalée par la revue finale du travail précédent disparaît alors par soustraction, et l'argument « les deux chemins montrent le même shader » — qui justifiait de reprendre les fichiers libretro tels quels — cesse d'avoir un second chemin à égaler.

Ce n'est pas dans cette spec. C'est mentionné parce que ça explique l'ordre.
