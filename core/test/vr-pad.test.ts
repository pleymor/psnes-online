/**
 * Two Touch controllers read as one SNES pad.
 *
 * Two traps, both silent if got wrong.
 *
 * The first is `xr-standard` versus `standard`. A Touch thumbstick reports on
 * `axes[2]`/`axes[3]`; the first two axes belong to a touchpad these
 * controllers do not have. `controls/binding.ts:71-75`'s `STANDARD_PAD` steers
 * on axes 0 and 1 (`PadAxis1Minus` for up, `PadAxis0Minus` for left), so
 * reusing that table would yield a dead d-pad with no error and no warning -
 * which is exactly why this module has its own table and shares no codes with
 * `InputCollector`.
 *
 * The second is `visible-blurred`. When the Quest system menu opens, the XR
 * animation loop keeps firing but input stops being delivered. A button held at
 * that instant would stay held forever and the character would run right on its
 * own. This returns a zero mask instead - the same reasoning as
 * `InputCollector.onBlur = () => this.held.clear()` (`znet/input.ts:66`).
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  readVrPad,
  menuPressed,
  activeXrInputs,
  XR_AXIS_THRESHOLD
} from '../../frontend/src/lib/vr/pad.js';
import {
  LETTERS_MAP,
  THUMB_MAP,
  assignInput
} from '../../frontend/src/lib/vr/pad-map.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

/** An `XRInputSource`-shaped controller. `xr-standard` button order:
 *  0 trigger, 1 squeeze, 2 touchpad (absent), 3 thumbstick press,
 *  4 lower face button (A / X), 5 upper face button (B / Y). */
function controller(handedness: 'left' | 'right', opts: {
  buttons?: number[];
  stick?: [number, number];
} = {}) {
  const pressed = new Set(opts.buttons ?? []);
  const [x, y] = opts.stick ?? [0, 0];
  return {
    handedness,
    gamepad: {
      buttons: Array.from({ length: 6 }, (_, i) => ({ pressed: pressed.has(i) })),
      axes: [0, 0, x, y]
    }
  };
}

test('nothing pressed is a zero mask', () => {
  assert.equal(readVrPad([controller('left'), controller('right')], LETTERS_MAP, 'visible'), 0);
});

test('letters: what is written on the controller is what the game names', () => {
  const mask = readVrPad(
    [controller('left', { buttons: [4, 5] }), controller('right', { buttons: [4, 5] })],
    LETTERS_MAP,
    'visible'
  );
  // left lower = X -> SNES X, left upper = Y -> SNES Y,
  // right lower = A -> SNES A, right upper = B -> SNES B
  assert.equal(mask, PAD.X | PAD.Y | PAD.A | PAD.B);
});

test('letters puts the Mario jump on the upper right button', () => {
  const upperRight = readVrPad([controller('right', { buttons: [5] })], LETTERS_MAP, 'visible');
  assert.equal(upperRight, PAD.B, 'SNES B is the bottom of the diamond but the top of the hand');
});

test('thumb: the jump moves to where the thumb already rests', () => {
  const lowerRight = readVrPad([controller('right', { buttons: [4] })], THUMB_MAP, 'visible');
  assert.equal(lowerRight, PAD.B, 'Quest A carries SNES B under the thumb');

  const upperRight = readVrPad([controller('right', { buttons: [5] })], THUMB_MAP, 'visible');
  assert.equal(upperRight, PAD.A);

  const lowerLeft = readVrPad([controller('left', { buttons: [4] })], THUMB_MAP, 'visible');
  assert.equal(lowerLeft, PAD.Y, 'Quest X carries SNES Y - run, held constantly');

  const upperLeft = readVrPad([controller('left', { buttons: [5] })], THUMB_MAP, 'visible');
  assert.equal(upperLeft, PAD.X);
});

test('the preset touches only the four face buttons', () => {
  const shoulders = [
    controller('left', { buttons: [0, 1] }),
    controller('right', { buttons: [0, 1] })
  ];
  const expected = PAD.L | PAD.SELECT | PAD.R | PAD.START;
  assert.equal(readVrPad(shoulders, LETTERS_MAP, 'visible'), expected);
  assert.equal(readVrPad(shoulders, THUMB_MAP, 'visible'), expected, 'shoulders and Start are not a preference');
});

test('the d-pad comes off axes 2 and 3, never 0 and 1', () => {
  const dead = readVrPad([controller('left', { stick: [-1, -1] })], LETTERS_MAP, 'visible');
  assert.notEqual(dead, 0, 'a stick read on axes 0/1 would report nothing here');
  assert.equal(dead, PAD.LEFT | PAD.UP);

  assert.equal(
    readVrPad([controller('left', { stick: [1, 1] })], LETTERS_MAP, 'visible'),
    PAD.RIGHT | PAD.DOWN
  );
});

test('the stick has to be pushed past the threshold to count', () => {
  const under = XR_AXIS_THRESHOLD - 0.01;
  assert.equal(readVrPad([controller('left', { stick: [under, 0] })], LETTERS_MAP, 'visible'), 0);
  const over = XR_AXIS_THRESHOLD + 0.01;
  assert.equal(readVrPad([controller('left', { stick: [over, 0] })], LETTERS_MAP, 'visible'), PAD.RIGHT);
});

test('either stick steers', () => {
  // The right one too, and this is the ergonomics rather than a convenience:
  // see `steer`. Reported from actual play.
  assert.equal(readVrPad([controller('right', { stick: [-1, 0] })], LETTERS_MAP, 'visible'), PAD.LEFT);
  assert.equal(readVrPad([controller('left', { stick: [-1, 0] })], LETTERS_MAP, 'visible'), PAD.LEFT);
});

test('the right stick steers while the left thumb works the buttons', () => {
  // The whole reason for the change. With only the left stick on the d-pad,
  // SNES X and Y - which live on the left controller's face - could not be
  // pressed while moving at all.
  const both = [
    controller('right', { stick: [0, 1] }),
    controller('left', { buttons: [4, 5] })
  ];
  assert.equal(readVrPad(both, LETTERS_MAP, 'visible'), PAD.DOWN | PAD.X | PAD.Y);
});

test('two sticks pushed against each other report both directions', () => {
  // Accepted, not prevented: real hardware does the same when somebody holds
  // left and right together, and it takes a deliberate act to produce.
  const fighting = [
    controller('left', { stick: [-1, 0] }),
    controller('right', { stick: [1, 0] })
  ];
  assert.equal(readVrPad(fighting, LETTERS_MAP, 'visible'), PAD.LEFT | PAD.RIGHT);
});

test('a stick on neither hand steers nothing', () => {
  // `handedness` is still the gate. A tracked source that is neither hand can
  // carry a gamepad, and it has no business driving the d-pad.
  assert.equal(readVrPad([controller('none', { stick: [-1, 0] })], LETTERS_MAP, 'visible'), 0);
});

test('a blurred session reads as nothing held', () => {
  const held = [controller('right', { buttons: [4, 5] }), controller('left', { stick: [1, 0] })];
  assert.equal(readVrPad(held, LETTERS_MAP, 'visible'), PAD.A | PAD.B | PAD.RIGHT);
  assert.equal(readVrPad(held, LETTERS_MAP, 'visible-blurred'), 0, 'the system menu must not weld a button down');
  assert.equal(readVrPad(held, LETTERS_MAP, 'hidden'), 0);
});

test('a controller with no gamepad is skipped rather than fatal', () => {
  const sources = [
    { handedness: 'right', gamepad: null },
    { handedness: 'none' },
    controller('left', { buttons: [0] })
  ];
  assert.equal(readVrPad(sources, LETTERS_MAP, 'visible'), PAD.L);
});

test('the right thumbstick click is the way back to the panels', () => {
  assert.equal(menuPressed([controller('right', { buttons: [3] })]), true);
  assert.equal(menuPressed([controller('left', { buttons: [3] })]), false, 'the left click is Select-adjacent, not the menu');
  assert.equal(menuPressed([controller('right', { buttons: [4] })]), false);
});

/*
 * Le mapping remplace le preset : la table figée `FACE` a disparu, et ce que
 * `readVrPad` lit est désormais une permutation que le joueur peut avoir
 * construite lui-même.
 *
 * Et `activeXrInputs` répond à l'autre question - non pas « quel masque SNES »
 * mais « quelles entrées physiques » - parce que c'est celle que la capture
 * pose, et que les deux ne coïncident que par accident.
 */

test('une map personnalisée décide du masque, là où le preset décidait', () => {
  // A sur le clic du stick gauche : une entrée qu'aucun preset n'utilise, donc
  // un masque que l'ancienne table ne pouvait pas produire.
  const map = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  const mask = readVrPad([controller('left', { buttons: [3] })], map, 'visible');
  assert.equal(mask, PAD.A, 'le clic du stick gauche ne portait pas A');
});

test('l échange déplace bien les deux boutons pour de vrai', () => {
  // Pas seulement dans la map : dans le masque que la manette produit.
  const map = assignInput(LETTERS_MAP, 'a', LETTERS_MAP.r);
  assert.equal(
    readVrPad([controller('right', { buttons: [0] })], map, 'visible'),
    PAD.A,
    'la gâchette droite devait porter A après échange'
  );
  assert.equal(
    readVrPad([controller('right', { buttons: [4] })], map, 'visible'),
    PAD.R,
    'le bouton bas droit devait recevoir R en retour'
  );
});

test('activeXrInputs rend les entrées tenues, et rien d autre', () => {
  const held = activeXrInputs([
    controller('left', { buttons: [0, 1] }),
    controller('right', { buttons: [5] })
  ]);
  assert.deepEqual(
    [...held].sort(),
    ['XrLeftSqueeze', 'XrLeftTrigger', 'XrRightFaceUpper'].sort()
  );
});

test('activeXrInputs ignore le clic du stick droit, qui est le menu', () => {
  // Hors modèle : il ne peut pas être capturé, donc pas être proposé - sinon un
  // joueur pourrait se retirer le seul moyen de rappeler les panneaux.
  assert.deepEqual(activeXrInputs([controller('right', { buttons: [3] })]), []);
});

test('activeXrInputs voit le clic du stick gauche, qui est la neuvième entrée', () => {
  assert.deepEqual(activeXrInputs([controller('left', { buttons: [3] })]), ['XrLeftStickClick']);
});

test('activeXrInputs ne rend rien quand rien n est tenu', () => {
  assert.deepEqual(activeXrInputs([controller('left'), controller('right')]), []);
});

test('activeXrInputs ignore une source qui n est ni gauche ni droite', () => {
  assert.deepEqual(activeXrInputs([controller('none', { buttons: [0] })]), []);
});

test('un masque nul est ce que produit une session non visible, boutons tenus ou non', () => {
  /*
   * La garde que les deux appelants portent déjà - `!scene.arePanelsVisible()`
   * dans `VrShell` - repose sur celle-ci : le menu système laisse la boucle
   * d'animation tourner et cesse de livrer l'entrée, et un bouton tenu à cet
   * instant resterait tenu tout le reste de la session.
   *
   * C'est aussi ce qui rend inutile un argument `capturing` : la capture n'est
   * atteignable que panneaux levés, où les appelants rendent déjà zéro. Un
   * second verrou pour la même porte est un verrou dont personne ne saurait
   * lequel ouvre.
   */
  const allHeld = [
    controller('left', { buttons: [0, 1, 3, 4, 5] }),
    controller('right', { buttons: [0, 1, 4, 5] })
  ];
  for (const visibility of ['hidden', 'visible-blurred', '']) {
    assert.equal(
      readVrPad(allHeld, LETTERS_MAP, visibility),
      0,
      `visibility=${visibility} a laissé passer un masque`
    );
  }
  // Sans cette dernière ligne, un `readVrPad` qui rendrait toujours zéro
  // satisferait le test.
  assert.notEqual(
    readVrPad(allHeld, LETTERS_MAP, 'visible'),
    0,
    'le test ne prouverait rien si visible rendait zéro aussi'
  );
});
