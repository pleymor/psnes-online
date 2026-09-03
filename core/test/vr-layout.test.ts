/**
 * Where the screen and the three panels sit, and why it is a pure function.
 *
 * None of these numbers will be right first time - they are reasoned starting
 * points, not measurements, and the only way to settle them is a headset on a
 * head. Keeping them in one module with no three.js import is what makes
 * tuning them a one-file change instead of a hunt through scene code.
 *
 * What the tests pin is not the numbers but the relationships that make the
 * "cockpit" layout the thing that was chosen: the panels are nearer than the
 * screen (legibility follows angular distance, which is what ruled out putting
 * all three on one 3 m arc), they are below eye level, and they are exact
 * mirrors. Break any of those and it is a different design.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneLayout } from '../../frontend/src/lib/vr/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('layout.ts imports nothing from three', () => {
  // The whole point of this module is that it is tunable and testable without
  // a renderer. A stray `import * as THREE` here would take both away, and it
  // is the sort of import that arrives while adding "just one Vector3".
  const source = readFileSync(
    path.resolve(here, '..', '..', 'frontend', 'src', 'lib', 'vr', 'layout.ts'),
    'utf8'
  );
  assert.equal(/from ['"]three['"]/.test(source), false, 'layout.ts must stay three-free');
});

test('the screen is a wide arc at arm-and-then-some length', () => {
  const { screen } = sceneLayout('crt');
  assert.equal(screen.radius, 2.5);
  assert.ok(screen.arc > 0.9 && screen.arc < 1.2, 'about 60 degrees of arc, in radians');
  assert.equal(screen.centerY, 0, 'straight ahead: y is measured from the eyes');
});

test('the screen takes its shape from the aspect preference', () => {
  const crt = sceneLayout('crt').screen;
  const square = sceneLayout('square').screen;

  // Arc length is the screen's width; the height follows the ratio the player
  // chose, so 'crt' is the 4:3 the games were composed for.
  const crtWidth = crt.radius * crt.arc;
  const squareWidth = square.radius * square.arc;
  assert.ok(Math.abs(crtWidth / crt.height - 4 / 3) < 1e-9);
  assert.ok(Math.abs(squareWidth / square.height - 8 / 7) < 1e-9);
  assert.ok(crt.height < square.height, '4:3 is a shorter picture than 8:7 at one width');
});

test('the panels are nearer than the screen, which is the whole of the choice', () => {
  const { screen, library, friends, profile } = sceneLayout('crt');
  for (const [name, panel] of [['library', library], ['friends', friends], ['profile', profile]] as const) {
    const [x, , z] = panel.position;
    const distance = Math.hypot(x, z);
    assert.ok(
      distance < screen.radius,
      `${name} must be nearer than the screen: legibility follows angular distance`
    );
  }
});

test('the panels sit below eye level, to be found by looking down', () => {
  const eye = 1.75;
  const { library, friends, profile } = sceneLayout('crt', eye);
  assert.ok(library.position[1] < eye);
  assert.ok(friends.position[1] < eye);
  assert.ok(profile.position[1] < library.position[1], 'the band is the lowest: it is used least');
});

test('the two lecterns are exact mirrors', () => {
  const { library, friends } = sceneLayout('crt');
  // A tolerance rather than equality: these come out of Math.sin and Math.cos,
  // whose exact sign symmetry is not something the language guarantees. A
  // picometre of asymmetry is not a layout bug; a centimetre would be, and
  // this still catches that.
  const mirrors = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);

  mirrors(library.position[0], -friends.position[0], 'library left, friends right');
  mirrors(library.position[1], friends.position[1], 'same height');
  mirrors(library.position[2], friends.position[2], 'same depth');
  mirrors(library.rotation[1], -friends.rotation[1], 'each yaws inward by the same amount');
  mirrors(library.rotation[0], friends.rotation[0], 'both pitch back identically');
  assert.equal(library.width, friends.width);
  assert.equal(library.height, friends.height);
});

test('everything is in front of the player', () => {
  const layout = sceneLayout('crt');
  for (const panel of [layout.library, layout.friends, layout.profile]) {
    assert.ok(panel.position[2] < 0, 'three.js looks down -Z; a positive z is behind the head');
  }
});

test('the lecterns pitch back so a lowered panel faces raised eyes', () => {
  const { library } = sceneLayout('crt');
  assert.ok(library.rotation[0] < 0, 'a negative pitch tips the top away and the face upward');
  assert.ok(Math.abs(library.rotation[0]) > 0.5, 'and by a real amount, not a token degree');
});

test('every height is measured from the eyes, never from a floor', () => {
  /*
   * `local` puts the origin at the head, so a positive y would hang the scene
   * above the player's gaze - which is exactly what the old floor-relative
   * numbers did whenever the fallback fired, and nobody ever saw it because
   * the Quest always granted the floor.
   */
  const layout = sceneLayout('crt');
  assert.equal(layout.screen.centerY, 0);

  for (const [name, placement] of [
    ['library', layout.library],
    ['friends', layout.friends],
    ['profile', layout.profile]
  ] as const) {
    assert.ok(placement.position[1] < 0, `${name} hangs above the eyes instead of below them`);
    assert.ok(
      placement.position[1] > -1.2,
      `${name} is down where a floor would be, which is what this change removed`
    );
  }
});
