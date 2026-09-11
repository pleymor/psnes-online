/**
 * Where the scene sits, and why it needs re-deciding.
 *
 * `layout.ts` says every distance is measured from the player's eyes, and
 * means it: `xr-session.ts` asks for the `local` reference space, whose origin
 * is the head's pose when the session opens, so y = 0 is eye level. What none
 * of that says out loud is that the claim is true for one instant only - the
 * session is granted while the Quest's boundary dialog is up, while the player
 * is still moving and the tracking is still settling, and the scene is nailed
 * to wherever the head happened to be. Reported from inside the headset as the
 * room being "sometimes far in front".
 *
 * So the anchor becomes a decision the app makes, more than once, and this
 * module is the arithmetic behind it.
 *
 * Yaw ONLY. Carrying the pitch would tip the whole room back with the
 * player's head and carrying the roll would bank it, and neither is anything
 * anybody asked for - the same mistake `panel-mesh.ts` documents about
 * rotation order, in a different place.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { anchorFrom, roomAnchor } from '../../frontend/src/lib/vr/anchor.js';

/** A quaternion for a rotation of `angle` radians about `axis`. */
function quat(axis: [number, number, number], angle: number): [number, number, number, number] {
  const half = angle / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
const HERE: [number, number, number] = [0, 0, 0];
const close = (a: number, b: number, why: string) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} vs ${b}`);

test('a head facing down -Z anchors at no rotation at all', () => {
  // three's convention, the one `layout.ts` is written in: the player looks
  // down -Z, +X is their right, +Y up.
  const anchor = anchorFrom(HERE, IDENTITY);
  close(anchor.yaw, 0, 'facing forward is yaw zero');
});

test('the position is taken as it is, because eye level is the whole point', () => {
  const anchor = anchorFrom([1.5, -0.2, 3], IDENTITY);
  assert.deepEqual(anchor.position, [1.5, -0.2, 3]);
});

test('a turned head carries its yaw', () => {
  for (const degrees of [15, 90, 179, -45, -120]) {
    const radians = (degrees * Math.PI) / 180;
    close(anchorFrom(HERE, quat([0, 1, 0], radians)).yaw, radians, `${degrees} degrees`);
  }
});

/*
 * Pitch and roll are discarded, which is the point of the whole function.
 *
 * A player looking up while the anchor is taken must not get a room tipped
 * back at them, and one with their head on one side must not get a banked one.
 * The scene's own geometry already decides how it faces the eyes -
 * `layout.ts`'s lecterns are tipped 40 degrees on purpose.
 */
test('a pitched head anchors to the same yaw as a level one', () => {
  const level = anchorFrom(HERE, quat([0, 1, 0], 0.7));
  for (const pitch of [0.4, -0.4, 1.0, -1.0]) {
    // Yaw then pitch, which is the order a head actually moves in.
    const q = multiply(quat([0, 1, 0], 0.7), quat([1, 0, 0], pitch));
    close(anchorFrom(HERE, q).yaw, level.yaw, `pitch ${pitch} leaked into the yaw`);
  }
});

test('a rolled head anchors to the same yaw too', () => {
  const level = anchorFrom(HERE, quat([0, 1, 0], -1.1));
  for (const roll of [0.3, -0.3, 0.9]) {
    const q = multiply(quat([0, 1, 0], -1.1), quat([0, 0, 1], roll));
    close(anchorFrom(HERE, q).yaw, level.yaw, `roll ${roll} leaked into the yaw`);
  }
});

/*
 * Straight up and straight down, which is where the obvious arithmetic breaks.
 *
 * Yaw is read from where the forward vector points once flattened onto the
 * floor - and a head looking straight down has no flattened forward vector at
 * all, it projects to a point. Taking `atan2(0, 0)` there would silently
 * answer zero and snap the whole room to face -Z, which from inside a headset
 * looks like the room having jumped for no reason. The rotated UP vector is
 * what still carries a direction in that pose, so it is used instead.
 */
test('a head looking straight down still anchors to the way it was facing', () => {
  const q = multiply(quat([0, 1, 0], 0.9), quat([1, 0, 0], -Math.PI / 2));
  close(anchorFrom(HERE, q).yaw, 0.9, 'looking at your feet lost the yaw');
});

test('a head looking straight up does too, and not backwards', () => {
  const q = multiply(quat([0, 1, 0], 0.9), quat([1, 0, 0], Math.PI / 2));
  close(anchorFrom(HERE, q).yaw, 0.9, 'looking at the ceiling flipped the room around');
});

test('very nearly straight down is not a discontinuity either', () => {
  const almost = multiply(quat([0, 1, 0], 0.9), quat([1, 0, 0], -Math.PI / 2 + 0.02));
  close(anchorFrom(HERE, almost).yaw, 0.9, 'the fallback and the main path disagree');
});

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

/** Hamilton product, `a` then `b` applied in that order (three's `multiply`). */
function multiply(
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}
