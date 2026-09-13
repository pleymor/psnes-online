/**
 * Les amis, en maillages. Ce module n'a AUCUNE décision.
 *
 * La jumelle de `decor/build.ts`, et pour la même raison : three n'est pas
 * exécutable sous Bun, donc tout ce qui pourrait se tromper est déjà parti
 * ailleurs. `roster.ts` dit QUI est là et où, `proximity.ts` dit ce qu'on en
 * montre, `avatar-art.ts` dit à quoi ils ressemblent. Ici on pose des boîtes.
 *
 * TROIS PIÈGES, DÉSARMÉS ICI PARCE QU'ILS ONT DÉJÀ COÛTÉ.
 *
 * La façade d'une boîte regarde -Z (`FRONT_NORMAL`), celle d'un quad regarde
 * +Z. Recopier la ligne de lacet de l'un à l'autre a déjà tourné tout le décor
 * proche de 180°, sans qu'aucun test le voie. Ici on ne calcule pas de lacet
 * du tout : on applique le quaternion reçu, qui est celui d'une tête.
 *
 * L'opacité descend de `proximity`, et sous le seuil on retire l'objet du
 * rendu (`visible = false`) au lieu de le rendre transparent : un transparent
 * invisible coûte encore son tri, et ce dépôt a déjà payé un basculement
 * d'ordre de rendu sur une surface transparente.
 *
 * Et on ne recrée JAMAIS un maillage par image. Un ami garde les siens tant
 * qu'il est là ; seuls ses `position`/`quaternion`/`visible` changent. C'est
 * l'avertissement de `panel-mesh.ts` sur le coût d'une re-rasterisation à
 * 72 Hz, appliqué aux géométries — et la plaque de pseudo, qui est bien un
 * canvas, ne se rasterise qu'UNE fois, à la naissance de l'ami.
 */
import * as THREE from 'three';
import { boxGeometry } from '../decor/box';
import { uvOf, type Atlas } from '../decor/atlas';
import { truncate } from '../panel';
import { SMW } from '../panels/chrome';
import { presenceFor } from './proximity';
import { namedOnly } from './roster';
import type { Pose, PeerPose } from './roster';

/** Une tête d'adulte fait vingt-quatre centimètres de large. */
export const HEAD_SIZE = 0.24;
/** Un poing fermé sur une manette. */
export const HAND_SIZE = 0.1;
/** De combien la plaque de pseudo flotte au-dessus du crâne. */
const LABEL_RISE = 0.22;

/**
 * Le canvas d'une plaque de pseudo, et la taille qu'elle occupe dans le monde.
 *
 * Le rapport des deux est ce qui compte : 256 × 64 pixels étalés sur 50 × 12,5
 * centimètres, soit le même rapport 4:1 de part et d'autre. Un sprite déformé
 * est le défaut que ce couplage rend impossible.
 */
const LABEL_PIXELS = { width: 256, height: 64 } as const;
const LABEL_METRES = { width: 0.5, height: 0.125 } as const;

export interface AvatarsOptions {
  atlas: Atlas;
  material: THREE.Material;
  /*
   * Pas de `head()` ici, contrairement à `DecorOptions`.
   *
   * Les billboards du décor sont des quads qu'il faut faire pivoter à la main
   * vers la tête, d'où le rappel dont `build.ts` a besoin. La plaque de pseudo
   * est un `THREE.Sprite`, qui fait face au lecteur tout seul par construction.
   * Un rappel de plus serait un paramètre que personne ne lit.
   */
  /** Le pseudo d'un identifiant, ou `null` si on ne le connaît pas — auquel
   *  cas l'ami n'est PAS dessiné. C'est `namedOnly` (`roster.ts`) qui applique
   *  la règle, pour qu'un test puisse la tenir. */
  label: (id: string) => string | null;
}

export interface Avatars {
  /** À passer à `scene.addDecor`. */
  group: THREE.Object3D;
  /**
   * `mine` est ma propre tête, pour la proximité, et `null` tant que je n'ai
   * pas de pose. Ce que ça vaut se lit dans `presenceFor` (`proximity.ts`),
   * qui porte le repli : ce module n'en décide rien.
   */
  update(peers: ReadonlyMap<string, PeerPose>, mine: Pose | null): void;
  dispose(): void;
}

interface Avatar {
  root: THREE.Object3D;
  head: THREE.Mesh;
  left: THREE.Mesh;
  right: THREE.Mesh;
  label: THREE.Sprite;
  material: THREE.Material;
  labelMaterial: THREE.SpriteMaterial;
  geometries: THREE.BufferGeometry[];
}

/**
 * Un cube dont chaque face tire ses uv de l'atlas partagé.
 *
 * Le modèle est `boxFor` de `decor/build.ts`, à un détail près : là-bas la
 * taille vient du dessin divisé par la densité de pixels, ici elle est donnée.
 * Une tête d'ami n'est pas un objet du décor qu'on agrandirait en redessinant
 * son motif — c'est une mesure du monde réel, et `HEAD_SIZE` la porte.
 *
 * Pas de `computeVertexNormals()` : rien n'est éclairé dans cette scène, donc
 * les normales n'occuperaient que de la mémoire.
 */
function geometryFor(
  atlas: Atlas,
  size: number,
  front: string,
  side: string,
  top: string
): THREE.BufferGeometry {
  const data = boxGeometry({
    width: size,
    height: size,
    depth: size,
    front: uvOf(atlas, front),
    side: uvOf(atlas, side),
    top: uvOf(atlas, top)
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return geometry;
}

/**
 * La plaque de pseudo : un canvas rasterisé UNE fois, à la création de l'ami.
 *
 * La fabrication du texte est celle de `panel-mesh.ts`, et son filtrage aussi :
 * linéaire dans les deux sens, aucun mipmap. Le raisonnement y est écrit — du
 * texte vu à une taille voisine de sa taille native ne gagne rien à un niveau
 * de mip et n'y perd que sa netteté. C'est l'inverse exact de l'atlas du décor,
 * qui lui est en `NearestFilter` parce que ses gros pixels sont le sujet.
 *
 * Le contour avant le remplissage : un pseudo blanc se lit sur le ciel comme
 * sur une colline seulement s'il porte son propre fond, et un liseré sombre
 * coûte moins qu'une plaque opaque qui masquerait le décor derrière.
 */
function labelSprite(pseudo: string): THREE.SpriteMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_PIXELS.width;
  canvas.height = LABEL_PIXELS.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('pas de contexte 2d pour la plaque de pseudo');

  ctx.font = '600 40px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // La police AVANT la mesure : `truncate` mesure avec le contexte courant, et
  // tronquer selon une police qui n'est pas celle du dessin coupe au mauvais
  // endroit — trop tôt, ou en débordant.
  const text = truncate(ctx, pseudo, canvas.width - 16);
  const x = canvas.width / 2;
  const y = canvas.height / 2;

  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = SMW.outline;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = SMW.ink;
  ctx.fillText(text, x, y);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  return new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    // Un nom qui flotte ne creuse pas le tampon de profondeur : il se mélange
    // par-dessus ce qu'il survole, comme le rideau de `build.ts`.
    depthWrite: false,
    toneMapped: false
  });
}

/**
 * Tout ce qu'un ami possède en propre.
 *
 * La `map` de la `SpriteMaterial` EST comptée ici : `Material.dispose()` ne
 * libère pas ses textures, donc l'oublier laisse un canvas téléversé sur le
 * GPU pour chaque ami qui a traversé le lobby — une fuite qu'aucun test ne
 * verra, puisque aucun test n'a de GPU.
 *
 * Ce qui n'est PAS ici : l'atlas et le matériau partagés du décor. `Decor`
 * en reste le seul propriétaire, et son `dispose()` les libère ; les libérer
 * aussi d'ici les retirerait sous les pieds du décor encore affiché.
 */
function release(avatar: Avatar): void {
  for (const geometry of avatar.geometries) geometry.dispose();
  avatar.material.dispose();
  avatar.labelMaterial.map?.dispose();
  avatar.labelMaterial.dispose();
}

function place(mesh: THREE.Object3D, pose: Pose): void {
  mesh.position.set(pose[0], pose[1], pose[2]);
  mesh.quaternion.set(pose[3], pose[4], pose[5], pose[6]);
}

export function createAvatars(opts: AvatarsOptions): Avatars {
  const group = new THREE.Group();
  const avatars = new Map<string, Avatar>();

  function build(id: string, pseudo: string): Avatar {
    /*
     * Un matériau PAR AMI, et non le matériau partagé du décor.
     *
     * L'opacité est individuelle - deux amis à deux distances ne s'effacent
     * pas pareil - et une opacité posée sur le matériau partagé les ferait
     * tous s'effacer ensemble, décor compris. Le coût est un bind par ami,
     * pour quelques amis.
     */
    const material = opts.material.clone();
    material.transparent = true;
    /*
     * PAS zéro, et pas non plus le 0,5 dont on hérite.
     *
     * `build.ts` prend 0,5 parce que ses découpes sont franches et ses quads
     * opaques ; mais `alphaTest` compare `opacity × alphaTexel`, donc 0,5
     * ferait disparaître l'ami ENTIER dès que le fondu de proximité passe sous
     * la moitié. Zéro, lui, garde les texels de marge d'`AVATAR_HAND` - des
     * `.`, donc alpha 0 : invisibles à la couleur, mais ÉCRITS dans le tampon
     * de profondeur, ce qui donne à chaque main une empreinte carrée qui
     * découpe les transparents dessinés après elle - la plaque d'un autre ami,
     * le rideau. C'est le piège du transparent qui coûte son tri, sous une
     * autre forme.
     *
     * 0,01 rejette les texels d'alpha nul et survit à tout le fondu : l'ami ne
     * s'efface qu'en deçà d'une opacité déjà invisible. Posé une fois à la
     * création, donc `USE_ALPHATEST` ne se recompile pas par image.
     */
    material.alphaTest = 0.01;
    /*
     * `DoubleSide` était le réglage des billboards du décor, qui pivotent et
     * passent par des angles montrant leur dos. Une tête et une main sont des
     * cubes FERMÉS : leurs faces intérieures ne seraient rasterisées que pour
     * être rejetées, et sur la main elles se mélangeraient à travers la marge
     * transparente.
     */
    material.side = THREE.FrontSide;
    material.depthWrite = true;

    const headGeometry = geometryFor(opts.atlas, HEAD_SIZE, 'avatarFace', 'avatarSide', 'avatarTop');
    /*
     * Une main distante se pose à la pose reçue, SANS correction, et elle ne
     * partage rien avec les mains locales.
     *
     * `poseInRoom()` émet le `gripSpace` - le poing - alors que les mains
     * locales sont dessinées depuis `renderer.xr.getController(i)`, c'est-à-dire
     * le `targetRaySpace` - le rayon de visée, incliné de 30 à 45° de tangage.
     * Emprunter la géométrie ou l'orientation des unes pour les autres
     * casserait UNIFORMÉMENT tous les poignets distants, ce qui se lit comme un
     * défaut de modèle et se chercherait donc au mauvais endroit.
     */
    const handGeometry = geometryFor(opts.atlas, HAND_SIZE, 'avatarHand', 'avatarHand', 'avatarHand');

    const head = new THREE.Mesh(headGeometry, material);
    const left = new THREE.Mesh(handGeometry, material);
    const right = new THREE.Mesh(handGeometry.clone(), material);

    const labelMaterial = labelSprite(pseudo);
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(LABEL_METRES.width, LABEL_METRES.height, 1);

    const root = new THREE.Group();
    root.add(head, left, right, label);
    group.add(root);
    // `id` sert au débogage depuis l'inspecteur : trouver de qui est la tête
    // qu'on regarde, sans avoir à remonter la carte à la main.
    root.name = `avatar:${id}`;

    return {
      root, head, left, right, label, material, labelMaterial,
      geometries: [headGeometry, handGeometry, right.geometry as THREE.BufferGeometry]
    };
  }

  return {
    group,

    update(peers, mine) {
      /*
       * Qui est dessinable, décidé par `roster` : un identifiant qu'on ne sait
       * pas nommer n'est pas là. La règle est une garantie de sécurité - aucun
       * inconnu dans le lobby de personne - donc elle vit chez un module qu'un
       * test peut exécuter, et pas dans cette boucle-ci.
       */
      const shown = namedOnly(peers, opts.label);

      // Les partis, d'abord. Contre `shown` et non contre `peers` : un ami
      // qu'on ne sait plus nommer doit s'en aller comme un ami qui a quitté le
      // lobby, sinon il resterait figé à sa dernière pose pour toujours.
      for (const [id, avatar] of avatars) {
        if (shown.has(id)) continue;
        release(avatar);
        group.remove(avatar.root);
        avatars.delete(id);
      }

      for (const [id, named] of shown) {
        const pose = named.pose;

        let avatar = avatars.get(id);
        if (!avatar) {
          avatar = build(id, named.pseudo);
          avatars.set(id, avatar);
        }

        // Y compris quand je n'ai pas encore ma propre pose : `presenceFor`
        // porte ce repli, parce que c'est une politique de proximité.
        const presence = presenceFor(mine, pose.head);

        avatar.root.visible = presence.visible;
        if (!presence.visible) continue;

        avatar.material.opacity = presence.opacity;
        avatar.labelMaterial.opacity = presence.opacity;

        place(avatar.head, pose.head);

        avatar.left.visible = pose.left !== null;
        if (pose.left) place(avatar.left, pose.left);
        avatar.right.visible = pose.right !== null;
        if (pose.right) place(avatar.right, pose.right);

        // La plaque flotte au-dessus du crâne et regarde toujours le lecteur :
        // un Sprite s'oriente tout seul, d'où le choix contre un quad qu'il
        // faudrait faire pivoter à la main comme les billboards du décor.
        avatar.label.position.set(pose.head[0], pose.head[1] + LABEL_RISE, pose.head[2]);
      }
    },

    dispose() {
      for (const avatar of avatars.values()) {
        release(avatar);
        group.remove(avatar.root);
      }
      avatars.clear();
    }
  };
}
