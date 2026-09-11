/**
 * Where each SNES layer slot sits in depth, remembered per game.
 *
 * The invariants worth holding here are the ones a reader of the module would
 * not guess.
 *
 * The key is the ROM's crc32 and nothing else. The VR shell only ever has a
 * crc32 in hand - `launchFor` is one - while the database UUID exists for some
 * games and not others, so keying on the UUID would quietly lose the setting
 * for exactly the local ROMs this feature is for. That means a malformed
 * identity has to be REFUSED rather than turned into a key: a lowercase or
 * truncated crc32 that got written anyway would be a preset the player can
 * never read back, since the code that reads uses the canonical form.
 *
 * A stored preset is repaired or dropped, never half-applied. Two different
 * cases hide behind that: a preset written before a slot existed is missing a
 * field and is back-filled, exactly as `readScreenShape` back-fills `height`;
 * a preset holding a distance that is not on the ladder is unreadable and goes,
 * because an off-ladder value is a state the panel's `-`/`+` cannot leave.
 *
 * And the ladders butt at both ends. Wrapping would send a layer from the
 * front of the picture to the back plane on one click too many, which reads as
 * the effect having broken rather than as a limit.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { VR_SLOT_KEYS, type VrSlotKey } from '../../frontend/src/lib/vr/layer-map.js';
import {
  DEFAULT_RELIEF,
  RELIEF_DISTANCES,
  RELIEF_SPACINGS,
  listReliefPresets,
  readReliefPreset,
  reliefKeyFor,
  reliefRungs,
  replaceReliefPresets,
  slotDistances,
  stepSlot,
  stepSpacing,
  writeReliefPreset,
  type ReliefPreset
} from '../../frontend/src/lib/vr/relief-preset.js';

const MARIO = '4C8A5E2B';
const ZELDA = 'B1C0FFEE';

function storage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => {
      held.set(key, value);
    },
    removeItem: (key: string) => {
      held.delete(key);
    },
    get length() {
      return held.size;
    },
    key: (index: number) => [...held.keys()][index] ?? null,
    held
  };
}

function slotsOf(preset: ReliefPreset): Record<string, number> {
  return preset.slots as Record<string, number>;
}

test('every default distance is a rung, so a player can step back to it', () => {
  // An off-ladder default would be a starting point the panel cannot return to:
  // the first press of `-` or `+` would jump to a neighbouring rung and the
  // original value would be gone for good.
  assert.ok(RELIEF_SPACINGS.includes(DEFAULT_RELIEF.spacing));
  for (const key of VR_SLOT_KEYS) {
    const value = slotsOf(DEFAULT_RELIEF)[key];
    assert.equal(typeof value, 'number', `${key} has no default`);
    assert.ok(RELIEF_DISTANCES.includes(value), `${key} default ${value} is not a rung`);
  }
});

test('the default ordering is the PPU compositing order, with the HUD excepted', () => {
  const slots = slotsOf(DEFAULT_RELIEF);
  // The probe's own numbers, arrived at by hand in `tools/vr-relief`.
  assert.equal(slots['backdrop'], 0);
  assert.equal(slots['bg3.lo'], 0.05);
  assert.equal(slots['bg2.lo'], 0.1);
  assert.equal(slots['bg1.lo'], 0.15);
  assert.equal(slots['sprite'], 0.18);
  // BG3-high is the status bar trick, and a status bar belongs on the glass.
  assert.equal(slots['bg3.hi'], 0);
  // The other high halves are the same tilemap as their low half and must not
  // be torn away from it.
  assert.equal(slots['bg1.hi'], slots['bg1.lo']);
  assert.equal(slots['bg2.hi'], slots['bg2.lo']);
  assert.equal(slots['bg4.hi'], slots['bg4.lo']);
  // BG4 only exists in mode 0, where it is behind BG3.
  assert.ok(slots['bg4.lo'] < slots['bg3.lo']);
});

test('a game with nothing stored gets the default, and storing the default keeps it that way', () => {
  const store = storage();
  assert.deepEqual(readReliefPreset(store, MARIO), DEFAULT_RELIEF);

  writeReliefPreset(store, MARIO, DEFAULT_RELIEF);
  // Removed rather than written: an entry that means "the default" would sit in
  // the profile for ever, and would pin this game to today's default if the
  // default ever moved.
  assert.equal(store.held.size, 0);
  assert.deepEqual(readReliefPreset(store, MARIO), DEFAULT_RELIEF);
});

test('a changed preset round-trips, and only for the game it was written for', () => {
  const store = storage();
  const deeper = stepSlot(stepSpacing(DEFAULT_RELIEF, 1), 'sprite', 1);

  writeReliefPreset(store, MARIO, deeper);
  assert.deepEqual(readReliefPreset(store, MARIO), deeper);
  assert.deepEqual(readReliefPreset(store, ZELDA), DEFAULT_RELIEF);
});

test('a malformed crc32 is refused rather than turned into a key', () => {
  const store = storage();
  const deeper = stepSlot(DEFAULT_RELIEF, 'bg1.lo', 1);

  // Lowercase is the dangerous one: `roms/checksum.ts` upper-cases, so a
  // lowercase key would be written once and never read back.
  for (const bad of ['', '4c8a5e2b', '4C8A5E2', '4C8A5E2BB', 'ZZZZZZZZ', '4C8A5E2 ']) {
    assert.equal(reliefKeyFor(bad), null, `${bad} should not name a key`);
    writeReliefPreset(store, bad, deeper);
    assert.equal(store.held.size, 0, `${bad} was written anyway`);
    assert.deepEqual(readReliefPreset(store, bad), DEFAULT_RELIEF);
  }

  assert.equal(reliefKeyFor(MARIO), `psnes-vr-relief:${MARIO}`);
});

test('a preset written before a slot existed is back-filled, not thrown away', () => {
  // The same reasoning as `readScreenShape` and its missing `height`: the
  // player chose the spacing and the distances that are there, and taking them
  // away over a field that did not exist yet would be gratuitous.
  const store = storage({
    [`psnes-vr-relief:${MARIO}`]: JSON.stringify({ spacing: 1.5, slots: { sprite: 0.26 } })
  });

  const read = readReliefPreset(store, MARIO);
  assert.equal(read.spacing, 1.5);
  assert.equal(slotsOf(read)['sprite'], 0.26);
  assert.equal(slotsOf(read)['bg1.lo'], slotsOf(DEFAULT_RELIEF)['bg1.lo']);
  // Back-filling repairs the stored entry in memory only; nothing is rewritten
  // behind the player's back.
  assert.equal(store.held.size, 1);
});

test('a preset missing its spacing altogether is back-filled too', () => {
  const store = storage({
    [`psnes-vr-relief:${MARIO}`]: JSON.stringify({ slots: { sprite: 0.26 } })
  });
  assert.equal(readReliefPreset(store, MARIO).spacing, DEFAULT_RELIEF.spacing);
});

test('an unreadable preset is removed rather than kept', () => {
  const unreadable: Record<string, string> = {
    'not json at all': 'not json at all',
    'an array': JSON.stringify([0, 0.05, 0.1]),
    'a bare number': JSON.stringify(0.15),
    // Off the ladder: a value the panel could not step away from without first
    // landing on a neighbouring rung.
    'a distance between rungs': JSON.stringify({ spacing: 1, slots: { sprite: 0.17 } }),
    'a spacing between rungs': JSON.stringify({ spacing: 1.1, slots: {} }),
    // Behind the back plane, which would put a layer on the wrong side of the
    // backdrop and invert the PPU's own order.
    'a negative distance': JSON.stringify({ spacing: 1, slots: { sprite: -0.05 } }),
    'a string distance': JSON.stringify({ spacing: 1, slots: { sprite: '0.18' } }),
    'slots that are not an object': JSON.stringify({ spacing: 1, slots: 0.18 })
  };

  for (const [what, stored] of Object.entries(unreadable)) {
    const store = storage({ [`psnes-vr-relief:${MARIO}`]: stored });
    assert.deepEqual(readReliefPreset(store, MARIO), DEFAULT_RELIEF, what);
    assert.equal(store.held.size, 0, `${what} was kept`);
  }
});

test('one bad distance drops the whole preset rather than half of it', () => {
  // Half-applying would leave the picture in a shape the player never chose and
  // cannot see the cause of: one layer at the distance they set, its neighbour
  // silently back at the default.
  const store = storage({
    [`psnes-vr-relief:${MARIO}`]: JSON.stringify({
      spacing: 1.5,
      slots: { 'bg1.lo': 0.22, sprite: 0.175 }
    })
  });
  assert.deepEqual(readReliefPreset(store, MARIO), DEFAULT_RELIEF);
  assert.equal(store.held.size, 0);
});

test('stray keys in stored JSON do not leak out', () => {
  const store = storage({
    [`psnes-vr-relief:${MARIO}`]: JSON.stringify({
      spacing: 1,
      slots: { sprite: 0.26, 'bg5.lo': 0.3 },
      curved: true,
      note: 'from some future build'
    })
  });

  const read = readReliefPreset(store, MARIO);
  assert.deepEqual(Object.keys(read).sort(), ['slots', 'spacing']);
  // The slot table is rebuilt from `VR_SLOT_KEYS`, so a slot this build does
  // not know about cannot reach the shader as an index into nothing.
  assert.deepEqual(Object.keys(read.slots).sort(), [...VR_SLOT_KEYS].sort());
  assert.equal(slotsOf(read)['sprite'], 0.26);
});

test('both ends of both ladders butt instead of wrapping', () => {
  const bottom = RELIEF_DISTANCES[0];
  const top = RELIEF_DISTANCES[RELIEF_DISTANCES.length - 1];

  for (const key of VR_SLOT_KEYS) {
    let preset = DEFAULT_RELIEF;
    for (let press = 0; press < RELIEF_DISTANCES.length + 3; press++) preset = stepSlot(preset, key, -1);
    assert.equal(slotsOf(preset)[key], bottom, `${key} did not stop at the bottom`);

    for (let press = 0; press < RELIEF_DISTANCES.length * 2 + 3; press++) preset = stepSlot(preset, key, 1);
    assert.equal(slotsOf(preset)[key], top, `${key} did not stop at the top`);
  }

  let preset = DEFAULT_RELIEF;
  for (let press = 0; press < RELIEF_SPACINGS.length + 3; press++) preset = stepSpacing(preset, -1);
  assert.equal(preset.spacing, RELIEF_SPACINGS[0]);
  for (let press = 0; press < RELIEF_SPACINGS.length * 2 + 3; press++) preset = stepSpacing(preset, 1);
  assert.equal(preset.spacing, RELIEF_SPACINGS[RELIEF_SPACINGS.length - 1]);
});

test('stepping one slot leaves every other slot and the spacing alone', () => {
  const stepped = stepSlot(DEFAULT_RELIEF, 'bg2.lo', 1);
  assert.equal(stepped.spacing, DEFAULT_RELIEF.spacing);
  for (const key of VR_SLOT_KEYS) {
    if (key === 'bg2.lo') continue;
    assert.equal(slotsOf(stepped)[key], slotsOf(DEFAULT_RELIEF)[key], key);
  }
  assert.notEqual(slotsOf(stepped)['bg2.lo'], slotsOf(DEFAULT_RELIEF)['bg2.lo']);
});

test('stepping starts from the default for a slot the preset does not mention', () => {
  const sparse: ReliefPreset = { spacing: 1, slots: {} };
  const stepped = stepSlot(sparse, 'sprite', 1);
  const expected = RELIEF_DISTANCES[RELIEF_DISTANCES.indexOf(slotsOf(DEFAULT_RELIEF)['sprite']) + 1];
  assert.equal(slotsOf(stepped)['sprite'], expected);
});

test('the rungs say where each slot is on the ladder, for the position dots', () => {
  const rungs = reliefRungs(DEFAULT_RELIEF);
  assert.equal(rungs.spacing, RELIEF_SPACINGS.indexOf(DEFAULT_RELIEF.spacing));
  assert.equal(rungs.slots['backdrop'], 0);
  assert.equal(rungs.slots['sprite'], RELIEF_DISTANCES.indexOf(0.18));
  // One rung per slot, so a panel can draw a row per slot without asking twice.
  assert.deepEqual(Object.keys(rungs.slots).sort(), [...VR_SLOT_KEYS].sort());
});

test('spacing scales every distance, and zero flattens the picture', () => {
  const half = { ...DEFAULT_RELIEF, spacing: 0.5 };
  const metres = slotDistances(half);
  assert.equal(metres['sprite'], 0.09);
  assert.equal(metres['backdrop'], 0);

  // The escape hatch: one rung below the shallowest relief is the flat picture,
  // so a player can compare against 2D without leaving the panel.
  const flat = slotDistances({ ...DEFAULT_RELIEF, spacing: 0 });
  for (const key of VR_SLOT_KEYS) assert.equal(flat[key], 0, key);
});

test('listing walks every game, and skips entries it cannot read', () => {
  const store = storage();
  const mario = stepSlot(DEFAULT_RELIEF, 'sprite', 1);
  // Up, not down: the default ships at the bottom rung, so stepping down is a
  // no-op and writing the default removes the key rather than storing it.
  const zelda = stepSpacing(DEFAULT_RELIEF, 1);
  writeReliefPreset(store, MARIO, mario);
  writeReliefPreset(store, ZELDA, zelda);
  store.setItem('psnes-vr-screen', JSON.stringify({ distance: 2.5 }));
  store.setItem('psnes-latency:4C8A5E2B', '2');
  store.setItem(`psnes-vr-relief:${'0BADBEEF'}`, 'not json');
  store.setItem('psnes-vr-relief:lowercase', JSON.stringify({ spacing: 1, slots: {} }));

  const table = listReliefPresets(store);
  assert.deepEqual(Object.keys(table).sort(), [MARIO, ZELDA]);
  assert.deepEqual(table[MARIO], mario);
  assert.deepEqual(table[ZELDA], zelda);
  // Listing reads; it does not tidy up behind itself.
  assert.equal(store.getItem('psnes-vr-screen'), JSON.stringify({ distance: 2.5 }));
  assert.equal(store.getItem('psnes-latency:4C8A5E2B'), '2');
});

test('replacing drops the presets that are not in the imported table', () => {
  // Replaces rather than merges, for the reason `replaceLatencyPreferences`
  // gives: a leftover local entry would mean the import silently did not take
  // effect for that one game.
  const store = storage();
  writeReliefPreset(store, MARIO, stepSlot(DEFAULT_RELIEF, 'sprite', 1));
  store.setItem('psnes-vr-screen', 'kept');

  const zelda = stepSpacing(DEFAULT_RELIEF, 1);
  replaceReliefPresets(store, { [ZELDA]: zelda });

  assert.deepEqual(readReliefPreset(store, MARIO), DEFAULT_RELIEF);
  assert.deepEqual(readReliefPreset(store, ZELDA), zelda);
  assert.equal(store.getItem('psnes-vr-screen'), 'kept');
});

test('a rejected crc32 in an imported table does not take the rest down with it', () => {
  const store = storage();
  const zelda = stepSpacing(DEFAULT_RELIEF, 1);
  replaceReliefPresets(store, { 'not a crc': DEFAULT_RELIEF, [ZELDA]: zelda } as Record<
    string,
    ReliefPreset
  >);
  assert.deepEqual(Object.keys(listReliefPresets(store)), [ZELDA]);
});

test('the ladder rises and starts at the back plane', () => {
  // Strictly increasing, because `reliefRungs` finds a value by `indexOf` and a
  // repeated rung would make one of the two unreachable by the dots.
  assert.equal(RELIEF_DISTANCES[0], 0);
  for (let i = 1; i < RELIEF_DISTANCES.length; i++) {
    assert.ok(RELIEF_DISTANCES[i] > RELIEF_DISTANCES[i - 1], `rung ${i}`);
  }
  assert.equal(RELIEF_SPACINGS[0], 0);
  for (let i = 1; i < RELIEF_SPACINGS.length; i++) {
    assert.ok(RELIEF_SPACINGS[i] > RELIEF_SPACINGS[i - 1], `spacing rung ${i}`);
  }
  // The slot ladder never reaches behind the backdrop; the sign is carried by
  // the direction of the whole model, not by individual values.
  for (const value of RELIEF_DISTANCES) assert.ok(value >= 0);
});

test('a slot key this build does not know is refused by stepSlot', () => {
  // The panel draws a row per `VR_SLOT_KEYS` entry, so this can only come from
  // an imported preset; returning the preset unchanged keeps it out of storage.
  const stepped = stepSlot(DEFAULT_RELIEF, 'bg5.lo' as VrSlotKey, 1);
  assert.deepEqual(stepped, DEFAULT_RELIEF);
});
