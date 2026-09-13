/**
 * Le seul module du lobby qui a une horloge.
 *
 * Ce que ces tests gardent, et qu'aucune lecture ne garderait : le retard
 * d'interpolation (sans lui chaque tête saute six fois par seconde), le fait
 * qu'un ami absent du dernier instantané disparaisse, et le SIGNE du slerp -
 * un quaternion et son opposé décrivent la même orientation, donc interpoler
 * sans retourner le signe fait tourner un ami de 170° dans le mauvais sens.
 * Ce dernier est invisible en lisant le code et évident dans un casque.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createRoster,
  namedOnly,
  slerp,
  INTERPOLATION_DELAY_MS,
  type PeerPose,
  type Pose
} from '../../frontend/src/lib/vr/lobby/roster.js';

const IDENTITY: Pose = [0, 0, 0, 0, 0, 0, 1];

function head(x: number, y = 0, z = 0): Pose {
  return [x, y, z, 0, 0, 0, 1];
}

test('un ami inconnu apparaît dès le premier instantané, à sa pose brute', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(1), left: null, right: null }] }, 1000);

  const shown = roster.at(1000 + INTERPOLATION_DELAY_MS);
  assert.equal(shown.size, 1);
  assert.deepEqual([...shown.get('a')!.head], [...head(1)]);
});

test('entre deux instantanés, la position est interpolée à mi-chemin', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(2), left: null, right: null }] }, 1100);

  // On dessine à `now - DELAY`. Pour viser 1050, soit le milieu, il faut
  // demander 1050 + DELAY.
  const shown = roster.at(1050 + INTERPOLATION_DELAY_MS);
  assert.ok(Math.abs(shown.get('a')!.head[0] - 1) < 1e-6, `attendu 1, reçu ${shown.get('a')!.head[0]}`);
});

test("le retard d'interpolation est réel : sans lui on verrait déjà la pose la plus récente", () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(2), left: null, right: null }] }, 1100);

  // À l'instant 1100 SANS retard on verrait x = 2. Avec le retard, on regarde
  // 1000 : la plus ancienne des deux.
  const shown = roster.at(1100);
  assert.ok(Math.abs(shown.get('a')!.head[0] - 0) < 1e-6, `attendu 0, reçu ${shown.get('a')!.head[0]}`);
});

test('au-delà du dernier instantané, on tient la dernière pose sans extrapoler', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(2), left: null, right: null }] }, 1100);

  // Très loin dans le futur : extrapoler enverrait l'ami à l'infini.
  const shown = roster.at(9000);
  assert.equal(shown.get('a')!.head[0], 2);
});

test('un ami absent du dernier instantané a quitté le lobby', () => {
  const roster = createRoster();
  roster.accept(
    {
      peers: [
        { id: 'a', head: head(0), left: null, right: null },
        { id: 'b', head: head(1), left: null, right: null }
      ]
    },
    1000
  );
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1100);

  const shown = roster.at(1100 + INTERPOLATION_DELAY_MS);
  assert.ok(shown.has('a'));
  assert.ok(!shown.has('b'), 'b est absent du dernier instantané, donc parti');
});

test('un instantané plus ancien que le précédent est ignoré', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(5), left: null, right: null }] }, 1100);
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);

  const shown = roster.at(1100 + INTERPOLATION_DELAY_MS);
  assert.equal(shown.get('a')!.head[0], 5, "l'instantané en retard ne doit pas remonter le temps");
});

test('une main absente le reste', () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: IDENTITY, right: null }] }, 1000);

  const shown = roster.at(1000 + INTERPOLATION_DELAY_MS);
  assert.notEqual(shown.get('a')!.left, null);
  assert.equal(shown.get('a')!.right, null);
});

test("une main qui apparaît entre deux instantanés n'est pas interpolée depuis rien", () => {
  const roster = createRoster();
  roster.accept({ peers: [{ id: 'a', head: head(0), left: null, right: null }] }, 1000);
  roster.accept({ peers: [{ id: 'a', head: head(0), left: head(3), right: null }] }, 1100);

  const shown = roster.at(1050 + INTERPOLATION_DELAY_MS);
  // Interpoler depuis `null` donnerait NaN ou l'origine : la main doit
  // simplement prendre sa valeur d'arrivée.
  assert.deepEqual([...shown.get('a')!.left!], [...head(3)]);
});

test('le slerp prend le chemin court, même quand les quaternions sont de signes opposés', () => {
  // 170° autour de Y, et le MÊME angle écrit avec le quaternion opposé.
  const angle = (170 * Math.PI) / 180;
  const a: Pose = [0, 0, 0, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
  // L'opposé terme à terme de la partie rotation : la MÊME orientation, écrite
  // avec l'autre signe. Rien dans les nombres ne dit lequel des deux on reçoit.
  const b: Pose = [0, 0, 0, -a[3], -a[4], -a[5], -a[6]];

  const mid = slerp(a, b, 0.5);
  // a et b décrivent la MÊME orientation : toute interpolation entre eux doit
  // y rester. Sans le retournement de signe, le milieu part à l'opposé.
  const dot = mid[3] * a[3] + mid[4] * a[4] + mid[5] * a[5] + mid[6] * a[6];
  assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-6, `le milieu a quitté l'orientation : dot=${dot}`);
});

test('le slerp interpole bien un demi-tour en deux quarts', () => {
  const half = Math.PI / 2;
  const a: Pose = [0, 0, 0, 0, 0, 0, 1];
  const b: Pose = [0, 0, 0, 0, Math.sin(half / 2), 0, Math.cos(half / 2)];

  const mid = slerp(a, b, 0.5);
  const quarter = Math.PI / 4;
  assert.ok(Math.abs(mid[4] - Math.sin(quarter / 2)) < 1e-6, `y=${mid[4]}`);
  assert.ok(Math.abs(mid[6] - Math.cos(quarter / 2)) < 1e-6, `w=${mid[6]}`);
});

test('le slerp rend un quaternion unitaire', () => {
  const a: Pose = [0, 0, 0, 0, 0, 0, 1];
  const angle = (120 * Math.PI) / 180;
  const b: Pose = [0, 0, 0, Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];

  const mid = slerp(a, b, 0.37);
  const norm = Math.hypot(mid[3], mid[4], mid[5], mid[6]);
  assert.ok(Math.abs(norm - 1) < 1e-6, `norme=${norm}`);
});

/*
 * `namedOnly` : la garantie qu'aucun inconnu n'apparaît dans le lobby de
 * personne.
 *
 * C'est une règle de SÉCURITÉ, et elle vivait dans la boucle de dessin -
 * c'est-à-dire dans le seul module du lobby qu'aucun test ne peut exécuter,
 * puisqu'il importe three. Une garantie invérifiable n'en est pas une.
 */
function posed(x: number): PeerPose {
  return { head: head(x), left: null, right: null };
}

test("un identifiant qu'on ne sait pas nommer est écarté", () => {
  const peers = new Map<string, PeerPose>([
    ['ami', posed(1)],
    ['inconnu', posed(2)]
  ]);

  const named = namedOnly(peers, (id) => (id === 'ami' ? 'Mario' : null));
  assert.deepEqual([...named.keys()], ['ami']);
  assert.equal(named.get('ami')!.pseudo, 'Mario');
});

test("l'écart est total : un inconnu n'est pas non plus rendu invisible", () => {
  // La distinction compte : « absent de la carte » veut dire qu'aucun maillage
  // ne sera construit pour lui, et non qu'on en construira un qu'on masquera.
  const peers = new Map<string, PeerPose>([['inconnu', posed(1)]]);
  assert.equal(namedOnly(peers, () => null).size, 0);
});

test('la pose traverse le filtre intacte', () => {
  const peers = new Map<string, PeerPose>([['ami', posed(3)]]);
  const named = namedOnly(peers, () => 'Luigi');
  assert.deepEqual([...named.get('ami')!.pose.head], [...head(3)]);
});

test("un pseudo vide est un nom connu, pas une absence de nom", () => {
  // Seul `null` écarte. Un pseudo vide viendrait d'ailleurs - d'une donnée
  // abîmée, pas d'un ami inconnu - et le faire disparaître ici cacherait ce
  // défaut-là derrière la règle de sécurité.
  const peers = new Map<string, PeerPose>([['ami', posed(1)]]);
  assert.equal(namedOnly(peers, () => '').size, 1);
});

test('une carte vide reste vide, sans consulter la liste d’amis', () => {
  let asked = 0;
  const named = namedOnly(new Map(), () => {
    asked += 1;
    return 'Mario';
  });
  assert.equal(named.size, 0);
  assert.equal(asked, 0);
});
