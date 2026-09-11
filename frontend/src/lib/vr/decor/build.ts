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
import { GROUND_TURF } from './art/ground';
import { ALL_ART } from './art';
import { COLOURS } from './palette';
import {
  SKY_RADIUS,
  CURTAIN_RADIUS,
  ROOM_DARK,
  floorRepeat,
  ART_PIXELS_PER_METRE
} from './composition';
import { curtainAtMillis, elapsedFor, type FadeTarget } from './fade';
import { packAtlas, uvOf, type Atlas } from './atlas';
import { scenery, props, type Prop, type BoxProp } from './placement';
import { boxGeometry } from './box';

export interface DecorOptions {
  /** Mètres sous l'œil, de `floor.ts`. */
  floorHeight: number;
  /** `renderer.capabilities.getMaxAnisotropy()`. */
  maxAnisotropy: number;
  /** La position de la tête, pour orienter les billboards. */
  head: () => { x: number; y: number; z: number };
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
  // Le cast suit TS 5.7+, qui a rendu les tableaux typés génériques sur
  // ArrayBufferLike : `Raster.data` (`pixels.ts`) reste un `Uint8ClampedArray`
  // ordinaire pour ne rien devoir au DOM, mais `ImageData` exige la variante
  // fixée sur `ArrayBuffer`. Aucune donnée ne change - le tampon en est
  // toujours un.
  ctx.putImageData(
    new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
    0,
    0
  );

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
    ctx.putImageData(
      new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
      rect.x,
      rect.y
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

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

/**
 * La boîte d'un objet proche : la jumelle de `quadFor`, même arithmétique de
 * position, mais une `BufferGeometry` à cinq faces produite par
 * `boxGeometry` (`box.ts`) plutôt qu'un `PlaneGeometry`.
 *
 * Pas de `computeVertexNormals()` : rien n'est éclairé dans cette scène
 * (`scene.ts` dit pourquoi), donc les normales ne serviraient qu'à occuper de
 * la mémoire.
 */
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
   * La répétition vaut `floorRepeat()` (`composition.ts`) : le diamètre en
   * mètres, parce que les uv d'un `CircleGeometry` couvrent 0..1 d'un bord à
   * l'autre.
   */
  const floorTexture = tileTexture(GROUND_TURF, opts.maxAnisotropy);
  floorTexture.repeat.set(floorRepeat(), floorRepeat());
  const floorGeometry = new THREE.CircleGeometry(SKY_RADIUS, 64);
  // `transparent: true` : le sol est le seul objet du décor en deçà du rayon
  // du rideau (voir plus bas), donc lui seul a besoin de son propre fondu.
  const floorMaterial = new THREE.MeshBasicMaterial({ map: floorTexture, transparent: true });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -opts.floorHeight;
  decor.add(floor);

  /*
   * Le rideau. `depthWrite: false` parce qu'il est transparent : il doit se
   * mélanger par-dessus le décor qu'il masque, pas creuser un trou dans le
   * tampon de profondeur. Les panneaux, eux, sont AUSSI transparents
   * (`panel-mesh.ts`) - ce n'est donc pas l'opacité qui les fait dessiner
   * avant le rideau, c'est le tri de three : les objets transparents sont
   * dessinés du plus proche au plus lointain, et à ~2 m ils précèdent de
   * toute façon un rideau à 5,5 m.
   */
  const curtainGeometry = new THREE.SphereGeometry(CURTAIN_RADIUS, 16, 12);
  const curtainMaterial = new THREE.MeshBasicMaterial({
    color: ROOM_DARK,
    side: THREE.BackSide,
    transparent: true,
    opacity: 0,
    depthWrite: false
  });
  const curtainMesh = new THREE.Mesh(curtainGeometry, curtainMaterial);

  /*
   * Le relief : collines, buissons, nuages. Un atlas, un matériau partagé, un
   * quad par élément de `scenery()` (`placement.ts`).
   *
   * `alphaTest` plutôt que `transparent` : les découpes sont franches - un
   * pixel est là ou il n'y est pas - et `transparent: true` ferait trier tous
   * ces quads entre eux à chaque image pour rien, avec les artefacts d'ordre
   * qui vont avec. `DoubleSide` parce qu'un billboard qui pivote passe par des
   * angles où sa face arrière regarde le joueur pendant une image.
   */
  const atlas = packAtlas(ALL_ART);
  const atlasMap = atlasTexture(atlas);
  const quadMaterial = new THREE.MeshBasicMaterial({
    map: atlasMap,
    transparent: false,
    alphaTest: 0.5,
    side: THREE.DoubleSide
  });
  const quadGeometries: THREE.BufferGeometry[] = [];
  const billboards: THREE.Mesh[] = [];
  for (const prop of scenery()) {
    const mesh = quadFor(prop, atlas, quadMaterial, opts.floorHeight);
    quadGeometries.push(mesh.geometry);
    decor.add(mesh);
    if (prop.facing === 'billboard') billboards.push(mesh);
  }

  /*
   * Les objets proches, en boîte : même atlas, même matériau que les quads du
   * relief - un seul bind de plus n'apporterait rien, et `boxFor` en est la
   * jumelle exacte pour la position.
   */
  for (const prop of props()) {
    const mesh = boxFor(prop, atlas, quadMaterial, opts.floorHeight);
    quadGeometries.push(mesh.geometry);
    decor.add(mesh);
  }

  // Réutilisés à chaque image plutôt qu'alloués dedans : cette boucle tourne
  // à la fréquence du casque, et une pause de ramasse-miettes s'entend comme
  // un accroc audio (`scene.ts` le dit déjà pour son raycaster).
  const here = new THREE.Vector3();
  const aim = new THREE.Vector3();

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
  let offset = 0;
  decor.visible = false;
  curtainMesh.visible = false;

  return {
    decor,
    curtain: curtainMesh,

    setVisible(visible: boolean): void {
      const next: FadeTarget = visible ? 'decor' : 'dark';
      if (next === target) return;
      /*
       * Reprendre à l'opacité courante, mais seulement si un fondu était en
       * cours. Au repos, l'opacité du matériau ne veut rien dire : le rideau
       * est masqué et c'est `scene.background` qui tient le noir. S'en servir
       * là ferait démarrer le fondu déjà terminé, et le décor apparaîtrait
       * d'un coup - le défaut inverse de celui qu'on corrige.
       */
      offset = settled ? 0 : elapsedFor(curtainMaterial.opacity, next);
      target = next;
      startedAt = null;
      settled = false;
      // Les deux sont visibles PENDANT le fondu, quel qu'en soit le sens : on
      // voit le rideau s'ouvrir sur le décor, ou se refermer dessus.
      decor.visible = true;
      curtainMesh.visible = true;
    },

    update(t: number): void {
      /*
       * Rien du tout quand le décor est masqué, et c'est `decor.visible` qui
       * le dit plutôt que `settled`.
       *
       * La distinction est celle qui manquait : `settled` devient vrai à la
       * FIN d'un fondu, donc s'en servir ici figerait les nuages dès que le
       * lobby a fini d'apparaître, alors qu'ils doivent suivre la tête tant
       * qu'on peut les voir. `decor.visible`, lui, reste vrai pendant les
       * deux fondus et tout le séjour dans le lobby, et ne tombe qu'une fois
       * le noir installé - c'est-à-dire exactement quand une partie tourne.
       *
       * Ce que ça vaut : sans cette garde, cinq `getWorldPosition` et cinq
       * `lookAt` s'exécutent soixante-douze fois par seconde à côté de
       * l'émulateur, sur un décor que personne ne regarde. La spec promet ici
       * « un `if` par image », et c'est ce `if`-là.
       */
      if (decor.visible) {
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
      }

      if (settled) return;
      if (startedAt === null) startedAt = t;
      // `curtainAtMillis` (`fade.ts`) porte la conversion ms → s : `t` vient
      // du runtime XR en millisecondes, mais `offset` est déjà en secondes
      // (`elapsedFor`), d'où l'addition avant la conversion plutôt qu'après.
      const step = curtainAtMillis((t - startedAt) + offset * 1000, target);
      curtainMaterial.opacity = step.opacity;
      /*
       * Le sol, lui, ne passe PAS derrière le rideau.
       *
       * C'est un disque centré sur le joueur : sa partie proche est à un
       * mètre de ses yeux, donc bien en deçà des 5,5 m de la sphère, et une
       * sphère en `BackSide` ne peut rien masquer de plus proche que son
       * propre rayon. Sans ce fondu-là, tout s'assombrit autour de soi
       * pendant que le sol reste en pleine lumière, puis disparaît d'un coup
       * quand `visible` bascule - l'à-coup exact que ce module existe pour
       * supprimer, sur la plus grande surface du champ de vision.
       */
      floorMaterial.opacity = 1 - step.opacity;
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
      for (const geometry of quadGeometries) geometry.dispose();
      quadMaterial.dispose();
      atlasMap.dispose();
    }
  };
}
