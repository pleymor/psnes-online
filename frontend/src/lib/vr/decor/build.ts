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
import { packAtlas, uvOf, type Atlas, type Uv } from './atlas';
import { scenery, props, creatures, type Prop, type BoxProp, type Creature } from './placement';
import { boxGeometry, boxYaw } from './box';
import { spriteFrame, patrol, piranha } from './motion';
import { COUNTER_DEPTH, type CounterRun } from '../layout';

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

export interface Decor {
  decor: THREE.Object3D;
  /**
   * Ce qui SUIT le joueur : le ciel, le sol, les collines, les nuages.
   *
   * Quatrième racine, et la raison d'être de tout le reste : elle prend la
   * rotation du joueur mais jamais son déplacement, ce qui fait une plaine
   * sans fin. Le proche reste posé et s'éloigne vraiment ; le lointain reste
   * centré sur la tête. Sans cette coupure, marcher trente mètres sortirait du
   * disque de sol et de la sphère de ciel, qui n'en font que trente.
   */
  far: THREE.Object3D;
  /**
   * Le rideau, qui rejoint la famille du lointain.
   *
   * Il doit suivre le joueur : c'est une cagoule autour de sa tête, pas un
   * endroit qu'on peut quitter. Son dégagement intérieur reste mesuré contre
   * l'écran, qui lui ne suit pas - et ça tient parce que la marche n'existe
   * qu'au lobby : pendant une partie, le joueur est à son ancre et les deux
   * sont concentriques comme avant.
   */
  curtain: THREE.Object3D;
  /**
   * Le comptoir. TROISIÈME RACINE, et elle va dans le groupe des PANNEAUX -
   * ni `room` ni `world` directement.
   *
   * Deux raisons qui tirent dans le même sens. Il épouse les panneaux, donc il
   * doit être ancré comme eux : dans `room`, il glisserait sous eux jusqu'à
   * `ANCHOR_DRIFT`. Et en pendant dans leur groupe il hérite de
   * `panelsVisible`, ce qui lui interdit de rester allumé pendant une partie
   * sans un état de plus - alors qu'à un mètre il est bien en deçà du rideau,
   * et qu'il aurait sinon fallu lui donner le fondu propre que seul le sol
   * porte aujourd'hui.
   */
  furniture: THREE.Object3D;
  /**
   * Fait GLISSER la texture du sol sous les pieds du joueur.
   *
   * Le sol suit le joueur - il est dans le lointain, sinon on sortirait du
   * disque - et c'est ce qui a produit le symptôme rapporté du casque : « la
   * texture du sol me suit ». Un sol dont la matière ne bouge pas est un sol
   * sur lequel on ne marche pas ; on glisse dessus comme sur un tapis roulant
   * à l'arrêt.
   *
   * La réponse n'est pas de déplacer le maillage mais sa TEXTURE. Les uv du
   * disque couvrent 0..1 d'un bord à l'autre, soit `floorRepeat()` tuiles sur
   * un diamètre de `SKY_RADIUS * 2` mètres : un mètre parcouru vaut donc
   * exactement une tuile de décalage, et le motif défile à la bonne vitesse
   * par construction plutôt que par réglage.
   */
  setGroundShift(shift: readonly [number, number]): void;
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
  /*
   * PAS le lacet de `quadFor`, et c'est la seule ligne où les jumelles
   * divergent : la normale d'un plan part vers +Z, la façade d'une boîte vers
   * -Z (`FRONT_NORMAL`). Recopier `-azimuth` ici a montré le DOS de chaque
   * objet proche - donc `spec.side`, la bande assombrie - jusqu'au
   * 2026-09-11. Les tuyaux étaient des plaques sombres, les blocs `?` des
   * cubes bruns sans `?`, et les 1039 tests passaient : ils épinglaient
   * l'enroulement, jamais la face tournée vers le joueur.
   */
  mesh.rotation.y = boxYaw(prop.azimuth);
  return mesh;
}

/**
 * Une face dont les uv changent d'image en image.
 *
 * La même forme sert aux créatures et aux boîtes qui pulsent, et ce n'est pas
 * un hasard : `box.ts` met sa FAÇADE en première face, donc ses quatre
 * premiers sommets - les huit premiers flottants d'uv - sont exactement ceux
 * d'un quad. Un seul type, une seule boucle.
 */
interface Animated {
  readonly uv: THREE.BufferAttribute;
  readonly frames: readonly Uv[];
  readonly hz: number;
  /** La dernière image écrite, pour ne pas réécrire ce qui n'a pas changé. */
  shown: number;
}

/** Une créature qui se déplace, avec de quoi la replacer sans trigonométrie. */
interface Moving {
  readonly mesh: THREE.Mesh;
  readonly base: THREE.Vector3;
  /** La tangente de l'anneau : la direction d'un va-et-vient. */
  readonly tangent: THREE.Vector3;
  readonly motion: Creature['motion'];
}

function writeFrame(animated: Animated, index: number): void {
  if (index === animated.shown) return;
  animated.shown = index;
  const uv = animated.frames[index];
  (animated.uv.array as Float32Array).set([
    uv.u0, uv.v1, uv.u1, uv.v1, uv.u0, uv.v0, uv.u1, uv.v0
  ]);
  animated.uv.needsUpdate = true;
}

/**
 * Un tronçon de comptoir : la troisième façon de poser une boîte, et la seule
 * qui ne soit pas polaire.
 *
 * `boxFor` prend un azimut et un rayon parce que tout le décor vit sur des
 * anneaux. Le comptoir, lui, épouse des panneaux dont les positions sont déjà
 * calculées par `layout.ts` : leur refaire des coordonnées polaires
 * réécrirait un fait qui existe. D'où une position explicite - mais le lacet
 * passe par `boxYaw`, comme partout, pour que le piège +Z/-Z reste à un seul
 * endroit du dépôt.
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
   * Un seul décalage, et ce n'est pas un réglage : `run.top` est le centre de
   * la face du DESSUS, alors que `boxGeometry` centre sa boîte sur son
   * origine. La demi-hauteur retranchée fait affleurer le plateau au bord bas
   * du panneau.
   *
   * La profondeur, elle, ne décale rien : elle est CENTRÉE sur ce bord, donc
   * le plateau déborde vers le joueur autant qu'il s'enfonce derrière. C'est
   * le test de continuité qui l'a imposé - en partant du bord vers l'arrière,
   * les trois tronçons reculaient chacun de leur côté et laissaient 2,8 cm de
   * trou à chaque jonction - et c'est aussi ce que fait un bureau.
   */
  mesh.position.set(run.top[0], run.top[1] - height / 2, run.top[2]);
  mesh.rotation.y = boxYaw(run.facing);
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
  const far = new THREE.Group();
  far.add(new THREE.Mesh(skyGeometry, skyMaterial));

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
  /*
   * Le sol se dessine AVANT tout autre transparent, et ce n'est pas un
   * réglage : c'est le plancher du monde.
   *
   * Sans cette ligne, il se disputait l'ordre avec les vitres des pupitres, et
   * le symptôme signalé depuis le casque le 2026-09-12 était exact au mot
   * près : « le verre prend deux aspects distincts selon l'inclinaison de la
   * tête ». Deux aspects, pas un dégradé - la signature d'un basculement
   * discret.
   *
   * La cause : three trie les transparents par leur profondeur dans le repère
   * de la CAMÉRA, pas par leur distance. Tourner la tête ne change aucune
   * distance mais change ces profondeurs, donc l'ordre peut s'inverser. Et ce
   * disque est le pire cas possible - trente mètres de rayon dont l'origine
   * est sous les pieds du joueur, donc trié comme s'il était à 1,6 m, soit
   * exactement la zone des pupitres. Selon l'inclinaison, il passait devant ou
   * derrière eux : devant, la vitre se mélangeait à l'herbe et se lisait comme
   * du verre ; derrière, elle se mélangeait au fond du ciel et devenait un
   * aplat.
   *
   * Le rideau garde son ordre par défaut, et il le faut : quand il se ferme,
   * il doit couvrir le sol comme le reste du décor.
   */
  floor.renderOrder = -1;
  far.add(floor);

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
    // Le drapeau décide, pas le rayon : voir `placement.ts` et les buissons
    // qui vivent sur deux anneaux.
    (prop.distant ? far : decor).add(mesh);
    if (prop.facing === 'billboard') billboards.push(mesh);
  }

  /*
   * Les objets proches, en boîte : même atlas, même matériau que les quads du
   * relief - un seul bind de plus n'apporterait rien, et `boxFor` en est la
   * jumelle exacte pour la position.
   */
  const animated: Animated[] = [];
  for (const prop of props()) {
    const mesh = boxFor(prop, atlas, quadMaterial, opts.floorHeight);
    quadGeometries.push(mesh.geometry);
    decor.add(mesh);
    // Le pulsement d'un bloc : sa façade, et rien d'autre. Les flancs gardent
    // leur teinte assombrie, ce qui est le propre du cyclage de palette.
    if (prop.frames) {
      animated.push({
        uv: mesh.geometry.getAttribute('uv') as THREE.BufferAttribute,
        frames: prop.frames.map((name) => uvOf(atlas, name)),
        hz: prop.hz ?? 1,
        shown: 0
      });
    }
  }

  /*
   * Ce qui bouge. Deux billboards, donc ils passent par la boucle
   * d'orientation avec les nuages - un goomba en volume n'est plus un goomba.
   *
   * `quadFor` est réutilisé tel quel plutôt que recopié : l'arithmétique de
   * position n'existe qu'une fois, et une créature n'est rien d'autre qu'un
   * élément du relief dont les uv changent.
   */
  const moving: Moving[] = [];
  for (const creature of creatures()) {
    const mesh = quadFor(
      {
        art: creature.frames[0],
        azimuth: creature.azimuth,
        radius: creature.radius,
        standing: creature.standing,
        facing: 'billboard',
        // Une créature RESTE posée : on doit pouvoir s'en approcher, et un
        // goomba qui suivrait le joueur serait une poursuite, pas un décor.
        distant: false
      },
      atlas,
      quadMaterial,
      opts.floorHeight
    );
    quadGeometries.push(mesh.geometry);
    decor.add(mesh);
    billboards.push(mesh);
    animated.push({
      uv: mesh.geometry.getAttribute('uv') as THREE.BufferAttribute,
      frames: creature.frames.map((name) => uvOf(atlas, name)),
      hz: creature.hz,
      shown: 0
    });
    moving.push({
      mesh,
      base: mesh.position.clone(),
      // La dérivée de la position sur l'anneau : (cos, 0, sin). Un va-et-vient
      // suit donc le cercle plutôt que de s'en écarter en ligne droite.
      tangent: new THREE.Vector3(Math.cos(creature.azimuth), 0, Math.sin(creature.azimuth)),
      motion: creature.motion
    });
  }

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
  far.visible = false;
  curtainMesh.visible = false;

  return {
    decor,
    far,
    curtain: curtainMesh,
    furniture,

    setGroundShift(shift: readonly [number, number]): void {
      /*
       * Une tuile par mètre : `floorRepeat()` répétitions sur un diamètre de
       * `SKY_RADIUS * 2`, donc le décalage en uv est le déplacement divisé par
       * ce diamètre, multiplié par le nombre de répétitions - ce qui se
       * simplifie en « mètres divisés par la taille d'une tuile », soit les
       * mètres eux-mêmes.
       *
       * Le signe : la texture glisse dans le sens OPPOSÉ à la marche, comme le
       * paysage défile à l'envers par la fenêtre d'un train.
       */
      floorTexture.offset.set(-shift[0], shift[1]);
    },

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
      far.visible = true;
      curtainMesh.visible = true;
    },

    update(t: number): void {
      /*
       * Rien du tout quand le décor est masqué, et c'est la visibilité du
       * LOINTAIN qui le dit plutôt que `settled` - les deux racines
       * s'allument et s'éteignent ensemble, et c'est celle-ci qui porte les
       * nuages, donc les billboards de cette boucle.
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
      if (far.visible) {
        /*
         * Le temps du runtime XR est en MILLISECONDES ; `motion.ts` travaille
         * en secondes. La conversion est ici, une fois, parce qu'un module de
         * mouvement qui connaîtrait l'unité du casque serait intestable.
         */
        const seconds = t / 1000;

        for (const item of animated) {
          writeFrame(item, spriteFrame(seconds, { frames: item.frames.length, hz: item.hz }));
        }

        /*
         * Le déplacement AVANT l'orientation : un billboard se tourne d'après
         * sa position, donc l'ordre inverse le viserait depuis l'endroit qu'il
         * vient de quitter - une image de retard, invisible à l'arrêt et
         * visible en marche.
         */
        for (const item of moving) {
          if (item.motion.kind === 'patrol') {
            const half = item.motion.span / 2;
            const { at } = patrol(seconds, {
              from: -half,
              to: half,
              speed: item.motion.speed
            });
            item.mesh.position.copy(item.base).addScaledVector(item.tangent, at);
          } else {
            item.mesh.position.y = item.base.y + piranha(seconds, item.motion);
          }
        }

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
      if (target === 'dark') {
        decor.visible = false;
        far.visible = false;
      }
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
