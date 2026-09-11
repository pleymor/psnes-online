# Le comptoir en blocs Mario — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poser les trois pupitres du lobby VR sur un comptoir en U fait de blocs de brique Mario, sans déplacer un seul panneau.

**Architecture:** La géométrie se dérive des panneaux eux-mêmes dans `layout.ts`, module sans three, donc vérifiable sous Bun. Les blocs sont des boîtes de `decor/box.ts` peintes avec l'atlas du décor, construites par `createDecor` comme une troisième racine — exactement ce que fait déjà le rideau. Cette racine pend dans le **groupe des panneaux**, ce qui l'ancre avec eux et lui fait hériter de leur visibilité.

**Tech Stack:** TypeScript, three.js 185, Svelte 4, `bun test`, WebXR.

**Spec:** `docs/superpowers/specs/2026-09-11-comptoir-blocs-mario-design.md`

## Global Constraints

- **Les trois panneaux ne bougent pas.** Position, inclinaison, taille, canevas, pointeur : aucun de ces nombres ne change. Un plan qui les touche a échoué.
- **Seize pixels d'art par mètre** (`ART_PIXELS_PER_METRE`). Une boîte tire sa taille de son art ; grossir un objet se fait en le dessinant plus grand, jamais en le mettant à l'échelle.
- **Le comptoir ne connaît jamais `floorHeight`.** Il est ancré avec les panneaux ; le sol ne l'est pas. Un champ de hauteur de sol dans ces types est un défaut.
- **Tout motif nouveau est inscrit dans `ALL_ART`**, sinon il n'est ni vérifié ni rangé dans l'atlas.
- **Aucune nouvelle suite de test** : tout s'ajoute à des fichiers déjà nommés dans `test:ui`. Une suite non nommée reste verte sans jamais tourner.
- **Node n'est pas sur le PATH par défaut.** Préfixer chaque commande de `PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"`.

---

## File Structure

| fichier | responsabilité |
|---|---|
| `frontend/src/lib/vr/layout.ts` | *(modifié)* `CounterRun`, `counterRuns`, `COUNTER_BLOCK_WIDTH`, `COUNTER_DEPTH`. Aucune importation de three, aucune de `decor/`. |
| `core/test/vr-layout.test.ts` | *(modifié)* la dérivation et la continuité du U |
| `frontend/src/lib/vr/decor/art/furniture.ts` | *(créé)* `COUNTER_BRICK`, `COUNTER_SIDE`, `COUNTER_TOP` |
| `frontend/src/lib/vr/decor/art/index.ts` | *(modifié)* les trois inscriptions |
| `core/test/vr-decor-art.test.ts` | *(modifié)* la taille du bloc, liée à `COUNTER_BLOCK_WIDTH` |
| `frontend/src/lib/vr/decor/build.ts` | *(modifié)* `counterFor`, `DecorOptions.counter`, `Decor.furniture` |
| `frontend/src/lib/vr/scene.ts` | *(modifié)* `addFurniture` |
| `frontend/src/lib/components/VrShell.svelte` | *(modifié)* deux lignes de câblage |

---

# Task 1 : La géométrie, dérivée des panneaux

**Files:**
- Modify: `frontend/src/lib/vr/layout.ts`
- Test: `core/test/vr-layout.test.ts` (existant)

**Interfaces:**
- Produces :
  ```ts
  export const COUNTER_BLOCK_WIDTH: number;   // 1 m
  export const COUNTER_DEPTH: number;         // 0.35 m
  export interface CounterRun {
    readonly top: [number, number, number];
    readonly facing: number;
  }
  export function counterRuns(layout: SceneLayout): readonly CounterRun[];
  ```

- [ ] **Step 1 : Écrire les tests, à ajouter à la fin de `core/test/vr-layout.test.ts`**

```ts
/*
 * Le comptoir. Trois tronçons, et rien de ce qui les décide n'est écrit deux
 * fois : chaque sommet est le bord bas de son panneau, donc déplacer un
 * pupitre déplace son bloc.
 *
 * Le premier test RECALCULE ce bord bas avec sa propre arithmétique plutôt que
 * d'appeler l'aide de `layout.ts`. C'est volontaire : un test qui réutilise la
 * fonction qu'il vérifie ne vérifie que lui-même.
 */

/** Le milieu du bord bas d'un panneau, recalculé ici et non importé. */
function bottomOf(placement: Placement): [number, number, number] {
  const [x, y, z] = placement.position;
  const [pitch, yaw] = placement.rotation;
  const half = placement.height / 2;
  // Rotation de (0, -half, 0) par X puis Y : l'ordre `YXZ` de `panel-mesh.ts`.
  const dy = -half * Math.cos(pitch);
  const dz = -half * Math.sin(pitch);
  return [x + dz * Math.sin(yaw), y + dy, z + dz * Math.cos(yaw)];
}

/** Les quatre coins d'un tronçon vus de dessus, dans l'ordre du tour. */
function planCorners(run: CounterRun): Array<[number, number]> {
  const tangent: [number, number] = [Math.cos(run.facing), Math.sin(run.facing)];
  const away: [number, number] = [Math.sin(run.facing), -Math.cos(run.facing)];
  const halfWidth = COUNTER_BLOCK_WIDTH / 2;
  const corners: Array<[number, number]> = [];
  for (const along of [halfWidth, -halfWidth]) {
    // Profondeur CENTRÉE sur le bord bas : le plateau déborde vers le
    // joueur autant qu'il s'enfonce derrière.
    for (const out of [-COUNTER_DEPTH / 2, COUNTER_DEPTH / 2]) {
      corners.push([
        run.top[0] + tangent[0] * along + away[0] * out,
        run.top[2] + tangent[1] * along + away[1] * out
      ]);
    }
  }
  return corners;
}

/** Le point est-il dans le rectangle du tronçon, vu de dessus. */
function inside(run: CounterRun, point: [number, number]): boolean {
  const dx = point[0] - run.top[0];
  const dz = point[1] - run.top[2];
  const along = dx * Math.cos(run.facing) + dz * Math.sin(run.facing);
  const out = dx * Math.sin(run.facing) - dz * Math.cos(run.facing);
  return (
    Math.abs(along) <= COUNTER_BLOCK_WIDTH / 2 + 1e-9 &&
    Math.abs(out) <= COUNTER_DEPTH / 2 + 1e-9
  );
}

test('le comptoir a un tronçon par pupitre, et rien de plus', () => {
  const runs = counterRuns(sceneLayout('crt', DEFAULT_SHAPE));
  assert.equal(runs.length, 3);
});

test('le sommet de chaque tronçon est le bord bas de son pupitre', () => {
  const layout = sceneLayout('crt', DEFAULT_SHAPE);
  const runs = counterRuns(layout);
  const panels = [layout.library, layout.profile, layout.friends];
  for (let i = 0; i < panels.length; i++) {
    const wanted = bottomOf(panels[i]);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(
        Math.abs(runs[i].top[axis] - wanted[axis]) < 1e-9,
        `tronçon ${i}, axe ${axis} : ${runs[i].top[axis]} au lieu de ${wanted[axis]}`
      );
    }
  }
});

test('le bandeau du profil pend plus bas que les deux latéraux', () => {
  // Le fait qui impose le décrochement du fond. S'il disparaissait - un
  // bandeau remonté, une inclinaison changée - le comptoir deviendrait plat et
  // ce test le dirait avant le casque.
  const runs = counterRuns(sceneLayout('crt', DEFAULT_SHAPE));
  assert.ok(runs[1].top[1] < runs[0].top[1] - 0.05, `${runs[1].top[1]} contre ${runs[0].top[1]}`);
  assert.ok(Math.abs(runs[0].top[1] - runs[2].top[1]) < 1e-9, 'les latéraux sont jumeaux');
});

test('chaque tronçon fait face au joueur, comme le pupitre qu_il porte', () => {
  const layout = sceneLayout('crt', DEFAULT_SHAPE);
  const runs = counterRuns(layout);
  const panels = [layout.library, layout.profile, layout.friends];
  for (let i = 0; i < panels.length; i++) {
    assert.ok(
      Math.abs(runs[i].facing - -panels[i].rotation[1]) < 1e-9,
      `tronçon ${i} regarde ${runs[i].facing}, son pupitre ${-panels[i].rotation[1]}`
    );
  }
});

test('le U est continu : deux tronçons voisins se recouvrent', () => {
  /*
   * L'assertion qui remplace trois affirmations fausses de la spec. Deux
   * rectangles tournés de 60° l'un par rapport à l'autre ne se comparent pas
   * en mesurant la distance entre deux milieux d'arêtes - c'est l'erreur qui a
   * fait croire d'abord à un intervalle de 4,2 cm à boucher avec des blocs
   * d'angle, puis à un décalage de 2,1 cm. Ici on teste ce qui compte : au
   * moins un coin de l'un tombe dans l'autre.
   */
  const runs = counterRuns(sceneLayout('crt', DEFAULT_SHAPE));
  for (const [a, b] of [
    [runs[0], runs[1]],
    [runs[1], runs[2]]
  ]) {
    const touching =
      planCorners(a).some((corner) => inside(b, corner)) ||
      planCorners(b).some((corner) => inside(a, corner));
    assert.ok(touching, `trou dans le comptoir entre ${a.facing} et ${b.facing}`);
  }
});
```

Ajouter `counterRuns`, `COUNTER_BLOCK_WIDTH`, `COUNTER_DEPTH` et le type `CounterRun` à l'importation de `./layout.js` en tête du fichier, et `Placement` s'il n'y est pas déjà. `DEFAULT_SHAPE` est déjà utilisé par les tests de ce fichier ; reprendre l'expression exacte qu'ils emploient pour construire un `sceneLayout`.

- [ ] **Step 2 : Lancer le test pour le voir échouer**

Run: `PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" bun test core/test/vr-layout.test.ts`
Expected: FAIL, `Export named 'counterRuns' not found in module .../layout.ts`

- [ ] **Step 3 : Écrire l'implémentation, à ajouter à la fin de `frontend/src/lib/vr/layout.ts`**

```ts
/**
 * Le comptoir qui porte les trois pupitres.
 *
 * Rien ici n'est un choix de composition : chaque tronçon se déduit du panneau
 * qu'il porte. C'est ce qui rend l'écart IMPOSSIBLE plutôt que surveillé -
 * déplacer un pupitre déplace son bloc, et aucune position n'est écrite deux
 * fois.
 *
 * Ce module ne connaît ni three ni `decor/`, et ne doit pas les connaître :
 * `decor/composition.ts` importe déjà `SIZE_REFERENCE_DISTANCE` d'ici, donc la
 * dépendance inverse ferait un cycle.
 */

/**
 * Un bloc fait un mètre de large.
 *
 * Déclaré ici parce que c'est une décision de composition - le comptoir est
 * pavé de blocs d'un mètre, comme un mur de Mario - mais l'art doit s'y
 * conformer, et `vr-decor-art.test.ts` tient les deux ensemble.
 */
export const COUNTER_BLOCK_WIDTH = 1;

/**
 * La profondeur du plateau, CENTRÉE sur le bord bas du panneau : il déborde
 * de moitié vers le joueur, comme un bureau dont l'écran est au fond. Partir
 * du bord en s'éloignant laissait 2,8 cm de trou à chaque jonction du U.
 *
 * Le seul nombre libre de tout le comptoir. Tout le reste est dérivé.
 */
export const COUNTER_DEPTH = 0.35;

export interface CounterRun {
  /** Le centre de la face du DESSUS, en mètres depuis l'œil. */
  readonly top: [number, number, number];
  /**
   * L'azimut vers lequel la face avant regarde - PAS celui où le bloc est
   * posé. `boxYaw` (`decor/box.ts`) en tire le lacet, pour que le piège
   * +Z/-Z reste enfermé à un seul endroit du dépôt.
   */
  readonly facing: number;
}

/**
 * Le milieu du bord bas d'un panneau, en mètres depuis l'œil.
 *
 * `verticalSpan` fait la même rotation quelques lignes plus haut mais rend des
 * ANGLES et ignore le lacet, d'où cette seconde fonction plutôt qu'un partage
 * forcé. Son commentaire vaut ici : le signe de la composante z est ce qui se
 * trompe, et avec un tangage négatif elle est POSITIVE, donc le bord bas se
 * rapproche du joueur.
 */
function bottomEdge(placement: Placement): [number, number, number] {
  const [x, y, z] = placement.position;
  const [pitch, yaw] = placement.rotation;
  const half = placement.height / 2;
  const downY = -half * Math.cos(pitch);
  const downZ = -half * Math.sin(pitch);
  return [x + downZ * Math.sin(yaw), y + downY, z + downZ * Math.cos(yaw)];
}

/**
 * Les trois tronçons, dans l'ordre du tour : gauche, fond, droite.
 *
 * L'ordre n'est pas cosmétique - le test de continuité compare les voisins
 * deux à deux, et il n'a de sens que si la liste suit le U.
 */
export function counterRuns(layout: SceneLayout): readonly CounterRun[] {
  return [layout.library, layout.profile, layout.friends].map((panel) => ({
    top: bottomEdge(panel),
    facing: -panel.rotation[1]
  }));
}
```

- [ ] **Step 4 : Lancer le test pour le voir passer**

Run: `PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" bun test core/test/vr-layout.test.ts`
Expected: PASS, cinq tests de plus qu'avant.

- [ ] **Step 5 : Vérifier que rien d'autre n'a bougé**

Run: `PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" bun run test:ui 2>&1 | tail -4`
Expected: aucun échec, et le total augmente exactement de cinq.

- [ ] **Step 6 : Commit**

```bash
git add frontend/src/lib/vr/layout.ts core/test/vr-layout.test.ts
git commit -m "$(cat <<'EOF'
Déduire le comptoir des pupitres qu'il porte

Chaque tronçon prend le bord bas de son panneau, calculé en tournant
(0, -hauteur/2, 0) par le tangage puis le lacet. Aucune position n'est écrite
deux fois : déplacer un pupitre déplace son bloc, donc l'écart n'est pas
surveillé, il est impossible.

Le test recalcule ce bord bas avec sa propre arithmétique plutôt que d'appeler
la fonction qu'il vérifie, et il tient la continuité du U par le recouvrement
des rectangles en plan. Cette dernière assertion remplace trois affirmations
fausses de la spec, toutes nées de la même erreur : mesurer la distance entre
deux milieux d'arêtes et la prendre pour l'intervalle entre deux rectangles
tournés de soixante degrés l'un par rapport à l'autre.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Task 2 : L'art du comptoir

**Files:**
- Create: `frontend/src/lib/vr/decor/art/furniture.ts`
- Modify: `frontend/src/lib/vr/decor/art/index.ts`
- Test: `core/test/vr-decor-art.test.ts` (existant)

**Interfaces:**
- Consumes : `COUNTER_BLOCK_WIDTH` (Task 1), `GROUND_BRICK` (`art/ground.ts`), `recolour` (`art/shapes.ts`).
- Produces : `COUNTER_BRICK`, `COUNTER_SIDE`, `COUNTER_TOP`, inscrits sous `counterBrick`, `counterSide`, `counterTop`.

- [ ] **Step 1 : Écrire le test, à ajouter à `core/test/vr-decor-art.test.ts`**

```ts
test('un bloc de comptoir fait la largeur qu_annonce le plan, et deux mètres de haut', () => {
  /*
   * Les deux moitiés d'un même fait, tenues ensemble : `layout.ts` décide que
   * le comptoir est pavé de blocs d'un mètre, l'art doit s'y conformer, et
   * seize pixels valent un mètre.
   *
   * Les deux mètres de hauteur ne sont pas décoratifs. Le comptoir est ancré
   * aux panneaux et le sol ne l'est pas : sa base doit descendre sous
   * n'importe quel sol plausible, et le disque du sol enterre l'excédent.
   * Raccourcir ce motif fait réapparaître le bas du bloc en l'air pour les
   * joueurs les plus grands.
   */
  const brick = rasterise(ALL_ART.counterBrick);
  assert.equal(brick.width / ART_PIXELS_PER_METRE, COUNTER_BLOCK_WIDTH);
  assert.equal(brick.height / ART_PIXELS_PER_METRE, 2);
});

test('le dessus du comptoir ne porte aucun contour', () => {
  // La leçon du sol, appliquée à l'autre surface qu'on voit du dessus : un
  // bord sombre redessine une grille régulière une fois carrelé.
  assert.ok(
    !Object.values(ALL_ART.counterTop.palette).includes('outline'),
    'un contour ferait une grille sur le plateau'
  );
});

test('le flanc du comptoir est plus sombre que sa façade', () => {
  // Ce qui donne le volume sans un pixel de dessin supplémentaire. Les deux
  // motifs ont le MÊME tracé, seule la palette change - si un jour ils
  // divergent, c'est que quelqu'un a redessiné au lieu de recolorer.
  assert.deepEqual(ALL_ART.counterSide.rows, ALL_ART.counterBrick.rows);
  assert.notDeepEqual(ALL_ART.counterSide.palette, ALL_ART.counterBrick.palette);
});
```

Ajouter à ce fichier les importations de `ART_PIXELS_PER_METRE` (`decor/composition.js`) et `COUNTER_BLOCK_WIDTH` (`vr/layout.js`) si elles n'y sont pas.

- [ ] **Step 2 : Lancer le test pour le voir échouer**

Run: `PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" bun test core/test/vr-decor-art.test.ts`
Expected: FAIL — `rasterise` jette sur `ALL_ART.counterBrick` qui est `undefined`.

- [ ] **Step 3 : Créer `frontend/src/lib/vr/decor/art/furniture.ts`**

```ts
/**
 * Le mobilier : le comptoir qui porte les trois pupitres.
 *
 * Aucun de ces trois motifs n'est dessiné. Le premier EMPILE l'appareil du sol
 * de brique, le deuxième le recolore, le troisième est un aplat. C'est
 * délibéré : la brique du comptoir doit être la même maçonnerie que celle du
 * monde, et deux grilles qui se ressemblent finissent toujours par diverger.
 */
import { recolour } from './shapes';
import { GROUND_BRICK } from './ground';
import type { Art } from '../pixels';

/**
 * Un bloc d'un mètre de large et DEUX de haut.
 *
 * Les deux mètres sont une contrainte d'ancrage rendue en pixels : le comptoir
 * est ancré aux panneaux, le sol ne l'est pas, donc sa base doit descendre
 * sous n'importe quel sol plausible plutôt que de viser une hauteur mesurée
 * qu'elle ne saurait pas suivre. Seuls les quatre-vingts centimètres du haut
 * se voient ; le disque du sol enterre le reste.
 *
 * `GROUND_BRICK` porte déjà deux rangs d'appareil décalés sur ses seize
 * lignes. Les empiler donne quatre rangs cohérents, sans un caractère de plus.
 */
export const COUNTER_BRICK: Art = {
  palette: GROUND_BRICK.palette,
  rows: [...GROUND_BRICK.rows, ...GROUND_BRICK.rows]
};

/** Les flancs : même tracé, palette assombrie, comme tout le lot 3. */
export const COUNTER_SIDE: Art = recolour(COUNTER_BRICK, {
  brick: 'brickDark',
  brickLight: 'brick'
});

/**
 * Le plateau : un aplat clair, sans contour.
 *
 * La leçon du sol, mot pour mot : un bord sombre redessine une grille
 * régulière tous les mètres, que l'œil lit comme un artefact plutôt que comme
 * une matière.
 *
 * C'est le seul motif du dépôt qu'une face non carrée peut étirer sans mentir,
 * parce qu'un aplat étiré reste le même aplat. La règle des seize pixels par
 * mètre ne lui doit donc rien.
 */
export const COUNTER_TOP: Art = {
  palette: { l: 'brickLight' },
  rows: Array.from({ length: 16 }, () => 'l'.repeat(16))
};
```

- [ ] **Step 4 : Inscrire les trois au registre, dans `frontend/src/lib/vr/decor/art/index.ts`**

Ajouter l'importation :

```ts
import { COUNTER_BRICK, COUNTER_SIDE, COUNTER_TOP } from './furniture';
```

et les trois entrées à `ALL_ART`, après `blockSide` :

```ts
  counterBrick: COUNTER_BRICK,
  counterSide: COUNTER_SIDE,
  counterTop: COUNTER_TOP,
```

- [ ] **Step 5 : Lancer les tests d'art et d'atlas**

Run: `PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" bun test core/test/vr-decor-art.test.ts core/test/vr-decor-atlas.test.ts`
Expected: PASS. Les invariants du registre balaient les trois motifs neufs sans qu'on ait rien écrit pour eux ; l'atlas les range.

- [ ] **Step 6 : Regarder la planche**

L'instrument de ce module, parce que `rasterise` dit qu'un motif est bien formé mais jamais qu'il ressemble à quelque chose. Depuis le scratchpad, avec la recette de la Task 10 du plan Mario : `sheet.ts` à l'échelle 5, `esbuild`, puis `playwright screenshot --viewport-size=1320,1320`.

Vérifier : le bloc de comptoir montre **quatre rangs de briques décalés**, sans couture visible au raccord des deux moitiés ; le flanc est franchement plus sombre que la façade ; le plateau est un aplat uni sans bord.

- [ ] **Step 7 : Commit**

```bash
git add frontend/src/lib/vr/decor/art/furniture.ts frontend/src/lib/vr/decor/art/index.ts core/test/vr-decor-art.test.ts
git commit -m "$(cat <<'EOF'
Dessiner le comptoir sans dessiner un seul pixel

Les trois motifs sont dérivés : la façade empile l'appareil du sol de brique,
le flanc le recolore, le plateau est un aplat. La brique du comptoir est donc
la même maçonnerie que celle du monde par construction, et non parce que
quelqu'un a recopié une grille.

Deux mètres de haut pour un comptoir qui n'en montre que quatre-vingts
centimètres : c'est une contrainte d'ancrage rendue en pixels. Le comptoir est
ancré aux panneaux, le sol ne l'est pas, donc sa base descend sous n'importe
quel sol plausible au lieu de viser une hauteur qu'elle ne saurait pas suivre.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Task 3 : Bâtir le comptoir et le brancher

**Files:**
- Modify: `frontend/src/lib/vr/decor/build.ts`
- Modify: `frontend/src/lib/vr/scene.ts`
- Modify: `frontend/src/lib/components/VrShell.svelte`

**Interfaces:**
- Consumes : `counterRuns`, `COUNTER_DEPTH`, `CounterRun` (Task 1) ; `counterBrick`, `counterSide`, `counterTop` (Task 2) ; `boxGeometry`, `boxYaw` (`decor/box.ts`, existants).
- Produces : `DecorOptions.counter: readonly CounterRun[]` ; `Decor.furniture: THREE.Object3D` ; `VrScene.addFurniture(object: THREE.Object3D): void`.

Aucun test unitaire : ce sont des objets three, et `build.ts` dit de lui-même qu'il n'est « vérifié que par l'œil ». La vérification est la construction réelle, puis le casque.

- [ ] **Step 1 : Ajouter `counterFor` à `frontend/src/lib/vr/decor/build.ts`, juste après `boxFor`**

```ts
/**
 * Un tronçon de comptoir : la troisième façon de poser une boîte, et la seule
 * qui ne soit pas polaire.
 *
 * `boxFor` prend un azimut et un rayon parce que tout le décor vit sur des
 * anneaux. Le comptoir, lui, épouse des panneaux dont les positions sont déjà
 * calculées par `layout.ts` : lui refaire des coordonnées polaires, ce serait
 * réécrire un fait qui existe. D'où une position explicite - mais le lacet
 * passe par `boxYaw`, comme partout, pour que le piège +Z/-Z reste à un seul
 * endroit.
 */
function counterFor(run: CounterRun, atlas: Atlas, material: THREE.Material): THREE.Mesh {
  const raster = rasterise(ALL_ART.counterBrick);
  const width = raster.width / ART_PIXELS_PER_METRE;
  const height = raster.height / ART_PIXELS_PER_METRE;

  const data = boxGeometry({
    width,
    height,
    depth: COUNTER_DEPTH,
    front: uvOf(atlas, 'counterBrick'),
    side: uvOf(atlas, 'counterSide'),
    top: uvOf(atlas, 'counterTop')
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  const mesh = new THREE.Mesh(geometry, material);
  /*
   * Deux décalages, et aucun des deux n'est un réglage.
   *
   * `run.top` est le centre de la face du DESSUS, alors que `boxGeometry`
   * centre sa boîte sur son origine : d'où la demi-hauteur retranchée, qui
   * fait affleurer le plateau au bord bas du panneau.
   *
   * En revanche la profondeur ne décale rien : elle est CENTRÉE sur le bord
   * bas, donc le plateau déborde vers le joueur autant qu'il s'enfonce
   * derrière. C'est ce que le test de continuité a imposé, et c'est aussi ce
   * que fait un bureau.
   */
  mesh.position.set(run.top[0], run.top[1] - height / 2, run.top[2]);
  mesh.rotation.y = boxYaw(run.facing);
  return mesh;
}
```

Ajouter en tête du fichier : `import { COUNTER_DEPTH, type CounterRun } from '../layout';`

- [ ] **Step 2 : Étendre `DecorOptions` et `Decor` dans le même fichier**

```ts
export interface DecorOptions {
  /** Mètres sous l'œil, de `floor.ts`. */
  floorHeight: number;
  /** `renderer.capabilities.getMaxAnisotropy()`. */
  maxAnisotropy: number;
  /** La position de la tête, pour orienter les billboards. */
  head: () => { x: number; y: number; z: number };
  /** Les tronçons du comptoir, de `counterRuns` (`layout.ts`). */
  counter: readonly CounterRun[];
}
```

```ts
export interface Decor {
  decor: THREE.Object3D;
  curtain: THREE.Object3D;
  /**
   * Le comptoir. TROISIÈME RACINE, et elle va dans le groupe des PANNEAUX -
   * ni `room` ni `world` directement.
   *
   * Deux raisons, et elles tirent dans le même sens. Il épouse les panneaux,
   * donc il doit être ancré comme eux : dans `room`, il glisserait sous eux
   * jusqu'à `ANCHOR_DRIFT`. Et en pendant dans leur groupe il hérite de
   * `panelsVisible`, ce qui lui interdit de rester allumé pendant une partie
   * sans un état de plus - alors qu'à un mètre il est bien en deçà du rideau.
   */
  furniture: THREE.Object3D;
  update(t: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
```

- [ ] **Step 3 : Construire le comptoir dans `createDecor`, juste après la boucle des créatures**

```ts
  /*
   * Le comptoir. Même atlas, même matériau que le reste : un bind de plus
   * n'apporterait rien, et sa brique est littéralement celle du monde.
   *
   * Ses géométries rejoignent `quadGeometries` pour que `dispose` les libère
   * avec les autres - une racine séparée ne veut pas dire une comptabilité
   * séparée.
   */
  const furniture = new THREE.Group();
  for (const run of opts.counter) {
    const mesh = counterFor(run, atlas, quadMaterial);
    quadGeometries.push(mesh.geometry);
    furniture.add(mesh);
  }
```

Puis ajouter `furniture,` au bloc `return {` de `createDecor`, à côté de `decor,` et `curtain: curtainMesh,`.

- [ ] **Step 4 : Ajouter `addFurniture` à `frontend/src/lib/vr/scene.ts`**

Dans l'interface, après `addCurtain` :

```ts
  /**
   * Ajoute un objet au GROUPE DES PANNEAUX.
   *
   * Existe pour le comptoir, et lui seul. Il épouse les panneaux, donc il doit
   * être ancré comme eux ; et en pendant dans leur groupe il s'éteint avec eux
   * quand une partie démarre, sans un état de plus - ce qui lui évite le fondu
   * que le sol, seul autre objet en deçà du rideau, doit porter.
   */
  addFurniture(object: THREE.Object3D): void;
```

Dans le bloc d'implémentation, après `addCurtain: (object) => void world.add(object),` :

```ts
    addFurniture: (object) => void panelGroup.add(object),
```

- [ ] **Step 5 : Brancher dans `frontend/src/lib/components/VrShell.svelte`**

Dans `ensureDecor()`, remplacer l'appel et les deux ajouts par :

```ts
    decor = createDecor({
      floorHeight: height,
      maxAnisotropy: scene.maxAnisotropy(),
      head: () => scene!.headPosition(),
      counter: counterRuns(scene.layout)
    });
    scene.addDecor(decor.decor);
    scene.addCurtain(decor.curtain);
    scene.addFurniture(decor.furniture);
```

Et ajouter `counterRuns` à l'importation de `$lib/vr/layout` en tête du composant, ou créer cette importation si le composant n'en a pas.

- [ ] **Step 6 : Vérifier**

```bash
PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" bun run test:ui 2>&1 | tail -4
cd frontend && PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" node ../node_modules/.bin/svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1 | tail -2
cd frontend && PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH" node ../node_modules/.bin/vite build 2>&1 | grep -E "built in|error"
```

Expected: aucun échec, zéro erreur de types, et la construction réelle passe — c'est la seule qui attrape ce que `test:ui` ne bâtit jamais.

- [ ] **Step 7 : Commit**

```bash
git add frontend/src/lib/vr/decor/build.ts frontend/src/lib/vr/scene.ts frontend/src/lib/components/VrShell.svelte
git commit -m "$(cat <<'EOF'
Poser le comptoir dans le groupe des panneaux

Troisième racine du décor, sur le modèle du rideau : construite par
createDecor, mais ajoutée ailleurs. Le rideau va dans world parce que son
dégagement est mesuré contre l'écran ; le comptoir va dans le groupe des
panneaux parce qu'il les épouse.

Ce choix paie deux fois. Ancré comme eux, il ne peut pas glisser sous eux
jusqu'à ANCHOR_DRIFT. Et pendu dans leur groupe, il hérite de panelsVisible,
donc il s'éteint avec eux quand une partie démarre - alors qu'à un mètre il est
bien en deçà du rideau, et qu'il aurait sinon fallu lui donner le fondu propre
que seul le sol porte aujourd'hui.

counterFor est la seule pose de boîte non polaire du dépôt : les positions
viennent de layout.ts, et leur refaire des coordonnées polaires réécrirait un
fait qui existe. Le lacet passe quand même par boxYaw.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Task 4 : La session casque

Aucun test ne dit si un meuble est à la bonne place. Celle-ci répond aux trois questions que la spec laisse ouvertes.

- [ ] **Step 1 : Entrer dans le lobby**

Servir le front du worktree, ouvrir l'onglet, activer l'Immersive Web Emulator, presser « Passer en VR ». Vérifier d'abord `xr_get_session_status` : `local-floor` doit figurer dans `enabledFeatures`, sinon la page servie n'est pas celle de cette branche.

- [ ] **Step 2 : Regarder les trois jonctions**

Le plateau affleure-t-il le bord bas de chaque panneau, sans fente ni chevauchement ? Le décrochement de onze centimètres du fond se lit-il comme une tablette basse ou comme une erreur ?

- [ ] **Step 3 : Répondre aux trois points ouverts de la spec**

- **Le cadre des panneaux** : la bordure bleue et le fond blanc tiennent-ils sur de la brique, ou faut-il les reprendre ?
- **La profondeur, 0,35 m** : le seul nombre libre. Trop mince, trop large ?
- **L'encoche des angles** : la morsure en V sur le bord arrière se voit-elle depuis un œil assis ? Si non, elle ne coûte rien ; si oui, elle vaut un motif d'angle taillé.

- [ ] **Step 4 : Rapporter, ne pas corriger dans la foulée**

Chaque correction est un changement de nombre dans `layout.ts` ou `furniture.ts`, donc un commit propre à elle. Les mélanger à la pose du comptoir rendrait le diff illisible.

---

## Self-review

**Couverture de la spec.** §0 (les panneaux ne bougent pas) → Global Constraints, et aucune tâche ne touche `sceneLayout`. §1.1 et §1.3 (les deux racines, la visibilité) → Task 3, steps 2 et 4. §1.2 (jamais `floorHeight`) → `CounterRun` n'a pas le champ, Task 1. §1.4 (la taille vient de l'art) → Task 2, step 1. §2 (la géométrie dérivée, la continuité) → Task 1 entière. §3 (l'art) → Task 2. §4 (les modules) → la table de File Structure, une tâche par groupe. §5 (les tests) → Tasks 1 et 2. §6 (les trois points ouverts) → Task 4, step 3. §7 (le damier, hors sujet) → aucune tâche, comme il se doit.

**Placeholders.** Aucun « TBD », aucun « similaire à la tâche N » : le code de chaque étape est écrit en entier, y compris les commentaires. Les deux endroits qui pourraient en avoir l'air sont explicites — `DEFAULT_SHAPE` en Task 1 step 1, dont le plan dit de reprendre l'expression exacte des tests voisins du même fichier, et la recette de la planche en Task 2 step 6, qui renvoie à une recette existante du plan Mario plutôt que de la recopier.

**Cohérence des types.** `CounterRun` est produit par Task 1 et consommé sous le même nom par Task 3. `COUNTER_DEPTH` et `COUNTER_BLOCK_WIDTH` sont déclarés en Task 1 et employés en Tasks 2 et 3. Les trois clés du registre — `counterBrick`, `counterSide`, `counterTop` — sont écrites identiques en Task 2 (inscription) et Task 3 (`uvOf`). `addFurniture` porte le même nom dans l'interface et dans l'implémentation.
