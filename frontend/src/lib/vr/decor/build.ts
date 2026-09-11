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
import { SKY_RADIUS, CURTAIN_RADIUS, ROOM_DARK, floorRepeat } from './composition';
import { curtainAtMillis, elapsedFor, type FadeTarget } from './fade';

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
  const floorTexture = tileTexture(GROUND_BRICK, opts.maxAnisotropy);
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
    }
  };
}
