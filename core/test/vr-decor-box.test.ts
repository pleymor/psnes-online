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
import { boxGeometry, boxYaw, FRONT_NORMAL } from '../../frontend/src/lib/vr/decor/box.js';
import { props } from '../../frontend/src/lib/vr/decor/placement.js';

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
  // Des fractions dyadiques : exactement représentables en float32, pour que
  // la comparaison stricte contre des littéraux ne trébuche pas sur un
  // arrondi (positions et uv sont des Float32Array).
  const front = { u0: 0.125, v0: 0.25, u1: 0.375, v1: 0.5 };
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

test('chaque face est enroulée vers l_extérieur', () => {
  /*
   * Le seul test qui aurait attrapé le défaut que ce module a failli avoir.
   *
   * L'enroulement s'inverse sans rien casser de visible depuis un terminal :
   * les comptes de sommets sont bons, les positions sont bonnes, les uv sont
   * bonnes. Ce qui change est le SIGNE de la normale, donc three cesse de
   * dessiner la face - et l'objet devient invisible plutôt que faux, ce qui
   * envoie chercher dans le graphe de scène, les matériaux ou le placement,
   * partout sauf ici.
   *
   * Aucun GPU n'est nécessaire pour le dire : le produit vectoriel de deux
   * arêtes donne la normale, et son produit scalaire avec l'axe sortant de la
   * face doit être positif.
   */
  const box = boxGeometry(SPEC);
  // Dans l'ordre d'émission de `boxGeometry` : façade, arrière, flanc gauche,
  // flanc droit, dessus.
  const OUTWARD: readonly (readonly [number, number, number])[] = [
    [0, 0, -1],
    [0, 0, 1],
    [-1, 0, 0],
    [1, 0, 0],
    [0, 1, 0]
  ];

  const at = (i: number): [number, number, number] => [
    box.positions[i * 3],
    box.positions[i * 3 + 1],
    box.positions[i * 3 + 2]
  ];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  const dot = (a: number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  for (let face = 0; face < OUTWARD.length; face++) {
    for (let triangle = 0; triangle < 2; triangle++) {
      const base = face * 6 + triangle * 3;
      const p0 = at(box.indices[base]);
      const p1 = at(box.indices[base + 1]);
      const p2 = at(box.indices[base + 2]);
      const normal = cross(sub(p1, p0), sub(p2, p0));
      assert.ok(
        dot(normal, OUTWARD[face]) > 0,
        `face ${face}, triangle ${triangle} : normale ${normal} contre sortante ${OUTWARD[face]}`
      );
    }
  }
});

/*
 * Le lacet, et pourquoi il ne se recopie PAS depuis `quadFor`.
 *
 * Les tests au-dessus épinglent l'enroulement, qui décide si l'objet se voit.
 * Ceux qui suivent épinglent une autre question, restée sans gardien jusqu'au
 * 2026-09-11 : QUELLE FACE accueille le joueur. Se tromper d'enroulement rend
 * la boîte invisible, ce qui se lit comme un décor qui n'a pas chargé ; se
 * tromper de lacet l'habille de la peau du dos - `spec.side`, la bande
 * assombrie - et ça, aucun nombre du maillage ne le dit.
 *
 * C'est exactement le défaut trouvé dans le casque : `boxFor` avait recopié la
 * ligne de `quadFor`, `mesh.rotation.y = -prop.azimuth`, dont le commentaire
 * dit pourtant pourquoi elle vaut ça - « la normale d'un plan part vers +Z ».
 * La face avant d'une boîte part vers -Z. Les deux diffèrent de π, et à
 * l'azimut 0 les deux lacets valent 0 : le signe n'est pas ce qui est faux,
 * donc la ligne se relit sans rien trahir. Les tuyaux étaient des plaques
 * sombres et les blocs `?` n'avaient pas de `?`.
 */
/** La normale, dans le plan xz, après un lacet de `yaw` autour de +Y. */
function afterYaw(normal: readonly [number, number], yaw: number): [number, number] {
  const [x, z] = normal;
  return [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
}

/**
 * La direction qui va de l'objet VERS le joueur.
 *
 * Elle se déduit de la position que `build.ts` calcule - `(R sin θ, y,
 * -R cos θ)` - et le rayon disparaît en chemin : le joueur est à l'origine,
 * donc seule la direction compte.
 */
function towardPlayer(azimuth: number): [number, number] {
  return [-Math.sin(azimuth), Math.cos(azimuth)];
}

const TURN = 2 * Math.PI;
/** Les azimuts douteux, plus tous ceux du décor réel. */
const AZIMUTHS = [
  0,
  TURN / 4,
  TURN / 2,
  (3 * TURN) / 4,
  -TURN / 4,
  TURN,
  ...props().map((prop) => prop.azimuth)
];

test('le lacet d_une boîte tourne sa façade vers le joueur', () => {
  for (const azimuth of AZIMUTHS) {
    const facing = afterYaw([FRONT_NORMAL.x, FRONT_NORMAL.z], boxYaw(azimuth));
    const wanted = towardPlayer(azimuth);
    // Deux directions unitaires : leur produit scalaire vaut 1 ou rien.
    const dot = facing[0] * wanted[0] + facing[1] * wanted[1];
    assert.ok(
      Math.abs(dot - 1) < 1e-9,
      `azimut ${azimuth} : la façade part vers ${facing}, le joueur est vers ${wanted}`
    );
  }
});

test('le lacet d_un quad retournerait la boîte, et c_est tout le piège', () => {
  /*
   * La règle de `quadFor` appliquée à une boîte : la façade part à l'exact
   * opposé du joueur. Ce test ne garde pas une propriété de la boîte, il garde
   * un RAPPROCHEMENT - que les deux lacets ne deviennent jamais une seule
   * ligne partagée « pour simplifier ». Le jour où `box.ts` déclarerait sa
   * façade vers +Z comme un plan, c'est ici que ça se saurait.
   */
  for (const azimuth of AZIMUTHS) {
    const facing = afterYaw([FRONT_NORMAL.x, FRONT_NORMAL.z], -azimuth);
    const wanted = towardPlayer(azimuth);
    const dot = facing[0] * wanted[0] + facing[1] * wanted[1];
    assert.ok(
      Math.abs(dot + 1) < 1e-9,
      `azimut ${azimuth} : le lacet d'un quad devrait montrer le dos, il donne ${dot}`
    );
  }
});
