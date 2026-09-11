/**
 * A five-sided box, to give volume to a flat drawing.
 *
 * Why not `THREE.BoxGeometry`: each face needs different uvs - the front
 * carries the drawing, the sides a darkened band - and `BoxGeometry` only
 * offers one set. `screen-geometry.ts` generates its own mesh for the same
 * reason, and gains the same benefit: this is all a pure function, hence
 * checkable without a GPU.
 *
 * Five faces. The underside of an object standing on the ground is never
 * seen, and the face that is never drawn can never be wrong.
 *
 * The winding is counter-clockwise as seen from outside, which is three's
 * convention for a front face. Getting it backwards makes the object
 * invisible rather than wrong-looking - the worse of the two, since it reads
 * as an object that was never added.
 */
import type { Uv } from './atlas';

/**
 * La normale de la face avant, AVANT toute rotation.
 *
 * Déclarée plutôt que sous-entendue, et c'est le correctif d'un défaut réel :
 * `build.ts` place les boîtes et les quads avec la même arithmétique, mais la
 * normale d'une `PlaneGeometry` part vers +Z et celle-ci vers -Z. La
 * convention vivait dans une phrase de commentaire ici, le lacet dans une
 * ligne là-bas, et recopier la ligne a tourné tout le décor proche de 180°.
 * Les deux nombres vivent maintenant dans le même fichier.
 */
export const FRONT_NORMAL = { x: 0, y: 0, z: -1 } as const;

/**
 * Le lacet qui tourne la façade vers le joueur, pour un objet posé à
 * l'azimut `azimuth`.
 *
 * `build.ts` pose l'objet en `(R sin θ, y, -R cos θ)`, donc la direction qui
 * mène au joueur est `(-sin θ, +cos θ)`. Tourner `FRONT_NORMAL` de `π - θ`
 * l'y amène exactement ; `-θ`, le lacet d'un quad, l'amène à l'opposé.
 *
 * Le piège que ça désarme : à l'azimut 0 les deux valent zéro et π, deux
 * lacets dont AUCUN ne se lit comme faux. Ce n'est pas un signe à corriger,
 * c'est une convention à ne pas partager - `vr-decor-box.test.ts` garde les
 * deux affirmations côte à côte.
 */
export function boxYaw(azimuth: number): number {
  return Math.PI - azimuth;
}

export interface BoxSpec {
  width: number;
  height: number;
  depth: number;
  /** The face turned toward -Z (`FRONT_NORMAL`), turned toward the player by
   *  `boxYaw`: the one carrying the drawing. */
  front: Uv;
  /** Both flanks, and the back. */
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

  // Each face: its four corners in the order top-left, top-right,
  // bottom-left, bottom-right, as seen from outside.
  const faces: { corners: number[][]; uv: Uv }[] = [
    // Front (-Z)
    { corners: [[-x, y, -z], [x, y, -z], [-x, -y, -z], [x, -y, -z]], uv: spec.front },
    // Back (+Z)
    { corners: [[x, y, z], [-x, y, z], [x, -y, z], [-x, -y, z]], uv: spec.side },
    // Left flank (-X)
    { corners: [[-x, y, z], [-x, y, -z], [-x, -y, z], [-x, -y, -z]], uv: spec.side },
    // Right flank (+X)
    { corners: [[x, y, -z], [x, y, z], [x, -y, -z], [x, -y, z]], uv: spec.side },
    // Top (+Y)
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
    indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], index * 6);
  });

  return { positions, uvs, indices };
}
