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
import {
  sceneLayout,
  eyeDistance,
  angularWidth,
  pixelsPerDegree,
  QUEST_3_PIXELS_PER_DEGREE
} from '../../frontend/src/lib/vr/layout.js';
import { LIBRARY_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/library.js';
import { FRIENDS_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/friends.js';
import { PROFILE_PANEL_SIZE } from '../../frontend/src/lib/vr/panels/profile.js';

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

/*
 * A panel's metres and its canvas pixels have to be the same shape.
 *
 * `panel-mesh.ts` maps each canvas onto its plane with uv 0..1 on both axes,
 * so the two aspect ratios multiply: a 0.7 x 0.5 m lectern carrying an
 * 800 x 600 canvas stretches every glyph horizontally by 1.4 / 1.3333, which
 * is five per cent. Small, invisible as a defect, and it makes all the text
 * very slightly wrong everywhere - which is the sort of thing that reads as
 * "the fonts look off in VR" and never gets diagnosed.
 *
 * The band was already exact. The lecterns were not, and this test is what
 * keeps the next edit to either number honest, since nothing else connects
 * `layout.ts` to the panel modules' canvas sizes.
 */
test('every panel is shaped like its own canvas, or its text is stretched', () => {
  const { library, friends, profile } = sceneLayout('crt');

  const pairs = [
    ['library', library, LIBRARY_PANEL_SIZE],
    ['friends', friends, FRIENDS_PANEL_SIZE],
    ['profile', profile, PROFILE_PANEL_SIZE]
  ] as const;

  for (const [name, placement, canvas] of pairs) {
    const metres = placement.width / placement.height;
    const pixels = canvas.width / canvas.height;
    assert.ok(
      Math.abs(metres / pixels - 1) < 0.002,
      `${name} is ${(metres / pixels).toFixed(4)}x wider in metres than in pixels`
    );
  }
});

/*
 * Angular size, which is the only thing legibility answers to.
 *
 * This file's header already says it - "legibility follows angular distance,
 * which is what ruled out putting all three on one 3 m arc" - but nothing
 * measured it, and the lecterns were reported from inside a headset as too
 * small to read without leaning in. At 30 degrees of view an 18px title on an
 * 800px canvas lands around ten display pixels of cap height on a Quest 3,
 * and ten is not enough. Hence a floor on the angle.
 *
 * `eyeDistance` gets its own test because getting it wrong is easy and I did:
 * `LECTERN_DISTANCE` is the HORIZONTAL radius, and the drop is the other leg
 * of the triangle, so the panel is further from the eyes than that constant
 * says. Every angle computed from the radius alone is overstated.
 */
test('the distance to a panel counts the drop, not just the radius', () => {
  const { library, profile } = sceneLayout('crt');

  // A lectern 1.06 out and 0.45 down is 1.15 away, not 1.06.
  const [x, y, z] = library.position;
  assert.ok(Math.abs(eyeDistance(library) - Math.hypot(x, y, z)) < 1e-9);
  assert.ok(
    eyeDistance(library) > Math.hypot(x, z),
    'a panel below eye level is further away than its radius'
  );

  // The band is straight ahead and well below, so its drop dominates even more.
  assert.ok(eyeDistance(profile) > 1.2);
});

test('the lecterns are wide enough in view to be read from where they sit', () => {
  const { library, friends } = sceneLayout('crt');

  for (const [name, panel] of [['library', library], ['friends', friends]] as const) {
    assert.ok(
      angularWidth(panel) >= 40,
      `${name} spans only ${angularWidth(panel).toFixed(1)} degrees, which reads as too small`
    );
  }
});

/*
 * And the canvas has to match the headset, in both directions.
 *
 * Under the display's own figure and the canvas is the limit: the text is
 * magnified and soft, which is the trap in enlarging a panel's metres without
 * enlarging its canvas. Far over it and the pixels are drawn and thrown away -
 * which is also what made mipmaps on these panels a pure loss, since there was
 * no detail below the display's reach for them to protect.
 *
 * A band rather than a target, because neither end is a cliff.
 */
test('every panel carries about as many canvas pixels as the headset can show', () => {
  const layout = sceneLayout('crt');
  const pairs = [
    ['library', layout.library, LIBRARY_PANEL_SIZE],
    ['friends', layout.friends, FRIENDS_PANEL_SIZE],
    ['profile', layout.profile, PROFILE_PANEL_SIZE]
  ] as const;

  for (const [name, placement, canvas] of pairs) {
    const ratio = pixelsPerDegree(placement, canvas) / QUEST_3_PIXELS_PER_DEGREE;
    assert.ok(
      ratio > 0.85 && ratio < 1.15,
      `${name} carries ${ratio.toFixed(3)}x the headset's pixels per degree`
    );
  }
});
