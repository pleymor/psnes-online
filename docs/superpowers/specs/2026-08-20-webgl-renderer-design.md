# Un rendu WebGL2 pour le cœur lockstep

Conception pour l'issue #9.

## Pourquoi maintenant

Cette issue existait indépendamment, mais elle est devenue un prérequis. Le solo passe aujourd'hui par la pile ancienne — `P2PRoom` → `ClientEmulator` → `WasmEmulator`, c'est-à-dire RetroArch — tandis que le lockstep passe par `$lib/znet`. L'observation qui a déclenché ce travail est que jouer en lockstep offre une meilleure expérience qu'en solo, et la conclusion est de faire passer le solo sur la pile récente.

Sauf que `znet` rend en 2D. Basculer le solo tel quel lui ferait perdre xBRZ, CRT-Easymode, sharp-bilinear et FXAA, que RetroArch lui donne aujourd'hui. D'où l'ordre retenu : le rendu d'abord, la bascule ensuite, aucun compromis à assumer entre les deux.

Le lockstep y gagne au passage un réglage que l'application propose déjà. `ShaderSelector.svelte` vit dans la fenêtre de réglages de l'accueil, écrit son choix dans `localStorage['psnes-shader']`, et ce choix est honoré par le chemin RetroArch seul : `LockstepRoom.svelte` ne lit jamais cette clé. Un joueur qui choisit xBRZ le voit donc en solo et le perd en salon lockstep, sans explication. Un réglage global qui ne s'applique qu'à la moitié des modes est pire qu'un réglage absent.

## Ce que le sélecteur propose réellement

Six entrées, une liste fixe, pas un écosystème :

| Préréglage | Passes | Directives utilisées |
|---|---|---|
| `xbrz/6xbrz-linear` | 2 | `filter_linear0=false`, `scale_type0=source`, `scale0=6.0`, `filter_linear1=true` |
| `xbrz/5xbrz-linear` | 2 | idem, `scale0=5.0` |
| `xbrz/4xbrz-linear` | 2 | idem, `scale0=4.0` |
| `crt/crt-easymode` | 1 | `filter_linear0=false` |
| `interpolation/sharp-bilinear-simple` | 1 | `filter_linear0=true` |
| `anti-aliasing/fxaa` | 1 | `filter_linear0=true`, `scale_type0=source`, `scale0=1.0` |

Ce tableau est **constaté**, pas supposé : les quatre préréglages ont été récupérés depuis le CDN épinglé dans `options.ts` et lus. Le sous-ensemble du format `.glslp` à implémenter est donc :

`shaders`, `shaderN`, `filter_linearN`, `scale_typeN` (valeur `source` uniquement), `scaleN`.

Cinq directives. Pas de modes d'habillage, pas d'historique de trames, pas d'alias, pas de framebuffers flottants, pas de mipmaps, aucun `scale_type` relatif au viewport.

## Le contrat des fichiers de shaders

Un `.glsl` libretro contient les deux étages dans un seul fichier, séparés par `#if defined(VERTEX)` / `#elif defined(FRAGMENT)`. La source est donc compilée **deux fois**, avec le define approprié en préambule.

Ces fichiers sont écrits pour GLSL ES 1.00 tout en gérant la 3.00 par macros (`__VERSION__ >= 130` bascule `varying`/`attribute`/`texture2D` vers `in`/`out`/`texture`). WebGL2 accepte GLSL ES 1.00, donc **aucune transpilation n'est nécessaire** : on compile sans directive `#version`, ce qui est le chemin pour lequel ces shaders ont été écrits.

Le contrat est petit et fermé :

- attributs `VertexCoord`, `COLOR`, `TexCoord`
- varyings `COL0`, `TEX0`, plus ceux que le shader déclare pour son propre usage
- uniformes `MVPMatrix`, `FrameDirection`, `FrameCount`, `OutputSize`, `TextureSize`, `InputSize`, et l'échantillonneur `Texture`

Vérifié sur les six : aucun ne déclare autre chose. `COLOR` et `COL0` sont déclarés partout et utilisés nulle part, donc le compilateur les élimine et `getAttribLocation` rend `-1` — un emplacement absent est normal et doit être ignoré, pas traité comme une erreur.

`crt-easymode.glsl` porte dix-sept `#pragma parameter`, et le mécanisme mérite d'être nommé parce qu'il a un mode de défaillance silencieux. Le fichier déclare ces réglages en uniformes sous `#ifdef PARAMETER_UNIFORM`, et leurs valeurs par défaut en `#define` dans la branche `#else`. **On ne définit donc jamais `PARAMETER_UNIFORM`** : les défauts se compilent dans le shader. Le définir sans fournir les dix-sept uniformes les laisserait à zéro, ce qui donne une image noire sans la moindre erreur de compilation. On ne construit pas d'interface de réglage.

## Architecture

### Un second rendu derrière la même interface

`CanvasRenderer` expose aujourd'hui trois choses que `LockstepRoom` utilise : un constructeur prenant le canvas, `setOptions(DisplayOptions)` et `draw(core: PsnesCore)`. `WebglRenderer` expose exactement les mêmes, si bien que le salon choisit l'un ou l'autre sans rien savoir de la différence.

Le choix se fait à la construction, avec repli sur le 2D dans quatre cas :

1. pas de contexte WebGL2 disponible
2. le préréglage demandé utilise une directive hors sous-ensemble
3. la compilation ou le liage d'un programme échoue
4. `webglcontextlost` pendant la partie

Le quatrième est le plus important en pratique : sur un portable qui bascule de carte graphique, une perte de contexte non traitée transforme le jeu en écran noir sans le moindre message.

### L'interpréteur, et ses refus

`frontend/src/lib/znet/preset.ts` — une fonction pure, sans dépendance au DOM ni au réseau :

```ts
parsePreset(source: string): PresetResult
```

où `PresetResult` est une union discriminée : soit le préréglage compris, soit une raison de refus nommant la directive fautive. Le refus est un résultat, pas une exception, pour que l'appelant ne puisse pas l'ignorer par distraction.

La règle qui compte : **tout ce qui n'est pas dans le sous-ensemble est refusé et nommé**. L'issue le demande explicitement, et pour une raison documentée — `xbrz-freescale` a été retiré de la liste parce que son échelle relative au viewport provoquait des erreurs de framebuffer. Un refus lisible vaut mieux qu'un écran noir.

La récupération des fichiers reste hors de cette fonction. Le dépôt et la version épinglée sont ceux d'`options.ts`, mais la résolution des chemins ne l'est pas : `resolveShader` code en dur une table de cas particuliers pour les trois xBRZ, alors que le préréglage nomme lui-même ses fichiers — et les nomme **relativement à lui**, `shader0 = shaders/6xbrz.glsl` puis `shader1 = ../stock.glsl`. On résout donc ces chemins comme des URL relatives à celle du préréglage, ce qui rend la table de cas particuliers inutile et gère par construction tout préréglage du sous-ensemble.

Les deux chemins de rendu affichent ainsi **les mêmes shaders**, ce qui est l'argument décisif de cette approche : des effets réécrits à la main donneraient au même réglage un aspect différent selon le mode de jeu.

### Les passes

Chaque passe intermédiaire dessine dans une texture dimensionnée `scale × source`. La dernière dessine sur le canvas. Deux passes suffisent aux six préréglages, mais rien dans la mécanique ne le suppose.

`InputSize` et `TextureSize` valent la taille de l'entrée de la passe ; `OutputSize` celle de sa cible. `FrameCount` s'incrémente à chaque image affichée, `FrameDirection` vaut 1 — le lockstep ne rejoue pas à l'envers côté affichage.

### Le téléversement de l'image

Le cœur détient un tampon à pas fixe, et ce n'est pas une supposition reprise de l'issue : `core/src/psnes_core.c:470` rend `PN_MAX_WIDTH` sans condition, valant 512 à la ligne 32. La largeur visible, elle, varie. `videoFrame()` recopie donc ligne par ligne pour compacter à `width × height`, et cette recopie n'existe que pour `putImageData`.

`PsnesCore` gagne donc un accès sans copie — une vue sur le tas WASM plus les trois dimensions — que `WebglRenderer` téléverse directement avec `UNPACK_ROW_LENGTH` réglé sur le pas. `CanvasRenderer` continue d'utiliser `videoFrame()` inchangé. Un coût par image disparaît pour le chemin WebGL sans rien changer à l'autre.

### Les changements de résolution

La SNES bascule entre 256×224, du 512×448 haute résolution et des modes entrelacés, et `pn_video_width/height` suivent. Une texture de taille fixe afficherait du bruit la première fois qu'un jeu ouvre un menu haute résolution.

La texture d'entrée et les framebuffers de passes sont donc réalloués quand les dimensions changent, pas à chaque image. La comparaison porte sur les dimensions constatées à l'image courante.

## Ce que cette conception refuse de faire

**Le rendu ne pilote rien.** Aucun `requestAnimationFrame` à l'intérieur, aucun cadencement sur le vsync, aucune compensation d'image perdue, aucun « je dessine quand je suis prêt ». `session.tick()` décide qu'une image existe ; le rendu ne fait que l'afficher.

Un corollaire mesuré : `draw()` est appelé depuis `onFrame` de la session, donc **une fois par image émulée et non par image affichée**. Après un décrochage réseau, le gouverneur en exécute jusqu'à huit dans une seule tranche de `requestAnimationFrame`, et le pipeline tournera donc huit fois pour une seule image visible. C'est déjà le comportement du chemin 2D ; en WebGL avec xBRZ 6x le coût est plus élevé. Ce n'est pas un risque de désynchronisation — le gouverneur plafonne, l'émulation reste juste — mais un risque de saccade visible, et la conception ne le corrige pas : ne dessiner que la dernière image d'une tranche changerait aussi le chemin 2D, ce qui sort de cette spec. À constater dans le navigateur avant d'y toucher.

Ce n'est pas une préférence de style. `FrameGovernor` est le seul possesseur de timer de cette pile — c'est écrit en tête de `session.ts`, « le moteur ne possède aucun timer, tout se passe dans `tick()` », et c'est ce qui rend la session testable. Si le rendu influençait le cadencement, l'émulation des deux joueurs dépendrait de leurs cartes graphiques. C'est une désynchronisation avec des étapes supplémentaires.

**Les options locales restent locales.** Net/lissé, lignes de balayage et format sont par joueur parce qu'ils ne changent rien de ce que l'émulateur calcule. Le choix du shader entre dans la même catégorie et n'a pas à traverser le réseau. Deux joueurs peuvent différer.

**Pas d'interface de réglage des shaders.** Les `#pragma parameter` gardent leurs valeurs par défaut. Six entrées dans une liste, comme aujourd'hui.

**Pas de nouveau format.** On ne réinvente pas les shaders à la main et on n'invente pas de préréglage maison. Ce sont les fichiers libretro, pris à la même version que le chemin RetroArch.

## Vérification

**Testable, et testé :** l'interpréteur de préréglages. Les quatre préréglages réels — repris verbatim dans les tests plutôt que récupérés au moment du test, pour que la suite ne dépende pas du réseau — plus ses refus : `scale_type = viewport`, une directive inconnue, un nombre de passes incohérent avec les `shaderN` présents, un fichier vide.

**Non testable ici, et je le dis plutôt que de le maquiller :** tout le pipeline GL. Il n'y a pas de contexte WebGL sous Node, et ce dépôt n'a aucun harnais navigateur — les 165 tests actuels sont du Node pur et du Playwright qui ne charge jamais de ROM. La compilation des shaders, le rendu multi-passe, le téléversement avec `UNPACK_ROW_LENGTH`, la réallocation sur changement de résolution et le repli sur perte de contexte seront vérifiés à l'œil, dans un navigateur, sur les six préréglages.

C'est une faiblesse réelle de cette conception. Elle est acceptée parce que la seule alternative — introduire un harnais de rendu navigateur — coûterait plus que la fonctionnalité, et parce que le repli sur le 2D borne le dégât : le pire cas d'un pipeline cassé est l'image qu'on a déjà aujourd'hui.

**Le contrôle qui compte le plus** n'est pas une capture d'écran mais une mesure : que le cadencement des images soit identique avec et sans shader, et identique entre les deux rendus. Si activer xBRZ change le nombre d'images émulées par seconde, le rendu n'est pas resté un puits passif, et c'est le seul défaut de ce travail qui pourrait désynchroniser une partie.

## Ce qui vient après

La bascule du solo sur `znet` — un `SoloRoom` qui compose le cœur, ce rendu, le gouverneur, les entrées et l'audio, avec une session solo implémentant le même `tick()` que `NetplaySession`. Le gouverneur dépend aujourd'hui du type concret `NetplaySession` ; en extraire un contrat étroit est le seul changement que cette bascule impose à l'existant.

Ce n'est pas dans cette spec. Elle est mentionnée parce qu'elle explique l'ordre choisi.
