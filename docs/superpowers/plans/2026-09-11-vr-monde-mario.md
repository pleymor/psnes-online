# Le monde Mario du lobby VR — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer la salle noire du lobby VR par un décor pixel-art SNES en calques à profondeurs différentes, avec un vrai sol et des sprites animés, qui s'efface en fondu dès qu'une partie démarre.

**Architecture:** Un répertoire `frontend/src/lib/vr/decor/` où **un seul module importe three** (`build.ts`). Tout le reste est pur et testé sous Bun : la palette, la rastérisation des grilles de caractères, le rangement de l'atlas, les profondeurs, la hauteur du sol, le fondu, le mouvement. `scene.ts` gagne un second groupe `room` dont le `y` ne suit pas l'ancre, et `VrShell` décide de la visibilité comme il décide déjà celle des panneaux.

**Tech Stack:** TypeScript, three.js (déjà présent), Bun pour les tests, SvelteKit pour la coquille. Aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-09-11-vr-monde-mario-design.md`

## Global Constraints

Ces règles valent pour **toutes** les tâches. Elles ne sont pas répétées ensuite.

- **`node` et `bun` ne sont pas sur le PATH.** Préfixer toute commande :
  `export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`
- **Un nouveau fichier `core/test/*.test.ts` ne tourne jamais tant qu'il n'est pas nommé dans le script `test:ui` de `package.json`.** C'est une liste explicite, pas un glob. Chaque tâche qui crée un test l'ajoute à cette ligne **dans le même commit**, et vérifie que le **total** de tests a augmenté.
- **Idiome de test du dépôt :** `import { test } from 'bun:test';` + `import assert from 'node:assert/strict';`. Les imports de modules applicatifs se font en chemin relatif avec l'extension `.js` : `import { x } from '../../frontend/src/lib/vr/decor/x.js';`
- **Aucune lumière, aucun matériau éclairé.** `MeshBasicMaterial` uniquement (`scene.ts` : « Every material is unlit MeshBasicMaterial, so there are no lights »).
- **Rien au-delà de 50 m** — le `far` de la caméra.
- **Aucun asset binaire.** Tout l'art est du code (grilles de caractères). Aucun fichier image n'entre dans le dépôt.
- **Nommage :** le groupe three existant de `scene.ts` s'appelle `world` et désigne **la pièce ancrée**. Le monde Mario s'appelle **`decor`** partout. Ne jamais introduire un second `world`.
- **Valeurs exactes reprises de la spec :**
  ```
  ART_PIXELS_PER_METRE = 16
  FLOOR_FALLBACK       = 1.2 m
  CURTAIN_RADIUS       = 5.5 m
  CURTAIN_MARGIN       = 0.15 m
  ANCHOR_DRIFT         = 0.8 m
  DECOR_NEAR           = 6.5 m
  SKY_RADIUS           = 30 m
  FADE_SECONDS         = 0.4
  ```
- **Le rideau vit dans le groupe `world` (avec les panneaux), le décor dans le groupe `room`.** Les deux origines dérivent verticalement l'une de l'autre dès que le joueur recentre à une autre hauteur, et `ANCHOR_DRIFT` est la réserve qui absorbe cette dérive. Voir Task 4 et Task 9.
- **Messages de commit** en français, à l'impératif, et terminés par :
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## File Structure

**Créés** — `frontend/src/lib/vr/decor/` :

| Fichier | Responsabilité | three ? |
|---|---|---|
| `palette.ts` | Les couleurs nommées du monde. Source unique. | non |
| `pixels.ts` | Grille de caractères + palette → RGBA. | non |
| `art/index.ts` | Le registre `ALL_ART`, sur lequel portent les invariants et l'atlas. | non |
| `art/ground.ts` | Tuile de sol, tuile d'herbe. | non |
| `art/scenery.ts` | Colline, buisson, nuage. *(lot 2)* | non |
| `art/props.ts` | Tuyau, bloc `?`, brique, pièce. *(lot 3)* | non |
| `art/creatures.ts` | Goomba, plante carnivore. *(lot 4)* | non |
| `atlas.ts` | Rangement des motifs dans une seule texture : rectangles et UV. | non |
| `composition.ts` | Le pendant de `layout.ts` : toutes les profondeurs, et le pire cas de l'écran. | non |
| `floor.ts` | La hauteur du sol, derrière un port. | non |
| `fade.ts` | L'opacité du rideau en fonction du temps. | non |
| `box.ts` | La géométrie d'une boîte pixel-art, UV par face. *(lot 3)* | non |
| `motion.ts` | `t` → index d'image, position, dérive. *(lot 4)* | non |
| `build.ts` | **Le seul qui importe three.** Meshes, `update(t)`, `setVisible`, `dispose`. | oui |

**Modifiés :**

| Fichier | Changement |
|---|---|
| `frontend/src/lib/vr/layout.ts` | Exporter `SIZE_REFERENCE_DISTANCE` (aujourd'hui privé) |
| `frontend/src/lib/vr/xr-session.ts` | `optionalFeatures: ['local-floor']` + exposer l'espace obtenu |
| `frontend/src/lib/vr/scene.ts` | Groupe `room`, `onFrame(t)`, `addDecor`, `decorVisible` |
| `frontend/src/lib/components/VrShell.svelte` | Construire le décor, le montrer/masquer sur les 6 sites connus |
| `package.json` | Chaque nouveau fichier de test dans `test:ui` |

**Outil de développement** (hors dépôt, dans le scratchpad) : un bundle esbuild + une page `file://` qui rend la planche de l'atlas et des vues du décor en PNG.

---

# Lot 1 — Le sol et le ciel

À la fin du lot : on entre en VR, on est debout sur un sol de briques sous un ciel bleu ; on lance un jeu, fondu vers la salle noire d'aujourd'hui.

---

### Task 1: La palette

**Files:**
- Create: `frontend/src/lib/vr/decor/palette.ts`
- Test: `core/test/vr-decor-palette.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: rien.
- Produces: `COLOURS: Readonly<Record<ColourName, string>>`, `type ColourName`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Les couleurs du monde, en un seul endroit.
 *
 * Le test ne juge pas le goût - il tient la FORME. Une couleur mal écrite
 * (`#fff`, `rgb(...)`, une majuscule) traverserait `pixels.ts` sans bruit et
 * ressortirait en pixels noirs dans le casque, à des heures de sa cause.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { COLOURS } from '../../frontend/src/lib/vr/decor/palette.js';

test('toute couleur est un hex à six chiffres, en minuscules', () => {
  for (const [name, value] of Object.entries(COLOURS)) {
    assert.match(value, /^#[0-9a-f]{6}$/, `${name} vaut ${value}`);
  }
});

test('la palette n_est pas vide et porte le ciel de SMB', () => {
  assert.ok(Object.keys(COLOURS).length >= 8);
  assert.equal(COLOURS.sky, '#5c94fc');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-palette.test.ts`
Expected: FAIL — `Cannot find module '.../decor/palette.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Les couleurs du monde Mario, nommées une fois.
 *
 * Pourquoi une table plutôt que des littéraux au fil des motifs : l'art est
 * écrit en grilles de caractères (`pixels.ts`), et un caractère y désigne un
 * NOM de couleur, pas une valeur. C'est ce qui rend le cyclage de palette du
 * bloc `?` gratuit (lot 4) - on échange une table, pas un dessin - et c'est ce
 * qui permet à un test de vérifier que tout caractère de tout motif pointe
 * quelque part.
 *
 * Les valeurs visent le nuancier SNES : des aplats francs, aucun dégradé.
 */
export const COLOURS = {
  sky: '#5c94fc',
  cloud: '#fcfcfc',
  hill: '#007800',
  hillDark: '#006000',
  grass: '#00a800',
  grassDark: '#007c00',
  brick: '#c84c0c',
  brickLight: '#e45c10',
  pipe: '#00a800',
  pipeHi: '#58d854',
  pipeSide: '#006000',
  block: '#e39a10',
  blockHi: '#fcbc3c',
  goomba: '#a04000',
  goombaFoot: '#e09050',
  outline: '#000000'
} as const;

export type ColourName = keyof typeof COLOURS;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-palette.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Ajouter le test à `test:ui`**

Dans `package.json`, ajouter `core/test/vr-decor-palette.test.ts` à la fin de la liste du script `test:ui`, avant `core/test/docs-content.test.ts`.

Vérifier : `bun run test:ui 2>&1 | tail -5` — le nombre total de tests doit avoir augmenté de 2.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/palette.ts core/test/vr-decor-palette.test.ts package.json
git commit -m "$(cat <<'EOF'
Nommer les couleurs du monde Mario en un seul endroit

L'art du décor s'écrit en grilles de caractères où un caractère désigne un
nom de couleur, pas une valeur. C'est ce qui rendra le cyclage de palette du
bloc ? gratuit, et ce qui permet de vérifier qu'aucun motif ne pointe dans le
vide.

Le test tient la forme, pas le goût : un #fff ou une majuscule traverserait la
rastérisation sans bruit et ressortirait en pixels noirs dans le casque, loin
de sa cause.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: La rastérisation des grilles

**Files:**
- Create: `frontend/src/lib/vr/decor/pixels.ts`
- Test: `core/test/vr-decor-pixels.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `COLOURS`, `ColourName` (Task 1).
- Produces:
  ```ts
  export const TRANSPARENT = '.';
  export interface Art { readonly palette: Readonly<Record<string, ColourName>>; readonly rows: readonly string[] }
  export interface Raster { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }
  export function rasterise(art: Art): Raster
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Grille de caractères -> RGBA.
 *
 * Aucune dépendance au DOM : `rasterise` rend un tableau d'octets, et c'est
 * `build.ts` qui en fait une `ImageData`. C'est ce qui permet de tenir cette
 * arithmétique responsable sous Bun, où il n'y a ni canvas ni GPU - la leçon
 * que `picture-filter.ts` a déjà payée dans ce dépôt.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { rasterise, TRANSPARENT } from '../../frontend/src/lib/vr/decor/pixels.js';

test('un motif de deux sur deux rend seize octets, ligne du haut d_abord', () => {
  const art = { palette: { s: 'sky', o: 'outline' }, rows: ['so', 'os'] } as const;
  const raster = rasterise(art);

  assert.equal(raster.width, 2);
  assert.equal(raster.height, 2);
  assert.equal(raster.data.length, 16);

  // #5c94fc = 92, 148, 252
  assert.deepEqual([...raster.data.slice(0, 4)], [92, 148, 252, 255]);
  assert.deepEqual([...raster.data.slice(4, 8)], [0, 0, 0, 255]);
  // deuxième ligne, inversée
  assert.deepEqual([...raster.data.slice(8, 12)], [0, 0, 0, 255]);
  assert.deepEqual([...raster.data.slice(12, 16)], [92, 148, 252, 255]);
});

test('le point est transparent et ne porte aucune couleur', () => {
  const raster = rasterise({ palette: { s: 'sky' }, rows: [`s${TRANSPARENT}`] });
  assert.deepEqual([...raster.data.slice(4, 8)], [0, 0, 0, 0]);
});

test('une grille en dents de scie est refusée en nommant la ligne', () => {
  assert.throws(
    () => rasterise({ palette: { s: 'sky' }, rows: ['ss', 's'] }),
    /ligne 1/
  );
});

test('un caractère absent de la palette est refusé en le nommant', () => {
  assert.throws(() => rasterise({ palette: { s: 'sky' }, rows: ['sx'] }), /'x'/);
});

test('une palette qui pointe hors des couleurs est refusée', () => {
  assert.throws(
    () => rasterise({ palette: { s: 'mauve' as never }, rows: ['s'] }),
    /mauve/
  );
});

test('une grille vide est refusée plutôt que rendue en zéro sur zéro', () => {
  assert.throws(() => rasterise({ palette: {}, rows: [] }), /vide/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-pixels.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * L'art du décor : une grille de caractères, une palette, des octets RGBA.
 *
 * Le format est choisi pour être lisible dans un diff et modifiable sans
 * outil. Un caractère y désigne un NOM de couleur (`palette.ts`), jamais une
 * valeur, ce qui laisse la porte ouverte au cyclage de palette.
 *
 * Aucune dépendance au DOM, volontairement : cette fonction rend un tableau
 * d'octets et rien de plus. `build.ts` en fait une `ImageData`. C'est la
 * seule façon de tester cette arithmétique sous Bun, où il n'y a ni canvas ni
 * GPU - et `picture-filter.ts` raconte dans ce dépôt ce que coûte de ne pas
 * le faire.
 *
 * Tout ce qui est douteux jette, et jette en NOMMANT le coupable. Un motif
 * mal formé qui se rendrait quand même donnerait des pixels noirs quelque
 * part dans un casque, à des heures de sa cause.
 */
import { COLOURS, type ColourName } from './palette';

/** Le seul caractère qui ne désigne pas une couleur. */
export const TRANSPARENT = '.';

export interface Art {
  readonly palette: Readonly<Record<string, ColourName>>;
  readonly rows: readonly string[];
}

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, ligne du haut d'abord, comme `ImageData`. */
  readonly data: Uint8ClampedArray;
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

export function rasterise(art: Art): Raster {
  if (art.rows.length === 0) throw new Error('motif vide : aucune ligne');

  const width = art.rows[0].length;
  if (width === 0) throw new Error('motif vide : la ligne 0 est vide');

  art.rows.forEach((row, index) => {
    if (row.length !== width) {
      throw new Error(
        `motif en dents de scie : la ligne ${index} fait ${row.length}, attendu ${width}`
      );
    }
  });

  // Résolu une fois par caractère plutôt qu'une fois par pixel : une tuile de
  // 16x16 vaut 256 recherches, et l'atlas en compte des dizaines.
  const resolved = new Map<string, [number, number, number]>();
  for (const [char, name] of Object.entries(art.palette)) {
    const hex = COLOURS[name];
    if (!hex) throw new Error(`la palette pointe sur une couleur inconnue : ${name}`);
    resolved.set(char, channels(hex));
  }

  const height = art.rows.length;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const char = art.rows[y][x];
      const at = (y * width + x) * 4;
      if (char === TRANSPARENT) continue; // déjà 0,0,0,0
      const rgb = resolved.get(char);
      if (!rgb) throw new Error(`caractère '${char}' absent de la palette (ligne ${y})`);
      data[at] = rgb[0];
      data[at + 1] = rgb[1];
      data[at + 2] = rgb[2];
      data[at + 3] = 255;
    }
  }

  return { width, height, data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-pixels.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

Run: `bun run test:ui 2>&1 | tail -5` — le total doit avoir monté de 6.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/pixels.ts core/test/vr-decor-pixels.test.ts package.json
git commit -m "$(cat <<'EOF'
Rendre une grille de caractères en octets RGBA, sans toucher au DOM

Le format de l'art du décor : une grille lisible en diff, une palette qui
désigne des noms de couleurs et non des valeurs. La fonction rend un tableau
d'octets et rien de plus - c'est build.ts qui en fera une ImageData.

Cette séparation est la seule façon de tenir l'arithmétique responsable sous
Bun, où il n'y a ni canvas ni GPU. Tout ce qui est douteux jette en nommant le
coupable : un motif mal formé rendu quand même donnerait des pixels noirs dans
un casque, à des heures de sa cause.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Le registre de l'art, et la première tuile

**Files:**
- Create: `frontend/src/lib/vr/decor/art/ground.ts`, `frontend/src/lib/vr/decor/art/index.ts`
- Test: `core/test/vr-decor-art.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Art`, `rasterise` (Task 2).
- Produces: `GROUND_BRICK: Art`, `GROUND_GRASS: Art`, `ALL_ART: Readonly<Record<string, Art>>`.

Le registre existe pour deux raisons qui se rejoignent : **les invariants portent sur lui** (un motif oublié du registre n'est vérifié par rien), et **l'atlas se range depuis lui** (Task 6). Tout motif ajouté dans un lot ultérieur entre dans `ALL_ART` et hérite des deux.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Les invariants de l'art, sur TOUT le registre.
 *
 * Ce test ne connaît aucun motif par son nom : il balaie `ALL_ART`. Ajouter un
 * tuyau au lot 3 le fait donc vérifier sans toucher ici - et un motif qu'on
 * oublierait d'inscrire au registre ne serait vérifié par rien, ce qui est la
 * seule façon de passer entre les mailles.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';

test('le registre n_est pas vide', () => {
  assert.ok(Object.keys(ALL_ART).length > 0);
});

test('tout motif du registre se rastérise sans jeter', () => {
  for (const [name, art] of Object.entries(ALL_ART)) {
    // `rasterise` porte déjà les refus : grille en dents de scie, caractère
    // hors palette, palette hors couleurs, motif vide. Les appeler ici, c'est
    // les appliquer à tout le registre d'un coup.
    assert.doesNotThrow(() => rasterise(art), `${name} ne se rastérise pas`);
  }
});

test('toute tuile de sol fait exactement un mètre, soit seize pixels d_art', () => {
  for (const [name, art] of Object.entries(ALL_ART)) {
    if (!name.startsWith('ground')) continue;
    const raster = rasterise(art);
    assert.equal(raster.width, 16, `${name} fait ${raster.width} de large`);
    assert.equal(raster.height, 16, `${name} fait ${raster.height} de haut`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-art.test.ts`
Expected: FAIL — `Cannot find module '.../decor/art/index.js'`

- [ ] **Step 3: Write minimal implementation**

`frontend/src/lib/vr/decor/art/ground.ts` :

```ts
/**
 * Le sol : la brique, et la brique coiffée d'herbe.
 *
 * Seize pixels de côté, parce qu'une tuile fait un mètre et que
 * `ART_PIXELS_PER_METRE` vaut seize (`composition.ts`). Ce n'est pas une
 * coïncidence à maintenir de tête : `vr-decor-art.test.ts` le vérifie sur
 * toute tuile dont le nom commence par `ground`.
 *
 * Le motif de briques est décalé d'une rangée sur l'autre, comme un vrai
 * appareil. Sans ce décalage, un sol carrelé donne des lignes de mortier
 * continues d'un bout à l'autre du monde, et l'œil les lit comme une grille
 * plutôt que comme de la maçonnerie.
 */
import type { Art } from '../pixels';

const BRICK_PALETTE = { b: 'brick', l: 'brickLight', k: 'outline' } as const;

export const GROUND_BRICK: Art = {
  palette: BRICK_PALETTE,
  rows: [
    'kkkkkkkkkkkkkkkk',
    'kllllllkkllllllk',
    'kllllllkkllllllk',
    'kbbbbbbkkbbbbbbk',
    'kbbbbbbkkbbbbbbk',
    'kbbbbbbkkbbbbbbk',
    'kbbbbbbkkbbbbbbk',
    'kkkkkkkkkkkkkkkk',
    'llllkkllllllkkll',
    'llllkkllllllkkll',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'bbbbkkbbbbbbkkbb',
    'kkkkkkkkkkkkkkkk'
  ]
};

export const GROUND_GRASS: Art = {
  palette: { ...BRICK_PALETTE, g: 'grass', d: 'grassDark' },
  rows: [
    'gggggggggggggggg',
    'gggggggggggggggg',
    'gggggggggggggggg',
    'dddddddddddddddd',
    'kkkkkkkkkkkkkkkk',
    'llllllkkllllllkk',
    'llllllkkllllllkk',
    'bbbbbbkkbbbbbbkk',
    'bbbbbbkkbbbbbbkk',
    'bbbbbbkkbbbbbbkk',
    'kkkkkkkkkkkkkkkk',
    'llkkllllllkkllll',
    'llkkllllllkkllll',
    'bbkkbbbbbbkkbbbb',
    'bbkkbbbbbbkkbbbb',
    'bbkkbbbbbbkkbbbb'
  ]
};
```

`frontend/src/lib/vr/decor/art/index.ts` :

```ts
/**
 * Le registre de tout l'art du décor.
 *
 * Deux consommateurs, et c'est ce qui justifie qu'il existe. Les invariants
 * (`vr-decor-art.test.ts`) le balaient, donc un motif inscrit ici est vérifié
 * sans que le test le connaisse. Et l'atlas (`atlas.ts`) s'en sert de source,
 * donc un motif inscrit ici obtient sa place dans la texture sans que le code
 * de rendu change.
 *
 * Le corollaire est la seule règle à retenir : **un motif qui n'est pas ici
 * n'est ni vérifié ni rangé.**
 */
import type { Art } from '../pixels';
import { GROUND_BRICK, GROUND_GRASS } from './ground';

export const ALL_ART: Readonly<Record<string, Art>> = {
  groundBrick: GROUND_BRICK,
  groundGrass: GROUND_GRASS
};

export type ArtName = keyof typeof ALL_ART;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-art.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/art core/test/vr-decor-art.test.ts package.json
git commit -m "$(cat <<'EOF'
Inscrire l'art du décor dans un registre que les tests balaient

Les invariants ne connaissent aucun motif par son nom : ils parcourent
ALL_ART. Un tuyau ajouté plus tard sera donc vérifié sans qu'on touche au
test, et l'atlas le rangera sans que le code de rendu change.

Le corollaire est la seule règle à retenir : un motif absent du registre n'est
ni vérifié ni rangé.

Les deux premières tuiles font seize pixels parce qu'une tuile fait un mètre.
Leur appareil est décalé d'une rangée sur l'autre - sans ce décalage, le sol
donne des lignes de mortier continues que l'œil lit comme une grille.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Les profondeurs, et le pire cas de l'écran

**Files:**
- Create: `frontend/src/lib/vr/decor/composition.ts`
- Modify: `frontend/src/lib/vr/layout.ts` (exporter `SIZE_REFERENCE_DISTANCE`)
- Test: `core/test/vr-decor-composition.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SCREEN_DISTANCES`, `SCREEN_ANGLES`, `SCREEN_HEIGHTS` (`../screen-shape`), `screenWidth` (`../screen-geometry`), `aspectRatioOf` (`$lib/znet/fit`), `SIZE_REFERENCE_DISTANCE` (`../layout`).
- Produces: `ART_PIXELS_PER_METRE`, `FLOOR_FALLBACK`, `CURTAIN_RADIUS`, `CURTAIN_MARGIN`, `DECOR_NEAR`, `SKY_RADIUS`, `FADE_SECONDS`, `RINGS`, `screenReach(): number`.

C'est **la tâche la plus importante du lot**. Elle tient les trois règles que la spec dit qu'aucune relecture n'attrape.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Les profondeurs du décor, et la seule d'entre elles qui soit un piège.
 *
 * Le rideau doit passer DERRIÈRE l'écran de jeu quel que soit le réglage du
 * joueur, et l'écran est réglable : cinq distances jusqu'à 4,3 m, cinq
 * angles jusqu'à 80 degrés, cinq hauteurs, deux formes, deux rapports de
 * pixel. Le test recalcule ce pire cas au lieu de constater un nombre - c'est
 * ce qui fait qu'ajouter un cran plus lointain, ou un rapport plus haut, fera
 * rougir ici en nommant la cause.
 *
 * La valeur attendue a été mesurée : 5,281 m, en pixels carrés (8/7, donc
 * l'écran le plus HAUT) et non en crt (4/3, qui donne 5,175 - onze
 * centimètres d'erreur, dans le sens dangereux).
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  screenReach,
  CURTAIN_RADIUS,
  CURTAIN_MARGIN,
  ANCHOR_DRIFT,
  DECOR_NEAR,
  SKY_RADIUS,
  RINGS,
  ART_PIXELS_PER_METRE
} from '../../frontend/src/lib/vr/decor/composition.js';

const CAMERA_FAR = 50; // `scene.ts`

test('le pire cas de l_écran est celui qui a été mesuré', () => {
  assert.ok(
    Math.abs(screenReach() - 5.281) < 0.002,
    `screenReach vaut ${screenReach()}`
  );
});

test('le rideau passe derrière l_écran, marge comprise', () => {
  assert.ok(
    screenReach() + CURTAIN_MARGIN <= CURTAIN_RADIUS,
    `${screenReach()} + ${CURTAIN_MARGIN} dépasse le rideau à ${CURTAIN_RADIUS}`
  );
});

test('le rideau passe devant le décor, dérive d_ancre comprise', () => {
  // Le rideau est dans `world` (centré sur l'ancre, comme les panneaux) et le
  // décor dans `room` (dont le y ne suit pas l'ancre). Les deux origines
  // s'écartent verticalement dès que le joueur recentre à une autre hauteur -
  // se lever après avoir joué assis. Sans cette réserve, un décor à 6 m
  // passerait DEVANT un rideau de 5,5 m après une telle dérive, et
  // réapparaîtrait au milieu d'une partie.
  assert.ok(
    CURTAIN_RADIUS + ANCHOR_DRIFT <= DECOR_NEAR,
    `rideau ${CURTAIN_RADIUS} + dérive ${ANCHOR_DRIFT} dépasse le décor à ${DECOR_NEAR}`
  );
});

test('tout anneau de décor est au-delà du rideau et en deçà du ciel', () => {
  for (const [name, radius] of Object.entries(RINGS)) {
    assert.ok(radius >= DECOR_NEAR, `${name} à ${radius} est trop près`);
    assert.ok(radius <= SKY_RADIUS, `${name} à ${radius} dépasse le ciel`);
  }
});

test('le ciel tient sous le far de la caméra', () => {
  assert.ok(SKY_RADIUS < CAMERA_FAR);
});

test('une tuile d_un mètre fait seize pixels d_art', () => {
  assert.equal(ART_PIXELS_PER_METRE, 16);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-composition.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3a: Exporter `SIZE_REFERENCE_DISTANCE` depuis `layout.ts`**

Dans `frontend/src/lib/vr/layout.ts`, la constante est aujourd'hui privée. Ajouter `export` devant, et une ligne au commentaire existant :

```ts
/**
 * … (commentaire existant conservé tel quel) …
 *
 * Exportée depuis que `decor/composition.ts` calcule la portée maximale de
 * l'écran : c'est la distance à laquelle `screenPlacement` lit la taille, donc
 * la recopier là-bas ferait deux vérités pour un seul nombre.
 */
export const SIZE_REFERENCE_DISTANCE = 2.5;
```

- [ ] **Step 3b: Écrire `composition.ts`**

```ts
/**
 * Toutes les profondeurs du décor, dans un module sans three.
 *
 * Le pendant exact de `layout.ts`, et pour la même raison : sans casque et
 * sans GPU sous Bun, la seule façon de tenir une géométrie responsable est de
 * la sortir du code qui dessine. `layout.ts` a attrapé deux erreurs de signe
 * grâce à cette séparation.
 *
 * Coordonnées de three, comme `layout.ts` : le joueur à l'origine regardant
 * -Z, +X à sa droite, +Y en haut. Mais à une différence près qui est tout
 * l'objet de `scene.ts`'s groupe `room` : ici, y = 0 est la hauteur de
 * référence de la session, PAS la tête au dernier recentrage. Le sol s'y place
 * à `-floorHeight` et n'en bouge plus.
 */
import { SCREEN_DISTANCES, SCREEN_ANGLES, SCREEN_HEIGHTS } from '../screen-shape';
import { screenWidth } from '../screen-geometry';
import { SIZE_REFERENCE_DISTANCE } from '../layout';
import { aspectRatioOf, type PixelAspect } from '$lib/znet/fit';

/** Seize pixels d'art par mètre : la résolution native d'une tuile SMB. */
export const ART_PIXELS_PER_METRE = 16;

/** Sous les yeux, en mètres, quand le casque refuse de dire où est le sol. */
export const FLOOR_FALLBACK = 1.2;

export const SKY_RADIUS = 30;
export const CURTAIN_RADIUS = 5.5;
/** Ce qui doit rester libre entre le coin le plus lointain de l'écran et le
 *  rideau. Pas une tolérance numérique : de la place pour que le joueur voie
 *  l'écran se détacher du noir plutôt que le raser. */
export const CURTAIN_MARGIN = 0.15;

/**
 * De combien les deux origines de la scène peuvent s'écarter verticalement.
 *
 * Le rideau vit dans le groupe `world`, centré sur l'ancre - comme les
 * panneaux, et c'est nécessaire : son dégagement intérieur est mesuré contre
 * l'écran, qui est ancré lui aussi. Le décor vit dans le groupe `room`, dont
 * le `y` ne suit PAS l'ancre, sans quoi le sol monterait avec le joueur.
 *
 * Les deux origines coïncident au premier recentrage et s'écartent à chacun
 * des suivants, de la différence de hauteur de tête - jouer assis puis se
 * lever et recentrer. Huit dixièmes de mètre couvre largement ce trajet.
 *
 * Ce que la réserve empêche est précis : sans elle, un décor à six mètres de
 * l'origine de `room` peut se retrouver à moins de cinq mètres et demi de
 * l'origine de `world`, donc DEVANT un rideau qui est censé le cacher - et
 * réapparaître au milieu d'une partie.
 */
export const ANCHOR_DRIFT = 0.8;

export const DECOR_NEAR = 6.5;
export const FADE_SECONDS = 0.4;

/** Le rayon de chaque famille d'objets. Voir la spec, §4.4. */
export const RINGS = {
  /** Blocs `?`, briques, pièces. */
  props: 7,
  pipes: 9,
  creatures: 12,
  clouds: 15,
  hills: 20,
  sky: SKY_RADIUS
} as const;

const ASPECTS: readonly PixelAspect[] = ['crt', 'square'];

/**
 * La distance du point de l'écran le plus éloigné de l'œil, sur TOUS les
 * réglages possibles.
 *
 * C'est le nombre dont dépend le rayon du rideau, et il n'est pas devinable :
 * l'écran est réglable en distance, en angle, en hauteur, en forme et en
 * rapport de pixel, soit cent combinaisons. Calculé plutôt que constaté, pour
 * qu'un sixième cran de distance fasse rougir le test au lieu de masquer
 * silencieusement l'image du jeu.
 *
 * Deux pièges déjà payés, tous deux dans le sens dangereux :
 *
 * - **La largeur se lit à la distance de RÉFÉRENCE, pas à celle du joueur.**
 *   C'est la correction que `layout.ts` documente : la taille est nominale,
 *   comme les pouces d'un téléviseur, donc `screenWidth` prend
 *   `SIZE_REFERENCE_DISTANCE` et la distance choisie n'agit que sur le
 *   placement.
 * - **Le plus PETIT rapport de pixel donne le coin le plus lointain.**
 *   `aspectRatioOf` rend 4/3 en `crt` mais 8/7 en `square`, et la hauteur vaut
 *   largeur / rapport : les pixels carrés donnent donc l'écran le plus haut.
 *   Ne mesurer que le crt sous-estime de onze centimètres.
 */
export function screenReach(): number {
  let worst = 0;
  for (const distance of SCREEN_DISTANCES)
    for (const angle of SCREEN_ANGLES)
      for (const height of SCREEN_HEIGHTS)
        for (const curved of [true, false])
          for (const aspect of ASPECTS) {
            const arc = (angle * Math.PI) / 180;
            const width = screenWidth(SIZE_REFERENCE_DISTANCE, arc, curved);
            const halfHeight = width / aspectRatioOf(aspect) / 2;
            const top = Math.abs(height) + halfHeight;
            // Un écran courbe est un cylindre : tous ses points sont à la même
            // distance horizontale. Un écran plat est une corde, donc ses coins
            // s'éloignent de la moitié de sa largeur.
            const far = curved
              ? Math.hypot(distance, top)
              : Math.hypot(width / 2, top, distance);
            if (far > worst) worst = far;
          }
  return worst;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-composition.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Vérifier que `layout.ts` n'a rien cassé**

Run: `bun test core/test/vr-layout.test.ts core/test/vr-screen-shape.test.ts`
Expected: PASS — l'ajout d'un `export` ne change aucun comportement, et ce contrôle le dit.

- [ ] **Step 6: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/vr/decor/composition.ts frontend/src/lib/vr/layout.ts \
        core/test/vr-decor-composition.test.ts package.json
git commit -m "$(cat <<'EOF'
Calculer la portée maximale de l'écran au lieu de la deviner

Le rideau qui masquera le décor doit passer derrière l'écran de jeu quel que
soit son réglage. L'écran est réglable sur cent combinaisons - cinq distances
jusqu'à 4,3 m, cinq angles, cinq hauteurs, deux formes, deux rapports de
pixel - et son coin le plus lointain atteint 5,281 m.

Le test recalcule ce pire cas plutôt que de constater le nombre : un sixième
cran de distance le fera rougir en nommant la cause, au lieu de masquer
silencieusement l'image du jeu.

Deux pièges valaient d'être écrits. La largeur se lit à la distance de
référence et non à celle du joueur, ce que layout.ts documente déjà. Et le
plus petit rapport de pixel donne l'écran le plus haut, donc le coin le plus
lointain : ne mesurer que le crt sous-estime de onze centimètres.

SIZE_REFERENCE_DISTANCE passe public pour ne pas avoir deux vérités.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: La hauteur du sol, derrière un port

**Files:**
- Create: `frontend/src/lib/vr/decor/floor.ts`
- Test: `core/test/vr-decor-floor.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `FLOOR_FALLBACK` (Task 4).
- Produces:
  ```ts
  export interface FloorPorts {
    floorSpace(): unknown | null;
    poseOf(space: unknown): { y: number } | null;
  }
  export function measureFloor(ports: FloorPorts): number | null
  // mètres SOUS l'œil, positif. `null` = pas encore mesurable, redemander à
  // la prochaine image.
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * À quelle hauteur poser le sol, et pourquoi tout échec y répond pareil.
 *
 * Le port existe pour la raison que tout le code d'appareil de ce dépôt
 * donne : pour que la décision soit testable sans casque, sans WebXR et sans
 * espace de référence.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { measureFloor } from '../../frontend/src/lib/vr/decor/floor.js';
import { FLOOR_FALLBACK } from '../../frontend/src/lib/vr/decor/composition.js';

const SPACE = {};

test('la pose mesurée donne la hauteur, en positif sous l_œil', () => {
  const height = measureFloor({
    floorSpace: () => SPACE,
    poseOf: () => ({ y: -1.42 })
  });
  assert.equal(height, 1.42);
});

test('un casque qui refuse local-floor répond tout de suite, par le repli', () => {
  // Pas `null` : il n'y a rien à attendre. Redemander image après image un
  // espace que le casque a refusé ne le ferait jamais apparaître, et le décor
  // ne serait jamais construit.
  const height = measureFloor({ floorSpace: () => null, poseOf: () => ({ y: -1.42 }) });
  assert.equal(height, FLOOR_FALLBACK);
});

test('un suivi pas encore prêt demande qu_on rappelle, sans se replier', () => {
  // La distinction est tout l'intérêt de cette fonction. Se replier ici
  // figerait 1,20 m à la première image d'une session dont le suivi met trois
  // images à démarrer - et le repli deviendrait le cas NORMAL.
  const height = measureFloor({ floorSpace: () => SPACE, poseOf: () => null });
  assert.equal(height, null);
});

test('un sol au-dessus de l_œil est refusé plutôt que cru', () => {
  // Le signe inversé est l'erreur la plus plausible de cette plomberie, et
  // elle est invisible : le sol serait au plafond, ce qui se lit comme un bug
  // de rendu et non comme un signe.
  const height = measureFloor({ floorSpace: () => SPACE, poseOf: () => ({ y: 1.42 }) });
  assert.equal(height, FLOOR_FALLBACK);
});

test('un sol à trois mètres sous l_œil est refusé', () => {
  const height = measureFloor({ floorSpace: () => SPACE, poseOf: () => ({ y: -3 }) });
  assert.equal(height, FLOOR_FALLBACK);
});

test('un port qui jette ne barre pas la route', () => {
  const height = measureFloor({
    floorSpace: () => {
      throw new Error('boom');
    },
    poseOf: () => null
  });
  assert.equal(height, FLOOR_FALLBACK);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-floor.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * À quelle hauteur poser le sol.
 *
 * La session demande `local` seulement, dont l'origine est la tête à
 * l'ouverture : il n'y a donc AUCUNE hauteur de sol dans cette scène, et
 * `layout.ts` en fait une vertu pour les panneaux, qui sont mesurés depuis
 * les yeux. Un sol, lui, a besoin du nombre.
 *
 * `xr-session.ts` avait mesuré `local-floor: NotSupportedError` le
 * 2026-09-07, mais son propre commentaire dit pourquoi : « That is the
 * conformant refusal for a feature that was not asked for. » La session ne
 * négociait aucune feature. On la demande maintenant en OPTIONNELLE, et
 * uniquement pour mesurer - l'ancrage ne change pas d'un iota, three continue
 * de travailler dans son propre `local`.
 *
 * Toute incertitude répond la même chose : le repli. Un sol un peu faux fait
 * un monde qui paraît un peu plus grand ; un sol au plafond, ou à trois
 * mètres, fait une scène que le joueur lit comme cassée. Les bornes ci-dessous
 * séparent les deux, et attrapent au passage l'erreur la plus plausible de
 * cette plomberie - le signe inversé, qui est invisible autrement.
 *
 * UNE seule incertitude ne se replie pas : « le suivi n'est pas encore prêt ».
 * La pose n'existe qu'à l'intérieur d'une image XR, et les premières d'une
 * session peuvent n'en porter aucune. Répondre le repli là ferait de 1,20 m le
 * cas NORMAL plutôt que le cas dégradé. Elle répond donc `null`, qui veut dire
 * « redemande à la prochaine image » - et l'appelant ne construit le décor
 * qu'une fois qu'il a un nombre.
 */
import { FLOOR_FALLBACK } from './composition';

/** Les hauteurs d'œil plausibles, assis compris. */
const MIN_HEIGHT = 0.6;
const MAX_HEIGHT = 2.2;

export interface FloorPorts {
  /** L'espace `local-floor` si le casque l'a accordé, sinon `null`. */
  floorSpace(): unknown | null;
  /**
   * La pose de `space` dans l'espace de référence de la scène, ou `null` si
   * le suivi n'est pas prêt. Seul le `y` est lu : c'est l'origine du sol
   * exprimée depuis l'œil, donc un nombre négatif.
   */
  poseOf(space: unknown): { y: number } | null;
}

/** Mètres sous l'œil, toujours positif. `null` : redemander à la prochaine image. */
export function measureFloor(ports: FloorPorts): number | null {
  try {
    const space = ports.floorSpace();
    // Rien à attendre : le casque a refusé. Redemander ne le ferait jamais
    // apparaître, et le décor ne serait jamais construit.
    if (!space) return FLOOR_FALLBACK;

    const pose = ports.poseOf(space);
    if (!pose) return null;

    const height = -pose.y;
    if (!Number.isFinite(height)) return FLOOR_FALLBACK;
    if (height < MIN_HEIGHT || height > MAX_HEIGHT) return FLOOR_FALLBACK;
    return height;
  } catch {
    return FLOOR_FALLBACK;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-floor.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/floor.ts core/test/vr-decor-floor.test.ts package.json
git commit -m "$(cat <<'EOF'
Décider la hauteur du sol derrière un port, repli compris

La session ne demande que local, dont l'origine est la tête à l'ouverture : il
n'y a aucune hauteur de sol dans cette scène. Les panneaux s'en passent, un
sol non.

Toute incertitude répond la même chose - le repli à 1,20 m. Un sol un peu faux
fait un monde qui paraît un peu plus grand ; un sol au plafond fait une scène
que le joueur lit comme cassée. Les bornes séparent les deux et attrapent au
passage le signe inversé, qui est l'erreur la plus plausible de cette
plomberie et la seule qui soit invisible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Le rangement de l'atlas

**Files:**
- Create: `frontend/src/lib/vr/decor/atlas.ts`
- Test: `core/test/vr-decor-atlas.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Art`, `rasterise` (Task 2), `ALL_ART` (Task 3).
- Produces:
  ```ts
  export interface AtlasRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  export interface Atlas { readonly width: number; readonly height: number; readonly rects: Readonly<Record<string, AtlasRect>> }
  export interface Uv { readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number }
  export function packAtlas(art: Readonly<Record<string, Art>>): Atlas
  export function uvOf(atlas: Atlas, name: string): Uv
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Tout l'art dans une seule texture, et les UV pour y piocher.
 *
 * Le rangement est pur, donc vérifiable : rien ne se chevauche, rien ne
 * déborde, et deux exécutions donnent le même plan. Un chevauchement se
 * verrait dans le casque comme un tuyau portant un morceau de goomba, ce qui
 * n'accuserait jamais le rangement.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { packAtlas, uvOf } from '../../frontend/src/lib/vr/decor/atlas.js';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';

test('chaque motif obtient un rectangle à sa taille', () => {
  const atlas = packAtlas(ALL_ART);
  for (const [name, art] of Object.entries(ALL_ART)) {
    const raster = rasterise(art);
    const rect = atlas.rects[name];
    assert.ok(rect, `${name} n'a pas de place`);
    assert.equal(rect.width, raster.width);
    assert.equal(rect.height, raster.height);
  }
});

test('aucun rectangle n_en chevauche un autre', () => {
  const atlas = packAtlas(ALL_ART);
  const rects = Object.entries(atlas.rects);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [nameA, a] = rects[i];
      const [nameB, b] = rects[j];
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      assert.ok(apart, `${nameA} chevauche ${nameB}`);
    }
  }
});

test('aucun rectangle ne déborde de la texture', () => {
  const atlas = packAtlas(ALL_ART);
  for (const [name, rect] of Object.entries(atlas.rects)) {
    assert.ok(rect.x >= 0 && rect.y >= 0, `${name} sort par le haut ou la gauche`);
    assert.ok(rect.x + rect.width <= atlas.width, `${name} sort à droite`);
    assert.ok(rect.y + rect.height <= atlas.height, `${name} sort en bas`);
  }
});

test('la texture est carrée et de côté une puissance de deux', () => {
  const atlas = packAtlas(ALL_ART);
  assert.equal(atlas.width, atlas.height);
  assert.equal(atlas.width & (atlas.width - 1), 0, `${atlas.width} n'est pas une puissance de deux`);
});

test('le rangement est déterministe', () => {
  assert.deepEqual(packAtlas(ALL_ART), packAtlas(ALL_ART));
});

test('les uv sont retournées, parce que three retourne la texture', () => {
  // `flipY` vaut true par défaut sur une CanvasTexture : la ligne du HAUT du
  // canvas devient v = 1. Un motif rangé tout en haut doit donc sortir avec
  // v1 = 1, et non v0 = 0.
  const atlas = { width: 64, height: 64, rects: { a: { x: 0, y: 0, width: 16, height: 16 } } };
  const uv = uvOf(atlas, 'a');
  assert.equal(uv.u0, 0);
  assert.equal(uv.u1, 16 / 64);
  assert.equal(uv.v1, 1);
  assert.equal(uv.v0, 1 - 16 / 64);
});

test('un motif inconnu jette plutôt que de rendre des uv nulles', () => {
  const atlas = packAtlas(ALL_ART);
  assert.throws(() => uvOf(atlas, 'licorne'), /licorne/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-atlas.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Tout l'art du monde dans une seule texture.
 *
 * Trois bénéfices, dont un décisif. Un seul téléversement et un seul bind.
 * Ajouter un motif ne touche pas le code de rendu, puisqu'il suffit de
 * l'inscrire au registre. Et surtout : **tout l'art est visible d'un coup dans
 * un seul PNG**, ce qui est la planche de référence du développement - sans
 * casque, c'est le seul instrument qui montre ce qu'on dessine.
 *
 * Un corollaire qui n'est pas évident : animer un sprite devient gratuit.
 * Changer d'image, c'est décaler deux UV - aucun redessin de canvas, aucun
 * téléversement. À comparer avec l'avertissement de `panel-mesh.ts` sur le
 * coût d'une re-rasterisation à 72 Hz.
 *
 * Le rangement est en étagères, trié par hauteur décroissante : c'est
 * l'algorithme le plus simple qui ne gaspille pas, et le gaspillage n'a de
 * toute façon aucune importance ici - quelques dizaines de motifs de seize à
 * soixante-quatre pixels tiennent dans une texture de 256 ou 512.
 */
import { rasterise, type Art } from './pixels';

/**
 * Un pixel de garde autour de chaque motif.
 *
 * Pas une précaution contre le filtrage - l'atlas est en `NearestFilter`, il
 * n'interpole rien. C'est contre l'arrondi : une UV qui tombe exactement sur
 * une frontière peut, selon le pilote, retomber d'un texel du mauvais côté, et
 * on verrait alors un liseré du motif voisin. Un pixel transparent de marge le
 * rend impossible.
 */
const PADDING = 1;

const FIRST_SIZE = 256;
const MAX_SIZE = 2048;

export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Atlas {
  readonly width: number;
  readonly height: number;
  readonly rects: Readonly<Record<string, AtlasRect>>;
}

export interface Uv {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

function tryPack(
  sized: readonly { name: string; width: number; height: number }[],
  size: number
): Record<string, AtlasRect> | null {
  const rects: Record<string, AtlasRect> = {};
  let shelfY = PADDING;
  let shelfHeight = 0;
  let cursorX = PADDING;

  for (const item of sized) {
    if (cursorX + item.width + PADDING > size) {
      // Étagère suivante.
      shelfY += shelfHeight + PADDING;
      shelfHeight = 0;
      cursorX = PADDING;
    }
    if (shelfY + item.height + PADDING > size) return null;

    rects[item.name] = { x: cursorX, y: shelfY, width: item.width, height: item.height };
    cursorX += item.width + PADDING;
    if (item.height > shelfHeight) shelfHeight = item.height;
  }
  return rects;
}

export function packAtlas(art: Readonly<Record<string, Art>>): Atlas {
  // Trié par hauteur décroissante puis par nom : la hauteur est ce qui rend
  // les étagères efficaces, le nom est ce qui rend le résultat déterministe -
  // sans lui, l'ordre des clés de l'objet déciderait, et une planche de
  // référence changerait de disposition sans raison entre deux exécutions.
  const sized = Object.entries(art)
    .map(([name, one]) => {
      const raster = rasterise(one);
      return { name, width: raster.width, height: raster.height };
    })
    .sort((a, b) => b.height - a.height || a.name.localeCompare(b.name));

  for (let size = FIRST_SIZE; size <= MAX_SIZE; size *= 2) {
    const rects = tryPack(sized, size);
    if (rects) return { width: size, height: size, rects };
  }
  throw new Error(`l'art du décor ne tient pas dans ${MAX_SIZE} pixels`);
}

/**
 * Les UV d'un motif, dans la convention de three.
 *
 * `flipY` vaut true par défaut sur une `CanvasTexture`, donc la ligne du HAUT
 * du canvas se retrouve en v = 1. C'est l'inversion ci-dessous, et l'oublier
 * donne un monde entier à l'envers - ce qui se remarque, mais seulement après
 * avoir cherché ailleurs.
 */
export function uvOf(atlas: Atlas, name: string): Uv {
  const rect = atlas.rects[name];
  if (!rect) throw new Error(`motif absent de l'atlas : ${name}`);
  return {
    u0: rect.x / atlas.width,
    u1: (rect.x + rect.width) / atlas.width,
    v0: 1 - (rect.y + rect.height) / atlas.height,
    v1: 1 - rect.y / atlas.height
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-atlas.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/atlas.ts core/test/vr-decor-atlas.test.ts package.json
git commit -m "$(cat <<'EOF'
Ranger tout l'art du décor dans une seule texture

Un seul téléversement, un seul bind, et surtout tout l'art visible d'un coup
dans un PNG - sans casque, c'est le seul instrument qui montre ce qu'on
dessine. Corollaire moins évident : animer un sprite devient gratuit, puisque
changer d'image ne fait que décaler deux UV.

Le rangement est pur, donc vérifiable : rien ne se chevauche, rien ne déborde,
deux exécutions donnent le même plan. Un chevauchement se verrait comme un
tuyau portant un morceau de goomba, ce qui n'accuserait jamais le rangement.

Le tri secondaire par nom n'est pas cosmétique : sans lui l'ordre des clés
déciderait, et la planche de référence changerait de disposition sans raison.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Demander `local-floor`, en option et pour mesurer seulement

**Files:**
- Modify: `frontend/src/lib/vr/xr-session.ts`
- Test: `core/test/vr-xr-session.test.ts` (fichier existant — déjà dans `test:ui`, rien à ajouter au `package.json`)

**Interfaces:**
- Consumes: rien.
- Produces: `VrSession.floorSpace: unknown | null`.

C'est la tâche qui touche le fichier portant l'avertissement « que personne ne retire ce levier une quatrième fois ». Lire son en-tête **en entier** avant de commencer.

- [ ] **Step 1: Write the failing test**

À ajouter à la fin de `core/test/vr-xr-session.test.ts`, en suivant l'idiome des tests déjà présents dans ce fichier :

```ts
test('la session demande local-floor en optionnel, et rien d_autre', () => {
  let asked: unknown = 'jamais appelé';
  const nav = {
    xr: {
      requestSession: async (_mode: string, init?: unknown) => {
        asked = init;
        return fakeSession();
      }
    }
  };
  return openVrSession(() => {}, nav).then(() => {
    assert.deepEqual(asked, { optionalFeatures: ['local-floor'] });
  });
});

test('un local-floor accordé est exposé', async () => {
  const floor = { it: 'is the floor' };
  const session = fakeSession();
  session.requestReferenceSpace = async (type: string) =>
    type === 'local-floor' ? floor : { it: 'local' };

  const opened = await openVrSession(() => {}, { xr: { requestSession: async () => session } });
  assert.equal(opened.floorSpace, floor);
});

test('un local-floor refusé laisse floorSpace nul sans faire échouer l_entrée', async () => {
  const session = fakeSession();
  session.requestReferenceSpace = async (type: string) => {
    if (type === 'local-floor') throw new Error('NotSupportedError');
    return { it: 'local' };
  };

  const opened = await openVrSession(() => {}, { xr: { requestSession: async () => session } });
  assert.equal(opened.floorSpace, null);
  // Et surtout : la session est bien ouverte.
  assert.ok(opened.session);
});
```

> **Note d'exécution :** `fakeSession()` doit être le fabricant de session factice déjà présent dans ce fichier. S'il porte un autre nom, utiliser celui-là ; s'il n'existe pas, l'extraire des tests existants en le laissant identique à ce qu'ils construisent aujourd'hui.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-xr-session.test.ts`
Expected: FAIL — `asked` vaut `undefined` (aucun dictionnaire n'est passé) et `floorSpace` n'existe pas.

- [ ] **Step 3: Write minimal implementation**

Dans `frontend/src/lib/vr/xr-session.ts` :

1. Ajouter `floorSpace: unknown | null;` à l'interface `VrSession`.
2. Remplacer l'appel et ajouter la demande d'espace :

```ts
  /*
   * Une seule feature négociée, et en OPTIONNELLE.
   *
   * L'en-tête ci-dessus raconte une sonde du 2026-09-07 qui a vu
   * `local-floor: NotSupportedError` sur un Quest, et en tire la bonne
   * conclusion : c'est le refus conforme d'une feature qui n'avait pas été
   * demandée. La voici demandée.
   *
   * Ce qu'elle sert, et rien d'autre : MESURER où est le sol, pour que
   * `decor/floor.ts` y pose le sol du monde. L'ancrage ne change pas d'un
   * iota - three continue de demander et d'utiliser son propre `local`
   * (`WebXRManager.js:509`), et `scene.ts` continue de lui répondre `local`.
   * Aucune géométrie de `layout.ts` ne devient relative au plancher.
   *
   * Optionnelle et non requise, parce qu'un casque qui la refuse doit entrer
   * en VR quand même : le repli de `floor.ts` donne un monde à peine plus
   * grand, alors qu'une feature requise donnerait une porte fermée.
   */
  const session = await nav.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor']
  });

  const referenceSpace = await session.requestReferenceSpace('local');

  /*
   * Le sol, demandé séparément et sans conséquence en cas d'échec.
   *
   * `requestReferenceSpace` rejette quand la feature n'a pas été accordée, et
   * ce rejet n'est pas une anomalie : c'est la réponse conforme d'un casque
   * qui ne sait pas où est le plancher. L'avaler ici est donc juste, et c'est
   * le seul endroit où ça l'est - plus haut, ça masquerait un vrai refus
   * d'ouvrir la session.
   */
  let floorSpace: unknown | null = null;
  try {
    floorSpace = (await session.requestReferenceSpace('local-floor')) ?? null;
  } catch {
    floorSpace = null;
  }
```

3. Ajouter `floorSpace` à l'objet retourné.
4. Compléter l'en-tête du module — la sonde de 2026-09-07 y est documentée comme une mesure, et il faut dire ce qui a changé depuis :

```
 * MISE À JOUR, 2026-09-11 : `local-floor` est désormais demandé en feature
 * OPTIONNELLE, uniquement pour mesurer la hauteur du plancher (`decor/floor.ts`).
 * La mesure de 2026-09-07 reste exacte et reste la raison de ce changement :
 * elle constatait le refus d'une feature jamais demandée. Ce qui n'a PAS
 * changé : l'espace de la scène est toujours `local`, three demande toujours
 * le sien, et `layout.ts` mesure toujours tout depuis les yeux.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-xr-session.test.ts`
Expected: PASS — les tests existants **et** les trois nouveaux.

- [ ] **Step 5: Vérifier qu'aucun autre appelant ne casse**

Run: `bun run test:ui 2>&1 | tail -5`
Expected: le total a monté de 3, zéro échec.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/xr-session.ts core/test/vr-xr-session.test.ts
git commit -m "$(cat <<'EOF'
Demander local-floor en option, pour mesurer le sol et rien d'autre

La sonde du 2026-09-07 avait vu local-floor: NotSupportedError sur un Quest,
et en tirait déjà la bonne conclusion : c'est le refus conforme d'une feature
qui n'avait pas été demandée. La voici demandée.

Ce qu'elle sert : savoir où est le plancher, pour que le décor du lobby y pose
son sol. Ce qui ne change pas, et l'en-tête le dit maintenant : l'espace de la
scène reste local, three demande toujours le sien, et layout.ts mesure
toujours tout depuis les yeux.

Optionnelle et non requise - un casque qui refuse doit entrer en VR quand
même. Le repli donne un monde à peine plus grand ; une feature requise
donnerait une porte fermée.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Le fondu du rideau

**Files:**
- Create: `frontend/src/lib/vr/decor/fade.ts`
- Test: `core/test/vr-decor-fade.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `FADE_SECONDS` (Task 4).
- Produces:
  ```ts
  export type FadeTarget = 'dark' | 'decor';
  export function curtain(elapsed: number, to: FadeTarget): { opacity: number; done: boolean }
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * L'opacité du rideau au fil du fondu.
 *
 * Pur et minuscule, mais pas gratuit : les deux sens ont des extrémités
 * inverses, et se tromper de sens donne un monde qui apparaît d'un coup au
 * lancement d'un jeu - exactement l'à-coup de luminance que le fondu existe
 * pour éviter.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { curtain } from '../../frontend/src/lib/vr/decor/fade.js';
import { FADE_SECONDS } from '../../frontend/src/lib/vr/decor/composition.js';

test('vers le noir : transparent au départ, opaque à l_arrivée', () => {
  assert.deepEqual(curtain(0, 'dark'), { opacity: 0, done: false });
  assert.deepEqual(curtain(FADE_SECONDS, 'dark'), { opacity: 1, done: true });
});

test('vers le décor : opaque au départ, transparent à l_arrivée', () => {
  assert.deepEqual(curtain(0, 'decor'), { opacity: 1, done: false });
  assert.deepEqual(curtain(FADE_SECONDS, 'decor'), { opacity: 0, done: true });
});

test('à mi-course, les deux sens se croisent à la moitié', () => {
  const half = FADE_SECONDS / 2;
  assert.ok(Math.abs(curtain(half, 'dark').opacity - 0.5) < 1e-9);
  assert.ok(Math.abs(curtain(half, 'decor').opacity - 0.5) < 1e-9);
});

test('un temps négatif est ramené au départ plutôt que de dépasser', () => {
  // Une horloge qui recule d'une image arrive : `t` vient du runtime XR.
  assert.deepEqual(curtain(-1, 'dark'), { opacity: 0, done: false });
});

test('au-delà de la durée, le fondu reste terminé', () => {
  assert.deepEqual(curtain(FADE_SECONDS * 10, 'dark'), { opacity: 1, done: true });
  assert.deepEqual(curtain(FADE_SECONDS * 10, 'decor'), { opacity: 0, done: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-fade.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * L'opacité du rideau, en fonction du temps écoulé.
 *
 * Pourquoi un fondu plutôt qu'une bascule : passer d'un ciel bleu plein champ
 * à du quasi-noir d'une image à l'autre est un à-coup de luminance sur toute
 * la rétine, et le retour est pire. Quatre dixièmes de seconde suffisent à le
 * supprimer sans faire attendre.
 *
 * Pourquoi une fonction pure plutôt qu'un état qui se décrémente : le temps
 * vient du runtime XR, et un compteur interne se désynchroniserait de lui à la
 * première image sautée. Ici, une image en retard rattrape toute seule.
 */
import { FADE_SECONDS } from './composition';

export type FadeTarget = 'dark' | 'decor';

export function curtain(
  elapsed: number,
  to: FadeTarget
): { opacity: number; done: boolean } {
  const progress = Math.min(1, Math.max(0, elapsed / FADE_SECONDS));
  const opacity = to === 'dark' ? progress : 1 - progress;
  return { opacity, done: progress >= 1 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-fade.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/fade.ts core/test/vr-decor-fade.test.ts package.json
git commit -m "$(cat <<'EOF'
Calculer l'opacité du rideau sans état qui se décrémente

Passer d'un ciel bleu plein champ à du quasi-noir d'une image à l'autre est un
à-coup de luminance sur toute la rétine, et le retour est pire. Quatre
dixièmes de seconde le suppriment sans faire attendre.

La fonction est pure parce que le temps vient du runtime XR : un compteur
interne se désynchroniserait de lui à la première image sautée, alors qu'ici
une image en retard rattrape toute seule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Le groupe `room`, et le temps dans `onFrame`

**Files:**
- Modify: `frontend/src/lib/vr/anchor.ts`
- Modify: `frontend/src/lib/vr/scene.ts`
- Test: `core/test/vr-anchor.test.ts` (existant, déjà dans `test:ui`)

**Interfaces:**
- Consumes: `Anchor`, `anchorFrom` (existants).
- Produces: `roomAnchor(anchor: Anchor): Anchor` ; sur `VrScene` : `onFrame(fn: (t: number) => void)`, `addDecor(object: THREE.Object3D)`, `addCurtain(object: THREE.Object3D)`.

C'est la correction structurelle de la spec §4.1. **L'arithmétique va dans `anchor.ts` pour être testable** ; `scene.ts` ne fait que l'appliquer, puisqu'il importe three et n'a donc pas de test unitaire.

- [ ] **Step 1: Write the failing test**

À ajouter à `core/test/vr-anchor.test.ts` :

```ts
test('l_ancre de la pièce garde le cap et le déplacement, mais jamais la hauteur', () => {
  // Le décor est un LIEU POSÉ PAR TERRE, pas un cockpit accroché à la tête.
  // Si le y de l'ancre lui parvenait, se lever et recentrer ferait monter le
  // sol avec le joueur - qui resterait à 1,20 m au-dessus de lui pour
  // toujours. C'est le seul objet de la scène dont la hauteur ne doit jamais
  // suivre celle du regard.
  const head = anchorFrom([0.3, 1.1, -0.7], IDENTITY);
  const room = roomAnchor(head);

  assert.equal(room.position[0], 0.3);
  assert.equal(room.position[1], 0);
  assert.equal(room.position[2], -0.7);
  assert.equal(room.yaw, head.yaw);
});

test('l_ancre de la pièce ne modifie pas celle qu_on lui donne', () => {
  // Les deux ancres sont appliquées à deux groupes différents dans la même
  // image : muter l'entrée ferait perdre sa hauteur au groupe des panneaux.
  const head = anchorFrom([0, 1.6, 0], IDENTITY);
  roomAnchor(head);
  assert.equal(head.position[1], 1.6);
});
```

Ajouter `roomAnchor` à l'import en tête de fichier.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-anchor.test.ts`
Expected: FAIL — `roomAnchor is not a function`.

- [ ] **Step 3a: Écrire `roomAnchor` dans `anchor.ts`**

```ts
/**
 * L'ancre du décor, qui n'est pas celle des panneaux.
 *
 * Une seule différence, et c'est toute la distinction entre les deux groupes
 * de la scène : **la hauteur est écartée.**
 *
 * Les panneaux sont un cockpit. Ils doivent suivre la tête, y compris en
 * hauteur, sinon un joueur qui se lève les laisse au niveau de ses genoux.
 * Le décor est un lieu posé par terre. Si le `y` lui parvenait, se lever et
 * recentrer ferait monter le sol avec le joueur, qui resterait suspendu à la
 * même hauteur au-dessus pour toujours - le seul objet de cette scène dont la
 * hauteur ne doit jamais suivre le regard.
 *
 * Le cap et le déplacement horizontal, eux, sont conservés : recentrer doit
 * bien remettre le monde en face de soi.
 *
 * Une copie, jamais une mutation : les deux ancres sont appliquées à deux
 * groupes dans la même image, et écraser l'entrée ferait perdre sa hauteur au
 * groupe des panneaux.
 */
export function roomAnchor(anchor: Anchor): Anchor {
  return {
    position: [anchor.position[0], 0, anchor.position[2]],
    yaw: anchor.yaw
  };
}
```

- [ ] **Step 3b: Câbler `scene.ts`**

Quatre modifications, toutes petites :

1. **L'interface** — `onFrame` transporte le temps, et deux points d'ajout apparaissent :

```ts
  /** Runs every XR frame, before the render. `t` is the XR timestamp, in
   *  milliseconds, exactly as three's animation loop receives it. */
  onFrame: (fn: (t: number) => void) => void;
  /**
   * Ajoute un objet au groupe `room` : un lieu posé par terre, dont la
   * hauteur ne suit pas la tête. Voir `roomAnchor`.
   */
  addDecor(object: THREE.Object3D): void;
  /**
   * Ajoute un objet au groupe `world`, avec les panneaux.
   *
   * Existe pour le rideau, et le rideau seul. Son dégagement intérieur est
   * mesuré contre l'écran, qui est ancré : le rideau doit donc l'être aussi,
   * et ne peut pas vivre dans `room` avec ce qu'il masque.
   */
  addCurtain(object: THREE.Object3D): void;
```

2. **Le groupe**, juste après `scene.add(world)` :

```ts
  /*
   * Le deuxième groupe : le lieu, par opposition au cockpit.
   *
   * Frère de `world` et non son enfant, précisément parce qu'il ne doit pas
   * hériter de sa hauteur. `roomAnchor` dit pourquoi. Les contrôleurs restent
   * en dehors des deux, comme avant.
   */
  const room = new THREE.Group();
  scene.add(room);
```

3. **Le recentrage** — dans le bloc `if (pose) { … }`, après les deux lignes qui placent `world` :

```ts
            const forRoom = roomAnchor(anchor);
            room.position.set(...forRoom.position);
            room.rotation.set(0, forRoom.yaw, 0);
```

4. **La boucle** — `renderer.setAnimationLoop((time) => {` au lieu de `(() => {`, et `for (const fn of perFrame) fn(time);`.

5. **Les deux méthodes**, à côté de `addPanel` :

```ts
    addDecor: (object) => void room.add(object),
    addCurtain: (object) => void world.add(object),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-anchor.test.ts`
Expected: PASS — les tests existants **et** les deux nouveaux.

- [ ] **Step 5: Vérifier que rien d'autre n'a bougé**

Run: `bun run test:ui 2>&1 | tail -5` puis
`cd frontend && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: zéro échec, zéro erreur de type. L'élargissement de `onFrame` doit être invisible pour son unique appelant (`VrShell.svelte:2843` passe `frame`, qui ne prend aucun argument — légal là où on en passe un).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/anchor.ts frontend/src/lib/vr/scene.ts core/test/vr-anchor.test.ts
git commit -m "$(cat <<'EOF'
Séparer le lieu du cockpit : un second groupe dont la hauteur ne suit pas la tête

anchorFrom rend la position complète de la tête, et scene.ts l'applique telle
quelle au groupe qui porte les panneaux. C'est juste pour eux : un cockpit doit
suivre le regard, sinon se lever les laisse aux genoux.

Ce serait le pire comportement possible pour un sol. Le décor à venir a donc
son propre groupe, frère et non enfant, qui reçoit le cap et le déplacement
horizontal mais jamais la hauteur - le seul objet de cette scène dont le
niveau ne doit jamais suivre celui du regard.

roomAnchor vit dans anchor.ts plutôt que dans scene.ts pour être testable :
scene.ts importe three et n'a pas de test unitaire. Elle copie au lieu de
muter, parce que les deux ancres servent deux groupes dans la même image.

onFrame transporte désormais l'horodatage XR, dont le décor a besoin pour son
fondu. Son unique appelant ne s'en aperçoit pas.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Le décor lui-même — ciel, sol, rideau

**Files:**
- Create: `frontend/src/lib/vr/decor/build.ts`
- Create (hors dépôt) : l'outil de planche, dans le scratchpad de la session

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces:
  ```ts
  export interface DecorOptions { floorHeight: number; maxAnisotropy: number }
  export interface Decor {
    decor: THREE.Object3D;    // pour scene.addDecor
    curtain: THREE.Object3D;  // pour scene.addCurtain
    update(t: number): void;
    setVisible(visible: boolean): void;
    dispose(): void;
  }
  export function createDecor(opts: DecorOptions): Decor
  ```

**Pas de test unitaire, et c'est délibéré** — c'est le seul module qui importe three, comme le GLSL de `picture-filter.ts`. L'instrument est la planche de rendu, à l'étape 3.

- [ ] **Step 1: Écrire `build.ts`**

```ts
/**
 * Le décor en objets three : le seul module de `decor/` qui importe three.
 *
 * Tout ce qui se décide est ailleurs - les couleurs, les motifs, les
 * profondeurs, la hauteur du sol, la courbe du fondu - et tout ça est testé.
 * Ce qui reste ici est du câblage, et il n'est vérifié que par l'œil : la
 * planche de rendu pendant le développement, le casque ensuite. C'est la même
 * situation que le GLSL de `picture-filter.ts`, et la même règle en découle :
 * ne rien mettre ici qui puisse se calculer ailleurs.
 *
 * DEUX RACINES, et ce n'est pas un détail de rangement. `decor` va dans le
 * groupe `room`, dont la hauteur ne suit pas la tête. `curtain` va dans
 * `world`, avec les panneaux, parce que son dégagement intérieur est mesuré
 * contre l'écran, qui est ancré. Les mettre ensemble casse l'un ou l'autre.
 */
import * as THREE from 'three';
import { rasterise, type Art } from './pixels';
import { GROUND_BRICK } from './art/ground';
import { COLOURS } from './palette';
import { SKY_RADIUS, CURTAIN_RADIUS } from './composition';
import { curtain as curtainAt, type FadeTarget } from './fade';

/** La couleur du fond de `scene.ts`. Le rideau la porte, pour que la fin du
 *  fondu soit exactement la salle noire d'aujourd'hui. */
const DARK = 0x0a0a12;

export interface DecorOptions {
  /** Mètres sous l'œil, de `floor.ts`. */
  floorHeight: number;
  /** `renderer.capabilities.getMaxAnisotropy()`. */
  maxAnisotropy: number;
}

export interface Decor {
  decor: THREE.Object3D;
  curtain: THREE.Object3D;
  update(t: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * La texture d'une tuile qui se répète.
 *
 * C'est la seule texture du décor qui ne vient PAS de l'atlas, et il y a une
 * raison dure : la répétition demande un `RepeatWrapping` sur toute la
 * texture, ce qu'un sous-rectangle d'atlas ne peut pas faire. Deux textures en
 * tout, donc, et c'est le minimum.
 *
 * Le filtrage inverse la règle de `panel-mesh.ts`, qui interdit les mipmaps.
 * Son raisonnement y est écrit : les pupitres sont à ~1:1 pixel-canvas contre
 * pixel-affiché, donc un niveau de mip ne protège aucun détail et ne fait que
 * flouter le texte. Un sol carrelé vu en incidence rasante est le cas
 * exactement opposé - à dix mètres une tuile d'un mètre occupe une poignée de
 * pixels, et le point-sampling y produit un moiré qui grouille. D'où :
 * `NearestFilter` en magnification, pour garder les gros pixels de près, et
 * mipmaps plus anisotropie en minification.
 */
function tileTexture(art: Art, maxAnisotropy: number): THREE.CanvasTexture {
  const raster = rasterise(art);
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('pas de contexte 2d pour la tuile du sol');
  ctx.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = maxAnisotropy;
  return texture;
}

export function createDecor(opts: DecorOptions): Decor {
  const decor = new THREE.Group();

  // Le ciel : un aplat, pas une texture. Peindre du bleu uni sur un panorama
  // demanderait quatre mille pixels de large pour rien.
  const skyGeometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const skyMaterial = new THREE.MeshBasicMaterial({
    color: COLOURS.sky,
    side: THREE.BackSide
  });
  decor.add(new THREE.Mesh(skyGeometry, skyMaterial));

  /*
   * Le sol, du MÊME rayon que le dôme.
   *
   * Égal et non inférieur : à la hauteur du sol, la sphère est un peu plus
   * étroite que son rayon, donc un disque de même rayon la TRANVERSE au lieu
   * de s'en approcher. C'est ce qui garantit qu'il n'y a pas de fente à
   * l'horizon, sans bande de raccord ni réglage à trouver.
   *
   * La répétition vaut le diamètre en mètres, parce que les uv d'un
   * `CircleGeometry` couvrent 0..1 d'un bord à l'autre : soixante répétitions
   * sur soixante mètres font bien une tuile par mètre.
   */
  const floorTexture = tileTexture(GROUND_BRICK, opts.maxAnisotropy);
  floorTexture.repeat.set(SKY_RADIUS * 2, SKY_RADIUS * 2);
  const floorGeometry = new THREE.CircleGeometry(SKY_RADIUS, 64);
  const floorMaterial = new THREE.MeshBasicMaterial({ map: floorTexture });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -opts.floorHeight;
  decor.add(floor);

  /*
   * Le rideau. `depthWrite: false` parce qu'il est transparent : il doit se
   * mélanger par-dessus le décor qu'il masque, pas creuser un trou dans le
   * tampon de profondeur devant les panneaux - qui sont plus proches, opaques,
   * et dessinés avant lui.
   */
  const curtainGeometry = new THREE.SphereGeometry(CURTAIN_RADIUS, 16, 12);
  const curtainMaterial = new THREE.MeshBasicMaterial({
    color: DARK,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0,
    depthWrite: false
  });
  const curtainMesh = new THREE.Mesh(curtainGeometry, curtainMaterial);

  /*
   * L'état du fondu, et pourquoi le départ n'est pas pris dans `setVisible`.
   *
   * `t` vient du runtime XR et n'est lisible que dans une image. `setVisible`
   * est appelée depuis un clic ou un lancement de jeu, donc hors image : elle
   * note l'intention, et la première image qui suit date le départ.
   *
   * Tout part caché. `VrShell` montre le décor explicitement quand le lobby
   * s'installe, ce qui évite un monde qui apparaîtrait pendant que le casque
   * affiche encore sa boîte de dialogue de limites.
   */
  let target: FadeTarget = 'dark';
  let startedAt: number | null = null;
  let settled = true;
  decor.visible = false;
  curtainMesh.visible = false;

  return {
    decor,
    curtain: curtainMesh,

    setVisible(visible: boolean): void {
      const next: FadeTarget = visible ? 'decor' : 'dark';
      if (next === target) return;
      target = next;
      startedAt = null;
      settled = false;
      // Les deux sont visibles PENDANT le fondu, quel qu'en soit le sens : on
      // voit le rideau s'ouvrir sur le décor, ou se refermer dessus.
      decor.visible = true;
      curtainMesh.visible = true;
    },

    update(t: number): void {
      if (settled) return;
      // three passe l'horodatage XR en millisecondes ; `fade.ts` compte en
      // secondes.
      if (startedAt === null) startedAt = t;
      const step = curtainAt((t - startedAt) / 1000, target);
      curtainMaterial.opacity = step.opacity;
      if (!step.done) return;

      settled = true;
      // Le rideau ne sert que pendant le fondu. Une fois opaque, ce qui tient
      // le noir est `scene.background`, qui porte déjà la même couleur - donc
      // le masquer ne change rien à l'image et supprime un appel de dessin.
      curtainMesh.visible = false;
      if (target === 'dark') decor.visible = false;
    },

    dispose(): void {
      skyGeometry.dispose();
      skyMaterial.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
      floorTexture.dispose();
      curtainGeometry.dispose();
      curtainMaterial.dispose();
    }
  };
}
```

- [ ] **Step 2: Vérifier les types**

Run: `cd frontend && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: zéro erreur.

- [ ] **Step 3: Monter la planche de rendu, et la regarder**

L'instrument qui remplace les tests pour ce module. **Dans le scratchpad, jamais dans le dépôt.**

`sheet.ts` — une page qui dessine l'atlas à l'échelle 8 et chaque tuile isolée :

```ts
import { ALL_ART } from '<worktree>/frontend/src/lib/vr/decor/art/index';
import { rasterise } from '<worktree>/frontend/src/lib/vr/decor/pixels';
import { packAtlas } from '<worktree>/frontend/src/lib/vr/decor/atlas';

const SCALE = 8;
const atlas = packAtlas(ALL_ART);
const canvas = document.createElement('canvas');
canvas.width = atlas.width * SCALE;
canvas.height = atlas.height * SCALE;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false; // sinon la planche ment sur ce qu'on dessine
ctx.fillStyle = '#202030';
ctx.fillRect(0, 0, canvas.width, canvas.height);

for (const [name, art] of Object.entries(ALL_ART)) {
  const raster = rasterise(art);
  const rect = atlas.rects[name];
  const tile = document.createElement('canvas');
  tile.width = raster.width;
  tile.height = raster.height;
  tile.getContext('2d')!.putImageData(
    new ImageData(raster.data, raster.width, raster.height), 0, 0
  );
  ctx.drawImage(tile, rect.x * SCALE, rect.y * SCALE, rect.width * SCALE, rect.height * SCALE);
  ctx.fillStyle = '#fff';
  ctx.font = '10px monospace';
  ctx.fillText(name, rect.x * SCALE, rect.y * SCALE - 2);
}
document.body.appendChild(canvas);
```

Construire et regarder :

```bash
cd <scratchpad>
npx esbuild sheet.ts --bundle --outfile=sheet.js
printf '<body style="margin:0;background:#111"><script src="sheet.js"></script></body>' > sheet.html
npx playwright screenshot --viewport-size=1400,1400 "file://$PWD/sheet.html" sheet.png
```

Puis **ouvrir `sheet.png` et vérifier** : les deux tuiles sont là, elles font seize pixels, l'appareil des briques est décalé d'une rangée sur l'autre, aucun motif n'en chevauche un autre, et le bord d'herbe est en haut de `groundGrass` et non en bas.

> Pourquoi `imageSmoothingEnabled = false` : sans lui la planche interpole l'agrandissement et montre des pixels flous qui ne sont pas ceux qu'on a écrits. C'est exactement le genre de mensonge d'instrument qui fait chercher un défaut ailleurs.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/vr/decor/build.ts
git commit -m "$(cat <<'EOF'
Construire le ciel, le sol et le rideau du décor

Le seul module de decor/ qui importe three, donc le seul sans test unitaire -
la même situation que le GLSL de picture-filter.ts, et la même règle : ne rien
mettre ici qui puisse se calculer ailleurs. L'instrument est la planche de
rendu, puis le casque.

Deux racines, et ce n'est pas du rangement. Le décor va dans le groupe room,
dont la hauteur ne suit pas la tête ; le rideau va dans world avec les
panneaux, parce que son dégagement intérieur est mesuré contre l'écran, qui
est ancré. Les réunir casse l'un ou l'autre.

Le sol a le même rayon que le dôme, donc il le transperce au lieu de s'en
approcher : pas de fente à l'horizon, sans bande de raccord. Et son filtrage
inverse la règle de panel-mesh.ts - mipmaps et anisotropie en minification -
parce qu'un carrelage vu en incidence rasante est le cas opposé d'un pupitre
vu à 1:1.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Brancher le décor dans la coquille

**Files:**
- Modify: `frontend/src/lib/vr/scene.ts` (deux accesseurs de plus)
- Modify: `frontend/src/lib/components/VrShell.svelte`

**Interfaces:**
- Consumes: `createDecor`, `Decor` (Task 10), `measureFloor` (Task 5), `addDecor` / `addCurtain` (Task 9).
- Produces: sur `VrScene`, `maxAnisotropy(): number` et `poseIn(space: unknown): { y: number } | null`.

Dernière tâche du lot : à la fin, le monde est visible dans un casque.

- [ ] **Step 1: Ajouter les deux accesseurs à `scene.ts`**

Dans l'interface :

```ts
  /** `renderer.capabilities.getMaxAnisotropy()`, dont le sol a besoin. */
  maxAnisotropy(): number;
  /**
   * L'origine de `space`, exprimée dans l'espace de référence de CETTE scène.
   *
   * Existe pour mesurer le plancher (`decor/floor.ts`) sans que le reste de
   * l'app ait à connaître `XRFrame`. Rend `null` hors image ou tant que le
   * suivi n'est pas prêt, ce que l'appelant doit traiter comme « redemande »
   * et non comme « pas de sol ».
   */
  poseIn(space: unknown): { y: number } | null;
```

Dans l'objet retourné :

```ts
    maxAnisotropy: () => renderer.capabilities.getMaxAnisotropy(),

    poseIn(space: unknown): { y: number } | null {
      const frame = renderer.xr.getFrame();
      // L'espace de three, pas celui de `xr-session.ts` : c'est celui dans
      // lequel tout, dans cette boucle, est exprimé.
      const reference = renderer.xr.getReferenceSpace();
      if (!frame || !reference || !space) return null;
      /*
       * L'ORDRE des arguments est le piège, et l'inverser ne jette pas - ça
       * rend l'opposé. `getPose(space, baseSpace)` donne la pose de `space`
       * VUE DEPUIS `baseSpace` : on veut l'origine du plancher vue depuis
       * l'œil, donc un y négatif. L'inverse donnerait l'œil vu depuis le
       * plancher, donc un y positif - que `floor.ts` refuse comme « sol au
       * plafond », ce qui est précisément le garde-fou prévu pour ça.
       */
      const pose = frame.getPose(space as XRSpace, reference);
      return pose ? { y: pose.transform.position.y } : null;
    },
```

- [ ] **Step 2: Câbler `VrShell.svelte`**

1. **Imports**, à côté des autres imports `$lib/vr` :

```ts
  import { createDecor, type Decor } from '$lib/vr/decor/build';
  import { measureFloor } from '$lib/vr/decor/floor';
```

2. **L'état**, à côté de `let scene: VrScene | null`. Un booléen explicite plutôt qu'une lecture de `screen.isPanel()` : le mode de l'écran décrit ce qui est PEINT dessus, et c'est la coquille qui sait si une partie tourne.

```ts
  let decor: Decor | null = null;
  /** Le lobby est-il à l'écran. Vrai à l'ouverture : aucune partie ne tourne. */
  let decorShowing = true;

  /** Les six sites qui basculent lobby/jeu passent par ici, et rien d'autre. */
  function showDecor(visible: boolean): void {
    decorShowing = visible;
    decor?.setVisible(visible);
  }

  /**
   * Construit le décor dès que le plancher est mesurable.
   *
   * Appelée à chaque image tant qu'elle n'a pas abouti. `measureFloor` rend
   * `null` tant que le suivi n'a pas donné de pose - les toutes premières
   * images d'une session - et construire avec le repli à ce moment-là ferait
   * de 1,20 m le cas normal plutôt que le cas dégradé. Quelques images de
   * retard sont invisibles : le décor naît caché.
   */
  function ensureDecor(): void {
    if (decor || !scene || !session) return;
    const height = measureFloor({
      floorSpace: () => session?.floorSpace ?? null,
      poseOf: (space) => scene?.poseIn(space) ?? null
    });
    if (height === null) return;

    decor = createDecor({ floorHeight: height, maxAnisotropy: scene.maxAnisotropy() });
    scene.addDecor(decor.decor);
    scene.addCurtain(decor.curtain);
    decor.setVisible(decorShowing);
  }
```

3. **La boucle**, juste après `scene.onFrame(frame);` (vers la ligne 2843). Un second abonnement plutôt qu'un élargissement de `frame` : `frame()` est appelée depuis plusieurs endroits sans argument, et lui en donner un obligerait à toucher chacun.

```ts
      scene.onFrame((t) => {
        ensureDecor();
        decor?.update(t);
      });
```

4. **Les six sites.** Chercher chaque appel et ajouter une ligne à côté :

| Ligne (avant modification) | Appel existant | Ajouter |
|---|---|---|
| ~723 | `scene.screen.showTestPattern();` | `showDecor(true);` |
| ~1234 | `scene?.screen.showPicture();` | `showDecor(false);` |
| ~1718 | `scene.screen.showPicture();` | `showDecor(false);` |
| ~2364 | `scene.screen.showPicture();` | `showDecor(false);` |
| ~2477 | `scene.screen.showTestPattern();` | `showDecor(true);` |
| ~2849 | `scene.screen.showTestPattern();` | `showDecor(true);` |

> Les numéros de ligne dérivent au fil des modifications. La vérification qui compte est le compte : `grep -c "showDecor(" frontend/src/lib/components/VrShell.svelte` doit rendre **7** (les six sites plus la déclaration), et `grep -c "showPicture()\|showTestPattern()"` doit rendre **6**. Si les deux ne s'accordent pas, un site a été manqué.

5. **La sortie**, à côté de `scene?.dispose();` (vers 3078), et **avant** lui :

```ts
    decor?.dispose();
    decor = null;
```

- [ ] **Step 3: Vérifier les types et la suite**

```bash
cd frontend && npx svelte-check --threshold error 2>&1 | tail -5
cd .. && bun run test:ui 2>&1 | tail -5
```
Expected: zéro erreur, zéro échec.

- [ ] **Step 4: Vérifier que la route VR construit toujours**

Run: `cd frontend && npx vite build 2>&1 | tail -15`
Expected: succès. Ce contrôle existe parce que `test:all` ne construit rien — seule la vraie construction du frontend attrape ce que le typage laisse passer.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/scene.ts frontend/src/lib/components/VrShell.svelte
git commit -m "$(cat <<'EOF'
Montrer le décor dans le lobby, l'effacer quand une partie démarre

La coquille décide, pas l'écran : isPanel() décrit ce qui est peint sur le
mesh, alors que c'est VrShell qui sait si une partie tourne. Six sites
basculent, tous par la même fonction, et deux grep les comptent.

Le décor naît à la première image où le plancher est mesurable, pas à
l'ouverture de la session : la pose n'existe qu'à l'intérieur d'une image XR,
et construire avec le repli avant qu'elle arrive ferait de 1,20 m le cas
normal. Quelques images de retard sont invisibles, le décor naissant caché.

poseIn porte un avertissement sur l'ordre de ses arguments : l'inverser ne
jette pas, ça rend l'opposé - l'œil vu depuis le plancher au lieu du plancher
vu depuis l'œil. C'est exactement ce que le garde-fou "sol au plafond" de
floor.ts attrape.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Session casque — le contrôle du lot 1**

Le lot est fini quand ces cinq observations sont faites, pas quand les tests passent :

1. **Le sol paraît-il à la bonne hauteur, assis ET debout ?** C'est la question que `local-floor` existe pour régler.
2. **Le fondu est-il confortable dans les deux sens ?** Lancer un jeu, puis le quitter.
3. **Se lever et recentrer ne fait PAS monter le sol.** Le contrôle direct de `roomAnchor`.
4. **Le Guardian se comporte-t-il comme avant ?** C'est le seul risque de `optionalFeatures`.
5. **Le compteur d'images tient-il dans le lobby ?** Si non, le levier est la foveation, et pas avant la mesure.

---

# Lot 2 — Le relief

Collines, buissons, nuages : les calques lointains. **C'est le lot qui juge le pari de l'approche A** — si l'empilement ne bat pas l'effet papier peint, on le découvre ici, avant d'avoir dessiné un seul tuyau.

---

### Task 12: Une seule silhouette pour les collines, les buissons et les nuages

**Files:**
- Create: `frontend/src/lib/vr/decor/art/shapes.ts`, `frontend/src/lib/vr/decor/art/scenery.ts`
- Modify: `frontend/src/lib/vr/decor/art/index.ts`
- Test: `core/test/vr-decor-shapes.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Art`, `ColourName`.
- Produces: `mound(radii, palette): Art` ; `HILL_LARGE`, `HILL_SMALL`, `BUSH`, `CLOUD`.

**Le fait qui rend ce lot bon marché :** dans Super Mario Bros., **le buisson, la colline et le nuage sont la même silhouette**, à la couleur près. Ce n'est pas une économie qu'on s'accorde, c'est la façon dont l'original était fait. Un générateur suffit donc pour les trois, et il tient en trente lignes là où trois grilles littérales en auraient pris deux cents.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Le générateur de silhouettes, et pourquoi il y en a un seul.
 *
 * Dans SMB, le buisson, la colline et le nuage partagent la même forme : une
 * rangée de lobes. Un générateur les rend tous les trois, ce qui remplace des
 * centaines de lignes de grille littérale par des nombres qu'on peut vérifier.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mound } from '../../frontend/src/lib/vr/decor/art/shapes.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';

const PALETTE = { body: 'hill', shade: 'hillDark', edge: 'outline' } as const;

test('la largeur est la somme des diamètres, la hauteur le plus grand rayon', () => {
  const art = mound([8, 12, 8], PALETTE);
  const raster = rasterise(art);
  assert.equal(raster.width, 2 * (8 + 12 + 8));
  assert.equal(raster.height, 12);
});

test('des lobes symétriques donnent une silhouette symétrique', () => {
  // Le miroir est la seule propriété qu'on puisse vérifier sans redessiner la
  // forme à la main - et une erreur d'un pixel dans le centrage des lobes la
  // casse, alors qu'elle passerait inaperçue à l'œil.
  const art = mound([8, 12, 8], PALETTE);
  for (const row of art.rows) {
    assert.equal(row, [...row].reverse().join(''), `ligne non miroir : ${row}`);
  }
});

test('la grille reste rectangulaire et se rastérise', () => {
  const art = mound([6, 10, 14, 10, 6], PALETTE);
  const width = art.rows[0].length;
  for (const row of art.rows) assert.equal(row.length, width);
  assert.doesNotThrow(() => rasterise(art));
});

test('le sommet de chaque colonne pleine porte le contour', () => {
  const art = mound([8], PALETTE);
  for (let x = 0; x < art.rows[0].length; x++) {
    const firstFilled = art.rows.findIndex((row) => row[x] !== '.');
    if (firstFilled === -1) continue;
    assert.equal(art.rows[firstFilled][x], 'e', `colonne ${x} sans contour`);
  }
});

test('un lobe de rayon nul est refusé plutôt que rendu vide', () => {
  assert.throws(() => mound([0], PALETTE), /rayon/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-shapes.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Write the implementation**

`art/shapes.ts` :

```ts
/**
 * La silhouette partagée par les collines, les buissons et les nuages.
 *
 * Ce n'est pas une économie qu'on s'accorde : dans Super Mario Bros., ces
 * trois-là SONT le même dessin, à la palette près. Écrire un générateur plutôt
 * que trois grilles littérales rend donc l'original plus fidèlement, en plus
 * de remplacer deux cents lignes de caractères par des nombres qu'un test peut
 * vérifier.
 *
 * Une « mound » est une rangée de lobes semi-circulaires posés côte à côte.
 * Les rayons décident de tout : `[8, 12, 8]` fait une colline à trois bosses
 * dont celle du milieu dépasse, `[8]` fait un buisson d'une seule.
 */
import type { ColourName } from '../palette';
import type { Art } from '../pixels';
import { TRANSPARENT } from '../pixels';

export interface MoundPalette {
  /** Le corps. */
  readonly body: ColourName;
  /** Le bas, plus sombre : ce qui empêche la forme de paraître découpée. */
  readonly shade: ColourName;
  /** Le contour, sur le sommet de chaque colonne. */
  readonly edge: ColourName;
}

/** Depuis le bas, la hauteur de la bande sombre. */
const SHADE_ROWS = 3;

export function mound(radii: readonly number[], palette: MoundPalette): Art {
  if (radii.length === 0) throw new Error('une silhouette sans lobe');
  for (const radius of radii) {
    if (!Number.isInteger(radius) || radius <= 0) {
      throw new Error(`rayon de lobe invalide : ${radius}`);
    }
  }

  const width = radii.reduce((sum, radius) => sum + 2 * radius, 0);
  const height = Math.max(...radii);

  // Le centre de chaque lobe, en pixels depuis la gauche.
  const centres: number[] = [];
  let cursor = 0;
  for (const radius of radii) {
    centres.push(cursor + radius);
    cursor += 2 * radius;
  }

  /** La hauteur de la silhouette à la colonne x : le plus haut des lobes. */
  function silhouette(x: number): number {
    let top = 0;
    radii.forEach((radius, index) => {
      // Le pixel est échantillonné en son MILIEU (+0.5), sinon la forme est
      // décalée d'un demi-pixel et le miroir se casse.
      const dx = x + 0.5 - centres[index];
      const inside = radius * radius - dx * dx;
      if (inside <= 0) return;
      const lobe = Math.round(Math.sqrt(inside));
      if (lobe > top) top = lobe;
    });
    return top;
  }

  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    // y = 0 est le haut de l'image ; la silhouette se mesure depuis le bas.
    const fromBottom = height - y;
    let row = '';
    for (let x = 0; x < width; x++) {
      const top = silhouette(x);
      if (fromBottom > top) {
        row += TRANSPARENT;
      } else if (fromBottom === top) {
        row += 'e';
      } else if (fromBottom <= SHADE_ROWS) {
        row += 's';
      } else {
        row += 'b';
      }
    }
    rows.push(row);
  }

  return {
    palette: { b: palette.body, s: palette.shade, e: palette.edge },
    rows
  };
}
```

`art/scenery.ts` :

```ts
/**
 * Le relief lointain, tout entier dérivé d'une seule silhouette.
 *
 * Les tailles se lisent en mètres : un lobe de rayon r fait 2r pixels de
 * large, et seize pixels font un mètre (`ART_PIXELS_PER_METRE`). Une colline
 * `[16, 24, 16]` mesure donc sept mètres de large sur un mètre cinquante de
 * haut - ce qui, posée à vingt mètres, occupe vingt degrés de vision.
 */
import { mound } from './shapes';

export const HILL_LARGE = mound([16, 24, 16], {
  body: 'hill',
  shade: 'hillDark',
  edge: 'outline'
});

export const HILL_SMALL = mound([12, 12], {
  body: 'hill',
  shade: 'hillDark',
  edge: 'outline'
});

/** Même forme que la colline : c'est ce que faisait l'original. */
export const BUSH = mound([8, 8, 8], {
  body: 'grass',
  shade: 'grassDark',
  edge: 'outline'
});

/** Et le nuage aussi - seule la palette change. */
export const CLOUD = mound([8, 12, 8], {
  body: 'cloud',
  shade: 'cloud',
  edge: 'outline'
});
```

Puis inscrire les quatre dans `ALL_ART` (`art/index.ts`), sous les clés `hillLarge`, `hillSmall`, `bush`, `cloud`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-shapes.test.ts core/test/vr-decor-art.test.ts`
Expected: PASS — les cinq nouveaux **et** les invariants du registre, qui couvrent désormais les quatre motifs sans avoir été touchés. C'est la promesse de la Task 3 qui se vérifie.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Regarder la planche**

Reconstruire `sheet.png` (Task 10, étape 3) et vérifier : les collines ont un sommet arrondi et non un escalier grossier, le contour suit bien le sommet de chaque colonne, la bande sombre du bas ne mange pas toute la forme, et le nuage est blanc avec un contour noir.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/vr/decor/art core/test/vr-decor-shapes.test.ts package.json
git commit -m "$(cat <<'EOF'
Dériver collines, buissons et nuages d'une seule silhouette

Dans Super Mario Bros., ces trois-là sont le même dessin à la palette près.
Un générateur les rend donc tous les trois : c'est plus fidèle à l'original
qu'trois grilles distinctes, et ça remplace deux cents lignes de caractères
par des nombres qu'un test peut vérifier.

Le miroir est la propriété qui tient l'ensemble : une erreur d'un pixel dans
le centrage des lobes le casse, alors qu'elle passerait inaperçue à l'œil.
D'où aussi l'échantillonnage au milieu du pixel plutôt qu'à son bord.

Les invariants du registre couvrent les quatre nouveaux motifs sans avoir été
touchés - c'est la promesse du registre qui se vérifie pour la première fois.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Où se pose chaque élément du relief

**Files:**
- Create: `frontend/src/lib/vr/decor/placement.ts`
- Test: `core/test/vr-decor-placement.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `RINGS`, `DECOR_NEAR`, `SKY_RADIUS` (Task 4), `ALL_ART` (Task 3).
- Produces:
  ```ts
  export type Facing = 'fixed' | 'billboard';
  export interface Prop {
    readonly art: string;
    readonly azimuth: number;   // radians, 0 = droit devant
    readonly radius: number;    // mètres
    readonly standing: number;  // mètres entre le SOL et le bas de l'objet
    readonly facing: Facing;
  }
  export function scenery(): readonly Prop[]
  ```

**Ce que `Prop` ne porte pas, délibérément : aucune taille.** Elle se déduit du dessin — largeur en pixels divisée par `ART_PIXELS_PER_METRE` — ce qui rend la règle des seize pixels par mètre **vraie partout par construction**, au lieu d'être une discipline à tenir à chaque placement.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Les placements du relief : les règles que la relecture n'attrape pas.
 *
 * Le test ne juge pas la composition - c'est affaire de goût et de casque. Il
 * tient les quatre invariants dont la violation est invisible depuis un
 * terminal et coûteuse dans un casque.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { scenery } from '../../frontend/src/lib/vr/decor/placement.js';
import { DECOR_NEAR, SKY_RADIUS } from '../../frontend/src/lib/vr/decor/composition.js';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';

test('aucun élément ne vient devant le rideau ni derrière le ciel', () => {
  for (const prop of scenery()) {
    assert.ok(prop.radius >= DECOR_NEAR, `${prop.art} à ${prop.radius} m est trop près`);
    assert.ok(prop.radius <= SKY_RADIUS, `${prop.art} à ${prop.radius} m dépasse le ciel`);
  }
});

test('tout élément désigne un motif qui existe', () => {
  for (const prop of scenery()) {
    assert.ok(ALL_ART[prop.art], `motif inconnu : ${prop.art}`);
  }
});

test('le relief fait vraiment le tour, pas seulement le devant', () => {
  // Le demandeur a choisi 360 degrés. Un décor qui ne couvre que l'avant est
  // la régression silencieuse la plus facile à commettre ici : on compose en
  // regardant droit devant, et on ne se retourne jamais depuis un terminal.
  const quadrants = new Set(
    scenery().map((prop) => Math.floor((((prop.azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)))
  );
  assert.equal(quadrants.size, 4, `quadrants occupés : ${[...quadrants]}`);
});

test('les collines sont fixes et les nuages des billboards', () => {
  // La règle de la spec §6, et elle a une raison dans chaque sens : une
  // colline à vingt mètres qui pivoterait perdrait sa silhouette franche, un
  // nuage fixe montrerait sa tranche.
  for (const prop of scenery()) {
    if (prop.art.startsWith('hill')) assert.equal(prop.facing, 'fixed', prop.art);
    if (prop.art === 'cloud') assert.equal(prop.facing, 'billboard', prop.art);
  }
});

test('les nuages flottent et le reste est posé', () => {
  for (const prop of scenery()) {
    if (prop.art === 'cloud') assert.ok(prop.standing > 2, 'un nuage au sol');
    else assert.equal(prop.standing, 0, `${prop.art} flotte`);
  }
});

test('la composition est déterministe', () => {
  assert.deepEqual(scenery(), scenery());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-placement.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Où se pose chaque élément du décor.
 *
 * Le pendant de `sceneLayout` pour le monde plutôt que pour les panneaux, et
 * trois-fois-rien de code : une liste de nombres. C'est voulu - ce qui se
 * décide ici doit pouvoir se relire d'un coup d'œil et se vérifier sans
 * casque.
 *
 * CE QUE `Prop` NE PORTE PAS : aucune taille. Elle se déduit du dessin -
 * largeur en pixels divisée par seize - ce qui rend la règle des seize pixels
 * par mètre vraie PAR CONSTRUCTION plutôt que par discipline. Grossir un
 * objet se fait donc en le dessinant plus grand, jamais en le mettant à
 * l'échelle, et c'est ce qui garantit que ses pixels restent de la taille de
 * tous les autres.
 *
 * Les azimuts sont volontairement irréguliers. Une répartition uniforme se
 * lit immédiatement comme une répétition - l'œil trouve la période - alors
 * qu'un décor de jeu est irrégulier.
 */
import { RINGS } from './composition';

export type Facing = 'fixed' | 'billboard';

export interface Prop {
  readonly art: string;
  /** Radians, 0 droit devant, croissant vers la droite du joueur. */
  readonly azimuth: number;
  readonly radius: number;
  /** Mètres entre le sol et le BAS de l'objet. Zéro : posé. */
  readonly standing: number;
  readonly facing: Facing;
}

const TURN = 2 * Math.PI;
/** Une fraction de tour, pour que les azimuts se lisent en douzièmes. */
const at = (twelfths: number) => (twelfths / 12) * TURN;

export function scenery(): readonly Prop[] {
  return [
    // Les collines : fixes, parce qu'à vingt mètres la stéréo ne distingue
    // plus le volume et qu'une silhouette franche vaut mieux qu'un pivot.
    { art: 'hillLarge', azimuth: at(0.7), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillSmall', azimuth: at(2.2), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillLarge', azimuth: at(4.1), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillSmall', azimuth: at(6.4), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillLarge', azimuth: at(8.3), radius: RINGS.hills, standing: 0, facing: 'fixed' },
    { art: 'hillSmall', azimuth: at(10.6), radius: RINGS.hills, standing: 0, facing: 'fixed' },

    // Les buissons : plus près que les collines, ce qui est tout l'intérêt -
    // c'est l'écart entre les deux anneaux qui produit la parallaxe.
    { art: 'bush', azimuth: at(1.4), radius: RINGS.creatures, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(3.3), radius: RINGS.clouds, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(5.1), radius: RINGS.creatures, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(7.8), radius: RINGS.clouds, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(9.2), radius: RINGS.creatures, standing: 0, facing: 'fixed' },
    { art: 'bush', azimuth: at(11.5), radius: RINGS.clouds, standing: 0, facing: 'fixed' },

    // Les nuages : billboards, parce qu'à cette distance le pivot est
    // indétectable et qu'il évite de les dessiner sous trois angles.
    { art: 'cloud', azimuth: at(0.2), radius: RINGS.clouds, standing: 7, facing: 'billboard' },
    { art: 'cloud', azimuth: at(3.9), radius: RINGS.clouds, standing: 9, facing: 'billboard' },
    { art: 'cloud', azimuth: at(6.1), radius: RINGS.clouds, standing: 6, facing: 'billboard' },
    { art: 'cloud', azimuth: at(8.8), radius: RINGS.clouds, standing: 10, facing: 'billboard' },
    { art: 'cloud', azimuth: at(10.3), radius: RINGS.clouds, standing: 8, facing: 'billboard' }
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test core/test/vr-decor-placement.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/placement.ts core/test/vr-decor-placement.test.ts package.json
git commit -m "$(cat <<'EOF'
Poser le relief autour du joueur, sans jamais écrire de taille

Un Prop ne porte pas de dimensions : elles se déduisent du dessin, largeur en
pixels divisée par seize. La règle des seize pixels par mètre devient donc
vraie par construction au lieu d'être une discipline à tenir à chaque
placement - grossir un objet se fait en le dessinant plus grand, jamais en le
mettant à l'échelle, et ses pixels restent de la taille de tous les autres.

Le test tient quatre règles dont la violation est invisible depuis un
terminal. La plus facile à enfreindre : ne composer que le devant. On compose
en regardant droit devant et on ne se retourne jamais - le test vérifie que
les quatre quadrants sont occupés.

Les azimuts sont irréguliers exprès : une répartition uniforme se lit comme
une répétition, l'œil en trouve la période.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Dessiner le relief

**Files:**
- Modify: `frontend/src/lib/vr/decor/build.ts`
- Modify: `frontend/src/lib/vr/scene.ts` (un accesseur de plus)
- Modify: `frontend/src/lib/components/VrShell.svelte` (le passer au décor)

**Interfaces:**
- Consumes: `scenery()` (Task 13), `packAtlas` / `uvOf` (Task 6), `ALL_ART`.
- Produces: sur `VrScene`, `headPosition(): { x: number; y: number; z: number }` ; `DecorOptions` gagne `head: () => { x: number; y: number; z: number }`.

- [ ] **Step 1: La tête, exposée par la scène**

Dans `scene.ts`, interface puis implémentation :

```ts
  /**
   * La position de la tête dans la scène, pour les billboards.
   *
   * Lue sur la caméra XR plutôt que sur `getViewerPose` : c'est celle qui a
   * effectivement servi au rendu de l'image en cours, donc un billboard
   * orienté avec elle ne peut pas être en retard d'une image.
   */
  headPosition(): { x: number; y: number; z: number };
```

```ts
    headPosition(): { x: number; y: number; z: number } {
      // `renderer.xr.getCamera()` rend la caméra de tableau (les deux yeux) ;
      // sa position est le point milieu, ce qui est exactement le bon repère
      // pour un billboard - viser un œil plutôt que l'autre ferait pivoter le
      // décor de quelques centièmes de degré à chaque image.
      const xr = renderer.xr.getCamera();
      return { x: xr.position.x, y: xr.position.y, z: xr.position.z };
    },
```

- [ ] **Step 2: La texture de l'atlas, dans `build.ts`**

```ts
/**
 * L'atlas, en une texture.
 *
 * `NearestFilter` DANS LES DEUX SENS, et aucun mipmap - l'exact opposé du sol.
 * Les deux règles cohabitent parce qu'elles répondent à deux problèmes : le
 * sol est vu en incidence rasante et grouille sans mipmaps, tandis que ces
 * quads-ci sont vus de face, à une taille voisine de leur taille native. Un
 * mipmap y produirait ce que `panel-mesh.ts` décrit - une image demi-résolution
 * à mélanger, donc du flou, contre un scintillement qui n'existe pas.
 *
 * Et surtout : le flou est précisément ce qu'on ne veut PAS ici. Le registre
 * choisi est « pixel-art assumé ». Des pixels nets et carrés sont le sujet.
 */
function atlasTexture(atlas: Atlas): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = atlas.width;
  canvas.height = atlas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("pas de contexte 2d pour l'atlas du décor");

  for (const [name, art] of Object.entries(ALL_ART)) {
    const raster = rasterise(art);
    const rect = atlas.rects[name];
    ctx.putImageData(new ImageData(raster.data, raster.width, raster.height), rect.x, rect.y);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
```

- [ ] **Step 3: Un quad par élément**

```ts
/**
 * Le quad d'un élément du décor.
 *
 * La taille vient du DESSIN, jamais du placement : `placement.ts` ne porte
 * aucune dimension, exprès. Diviser par seize est donc le seul endroit du
 * codebase où la densité de pixels s'applique, ce qui la rend vraie partout.
 *
 * Les uv sont écrites à la main sur une `PlaneGeometry` plutôt que passées par
 * `texture.offset`/`repeat` : offset et repeat vivent sur la TEXTURE, donc les
 * partager entre deux quads en fait dériver un, et les cloner ferait une
 * texture par objet.
 */
function quadFor(
  prop: Prop,
  atlas: Atlas,
  material: THREE.Material,
  floorHeight: number
): THREE.Mesh {
  const raster = rasterise(ALL_ART[prop.art]);
  const width = raster.width / ART_PIXELS_PER_METRE;
  const height = raster.height / ART_PIXELS_PER_METRE;

  const geometry = new THREE.PlaneGeometry(width, height);
  const uv = uvOf(atlas, prop.art);
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      // L'ordre des sommets d'une PlaneGeometry : haut-gauche, haut-droit,
      // bas-gauche, bas-droit.
      [uv.u0, uv.v1, uv.u1, uv.v1, uv.u0, uv.v0, uv.u1, uv.v0],
      2
    )
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    prop.radius * Math.sin(prop.azimuth),
    -floorHeight + prop.standing + height / 2,
    -prop.radius * Math.cos(prop.azimuth)
  );
  // Le lacet est l'opposé de l'azimut : la normale d'un plan part vers +Z, et
  // tourner de -azimut la ramène vers le joueur. Se tromper de signe montre le
  // DOS d'un quad invisible, ce qui se lit comme « le décor n'a pas chargé ».
  // C'est la même erreur que `layout.ts` documente pour ses pupitres.
  mesh.rotation.y = -prop.azimuth;
  return mesh;
}
```

Le matériau est **partagé par tous les quads** : `new THREE.MeshBasicMaterial({ map: texture, transparent: false, alphaTest: 0.5, side: THREE.DoubleSide })`.

> `alphaTest` plutôt que `transparent` : les découpes sont franches - un pixel est là ou il n'y est pas - et `transparent: true` ferait trier tous ces quads entre eux à chaque image pour rien, avec les artefacts d'ordre qui vont avec. `DoubleSide` parce qu'un billboard qui pivote passe par des angles où sa face arrière regarde le joueur pendant une image.

- [ ] **Step 4: Les billboards, une ligne par image**

Garder les billboards dans un tableau à la construction, puis dans `update` :

```ts
      // Les billboards visent la tête à LEUR PROPRE hauteur : viser la tête
      // elle-même les ferait basculer en tangage quand le joueur lève les
      // yeux, ce qui trahit immédiatement la surface plate - un nuage ne se
      // penche pas vers vous.
      const head = opts.head();
      for (const mesh of billboards) {
        mesh.getWorldPosition(here);
        aim.set(head.x, here.y, head.z);
        mesh.lookAt(aim);
      }
```

`here` et `aim` sont deux `THREE.Vector3` alloués une fois au niveau du module de fabrique — cette boucle tourne à la fréquence du casque, et une pause de ramasse-miettes s'entend comme un accroc audio (`scene.ts` le dit déjà pour son raycaster).

- [ ] **Step 5: Passer la tête au décor**

Dans `VrShell.svelte`, `createDecor` gagne un argument :

```ts
    decor = createDecor({
      floorHeight: height,
      maxAnisotropy: scene.maxAnisotropy(),
      head: () => scene!.headPosition()
    });
```

- [ ] **Step 6: Vérifier**

```bash
cd frontend && npx svelte-check --threshold error 2>&1 | tail -5
cd .. && bun run test:ui 2>&1 | tail -5
cd frontend && npx vite build 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/vr/decor/build.ts frontend/src/lib/vr/scene.ts \
        frontend/src/lib/components/VrShell.svelte
git commit -m "$(cat <<'EOF'
Dresser le relief autour du joueur

Un atlas, un matériau, un quad par élément. La taille de chaque quad vient du
dessin et non du placement : diviser par seize est le seul endroit où la
densité de pixels s'applique, ce qui la rend vraie partout.

Filtrage à l'opposé de celui du sol, et les deux ont raison : le sol est vu en
incidence rasante et grouille sans mipmaps, ces quads sont vus de face à leur
taille native et un mipmap n'y ajouterait que du flou. Or le flou est
exactement ce qu'on ne veut pas - des pixels nets et carrés sont le sujet.

alphaTest plutôt que transparent : les découpes sont franches, et le tri par
transparence coûterait un tri par image pour des artefacts d'ordre en prime.

Les billboards visent la tête à leur propre hauteur. Viser la tête elle-même
les ferait basculer quand le joueur lève les yeux, ce qui trahit la surface
plate : un nuage ne se penche pas vers vous.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Session casque — LE contrôle du pari**

C'est le moment décisif du projet. Une seule question, et elle se pose de loin :

> **Est-ce que ça a de la profondeur, ou est-ce que c'est un papier peint ?**

Bouger la tête latéralement de vingt centimètres. Les buissons doivent glisser devant les collines. Si l'effet n'y est pas, **ne pas passer au lot 3** : les causes plausibles, dans l'ordre, sont un écart d'anneaux trop faible (buissons et collines trop proches l'un de l'autre en profondeur), un décor globalement trop loin, ou un relief trop peu dense pour que l'œil ait des repères à comparer. Les trois se corrigent dans `placement.ts` et `composition.ts`, sans toucher au rendu.

---

# Lot 3 — Les objets proches

Tuyaux, blocs `?`, pièces, montés en **boîte pixel-art** : même dessin plat, assemblé, avec les côtés en teinte assombrie. C'est ce que la spec §6 appelle « posé plutôt que collé ».

---

### Task 15: La géométrie d'une boîte pixel-art

**Files:**
- Create: `frontend/src/lib/vr/decor/box.ts`
- Test: `core/test/vr-decor-box.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Uv` (Task 6).
- Produces:
  ```ts
  export interface BoxSpec { width: number; height: number; depth: number; front: Uv; side: Uv; top: Uv }
  export interface BoxMesh { positions: Float32Array; uvs: Float32Array; indices: Uint16Array }
  export function boxGeometry(spec: BoxSpec): BoxMesh
  ```

**Cinq faces, pas six.** Le dessous d'un tuyau posé au sol n'est jamais vu, et la face qu'on ne dessine pas est celle qui ne peut pas être fausse.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * La boîte qui donne du volume à un dessin plat.
 *
 * Pourquoi une géométrie à la main plutôt qu'une `BoxGeometry` de three : il
 * faut des uv DIFFÉRENTES par face - la façade porte le dessin, les côtés une
 * bande assombrie - et `BoxGeometry` en impose un jeu unique. C'est le même
 * raisonnement que `screen-geometry.ts`, qui génère son maillage pour la même
 * raison, et avec le même bénéfice : tout est une fonction pure.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { boxGeometry } from '../../frontend/src/lib/vr/decor/box.js';

const UV = { u0: 0, v0: 0, u1: 0.5, v1: 0.5 };
const SPEC = { width: 2, height: 1, depth: 0.5, front: UV, side: UV, top: UV };

test('cinq faces font vingt sommets et trente indices', () => {
  const box = boxGeometry(SPEC);
  assert.equal(box.positions.length, 20 * 3);
  assert.equal(box.uvs.length, 20 * 2);
  assert.equal(box.indices.length, 5 * 6);
});

test('aucun sommet ne sort de la boîte annoncée', () => {
  const box = boxGeometry(SPEC);
  for (let i = 0; i < box.positions.length; i += 3) {
    assert.ok(Math.abs(box.positions[i]) <= SPEC.width / 2 + 1e-9, 'x déborde');
    assert.ok(Math.abs(box.positions[i + 1]) <= SPEC.height / 2 + 1e-9, 'y déborde');
    assert.ok(Math.abs(box.positions[i + 2]) <= SPEC.depth / 2 + 1e-9, 'z déborde');
  }
});

test('la boîte est centrée : chaque extrémité est atteinte', () => {
  const box = boxGeometry(SPEC);
  const xs: number[] = [];
  for (let i = 0; i < box.positions.length; i += 3) xs.push(box.positions[i]);
  assert.equal(Math.min(...xs), -SPEC.width / 2);
  assert.equal(Math.max(...xs), SPEC.width / 2);
});

test('il n_y a pas de face dessous', () => {
  // Toutes les faces horizontales sont en HAUT. Une face du dessous serait
  // invisible depuis le sol et doublerait la surface à remplir pour rien.
  const box = boxGeometry(SPEC);
  const bottoms: number[] = [];
  for (let i = 0; i < box.positions.length; i += 3) {
    if (box.positions[i + 1] === -SPEC.height / 2) bottoms.push(i);
  }
  // Les quatre faces verticales touchent le bas, mais aucune n'y est plane :
  // huit sommets au total, pas douze.
  assert.equal(bottoms.length, 8);
});

test('la façade porte les uv de la façade', () => {
  const front = { u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4 };
  const box = boxGeometry({ ...SPEC, front });
  // La façade est la première face émise : ses quatre sommets ouvrent le
  // tableau des uv.
  assert.deepEqual([...box.uvs.slice(0, 8)], [
    front.u0, front.v1, front.u1, front.v1, front.u0, front.v0, front.u1, front.v0
  ]);
});

test('une dimension nulle est refusée', () => {
  assert.throws(() => boxGeometry({ ...SPEC, depth: 0 }), /profondeur/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/test/vr-decor-box.test.ts` → module introuvable.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Une boîte à cinq faces, pour donner du volume à un dessin plat.
 *
 * Pourquoi pas `THREE.BoxGeometry` : il faut des uv différentes par face - la
 * façade porte le motif, les côtés une bande assombrie - et `BoxGeometry` n'en
 * propose qu'un jeu. `screen-geometry.ts` génère son maillage pour la même
 * raison, et avec le même bénéfice : tout ceci est une fonction pure, donc
 * vérifiable sans GPU.
 *
 * Cinq faces. Le dessous d'un objet posé au sol n'est jamais vu, et la face
 * qu'on ne dessine pas ne peut pas être fausse.
 *
 * L'enroulement est anti-horaire vu de l'extérieur, ce qui est la convention
 * de three pour une face avant. L'inverser rend l'objet invisible plutôt que
 * mal dessiné - le pire des deux, parce que ça ressemble à un objet qui n'a
 * pas été ajouté.
 */
import type { Uv } from './atlas';

export interface BoxSpec {
  width: number;
  height: number;
  depth: number;
  /** La face tournée vers -Z : celle que le joueur voit. */
  front: Uv;
  /** Les deux flancs, et l'arrière. */
  side: Uv;
  top: Uv;
}

export interface BoxMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

export function boxGeometry(spec: BoxSpec): BoxMesh {
  if (spec.width <= 0) throw new Error(`largeur invalide : ${spec.width}`);
  if (spec.height <= 0) throw new Error(`hauteur invalide : ${spec.height}`);
  if (spec.depth <= 0) throw new Error(`profondeur invalide : ${spec.depth}`);

  const x = spec.width / 2;
  const y = spec.height / 2;
  const z = spec.depth / 2;

  // Chaque face : ses quatre coins dans l'ordre haut-gauche, haut-droit,
  // bas-gauche, bas-droit, vue depuis l'extérieur.
  const faces: { corners: number[][]; uv: Uv }[] = [
    // Façade (-Z)
    { corners: [[-x, y, -z], [x, y, -z], [-x, -y, -z], [x, -y, -z]], uv: spec.front },
    // Arrière (+Z)
    { corners: [[x, y, z], [-x, y, z], [x, -y, z], [-x, -y, z]], uv: spec.side },
    // Flanc gauche (-X)
    { corners: [[-x, y, z], [-x, y, -z], [-x, -y, z], [-x, -y, -z]], uv: spec.side },
    // Flanc droit (+X)
    { corners: [[x, y, -z], [x, y, z], [x, -y, -z], [x, -y, z]], uv: spec.side },
    // Dessus (+Y)
    { corners: [[-x, y, z], [x, y, z], [-x, y, -z], [x, y, -z]], uv: spec.top }
  ];

  const positions = new Float32Array(faces.length * 4 * 3);
  const uvs = new Float32Array(faces.length * 4 * 2);
  const indices = new Uint16Array(faces.length * 6);

  faces.forEach((face, index) => {
    const base = index * 4;
    face.corners.forEach((corner, corner_index) => {
      positions.set(corner, (base + corner_index) * 3);
    });
    uvs.set(
      [face.uv.u0, face.uv.v1, face.uv.u1, face.uv.v1, face.uv.u0, face.uv.v0, face.uv.u1, face.uv.v0],
      base * 2
    );
    indices.set([base, base + 2, base + 1, base + 1, base + 2, base + 3], index * 6);
  });

  return { positions, uvs, indices };
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test core/test/vr-decor-box.test.ts`, 6 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/box.ts core/test/vr-decor-box.test.ts package.json
git commit -m "$(cat <<'EOF'
Donner du volume à un dessin plat, en cinq faces

Une BoxGeometry de three n'accepte qu'un jeu d'uv, or il en faut un par face :
la façade porte le motif, les flancs une bande assombrie. screen-geometry.ts
génère son maillage pour la même raison, et avec le même bénéfice - tout ceci
est une fonction pure, donc vérifiable sans GPU.

Cinq faces et pas six : le dessous d'un objet posé au sol n'est jamais vu, et
la face qu'on ne dessine pas ne peut pas être fausse.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Le tuyau, le bloc `?`, la pièce

**Files:**
- Modify: `frontend/src/lib/vr/decor/art/shapes.ts` (un générateur de plus)
- Create: `frontend/src/lib/vr/decor/art/props.ts`
- Modify: `frontend/src/lib/vr/decor/art/index.ts`
- Test: `core/test/vr-decor-shapes.test.ts` (existant)

**Interfaces:**
- Produces: `banded(width, height, bands): Art` ; `PIPE_SHAFT`, `PIPE_LIP`, `QUESTION_BLOCK`, `COIN_0..3`, et `SIDE_*` pour les flancs.

- [ ] **Step 1: Ajouter les tests de `banded` au fichier existant**

```ts
test('les bandes verticales couvrent toute la largeur sans trou', () => {
  const art = banded(8, 4, [
    { to: 1, colour: 'outline' },
    { to: 3, colour: 'pipeHi' },
    { to: 7, colour: 'pipe' },
    { to: 8, colour: 'outline' }
  ]);
  const raster = rasterise(art);
  assert.equal(raster.width, 8);
  assert.equal(raster.height, 4);
  // Aucun pixel transparent : une bande manquante laisserait un trou vertical
  // dans un tuyau, ce qui se voit mais seulement dans un casque.
  for (let i = 3; i < raster.data.length; i += 4) assert.equal(raster.data[i], 255);
});

test('des bandes qui ne finissent pas à la largeur sont refusées', () => {
  assert.throws(
    () => banded(8, 4, [{ to: 6, colour: 'pipe' }]),
    /couvre 6 colonnes sur 8/
  );
});

test('toutes les lignes d_une bande verticale sont identiques', () => {
  const art = banded(6, 3, [{ to: 6, colour: 'pipe' }]);
  assert.equal(new Set(art.rows).size, 1);
});
```

- [ ] **Step 2: Écrire `banded` dans `shapes.ts`**

```ts
/**
 * Un motif fait de bandes verticales : tout ce qui est un tube en pixel-art.
 *
 * Un tuyau de SMB est exactement ça - un liseré noir, deux colonnes claires
 * qui font la lumière, le corps, une colonne sombre, un liseré. Le décrire en
 * bandes plutôt qu'en grille littérale évite quarante lignes de caractères et
 * rend la vérification possible : `to` doit atteindre la largeur, sinon il
 * reste un trou vertical qu'on ne verrait que dans un casque.
 */
export interface Band {
  /** La colonne après la dernière de cette bande. Cumulatif. */
  readonly to: number;
  readonly colour: ColourName;
}

export function banded(width: number, height: number, bands: readonly Band[]): Art {
  if (width <= 0 || height <= 0) throw new Error(`taille invalide : ${width}x${height}`);
  const last = bands[bands.length - 1];
  if (!last || last.to !== width) {
    throw new Error(`les bandes couvrent ${last?.to ?? 0} colonnes sur ${width}`);
  }

  const palette: Record<string, ColourName> = {};
  let row = '';
  let from = 0;
  bands.forEach((band, index) => {
    const char = String.fromCharCode(97 + index); // a, b, c…
    palette[char] = band.colour;
    row += char.repeat(band.to - from);
    from = band.to;
  });

  return { palette, rows: Array.from({ length: height }, () => row) };
}
```

- [ ] **Step 3: Écrire `art/props.ts`**

```ts
/**
 * Les objets proches : ceux que la stéréo voit en volume.
 *
 * Les tailles se lisent en mètres, à seize pixels le mètre. Un tuyau fait deux
 * mètres de haut et un de large, comme dans le jeu.
 *
 * Chaque objet a un motif de FAÇADE et un motif de FLANC. Le flanc n'est pas
 * un dessin de plus : c'est le même tracé dans une palette assombrie, ce que
 * `banded` rend immédiat. C'est ce qui permet de monter ces objets en boîte
 * sans produire une seule image d'art supplémentaire.
 */
import { banded } from './shapes';
import type { Art } from '../pixels';

/** 1 m de large, 1,5 m de haut : le fût sous la lèvre. */
export const PIPE_SHAFT = banded(16, 24, [
  { to: 1, colour: 'outline' },
  { to: 4, colour: 'pipeHi' },
  { to: 13, colour: 'pipe' },
  { to: 15, colour: 'pipeSide' },
  { to: 16, colour: 'outline' }
]);

/** Les flancs du fût : même tracé, palette assombrie. */
export const PIPE_SHAFT_SIDE = banded(16, 24, [
  { to: 1, colour: 'outline' },
  { to: 4, colour: 'pipe' },
  { to: 15, colour: 'pipeSide' },
  { to: 16, colour: 'outline' }
]);

/** La lèvre : 1,25 m de large, 0,5 m de haut. */
export const PIPE_LIP = banded(20, 8, [
  { to: 1, colour: 'outline' },
  { to: 5, colour: 'pipeHi' },
  { to: 17, colour: 'pipe' },
  { to: 19, colour: 'pipeSide' },
  { to: 20, colour: 'outline' }
]);

export const PIPE_LIP_SIDE = banded(20, 8, [
  { to: 1, colour: 'outline' },
  { to: 5, colour: 'pipe' },
  { to: 19, colour: 'pipeSide' },
  { to: 20, colour: 'outline' }
]);

/**
 * Le bloc `?`, en grille littérale.
 *
 * Le seul motif de ce lot qui ne se génère pas : un glyphe n'est pas une
 * répétition, et le décrire en bandes serait plus long que le dessiner.
 */
export const QUESTION_BLOCK: Art = {
  palette: { k: 'outline', y: 'block', h: 'blockHi', d: 'brickDark' },
  rows: [
    'kkkkkkkkkkkkkkkk',
    'khhhhhhhhhhhhhhk',
    'khyyyyyyyyyyyyhk',
    'khyyyykkkkyyyyhk',
    'khyyykkhhkkyyyhk',
    'khyykkhyyhkkyyhk',
    'khyykkyykkkkyyhk',
    'khyyyyyykkyyyyhk',
    'khyyyyykkyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khyyyyyyyyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khyyyykkyyyyyyhk',
    'khhhhhhhhhhhhhhk',
    'kkkkkkkkkkkkkkkk'
  ]
};

/** Le flanc d'un bloc : uni, contour compris. */
export const BLOCK_SIDE = banded(16, 16, [
  { to: 1, colour: 'outline' },
  { to: 15, colour: 'brickDark' },
  { to: 16, colour: 'outline' }
]);
```

> `brickDark` n'existe pas encore dans `palette.ts` : l'ajouter (`'#8a5000'`), le test de forme de la Task 1 le couvre automatiquement.

- [ ] **Step 4: Inscrire au registre, lancer les tests, regarder la planche**

Ajouter les six motifs à `ALL_ART`. Puis :

```bash
bun test core/test/vr-decor-shapes.test.ts core/test/vr-decor-art.test.ts core/test/vr-decor-atlas.test.ts
```
Expected: PASS partout. Reconstruire `sheet.png` et vérifier que le `?` est lisible et centré, que les tuyaux ont leur reflet à gauche, et que les flancs sont bien plus sombres que les façades.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/decor/art frontend/src/lib/vr/decor/palette.ts core/test/vr-decor-shapes.test.ts
git commit -m "$(cat <<'EOF'
Dessiner les tuyaux, le bloc ? et leurs flancs

Un tuyau de SMB est une suite de bandes verticales : un liseré, deux colonnes
claires qui font la lumière, le corps, une colonne sombre, un liseré. Le
décrire ainsi évite quarante lignes de grille et rend la vérification possible
- les bandes doivent atteindre la largeur, sinon il reste un trou vertical
qu'on ne verrait que dans un casque.

Les flancs ne sont pas des dessins de plus : c'est le même tracé dans une
palette assombrie. C'est ce qui permettra de monter ces objets en boîte sans
produire une seule image d'art supplémentaire.

Le bloc ? reste une grille littérale : un glyphe n'est pas une répétition, et
le décrire en bandes serait plus long que le dessiner.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Poser et dresser les objets proches

**Files:**
- Modify: `frontend/src/lib/vr/decor/placement.ts` (une liste de plus)
- Modify: `frontend/src/lib/vr/decor/build.ts` (les boîtes)
- Test: `core/test/vr-decor-placement.test.ts` (existant)

**Interfaces:**
- Produces: `props(): readonly BoxProp[]` avec
  ```ts
  export interface BoxProp {
    readonly front: string; readonly side: string; readonly top: string;
    readonly azimuth: number; readonly radius: number;
    readonly standing: number; readonly depth: number;
  }
  ```

- [ ] **Step 1: Tests à ajouter au fichier de placement**

```ts
test('aucun objet proche ne vient devant le rideau', () => {
  for (const prop of props()) {
    assert.ok(prop.radius >= DECOR_NEAR, `${prop.front} à ${prop.radius} m`);
  }
});

test('tout objet proche désigne trois motifs qui existent', () => {
  for (const prop of props()) {
    for (const art of [prop.front, prop.side, prop.top]) {
      assert.ok(ALL_ART[art], `motif inconnu : ${art}`);
    }
  }
});

test('les objets proches restent dans la zone où la stéréo voit le volume', () => {
  // La spec §6 : la boîte se justifie sous douze mètres. Plus loin, elle coûte
  // quatre faces pour un volume que personne ne perçoit, et il faut repasser
  // en quad plat.
  for (const prop of props()) {
    assert.ok(prop.radius <= 12, `${prop.front} à ${prop.radius} m ne mérite plus une boîte`);
  }
});

test('un objet proche a une profondeur réelle', () => {
  for (const prop of props()) assert.ok(prop.depth > 0.1, `${prop.front} est plat`);
});
```

- [ ] **Step 2: Ajouter `props()` à `placement.ts`**

```ts
/**
 * Les objets qu'on voit en volume, montés en boîte.
 *
 * Le rayon est borné à douze mètres et le test le tient : au-delà, la stéréo
 * ne perçoit plus l'épaisseur, et la boîte coûterait quatre faces pour rien.
 * C'est la règle de la spec §6, et elle a une conséquence pratique - déplacer
 * un tuyau plus loin ne se fait pas en changeant un nombre ici, mais en le
 * repassant en quad plat.
 */
export interface BoxProp {
  readonly front: string;
  readonly side: string;
  readonly top: string;
  readonly azimuth: number;
  readonly radius: number;
  readonly standing: number;
  /** Mètres. Un tuyau est aussi profond que large. */
  readonly depth: number;
}

export function props(): readonly BoxProp[] {
  return [
    // Un tuyau complet : le fût, puis la lèvre posée dessus.
    { front: 'pipeShaft', side: 'pipeShaftSide', top: 'pipeShaftSide',
      azimuth: at(1.1), radius: RINGS.pipes, standing: 0, depth: 1 },
    { front: 'pipeLip', side: 'pipeLipSide', top: 'pipeLipSide',
      azimuth: at(1.1), radius: RINGS.pipes, standing: 1.5, depth: 1.25 },

    { front: 'pipeShaft', side: 'pipeShaftSide', top: 'pipeShaftSide',
      azimuth: at(7.4), radius: RINGS.pipes, standing: 0, depth: 1 },
    { front: 'pipeLip', side: 'pipeLipSide', top: 'pipeLipSide',
      azimuth: at(7.4), radius: RINGS.pipes, standing: 1.5, depth: 1.25 },

    // La rangée de blocs `?`, à hauteur de frappe : 1,2 m au-dessus de l'œil,
    // donc `standing` vaut la hauteur du sol plus 1,2 - mais le sol n'est pas
    // connu ici, et c'est voulu. `build.ts` ajoute -floorHeight ; ce qui suit
    // est donc la hauteur AU-DESSUS DU SOL, comme pour tout le reste.
    { front: 'questionBlock', side: 'blockSide', top: 'blockSide',
      azimuth: at(11.6), radius: RINGS.props, standing: 2.4, depth: 1 },
    { front: 'questionBlock', side: 'blockSide', top: 'blockSide',
      azimuth: at(0), radius: RINGS.props, standing: 2.4, depth: 1 },
    { front: 'questionBlock', side: 'blockSide', top: 'blockSide',
      azimuth: at(0.4), radius: RINGS.props, standing: 2.4, depth: 1 }
  ];
}
```

- [ ] **Step 3: Les boîtes dans `build.ts`**

Une fabrique jumelle de `quadFor`, qui fait la même arithmétique de position mais produit une `BufferGeometry` à partir de `boxGeometry` :

```ts
function boxFor(
  prop: BoxProp,
  atlas: Atlas,
  material: THREE.Material,
  floorHeight: number
): THREE.Mesh {
  const raster = rasterise(ALL_ART[prop.front]);
  const width = raster.width / ART_PIXELS_PER_METRE;
  const height = raster.height / ART_PIXELS_PER_METRE;

  const data = boxGeometry({
    width,
    height,
    depth: prop.depth,
    front: uvOf(atlas, prop.front),
    side: uvOf(atlas, prop.side),
    top: uvOf(atlas, prop.top)
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(
    prop.radius * Math.sin(prop.azimuth),
    -floorHeight + prop.standing + height / 2,
    -prop.radius * Math.cos(prop.azimuth)
  );
  mesh.rotation.y = -prop.azimuth;
  return mesh;
}
```

> Pas de `computeVertexNormals()` : rien n'est éclairé dans cette scène, donc les normales ne serviraient qu'à occuper de la mémoire. `scene.ts` dit pourquoi il n'y a pas de lumière.

- [ ] **Step 4: Vérifier**

```bash
bun run test:ui 2>&1 | tail -5
cd frontend && npx svelte-check --threshold error 2>&1 | tail -5 && npx vite build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/decor core/test/vr-decor-placement.test.ts
git commit -m "$(cat <<'EOF'
Monter les tuyaux et les blocs en boîtes, pour que la stéréo les trouve posés

Même dessin, assemblé : façade, deux flancs assombris, dessus. Aucune image
d'art de plus - les flancs sont le même tracé dans une palette sombre.

Le rayon est borné à douze mètres et le test le tient. Au-delà, la stéréo ne
perçoit plus l'épaisseur et la boîte coûterait quatre faces pour rien.
Déplacer un tuyau plus loin ne se fait donc pas en changeant un nombre : il
faut le repasser en quad plat.

Aucune normale calculée : rien n'est éclairé dans cette scène.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Session casque — le contrôle du lot 3**

Deux questions : **les objets à sept-neuf mètres ont-ils de l'épaisseur**, ou restent-ils des découpes ? Et **les gros pixels tiennent-ils d'aussi près**, ou deviennent-ils une bouillie ? Si le second échoue, le levier n'est pas le filtrage — c'est `ART_PIXELS_PER_METRE`, et le changer redessine tout le monde d'un coup.

---

# Lot 4 — La vie

Le seul lot qui peut donner la nausée. Ses trois règles de confort sont des **contraintes de design**, pas des réglages : rien ne traverse le champ central, aucun mouvement de grande surface, rien au-dessus de 3 Hz.

---

### Task 18: Le mouvement, en fonctions pures

**Files:**
- Create: `frontend/src/lib/vr/decor/motion.ts`
- Test: `core/test/vr-decor-motion.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces (tous les `t` en **secondes**) :
  ```ts
  export function spriteFrame(t: number, o: { frames: number; hz: number }): number
  export function patrol(t: number, o: { from: number; to: number; speed: number }): { at: number; facing: 1 | -1 }
  export function drift(t: number, o: { start: number; speed: number; wrap: number }): number
  export function piranha(t: number, o: { period: number; outFor: number; travel: number; rise: number }): number
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Le mouvement du décor, sans état ni horloge.
 *
 * Chaque fonction est `t -> position`. Pas d'incrément par image : le temps
 * vient du runtime XR, et un compteur interne dériverait de lui à la première
 * image sautée - or un goomba qui dérive finit par sortir de sa plate-forme.
 *
 * Les tests portent sur les BORNES plutôt que sur des valeurs choisies. Une
 * valeur exacte à un instant donné ne dit rien d'utile ; « ne sort jamais de
 * son segment, quel que soit t » est la propriété qui compte.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spriteFrame, patrol, drift, piranha } from '../../frontend/src/lib/vr/decor/motion.js';

test('la cadence d_image est celle demandée, pas celle du casque', () => {
  const o = { frames: 2, hz: 8 };
  assert.equal(spriteFrame(0, o), 0);
  assert.equal(spriteFrame(0.124, o), 0);
  assert.equal(spriteFrame(0.125, o), 1);
  assert.equal(spriteFrame(0.25, o), 0);
});

test('l_index d_image reste dans la plage pour tout t', () => {
  const o = { frames: 3, hz: 8 };
  for (const t of [-5, 0, 0.001, 7.3, 1e6]) {
    const frame = spriteFrame(t, o);
    assert.ok(Number.isInteger(frame), `${t} donne ${frame}`);
    assert.ok(frame >= 0 && frame < 3, `${t} donne ${frame}`);
  }
});

test('un goomba ne sort jamais de son segment', () => {
  const o = { from: -3, to: 3, speed: 1 };
  for (let t = 0; t < 60; t += 0.037) {
    const { at } = patrol(t, o);
    assert.ok(at >= o.from - 1e-9 && at <= o.to + 1e-9, `t=${t} donne ${at}`);
  }
});

test('un goomba part de sa borne basse et fait demi-tour à l_autre', () => {
  const o = { from: -3, to: 3, speed: 1 };
  assert.ok(Math.abs(patrol(0, o).at - -3) < 1e-9);
  assert.equal(patrol(0.5, o).facing, 1);
  // Six mètres à un mètre par seconde : le demi-tour est à six secondes.
  assert.ok(Math.abs(patrol(6, o).at - 3) < 1e-9);
  assert.equal(patrol(6.5, o).facing, -1);
  assert.ok(Math.abs(patrol(12, o).at - -3) < 1e-9);
});

test('un nuage revient au début au lieu de partir à l_infini', () => {
  const o = { start: 0, speed: 0.05, wrap: 10 };
  for (let t = 0; t < 1000; t += 7) {
    const at = drift(t, o);
    assert.ok(at >= 0 && at < o.wrap, `t=${t} donne ${at}`);
  }
});

test('la plante reste rentrée la plus grande partie du temps', () => {
  const o = { period: 6, outFor: 2.4, travel: 1.2, rise: 0.4 };
  assert.equal(piranha(0, o), 0);
  assert.equal(piranha(3, o), 0);
  assert.equal(piranha(5.9, o), 0);
  // Sortie complète au milieu de sa fenêtre.
  assert.ok(Math.abs(piranha(1.2, o) - 1.2) < 1e-9);
});

test('la plante ne dépasse jamais sa course', () => {
  const o = { period: 6, outFor: 2.4, travel: 1.2, rise: 0.4 };
  for (let t = 0; t < 60; t += 0.017) {
    const at = piranha(t, o);
    assert.ok(at >= 0 && at <= o.travel + 1e-9, `t=${t} donne ${at}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test core/test/vr-decor-motion.test.ts`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Le mouvement du décor : `t` en secondes, et rien d'autre.
 *
 * Aucune de ces fonctions ne garde d'état. Le temps vient du runtime XR, et un
 * compteur incrémenté par image dériverait de lui dès la première image
 * sautée - un goomba qui dérive finit par sortir de sa plate-forme, une plante
 * par rester dehors. Ici, une image en retard rattrape toute seule.
 *
 * Les trois règles de confort de la spec vivent dans les APPELANTS - les
 * vitesses et les rayons - pas ici. Ce module ne sait pas ce qu'est un degré
 * par seconde ; il sait faire un triangle et un modulo.
 */

/** L'image courante d'une boucle, à la cadence demandée. */
export function spriteFrame(t: number, o: { frames: number; hz: number }): number {
  const ticks = Math.floor(Math.max(0, t) * o.hz);
  return ticks % o.frames;
}

/**
 * Un va-et-vient entre deux bornes : une onde triangulaire.
 *
 * Part de `from`, ce qui n'est pas indifférent - `patrol(0)` doit être le
 * point où l'objet a été POSÉ dans `placement.ts`, sinon tout saute à la
 * première image.
 */
export function patrol(
  t: number,
  o: { from: number; to: number; speed: number }
): { at: number; facing: 1 | -1 } {
  const span = o.to - o.from;
  const period = (2 * span) / o.speed;
  const phase = ((t % period) + period) % period;
  const travelled = phase * o.speed;
  return travelled <= span
    ? { at: o.from + travelled, facing: 1 }
    : { at: o.to - (travelled - span), facing: -1 };
}

/** Une dérive qui repasse par zéro plutôt que de s'éloigner sans fin. */
export function drift(t: number, o: { start: number; speed: number; wrap: number }): number {
  const at = o.start + t * o.speed;
  return ((at % o.wrap) + o.wrap) % o.wrap;
}

/**
 * La plante carnivore : dehors un moment, rentrée le reste du temps.
 *
 * Rendue en hauteur au-dessus de sa position rentrée, donc zéro veut dire
 * « invisible dans le tuyau ». La montée et la descente prennent `rise`
 * chacune, ce qui évite l'apparition instantanée - le seul mouvement de ce
 * décor qui serait brusque.
 */
export function piranha(
  t: number,
  o: { period: number; outFor: number; travel: number; rise: number }
): number {
  const phase = ((t % o.period) + o.period) % o.period;
  if (phase >= o.outFor) return 0;
  if (phase < o.rise) return (phase / o.rise) * o.travel;
  const falling = o.outFor - o.rise;
  if (phase > falling) return ((o.outFor - phase) / o.rise) * o.travel;
  return o.travel;
}
```

- [ ] **Step 4: Run test to verify it passes** — 7 tests.

- [ ] **Step 5: Ajouter à `test:ui` et vérifier le total**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor/motion.ts core/test/vr-decor-motion.test.ts package.json
git commit -m "$(cat <<'EOF'
Faire bouger le décor sans garder d'état

Chaque fonction est t -> position. Un compteur incrémenté par image dériverait
du runtime XR dès la première image sautée, et un goomba qui dérive finit par
sortir de sa plate-forme. Ici une image en retard rattrape toute seule.

Les tests portent sur les bornes plutôt que sur des valeurs choisies : une
valeur exacte à un instant donné ne dit rien, alors que « ne sort jamais de
son segment, quel que soit t » est la propriété qui compte.

patrol part de sa borne basse, ce qui n'est pas indifférent : patrol(0) doit
être le point où l'objet a été posé, sinon tout saute à la première image.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Les créatures, et le bloc `?` qui pulse sans nouveau dessin

**Files:**
- Modify: `frontend/src/lib/vr/decor/art/shapes.ts` (`recolour`)
- Create: `frontend/src/lib/vr/decor/art/creatures.ts`
- Modify: `frontend/src/lib/vr/decor/art/props.ts`, `art/index.ts`, `palette.ts`
- Test: `core/test/vr-decor-shapes.test.ts` (existant)

- [ ] **Step 1: Tests de `recolour`, à ajouter**

```ts
test('recolorer ne touche pas au dessin, seulement à la palette', () => {
  const source = { palette: { a: 'block', b: 'outline' }, rows: ['ab', 'ba'] } as const;
  const variant = recolour(source, { block: 'blockHi' });
  assert.deepEqual(variant.rows, source.rows);
  assert.equal(variant.palette.a, 'blockHi');
  assert.equal(variant.palette.b, 'outline');
});

test('recolorer ne modifie pas la source', () => {
  const source = { palette: { a: 'block' }, rows: ['a'] } as const;
  recolour(source, { block: 'blockHi' });
  assert.equal(source.palette.a, 'block');
});
```

- [ ] **Step 2: Écrire `recolour`**

```ts
/**
 * Le même dessin, dans d'autres couleurs.
 *
 * C'est ce qui rend le pulsement du bloc `?` GRATUIT en travail de dessin : la
 * NES animait ce bloc en changeant sa palette, pas sa forme, et on fait
 * exactement pareil. Trois variantes du même motif entrent dans l'atlas, et
 * l'animation ne fait que passer de l'une à l'autre - ce qui, avec un atlas,
 * ne coûte que deux UV.
 *
 * Une copie, jamais une mutation : les variantes coexistent dans le registre
 * avec leur source.
 */
export function recolour(
  art: Art,
  swap: Partial<Record<ColourName, ColourName>>
): Art {
  const palette: Record<string, ColourName> = {};
  for (const [char, name] of Object.entries(art.palette)) {
    palette[char] = swap[name] ?? name;
  }
  return { palette, rows: [...art.rows] };
}
```

- [ ] **Step 3: Les trois variantes du bloc, dans `props.ts`**

```ts
/**
 * Les trois temps du pulsement, sans un pixel de plus.
 *
 * Le corps passe du jaune au clair et revient. Exactement le cyclage de
 * palette de l'original, et le poste d'animation le moins cher du lot : zéro
 * image d'art produite.
 */
export const QUESTION_BLOCK_1 = recolour(QUESTION_BLOCK, { block: 'blockHi', blockHi: 'block' });
export const QUESTION_BLOCK_2 = recolour(QUESTION_BLOCK, { block: 'brickDark' });
```

- [ ] **Step 4: `art/creatures.ts`**

```ts
/**
 * Ce qui bouge : le goomba et la plante carnivore.
 *
 * Les deux restent des BILLBOARDS, jamais des boîtes. La spec §6 le dit : un
 * sprite de jeu 2D n'a jamais eu de dos, et lui en donner un serait le seul
 * endroit où l'on trahirait vraiment le registre. Un tuyau en volume reste un
 * tuyau ; un goomba en volume n'est plus un goomba.
 *
 * Deux images chacun, à huit par seconde.
 */
import { banded } from './shapes';
import type { Art } from '../pixels';

const GOOMBA_PALETTE = { k: 'outline', g: 'goomba', f: 'goombaFoot', w: 'cloud' } as const;

/** Pieds écartés. 1 m de large, 0,875 m de haut. */
export const GOOMBA_A: Art = {
  palette: GOOMBA_PALETTE,
  rows: [
    '.....kkkkkk.....',
    '...kkggggggkk...',
    '..kgggggggggak..'.replace('a', 'g'),
    '.kggggggggggggk.',
    'kggwwkggggkwwggk',
    'kggwkkggggkkwggk',
    'kgggkkggggkkgggk',
    'kgggggggggggggggk'.slice(0, 16),
    'kgggggggggggggk.'.slice(0, 16),
    '.kggggggggggggk.',
    '..kffffffffffk..',
    '.kfffkkkkkkfffk.',
    'kfffk......kfffk',
    'kkkk........kkkk'
  ]
};

/** Pieds serrés : la deuxième image de la marche. */
export const GOOMBA_B: Art = {
  palette: GOOMBA_PALETTE,
  rows: [
    '.....kkkkkk.....',
    '...kkggggggkk...',
    '..kggggggggggk..',
    '.kggggggggggggk.',
    'kggwwkggggkwwggk',
    'kggwkkggggkkwggk',
    'kgggkkggggkkgggk',
    'kggggggggggggggk'.slice(0, 16),
    'kggggggggggggggk'.slice(0, 16),
    '.kggggggggggggk.',
    '..kffffffffffk..',
    '..kfffffffffffk.'.slice(0, 16),
    '..kkffffffffkk..',
    '....kkkkkkkk....'
  ]
};

/** Le pied de la plante : une tige verte qui monte du tuyau. */
export const PIRANHA_STEM = banded(8, 16, [
  { to: 1, colour: 'outline' },
  { to: 3, colour: 'pipeHi' },
  { to: 7, colour: 'pipe' },
  { to: 8, colour: 'outline' }
]);

const PIRANHA_PALETTE = { k: 'outline', r: 'brick', w: 'cloud', d: 'brickDark' } as const;

/** Gueule fermée. */
export const PIRANHA_CLOSED: Art = {
  palette: PIRANHA_PALETTE,
  rows: [
    '...kkkkkkkkkk...',
    '..krrrrrrrrrrk..',
    '.krrwwrrrrwwrrk.',
    'krrrwwrrrrwwrrrk',
    'krrrrrrrrrrrrrrk',
    'krrrkkkkkkkkrrrk',
    'krrrrrrrrrrrrrrk',
    'krrrrrrrrrrrrrrk',
    '.krrrrrrrrrrrrk.',
    '..kkdddddddkk...'.slice(0, 16)
  ]
};

/** Gueule ouverte. */
export const PIRANHA_OPEN: Art = {
  palette: PIRANHA_PALETTE,
  rows: [
    '...kkkkkkkkkk...',
    '..krrrrrrrrrrk..',
    '.krrwwrrrrwwrrk.',
    'krrrwwrrrrwwrrrk',
    'krrrrrrrrrrrrrrk',
    'kkkkkkkkkkkkkkkk',
    'kwwwwwwwwwwwwwwk',
    'kkkkkkkkkkkkkkkk',
    '.krrrrrrrrrrrrk.',
    '..kkdddddddkk...'.slice(0, 16)
  ]
};
```

> **Attention en tapant ces grilles :** les invariants de la Task 3 exigent des lignes **de longueur égale**. Les `.slice(0, 16)` ci-dessus sont là pour rendre l'intention explicite là où une ligne risquait de déborder — les remplacer par des littéraux de seize caractères une fois vérifiés, et laisser le test trancher. C'est exactement le genre d'erreur que ce test existe pour attraper : `bun test core/test/vr-decor-art.test.ts` nomme la ligne fautive.

- [ ] **Step 5: Inscrire au registre, lancer les tests, regarder la planche**

Reconstruire `sheet.png`. Vérifier : les deux goombas diffèrent **seulement** par les pieds, les yeux sont au même endroit sur les deux (un œil qui saute d'un pixel se voit comme un tremblement), et la gueule ouverte de la plante est franchement ouverte.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/vr/decor core/test/vr-decor-shapes.test.ts
git commit -m "$(cat <<'EOF'
Dessiner le goomba et la plante, et faire pulser le bloc sans rien dessiner

Huit images d'art pour tout le mouvement du monde, et le bloc ? n'en coûte
aucune : la NES l'animait en changeant sa palette, pas sa forme. recolour fait
exactement ça, et avec un atlas l'animation ne coûte que deux UV.

Les deux créatures restent des billboards. Un tuyau en volume reste un tuyau ;
un goomba en volume n'est plus un goomba, et ce serait le seul endroit où l'on
trahirait vraiment le registre.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Animer

**Files:**
- Modify: `frontend/src/lib/vr/decor/placement.ts` (`creatures()`)
- Modify: `frontend/src/lib/vr/decor/build.ts`
- Test: `core/test/vr-decor-placement.test.ts` (existant)

**Interfaces:**
- Produces:
  ```ts
  export interface Creature {
    readonly frames: readonly string[];   // les motifs de la boucle
    readonly hz: number;
    readonly azimuth: number; readonly radius: number; readonly standing: number;
    readonly motion: { kind: 'patrol'; span: number; speed: number }
                   | { kind: 'piranha'; period: number; outFor: number; travel: number }
                   | { kind: 'still' };
  }
  export function creatures(): readonly Creature[]
  ```

- [ ] **Step 1: Tests à ajouter — les trois règles de confort**

```ts
test('rien ne bouge assez vite pour donner la nausée', () => {
  // La règle de la spec §7 : moins de sept degrés par seconde. C'est le
  // mouvement rapide près du centre du champ qui rend malade, et c'est une
  // contrainte de COMPOSITION - elle se viole en rapprochant un goomba, pas
  // en le rendant plus rapide.
  for (const creature of creatures()) {
    if (creature.motion.kind !== 'patrol') continue;
    const degreesPerSecond = (creature.motion.speed / creature.radius) * (180 / Math.PI);
    assert.ok(degreesPerSecond < 7, `${creature.frames[0]} file à ${degreesPerSecond} deg/s`);
  }
});

test('rien ne clignote au-dessus de trois hertz', () => {
  for (const creature of creatures()) {
    assert.ok(creature.hz <= 8, `${creature.frames[0]} à ${creature.hz} Hz`);
    // Une boucle de deux images à 8 Hz fait quatre alternances par seconde sur
    // un sprite de la taille d'un genou : ce n'est pas un clignotement de
    // grande surface, et c'est la cadence de l'original.
    if (creature.frames.length === 1) assert.ok(creature.hz <= 3, 'un aplat qui clignote');
  }
});

test('toute créature désigne des motifs qui existent, et au moins un', () => {
  for (const creature of creatures()) {
    assert.ok(creature.frames.length >= 1);
    for (const art of creature.frames) assert.ok(ALL_ART[art], `motif inconnu : ${art}`);
  }
});

test('aucune créature ne vient devant le rideau', () => {
  for (const creature of creatures()) {
    assert.ok(creature.radius >= DECOR_NEAR, `${creature.frames[0]} à ${creature.radius} m`);
  }
});
```

- [ ] **Step 2: `creatures()` dans `placement.ts`**

```ts
/**
 * Ce qui bouge, et à quelle distance.
 *
 * Le rayon n'est pas un choix esthétique ici : c'est lui qui tient la première
 * règle de confort. Un goomba à un mètre par seconde couvre 4,8 degrés par
 * seconde à douze mètres, et le double à six. Rapprocher une créature est donc
 * la façon dont cette règle se viole - pas l'accélérer - et le test mesure
 * bien le rapport des deux.
 */
export function creatures(): readonly Creature[] {
  return [
    { frames: ['goombaA', 'goombaB'], hz: 8, azimuth: at(2.6), radius: RINGS.creatures,
      standing: 0, motion: { kind: 'patrol', span: 3, speed: 0.9 } },
    { frames: ['goombaA', 'goombaB'], hz: 8, azimuth: at(8.9), radius: RINGS.creatures,
      standing: 0, motion: { kind: 'patrol', span: 3, speed: 0.9 } },
    // La plante sort du tuyau posé au même azimut par `props()`.
    { frames: ['piranhaClosed', 'piranhaOpen'], hz: 4, azimuth: at(1.1), radius: RINGS.pipes,
      standing: 1.4, motion: { kind: 'piranha', period: 6, outFor: 2.4, travel: 1.1 } },
    // Les blocs qui pulsent : immobiles, mais leur palette tourne.
    { frames: ['questionBlock', 'questionBlock1', 'questionBlock2'], hz: 3,
      azimuth: at(0), radius: RINGS.props, standing: 2.4, motion: { kind: 'still' } }
  ];
}
```

- [ ] **Step 3: L'animation dans `build.ts`**

Chaque créature est un quad construit comme au lot 2, plus **un jeu d'UV par image**, gardé à la construction :

```ts
  // Les uv de chaque image, calculées une fois. Animer ne fait ensuite que
  // réécrire huit flottants - aucun canvas redessiné, aucune texture
  // téléversée. C'est ce que l'atlas achète.
  const frames = creature.frames.map((name) => uvOf(atlas, name));
```

Puis dans `update`, pour chaque créature :

```ts
      const index = spriteFrame(seconds, { frames: frames.length, hz: creature.hz });
      if (index !== shown) {
        shown = index;
        const uv = frames[index];
        attribute.set([uv.u0, uv.v1, uv.u1, uv.v1, uv.u0, uv.v0, uv.u1, uv.v0]);
        attribute.needsUpdate = true;
      }
```

> Le `if (index !== shown)` n'est pas une micro-optimisation : sans lui, `needsUpdate` est vrai à chaque image et three ré-envoie le tampon d'uv soixante-douze fois par seconde pour des valeurs identiques.

Le déplacement, selon `motion.kind` : `patrol` écrit `mesh.position.x` **le long de la tangente** de l'anneau (donc dans le repère tourné du quad, un décalage sur X local) ; `piranha` écrit `mesh.position.y` ; `still` ne fait rien. Et comme ces deux-là sont des billboards, ils passent aussi par la boucle d'orientation de la Task 14.

- [ ] **Step 4: Vérifier**

```bash
bun run test:ui 2>&1 | tail -5
cd frontend && npx svelte-check --threshold error 2>&1 | tail -5 && npx vite build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/vr/decor core/test/vr-decor-placement.test.ts
git commit -m "$(cat <<'EOF'
Animer le décor pour huit flottants par changement d'image

Aucun canvas redessiné, aucune texture téléversée : changer d'image réécrit
les uv d'un quad. C'est ce que l'atlas achète, et c'est une autre catégorie de
dépense que les panneaux, dont panel-mesh.ts dit qu'une re-rasterisation à
72 Hz coûterait plus que l'émulateur.

La garde sur l'index n'est pas une micro-optimisation : sans elle, three
ré-envoie le tampon d'uv soixante-douze fois par seconde pour des valeurs
identiques.

Le test de confort mesure le rapport vitesse/rayon et non la vitesse seule :
la règle des sept degrés par seconde se viole en rapprochant un goomba, pas en
l'accélérant.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Session casque — le contrôle du lot 4, et du projet**

**La seule question qui compte ici est le confort**, et elle demande une session plus longue que les précédentes — dix minutes dans le lobby, pas trente secondes. Chercher : un inconfort qui monte lentement, le regard attiré malgré soi par un goomba pendant qu'on choisit un jeu, une plante dont la sortie surprend à chaque fois.

Les trois leviers, dans l'ordre où les tirer : **éloigner** (le rayon, qui divise la vitesse angulaire), **ralentir**, **retirer**. Le troisième est légitime : le monde reste vivant avec deux animations au lieu de quatre.

---

## Self-review

Relecture du plan contre la spec, faite après écriture.

**Couverture.** Chaque section de la spec pointe sur une tâche : §0 → Tasks 4 et 9 ; §1 → tout le lot 1 ; §2 (échelle) → `ART_PIXELS_PER_METRE`, Task 4, appliqué en Tasks 14 et 17 ; §3 (modules) → la table de File Structure, une tâche par module ; §4.1 → Task 9 ; §4.2 → Tasks 5 et 7 ; §4.3 → Task 10 ; §4.4 → Task 10 ; §5 → Tasks 1, 2, 3, 6 ; §6 → Tasks 13, 15, 17 ; §7 → Tasks 18, 19, 20 ; §8 → Tasks 8, 10, 11 ; §9 → le découpage en quatre lots ; §10 → les tests de chaque tâche, et la règle `test:ui` en Global Constraints ; §11 → les étapes « session casque » des Tasks 11, 14, 17, 20 ; §12 → rien n'y contrevient.

**Deux écarts assumés par rapport à la spec, tous deux découverts en écrivant le plan :**

1. **`DECOR_NEAR` passe de 6 à 6,5 m**, et `ANCHOR_DRIFT` apparaît. Le rideau doit vivre avec les panneaux et le décor dans l'autre groupe ; les deux origines dérivent verticalement, et sans réserve le décor peut repasser devant le rideau en pleine partie. La spec a été corrigée en conséquence.
2. **`decorVisible` n'est pas une méthode de la scène**, comme le disait la spec §8, mais `decor.setVisible`. Le fondu appartient au décor, et faire passer la scène par-dessus l'obligerait à connaître un état qui ne la regarde pas. La scène gagne à la place `addDecor` et `addCurtain`.

**Cohérence des types.** `Prop` (Task 13), `BoxProp` (Task 17) et `Creature` (Task 20) sont trois formes distinctes et voulues : un quad plat, une boîte, un quad animé. Elles partagent `azimuth` / `radius` / `standing` avec la même sémantique — `standing` est toujours « mètres entre le sol et le bas de l'objet », et c'est toujours `build.ts` qui y ajoute `-floorHeight`. `measureFloor` rend `number | null` partout (Tasks 5 et 11). `uvOf` rend un `Uv` consommé à l'identique par `quadFor`, `boxGeometry` et l'animation.

**Pas de marqueur laissé.** Aucun « TBD », aucun « comme la tâche N ». Les deux endroits qui pourraient en avoir l'air sont signalés : les `.slice(0, 16)` des grilles de la Task 19, avec l'instruction de les remplacer par des littéraux et le test qui le vérifie ; et les numéros de ligne de la Task 11, accompagnés des deux `grep` qui les remplacent.
