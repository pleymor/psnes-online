# Tablette flottante pour les options VR — plan d'implémentation (lot 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sortir le panneau des contrôles de l'écran incurvé et le poser sur une tablette flottant à 1,5 m, pour que le jeu reste visible pendant un réglage.

**Architecture:** La tablette est un quatrième `scene.addPanel()`, pas un nouveau type d'objet. Aucune machine à états : `remapOpen` devient `tabletOpen`. Deux règles pures nouvelles dans `layout.ts` et `panel.ts` portent les invariants que le casque ne peut pas vérifier tout seul.

**Tech Stack:** Svelte 4, three.js 0.185.1 (WebXR), Bun test, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-07-vr-tablette-options-design.md`

## Global Constraints

- Aucune modification serveur, aucune migration.
- `layout.ts` n'importe rien de three — `vr-layout.test.ts` le vérifie en lisant le fichier.
- Tout panneau doit avoir la forme de son canvas (test d'aspect) et porter 25 px/degré à ±15 % (test de résolution). Les deux vivent dans `core/test/vr-layout.test.ts`.
- Deux locales, `en` et `fr`, dans `frontend/src/lib/i18n/translations.ts` ; `core/test/i18n-parity.test.ts` refuse une clé présente d'un seul côté.
- Tout nouveau fichier de test doit être ajouté au script `test:ui` de `package.json`, sinon il ne tourne jamais en CI.
- Commandes : `bun test <fichier>` pour un fichier, `bun run test:ui` pour la suite, et depuis `frontend/` avec `PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"` : `npx svelte-check --tsconfig ./tsconfig.json --threshold error`.

---

### Task 1 : la place de la tablette, et la marge qui garde son bas lisible

**Files:**
- Modify: `frontend/src/lib/vr/layout.ts`
- Test: `core/test/vr-layout.test.ts`

**Interfaces:**
- Consumes: `Placement`, `eyeDistance`, `angularWidth`, `pixelsPerDegree`, `QUEST_3_PIXELS_PER_DEGREE` — déjà exportés par `layout.ts`.
- Produces: `SceneLayout.tablet: Placement` ; `verticalSpan(placement: Placement): { top: number; bottom: number }` en degrés, positif vers le haut.

- [ ] **Step 1: écrire le test qui échoue**

Ajouter à la fin de `core/test/vr-layout.test.ts` :

```ts
/*
 * L'étendue verticale d'un panneau, tangage compris.
 *
 * Le cas de contrôle en premier, parce que c'est ce qui a manqué la première
 * fois : un panneau basculé de -90 degrés est à plat, face au ciel, donc son
 * bord « haut » est le plus ÉLOIGNÉ du joueur et se lit près de l'horizon. Une
 * version signée à l'envers passe toutes les assertions symétriques et échoue
 * uniquement celle-là - elle avait produit une marge de 8,3 degrés là où la
 * vérité est un chevauchement.
 */
test('un panneau a plat face au ciel a son bord haut au loin', () => {
  const flat = {
    position: [0, 0, -1] as [number, number, number],
    rotation: [-Math.PI / 2, 0, 0] as [number, number, number],
    width: 1,
    height: 1
  };
  const span = verticalSpan(flat);
  assert.ok(Math.abs(span.top) < 0.001, `bord haut a ${span.top.toFixed(2)} deg, attendu ~0`);
  assert.ok(Math.abs(span.bottom) < 0.001, `bord bas a ${span.bottom.toFixed(2)} deg, attendu ~0`);
});

test('sans tangage l etendue est symetrique', () => {
  const flat = {
    position: [0, 0, -1] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    width: 1,
    height: 1
  };
  const span = verticalSpan(flat);
  assert.ok(Math.abs(span.top - 26.565) < 0.01);
  assert.ok(Math.abs(span.bottom + 26.565) < 0.01);
});

test('un tangage arriere descend le bord bas, parce qu il le rapproche', () => {
  const base = {
    position: [0, 0, -1] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    width: 1,
    height: 1
  };
  const tipped = { ...base, rotation: [-Math.PI / 6, 0, 0] as [number, number, number] };
  assert.ok(
    verticalSpan(tipped).bottom < verticalSpan(base).bottom,
    'le bord bas se rapproche du joueur, donc son elevation descend'
  );
});

/*
 * Qui occulte qui, et pourquoi ce test a changé de sujet.
 *
 * La tablette est à 1,5 m et le bandeau à 1,0 m : ils peuvent se chevaucher en
 * angle sans se toucher, et le plus proche gagne. Le plus proche est le
 * BANDEAU - donc la sortie n'est jamais masquée, contrairement à ce que la
 * première version de cette conception affirmait. Ce qui est en jeu est la
 * lisibilité du bas de la tablette, où le panneau des contrôles dessine sa
 * bande de mapping fixe.
 */
test('le bandeau ne mange pas le bas de la tablette', () => {
  const { tablet, profile } = sceneLayout('crt');

  assert.ok(
    eyeDistance(profile) < eyeDistance(tablet),
    'si le bandeau cessait d etre le plus proche, ce test protegerait le mauvais bord'
  );

  const marge = verticalSpan(tablet).bottom - verticalSpan(profile).top;
  assert.ok(
    marge > 1,
    `le bas de la tablette est a ${marge.toFixed(1)} deg du haut du bandeau, donc derriere lui`
  );
});

test('la tablette flotte devant l ecran, pas dessus', () => {
  const { tablet, screen } = sceneLayout('crt');
  assert.ok(
    eyeDistance(tablet) < screen.radius - 0.8,
    'sans separation il n y a pas de parallaxe, donc pas d effet flottant'
  );
});

test('une part utile de l image du jeu reste au-dessus de la tablette', () => {
  const { tablet, screen } = sceneLayout('crt');
  const image = verticalSpan({
    position: [0, screen.centerY, -screen.radius],
    rotation: [0, 0, 0],
    width: screen.radius * screen.arc,
    height: screen.height
  });
  const reste = (image.top - verticalSpan(tablet).top) / (image.top - image.bottom);
  // 45 % avec les chiffres retenus. Flotter devant l ecran implique d en
  // masquer une part : ce test borne cette part, il ne la supprime pas.
  assert.ok(reste > 0.35, `il ne reste que ${(reste * 100).toFixed(0)}% de l image au-dessus`);
});
```

Ajouter `verticalSpan` et `TABLET_PANEL_SIZE` aux imports du fichier :

```ts
import {
  sceneLayout,
  eyeDistance,
  angularWidth,
  pixelsPerDegree,
  verticalSpan,
  QUEST_3_PIXELS_PER_DEGREE
} from '../../frontend/src/lib/vr/layout.js';
import { TABLET_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/controls.js';
```

Et ajouter la tablette aux deux tests d'invariants existants, dans leurs tableaux `pairs` :

```ts
    ['tablet', layout.tablet, TABLET_PANEL_SIZE],
```

- [ ] **Step 2: lancer le test pour vérifier qu'il échoue**

Run: `bun test core/test/vr-layout.test.ts`
Expected: FAIL — `Export named 'verticalSpan' not found`.

- [ ] **Step 3: implémenter**

Dans `frontend/src/lib/vr/layout.ts`, ajouter les constantes près de celles du bandeau :

```ts
/*
 * La tablette : les menus d'options, à leur propre profondeur.
 *
 * Chaque nombre est déduit, pas choisi. 1,12 / 0,84 = 4/3 parce que c'est la
 * forme du canvas de `panels/controls.ts` (1024 x 768), et un panneau qui n'a
 * pas la forme de son canvas étire tout son texte. 1,5 m parce que son centre
 * est alors à 1,540 m des yeux, qu'elle occupe 40,0 degrés, et que 1024/40,0
 * donne 25,6 pixels de canvas par degré contre les 25 du Quest 3.
 *
 * L'écran est à 2,5 m : il reste un mètre franc entre les deux surfaces, et
 * c'est cette séparation qui fait que « flottant devant l'écran » veut dire
 * quelque chose.
 *
 * La descente de 0,35 m est un arbitrage chiffré, et choisi contre deux
 * autres. L'image du jeu occupe -21,4 à +21,4 degrés et la tablette -28,4 à
 * +2,1 : elle couvre 55 % de l'image et en laisse 45 % au-dessus d'elle. Plus
 * bas elle couvrirait moins - 42 % à 0,50 m - mais son bord bas passerait
 * derrière le bandeau, qui est plus proche. Plus haut elle dégagerait le
 * bandeau et mangerait l'image : 64 % à 0,25 m. 0,35 m est le premier cran où
 * la marge au-dessus du bandeau est réelle plutôt que rasante.
 *
 * Flotter devant l'écran implique d'en masquer une part. La demande était que
 * le jeu reste SUR l'écran de jeu, pas qu'on le voie entièrement.
 */
const TABLET_DISTANCE = 1.5;
const TABLET_DROP = 0.35;
const TABLET_WIDTH = 1.12;
const TABLET_HEIGHT = TABLET_WIDTH / (1024 / 768);
/** L'élévation de son propre centre, donc elle fait face au regard. */
const TABLET_PITCH = -Math.atan(TABLET_DROP / TABLET_DISTANCE);
```

Ajouter le champ à l'interface :

```ts
export interface SceneLayout {
  screen: ScreenPlacement;
  library: Placement;
  friends: Placement;
  profile: Placement;
  /** Les menus d'options, devant l'écran. Voir les constantes ci-dessus. */
  tablet: Placement;
}
```

Et au retour de `sceneLayout`, après `profile` :

```ts
    tablet: {
      position: [0, -TABLET_DROP, -TABLET_DISTANCE],
      rotation: [TABLET_PITCH, 0, 0],
      width: TABLET_WIDTH,
      height: TABLET_HEIGHT
    }
```

Puis la fonction pure, à côté de `angularWidth` :

```ts
/**
 * Le haut et le bas d'un panneau, en degrés au-dessus de l'horizon.
 *
 * Le tangage compte, et c'est tout l'intérêt : il fait pivoter les deux bords
 * autour du centre, donc un tangage arrière rapproche le bord bas du joueur en
 * même temps qu'il le descend. Deux estimations successives de la marge entre
 * la tablette et le bandeau se sont trouvées fausses pour avoir sauté cette
 * étape, dont une avec le signe inversé - d'où le cas de contrôle du panneau à
 * plat dans les tests, qui est la seule assertion qu'une version signée à
 * l'envers échoue.
 *
 * Seul le tangage est lu. Un lacet ne change rien à une étendue verticale, et
 * aucun panneau de cette scène n'a de roulis - `panel-mesh.ts` explique
 * pourquoi son ordre de rotation est `YXZ` précisément pour qu'il n'y en ait
 * pas.
 */
export function verticalSpan(placement: Placement): { top: number; bottom: number } {
  const [, y, z] = placement.position;
  const [pitch] = placement.rotation;
  const half = placement.height / 2;

  /*
   * Le vecteur « haut » du panneau après son tangage.
   *
   * Une rotation d'angle p autour de X envoie (0,1,0) sur (0, cos p, sin p).
   * Le signe de la composante z est ce qui s'est trompé une fois : avec p
   * négatif elle est négative, donc le bord haut s'ÉLOIGNE du joueur, ce que
   * le cas du panneau à plat face au ciel vérifie sans ambiguïté.
   */
  const upY = half * Math.cos(pitch);
  const upZ = half * Math.sin(pitch);

  const angle = (dy: number, dz: number) =>
    (Math.atan2(y + dy, -(z + dz)) * 180) / Math.PI;

  return { top: angle(upY, upZ), bottom: angle(-upY, -upZ) };
}
```

- [ ] **Step 4: lancer les tests**

Run: `bun test core/test/vr-layout.test.ts`
Expected: PASS, tous.

- [ ] **Step 5: commit**

```bash
git add frontend/src/lib/vr/layout.ts core/test/vr-layout.test.ts
git commit -m "Give the options tablet a place, and measure what it must not cover"
```

---

### Task 2 : un panneau invisible cesse d'être une cible

**Files:**
- Modify: `frontend/src/lib/vr/panel.ts`
- Modify: `frontend/src/lib/vr/scene.ts`
- Test: `core/test/vr-panel.test.ts`

**Interfaces:**
- Produces: `aimable<T extends { mesh: { visible: boolean } }>(panels: readonly T[], panelsVisible: boolean): T[]`

- [ ] **Step 1: écrire le test qui échoue**

Ajouter à la fin de `core/test/vr-panel.test.ts` :

```ts
/*
 * Quels panneaux sont visables, et pourquoi c'est une fonction.
 *
 * `Raycaster` de three ne teste que les layers, jamais la visibilité
 * (`Raycaster.js:240`) : un mesh simplement masqué reste donc touché par un
 * rayon. Le mode de défaillance est le pire de sa catégorie - des pressées
 * avalées par une surface que le joueur ne voit pas, sur ce qui se trouve
 * derrière elle - et la tablette flottante est précisément un panneau qui
 * passe le plus clair de son temps masqué.
 */
const panel = (id: string, visible: boolean) => ({ id, mesh: { visible } });

test('un panneau masque n est pas une cible', () => {
  const panels = [panel('library', true), panel('tablet', false)];
  assert.deepEqual(aimable(panels, true).map((p) => p.id), ['library']);
});

test('rien n est visable quand les panneaux sont rappeles', () => {
  // La gachette est la manette pendant une partie, pas un pointeur.
  assert.deepEqual(aimable([panel('library', true)], false), []);
});

test('tout ce qui est visible est visable', () => {
  const panels = [panel('a', true), panel('b', true)];
  assert.equal(aimable(panels, true).length, 2);
});

test('l ordre est conserve, parce que hit() prend la premiere correspondance', () => {
  const panels = [panel('first', true), panel('second', true)];
  assert.deepEqual(aimable(panels, true).map((p) => p.id), ['first', 'second']);
});
```

Ajouter `aimable` aux imports du fichier.

- [ ] **Step 2: lancer le test pour vérifier qu'il échoue**

Run: `bun test core/test/vr-panel.test.ts`
Expected: FAIL — `Export named 'aimable' not found`.

- [ ] **Step 3: implémenter la fonction pure**

À la fin de `frontend/src/lib/vr/panel.ts` :

```ts
/**
 * Les panneaux qu'un rayon doit pouvoir toucher.
 *
 * Deux règles, et la seconde est un piège de three. La première : rien n'est
 * visable quand les panneaux sont rappelés, parce que la gâchette est alors la
 * manette et non un pointeur. La seconde : un panneau masqué n'est pas une
 * cible - et il faut le dire ici, parce que `Raycaster` ne teste que les
 * layers et jamais `visible` (`Raycaster.js:240`), donc un mesh caché reste
 * touché par un rayon. Une tablette fermée avalerait les pressées destinées
 * aux pupitres derrière elle, invisiblement.
 *
 * L'ordre est conservé : `hit()` retourne la première correspondance, donc
 * l'ordre du tableau est son ordre de profondeur.
 */
export function aimable<T extends { mesh: { visible: boolean } }>(
  panels: readonly T[],
  panelsVisible: boolean
): T[] {
  if (!panelsVisible) return [];
  return panels.filter((panel) => panel.mesh.visible);
}
```

- [ ] **Step 4: lancer les tests**

Run: `bun test core/test/vr-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: la brancher dans `scene.ts`**

Dans `frontend/src/lib/vr/scene.ts`, remplacer dans `aimedAt` :

```ts
    const targets: THREE.Object3D[] = [];
    if (panelGroup.visible) targets.push(...panelMeshes);
    if (screen.isPanel()) targets.push(screen.mesh);
```

par :

```ts
    // `panels`, pas `panelMeshes` : la règle vit dans `panel.ts` maintenant,
    // et elle a besoin de voir la visibilité de chaque mesh.
    const targets: THREE.Object3D[] = aimable(panels, panelGroup.visible).map(
      (panel) => panel.mesh
    );
    if (screen.isPanel()) targets.push(screen.mesh);
```

Ajouter `aimable` à l'import depuis `./panel`, et supprimer le tableau `panelMeshes` ainsi que le `panelMeshes.push` de `addPanel` — il n'a plus de lecteur. Son commentaire d'origine expliquait qu'il évitait une allocation dans la boucle chaude ; `aimable` en fait une par appel, exactement comme le `targets` qu'il remplace, donc rien ne régresse.

- [ ] **Step 6: vérifier les types et la suite**

Run depuis `frontend/` : `PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npx svelte-check --tsconfig ./tsconfig.json --threshold error`
Expected: 0 errors.

Run: `bun run test:ui`
Expected: 0 fail.

- [ ] **Step 7: commit**

```bash
git add frontend/src/lib/vr/panel.ts frontend/src/lib/vr/scene.ts core/test/vr-panel.test.ts
git commit -m "Stop a hidden panel from swallowing presses meant for what is behind it"
```

---

### Task 3 : le panneau des contrôles déménage sur la tablette

**Files:**
- Modify: `frontend/src/lib/vr/panels/controls.ts` (ajouter `TABLET_PANEL_SIZE` comme alias exporté)
- Modify: `frontend/src/lib/components/VrShell.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`
- Test: `core/test/vr-panel-controls.test.ts`

**Interfaces:**
- Consumes: `SceneLayout.tablet` (Task 1), `aimable` (Task 2).
- Produces: rien pour un lot ultérieur.

- [ ] **Step 1: nommer la taille de la tablette**

Dans `frontend/src/lib/vr/panels/controls.ts`, sous `CONTROLS_PANEL_SIZE` :

```ts
/**
 * Le même canvas, sous le nom de la surface qui le porte.
 *
 * `layout.ts` a besoin de cette taille pour vérifier que la tablette a la
 * forme de son canvas, et il ne peut pas dépendre du panneau des contrôles en
 * particulier : c'est la tablette qui est mesurée, pas son contenu du jour. Le
 * lot 2 remplacera ce contenu par la manette dessinée sans toucher à la
 * surface.
 */
export const TABLET_PANEL_SIZE = CONTROLS_PANEL_SIZE;
```

- [ ] **Step 2: le libellé de sortie devient un retour**

Dans `frontend/src/lib/i18n/translations.ts`, remplacer les deux valeurs de `vrRemapDone` :

```ts
    vrRemapDone: 'Back',
```
```ts
    vrRemapDone: 'Retour',
```

Le demandeur a demandé « un bouton de retour pour naviguer vers le menu principal d'options ». Ce bouton existait déjà sous le nom « Terminé », qui dit qu'on a fini un réglage plutôt qu'on remonte d'un cran — et ce qu'il ramène est le bandeau, qui *est* ce menu principal.

- [ ] **Step 3: adapter le test des contrôles**

Dans `core/test/vr-panel-controls.test.ts`, la valeur de `done` dans `LABELS` passe de `'Terminé'` à `'Retour'`. Le fichier commente déjà pourquoi ses libellés sont les formulations expédiées : le test de largeur les mesure.

Run: `bun test core/test/vr-panel-controls.test.ts`
Expected: PASS.

- [ ] **Step 4: la tablette dans VrShell**

Déclarer le panneau à côté des autres :

```ts
  let tabletPanel: PanelMesh | null = null;
```

L'ajouter dans `enter()`, après `profilePanel` :

```ts
      tabletPanel = scene.addPanel('tablet', scene.layout.tablet, TABLET_PANEL_SIZE);
      // Fermée à l'ouverture de la session. `aimable` (panel.ts) est ce qui
      // fait que « masquée » veut dire « pas une cible » et pas seulement
      // « invisible ».
      tabletPanel.mesh.visible = false;
```

Renommer `remapOpen` en `tabletOpen` partout dans le fichier.

- [ ] **Step 5: `repaintControls` peint la tablette**

Remplacer le corps de `repaintControls` :

```ts
  function repaintControls(): void {
    if (!tabletPanel || !tabletOpen) return;
    const state = { map: padMap, listeningFor, language: $language };
    tabletPanel.regions = layoutControlsPanel(state);
    const regions = tabletPanel.regions;
    tabletPanel.paint((ctx) =>
      drawControlsPanel(ctx, state, regions, {
        labels: controlsLabels(),
        hoverId: hovered?.panel === 'tablet' ? hovered.region.id : null
      })
    );
  }
```

- [ ] **Step 6: ouvrir et fermer**

```ts
  /**
   * Ouvre la tablette. L'écran ne bouge pas.
   *
   * Ce `launchFor = null` que cette fonction portait est parti avec le
   * déménagement : ouvrir les contrôles abandonnait l'écran de lancement,
   * parce que les deux se disputaient la même surface. Ils ne se la disputent
   * plus, donc le jeu continue et l'écran de lancement reste.
   */
  function openTablet(): void {
    tabletOpen = true;
    listeningFor = null;
    captureGate.reset();
    if (tabletPanel) tabletPanel.mesh.visible = true;
    repaintControls();
  }

  /** Ferme la tablette. L'écran n'a jamais été pris, il n'y a rien à rendre. */
  function closeTablet(): void {
    tabletOpen = false;
    listeningFor = null;
    captureGate.reset();
    if (tabletPanel) {
      tabletPanel.regions.length = 0;
      tabletPanel.mesh.visible = false;
    }
  }
```

Remplacer les appels à `openRemap()` / `closeRemap()` et supprimer les deux anciennes fonctions.

- [ ] **Step 7: le dispatch écoute la tablette**

La branche `if (target.panel === 'screen' && tabletOpen) {` devient `if (target.panel === 'tablet') {`, et son `if (id === 'close') { closeRemap(); return; }` devient `closeTablet()`.

Retirer de la branche `screen` la garde qui l'ouvrait, et le commentaire « Before the launch screen's own branch: both live on `scene.screen.regions` » — il décrit un partage qui n'existe plus.

Dans le rafraîchissement de survol, ajouter `if (panel === 'tablet') repaintControls();` et retirer le `if (remapOpen) repaintControls(); else repaintLaunch();` de la branche `screen`, qui n'a plus de raison de choisir.

- [ ] **Step 8: vérifier**

Run depuis `frontend/` : `PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" npx svelte-check --tsconfig ./tsconfig.json --threshold error`
Expected: 0 errors.

Run: `bun run test:ui && bun run test:backend && bun run test:netplay`
Expected: 0 fail partout.

- [ ] **Step 9: commit**

```bash
git add frontend/src/lib/vr/panels/controls.ts frontend/src/lib/components/VrShell.svelte frontend/src/lib/i18n/translations.ts core/test/vr-panel-controls.test.ts
git commit -m "Move the controls onto the tablet, and give the screen back to the game"
```

---

## Ce que ce plan ne fait pas

- La manette SNES dessinée et la capture séquentielle : lot 2, sa propre conception.
- L'écran de lancement reste sur l'écran incurvé (section 7 de la spec).
- Aucun panneau de gestion des sauvegardes, donc aucun bouton vers lui.
