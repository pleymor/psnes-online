/**
 * Une manette Bluetooth, lue depuis une session immersive.
 *
 * Le canal est certain, et c'est la spec qui le dit : le module Gamepads de
 * WebXR interdit d'exposer comme source d'entrée XR un périphérique qui
 * n'appartient pas au casque - « the majority of traditional gamepads » y est
 * nommément. Une manette Bluetooth n'arrive donc JAMAIS dans
 * `session.inputSources`, et réciproquement les manettes Touch n'arrivent
 * jamais dans `navigator.getGamepads()`. Les deux canaux sont disjoints par
 * construction, ce qui est exactement ce qui rend la fusion des deux masques
 * sûre : aucun bouton ne peut être compté deux fois.
 *
 * Ce que cette lecture N'invente pas, c'est le mapping. Elle lit la table de la
 * page plate - celle que le joueur configure sur grand écran et que son compte
 * porte - et pas la table VR, qui n'a que huit boutons parce que la croix y vit
 * sur les sticks. C'est précisément ce qui fait marcher les directions : la
 * table plate en a douze, et son défaut lie chaque direction à la croix ET au
 * stick gauche.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  readBluetoothPad,
  bluetoothPadName
} from '../../frontend/src/lib/vr/bt-pad.js';
import { STANDARD_PAD, clonePad } from '../../frontend/src/lib/controls/binding.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

/** Une manette au mapping `standard` : 16 boutons, 4 axes. */
function pad(over: {
  buttons?: number[];
  axes?: number[];
  connected?: boolean;
  id?: string;
  mapping?: string;
} = {}) {
  const pressed = new Set(over.buttons ?? []);
  const axes = [0, 0, 0, 0];
  (over.axes ?? []).forEach((value, index) => (axes[index] = value));
  return {
    connected: over.connected ?? true,
    id: over.id ?? '8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)',
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.has(i) })),
    axes,
    mapping: over.mapping ?? 'standard'
  };
}

test('les quatre directions marchent, par la croix comme par le stick', () => {
  // C'est LA question qui a décidé de réutiliser la table plate : la table VR
  // n'a pas de directions du tout.
  const dpad = [
    [12, PAD.UP], [13, PAD.DOWN], [14, PAD.LEFT], [15, PAD.RIGHT]
  ] as const;
  for (const [button, bit] of dpad) {
    assert.equal(
      readBluetoothPad([pad({ buttons: [button] })], STANDARD_PAD, 'visible'),
      bit,
      `le bouton ${button} de la croix ne donne pas sa direction`
    );
  }

  assert.equal(readBluetoothPad([pad({ axes: [0, -1] })], STANDARD_PAD, 'visible'), PAD.UP);
  assert.equal(readBluetoothPad([pad({ axes: [0, 1] })], STANDARD_PAD, 'visible'), PAD.DOWN);
  assert.equal(readBluetoothPad([pad({ axes: [-1, 0] })], STANDARD_PAD, 'visible'), PAD.LEFT);
  assert.equal(readBluetoothPad([pad({ axes: [1, 0] })], STANDARD_PAD, 'visible'), PAD.RIGHT);
});

test('les huit boutons marchent aussi', () => {
  const expected = [
    [1, PAD.A], [0, PAD.B], [3, PAD.X], [2, PAD.Y],
    [4, PAD.L], [5, PAD.R], [9, PAD.START], [8, PAD.SELECT]
  ] as const;
  for (const [button, bit] of expected) {
    assert.equal(
      readBluetoothPad([pad({ buttons: [button] })], STANDARD_PAD, 'visible'),
      bit,
      `le bouton ${button} ne donne pas son masque`
    );
  }
});

test('plusieurs entrées tenues donnent un seul masque', () => {
  const mask = readBluetoothPad(
    [pad({ buttons: [1, 0, 12] })],
    STANDARD_PAD,
    'visible'
  );
  assert.equal(mask, PAD.A | PAD.B | PAD.UP);
});

test('rien de tenu, rien de rendu', () => {
  assert.equal(readBluetoothPad([pad()], STANDARD_PAD, 'visible'), 0);
  assert.equal(readBluetoothPad([], STANDARD_PAD, 'visible'), 0);
  assert.equal(readBluetoothPad([null], STANDARD_PAD, 'visible'), 0);
});

test('une manette déconnectée ne tient rien', () => {
  // `getGamepads()` garde ses créneaux : une manette éteinte reste dans le
  // tableau avec ses derniers boutons, et sans ce filtre elle les tiendrait
  // pour le reste de la session.
  const off = pad({ buttons: [1, 12], connected: false });
  assert.equal(readBluetoothPad([off], STANDARD_PAD, 'visible'), 0);
});

test('le menu système ne soude pas un bouton', () => {
  // La même règle que `readVrPad` : la boucle continue de tourner et les
  // entrées cessent d'arriver, donc un bouton tenu à cet instant resterait
  // tenu pour le reste de la partie.
  const held = [pad({ buttons: [1] })];
  assert.equal(readBluetoothPad(held, STANDARD_PAD, 'visible-blurred'), 0);
  assert.equal(readBluetoothPad(held, STANDARD_PAD, 'hidden'), 0);
  assert.equal(readBluetoothPad(held, STANDARD_PAD, 'visible'), PAD.A);
});

test('une table remappée est celle qui décide', () => {
  // Le joueur configure sa manette sur la page plate, sur grand écran. La VR
  // n'a pas sa propre table pour elle, et c'est tout l'intérêt.
  const custom = clonePad(STANDARD_PAD);
  custom.a = ['PadButton0'];
  custom.b = ['PadButton1'];

  assert.equal(readBluetoothPad([pad({ buttons: [0] })], custom, 'visible'), PAD.A);
  assert.equal(readBluetoothPad([pad({ buttons: [1] })], custom, 'visible'), PAD.B);
});

test('un bouton sans binding ne rend rien', () => {
  const bare = clonePad(STANDARD_PAD);
  bare.a = [];
  assert.equal(readBluetoothPad([pad({ buttons: [1] })], bare, 'visible'), 0);
});

test('deux manettes branchées comptent toutes les deux', () => {
  // Personne ne joue à deux sur un casque, mais un dongle oublié est un
  // créneau de plus : ignorer les suivantes rendrait la deuxième manette
  // muette sans rien dire.
  const mask = readBluetoothPad(
    [pad({ buttons: [1] }), pad({ buttons: [12] })],
    STANDARD_PAD,
    'visible'
  );
  assert.equal(mask, PAD.A | PAD.UP);
});

test('le nom de la manette est celui que le casque annonce', () => {
  assert.equal(bluetoothPadName([pad({ id: '8BitDo SN30' })]), '8BitDo SN30');
  assert.equal(bluetoothPadName([]), null, 'aucune manette');
  assert.equal(bluetoothPadName([null]), null);
  assert.equal(
    bluetoothPadName([pad({ connected: false })]),
    null,
    'une manette éteinte n est pas une manette détectée'
  );
  // La première connectée : le panneau n'a la place que d'un nom.
  assert.equal(
    bluetoothPadName([pad({ connected: false }), pad({ id: 'Xbox Wireless' })]),
    'Xbox Wireless'
  );
});

test('une manette XR ici serait lue deux fois : elle est ecartee', () => {
  /*
   * La spec interdit qu'une manette Touch apparaisse dans `getGamepads()`, et
   * ce test protege contre un navigateur qui l'y mettrait quand meme. La panne
   * evitee est silencieuse : les indices de la table plate appliques a une
   * manette Touch produiraient des pressees fantomes, sans erreur ni trace, en
   * plus du masque que `readVrPad` produit deja pour la meme main.
   */
  const touch = pad({ buttons: [1, 12], mapping: 'xr-standard' });
  assert.equal(readBluetoothPad([touch], STANDARD_PAD, 'visible'), 0);
  assert.equal(bluetoothPadName([touch]), null, 'et elle ne s annonce pas comme manette');
});

test('une manette au mapping inconnu est lue quand meme', () => {
  // Une chaine vide veut dire « indices non garantis », ce qui est exactement
  // le cas que le joueur regle a la main sur la page plate. L'ecarter
  // reprendrait ce que la page plate accepte deja.
  const exotic = pad({ buttons: [1], mapping: '' });
  assert.equal(readBluetoothPad([exotic], STANDARD_PAD, 'visible'), PAD.A);
});
