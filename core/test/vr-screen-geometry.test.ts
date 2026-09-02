/**
 * The curved screen, and why it is not a CylinderGeometry.
 *
 * `videoSurface()` is a zero-copy view into wasm memory whose stride is fixed
 * at 512 pixels however wide the picture is - so at the usual 256, half of
 * every row is padding. `videoFrame()` repacks it tightly and pays a full copy
 * per frame for the privilege.
 *
 * This takes neither trade: the padded buffer is uploaded as a stride-wide
 * texture and the mesh's u coordinates stop at width/stride, so the padding is
 * simply never sampled. That means generating uvs, which means generating the
 * mesh, which is why this module exists - and it makes the whole thing a pure
 * function that Bun can check.
 *
 * The winding is worth a test of its own. Facing the wrong way shows an
 * invisible screen, which from inside a headset is indistinguishable from a
 * game that failed to boot.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  curvedScreenGeometry,
  visibleU
} from '../../frontend/src/lib/vr/screen-geometry.js';

const SPEC = { radius: 2.5, arc: Math.PI / 3, height: 1.2, segments: 8, uMax: 0.5 };

test('the sampled width is the visible fraction of the padded buffer', () => {
  assert.equal(visibleU(256, 512), 0.5, 'the usual case: half of every row is padding');
  assert.equal(visibleU(512, 512), 1, 'a full-width mode samples everything');
  assert.equal(visibleU(240, 512), 240 / 512);
});

test('a nonsense stride samples the whole texture rather than dividing by zero', () => {
  assert.equal(visibleU(256, 0), 1);
  assert.equal(visibleU(0, 512), 1, 'a zero width would sample nothing at all - show everything');
});

test('the mesh is two rows of columns, stitched into quads', () => {
  const { positions, uvs, indices } = curvedScreenGeometry(SPEC);
  assert.equal(positions.length, (8 + 1) * 2 * 3, 'nine columns, two rows, xyz each');
  assert.equal(uvs.length, (8 + 1) * 2 * 2);
  assert.equal(indices.length, 8 * 6, 'two triangles per quad');
});

test('every vertex is exactly on the cylinder', () => {
  const { positions } = curvedScreenGeometry(SPEC);
  for (let i = 0; i < positions.length; i += 3) {
    const distance = Math.hypot(positions[i], positions[i + 2]);
    assert.ok(
      Math.abs(distance - SPEC.radius) < 1e-6,
      `vertex ${i / 3} sits at ${distance}, not on a ${SPEC.radius} m radius`
    );
  }
});

test('the arc is centred on straight ahead', () => {
  const { positions } = curvedScreenGeometry(SPEC);
  const half = SPEC.arc / 2;

  // First column, bottom row.
  assert.ok(Math.abs(positions[0] - SPEC.radius * Math.sin(-half)) < 1e-6);
  assert.ok(positions[0] < 0, 'the arc starts on the player\'s left');

  // Last column, bottom row.
  const last = (8 * 2) * 3;
  assert.ok(Math.abs(positions[last] - SPEC.radius * Math.sin(half)) < 1e-6);
  assert.ok(positions[last] > 0, 'and ends on their right');
});

/**
 * A tolerance, because `positions` is a Float32Array and the expectations are
 * float64 literals.
 *
 * `SPEC.height / 2` is 0.6, which binary32 cannot hold exactly - it comes back
 * as -0.6000000238418579, 2.4e-8 away. `assert.equal` there can never pass, for
 * any correct implementation, and an earlier version of this test spent two
 * agent runs proving that. 1e-6 is thousands of times larger than the storage
 * error and still tens of thousands of times smaller than any geometry bug,
 * which would be centimetres.
 */
const NEAR = 1e-6;
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < NEAR, `${what}: ${actual} vs ${expected}`);

test('the screen is centred vertically on its own origin', () => {
  const { positions } = curvedScreenGeometry(SPEC);
  const ys: number[] = [];
  for (let i = 1; i < positions.length; i += 3) ys.push(positions[i]);
  near(Math.min(...ys), -SPEC.height / 2, 'bottom row');
  near(Math.max(...ys), SPEC.height / 2, 'top row - layout.ts places it, the mesh does not');
});

test('u stops at uMax, so the padding is never sampled', () => {
  const { uvs } = curvedScreenGeometry(SPEC);
  const us: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < uvs.length; i += 2) { us.push(uvs[i]); vs.push(uvs[i + 1]); }

  assert.equal(Math.min(...us), 0);
  assert.equal(Math.max(...us), 0.5, 'sampling past this shows 256 columns of stale memory');
  assert.equal(Math.min(...vs), 0);
  assert.equal(Math.max(...vs), 1);
});

test('the bottom row carries v = 0 and the top row v = 1', () => {
  const { positions, uvs } = curvedScreenGeometry(SPEC);
  // Vertex 0 is the first column's bottom, vertex 1 its top.
  near(positions[1], -SPEC.height / 2, "vertex 0 is column 0's bottom");
  assert.equal(uvs[1], 0);
  near(positions[4], SPEC.height / 2, "vertex 1 is column 0's top");
  assert.equal(uvs[3], 1);
});

test('the front face is the one the player is standing in front of', () => {
  const { positions, indices } = curvedScreenGeometry({ ...SPEC, segments: 2 });
  const at = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];

  const [a, b, c] = [at(indices[0]), at(indices[1]), at(indices[2])];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  // Cross product, which is the face normal for three's default CCW winding.
  const nz = ab[0] * ac[1] - ab[1] * ac[0];

  assert.ok(
    nz > 0,
    'the normal must have a +Z component: the player is at the origin looking down -Z, ' +
      'and a screen wound the other way is invisible - which reads as a game that never booted'
  );
});
