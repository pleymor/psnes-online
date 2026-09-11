/**
 * Turning a PPU priority byte back into the name of a layer.
 *
 * This is the piece that makes a per-game depth setting mean anything. The
 * core hands over one byte per pixel, and that byte is `D + priority`, where
 * the priority a background gets is chosen by the BG mode: in mode 1 BG1 is
 * 15/11 and BG2 14/10, but in mode 3 BG1 is 15/7 and BG2 11/3. So 43 (that is,
 * 32 + 11) is BG1 in one mode and BG2 in the other, and a table of distances
 * keyed on the raw byte silently means something different per game.
 *
 * Every constant below is read off the DO_BG table in snes9x's gfx.cpp and the
 * Mode 7 renderers in tile.c. The values in `readFromMario` are not from that
 * table - they were measured out of a running frame, and they are here so that
 * a change to the table has to survive contact with a real game.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  layerOf,
  layerTable,
  slotKey,
  slotOf,
  slotTable,
  VR_LAYERS,
  VR_SLOT_KEYS
} from '../../frontend/src/lib/vr/layer-map.js';

const keyOf = (byte: number, mode: number, bg3Priority: boolean) => {
  const slot = slotOf(byte, mode, bg3Priority);
  return slot ? slotKey(slot) : null;
};

const MAIN = 32; // D for the main screen, and for the subscreen when $2130 bit 1 is set

test('mode 1 separates the three backgrounds and the sprites', () => {
  assert.equal(layerOf(MAIN + 15, 1, false), 'bg1');
  assert.equal(layerOf(MAIN + 11, 1, false), 'bg1');
  assert.equal(layerOf(MAIN + 14, 1, false), 'bg2');
  assert.equal(layerOf(MAIN + 10, 1, false), 'bg2');
  assert.equal(layerOf(MAIN + 7, 1, false), 'bg3');
  assert.equal(layerOf(MAIN + 3, 1, false), 'bg3');
  for (const priority of [0, 1, 2, 3]) {
    assert.equal(layerOf(MAIN + 4 + 4 * priority, 1, false), 'sprite');
  }
});

test('BG3Priority moves BG3 to the front of mode 1, and only there', () => {
  assert.equal(layerOf(MAIN + 17, 1, true), 'bg3');
  // Without the flag the game never writes 17, so it names no layer at all.
  assert.equal(layerOf(MAIN + 17, 1, false), null);
  assert.equal(layerOf(MAIN + 17, 3, true), null);
});

test('the same byte names different layers in different modes', () => {
  // 43 is 32 + 11. This is the whole reason the mode has to travel with the plane.
  assert.equal(layerOf(43, 1, false), 'bg1');
  assert.equal(layerOf(43, 3, false), 'bg2');
  assert.equal(layerOf(43, 7, false), 'bg2');
});

test('mode 0 is the only one with a fourth background', () => {
  assert.equal(layerOf(MAIN + 6, 0, false), 'bg4');
  assert.equal(layerOf(MAIN + 2, 0, false), 'bg4');
  assert.equal(layerOf(MAIN + 6, 1, false), null);
});

test('mode 7 draws BG1 at one fixed depth and BG2 by pixel bit', () => {
  assert.equal(layerOf(MAIN + 7, 7, false), 'bg1');
  assert.equal(layerOf(MAIN + 11, 7, false), 'bg2');
  assert.equal(layerOf(MAIN + 3, 7, false), 'bg2');
});

test('the backdrop is the literal 1, whichever screen and mode it came from', () => {
  for (const mode of [0, 1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(layerOf(1, mode, false), 'backdrop');
  }
});

test('a subscreen with $2130 bit 1 clear numbers its layers from zero', () => {
  // D is (FillRAM[0x2130] & 2) << 4 on the subscreen: 32, or 0. The low form
  // has to name the same layers, or every game that composites through colour
  // math reads as a single flat sheet.
  assert.equal(layerOf(15, 1, false), 'bg1');
  assert.equal(layerOf(14, 1, false), 'bg2');
  assert.equal(layerOf(3, 1, false), 'bg3');
  assert.equal(layerOf(8, 1, false), 'sprite');
});

test('nothing the PPU never writes is given a layer', () => {
  assert.equal(layerOf(0, 1, false), null);
  assert.equal(layerOf(31, 1, false), null);
  assert.equal(layerOf(200, 1, false), null);
});

test('readFromMario: the bytes a real frame actually contains', () => {
  // Super Mario All-Stars, world 1-1, running in mode 1. Measured, not derived.
  const seen: Record<number, string> = {
    1: 'backdrop',
    35: 'bg3',
    42: 'bg2',
    43: 'bg1',
    44: 'sprite',
    48: 'sprite',
    49: 'bg3'
  };
  for (const [byte, layer] of Object.entries(seen)) {
    assert.equal(layerOf(Number(byte), 1, true), layer, `byte ${byte}`);
  }
});

test('one layer at two priorities is two places, not one', () => {
  // The reason slots exist. In Mario All-Stars the clouds and the status bar
  // are both BG3; putting BG3 at a single distance puts the HUD in the sky.
  assert.equal(keyOf(35, 1, true), 'bg3.lo');
  assert.equal(keyOf(49, 1, true), 'bg3.hi');
  assert.equal(layerOf(35, 1, true), layerOf(49, 1, true));
});

test('high and low are told apart for every background of a mode', () => {
  assert.equal(keyOf(MAIN + 15, 1, false), 'bg1.hi');
  assert.equal(keyOf(MAIN + 11, 1, false), 'bg1.lo');
  assert.equal(keyOf(MAIN + 14, 1, false), 'bg2.hi');
  assert.equal(keyOf(MAIN + 10, 1, false), 'bg2.lo');
  assert.equal(keyOf(MAIN + 6, 0, false), 'bg4.hi');
  assert.equal(keyOf(MAIN + 2, 0, false), 'bg4.lo');
});

test('slots the pair makes no sense for keep a single name', () => {
  assert.equal(keyOf(1, 1, false), 'backdrop');
  for (const priority of [0, 1, 2, 3]) {
    assert.equal(keyOf(MAIN + 4 + 4 * priority, 1, false), 'sprite');
  }
  // Mode 7's BG1 has one priority only, so it is not "the high one".
  assert.equal(keyOf(MAIN + 7, 7, false), 'bg1.lo');
});

test('slotTable covers every byte and falls back to the far plane', () => {
  const table = slotTable(1, true);
  assert.equal(table.length, 256);
  assert.equal(table[35], VR_SLOT_KEYS.indexOf('bg3.lo'));
  assert.equal(table[49], VR_SLOT_KEYS.indexOf('bg3.hi'));
  assert.equal(table[200], VR_SLOT_KEYS.indexOf('backdrop'));
});

test('layerTable answers for every byte a shader might sample', () => {
  const table = layerTable(1, true);
  assert.equal(table.length, 256);
  assert.equal(table[43], VR_LAYERS.indexOf('bg1'));
  assert.equal(table[1], VR_LAYERS.indexOf('backdrop'));
  // Unknown bytes fall back to the backdrop rather than to a random layer: a
  // pixel at an unexpected depth belongs at the back, where a mistake is a
  // pixel that did not move.
  assert.equal(table[200], VR_LAYERS.indexOf('backdrop'));
});
