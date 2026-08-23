import { ControlsConfig, KeyConfig, PadConfig, PlayerControls } from '../types/index.js';

export function getDefaultKeyConfig(): KeyConfig {
  return {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyX',
    b: 'KeyZ',
    x: 'KeyS',
    y: 'KeyA',
    l: 'KeyQ',
    r: 'KeyW',
    start: 'Enter',
    select: 'ShiftRight'
  };
}

export function isValidKeyConfig(config: any): config is KeyConfig {
  const requiredKeys = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'];

  if (!config || typeof config !== 'object') {
    return false;
  }

  for (const key of requiredKeys) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      return false;
    }
  }

  return true;
}

const BUTTONS: (keyof KeyConfig)[] = [
  'up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'
];

/**
 * The second player's defaults.
 *
 * No overlap with player 1's: two players on keyboard on the same machine is
 * the most common local case, and it must work out of the box. The copy of
 * this table on the frontend (`controls/binding.ts`) must stay identical -
 * the repo already duplicates `KeyConfig` for the same reason, the backend
 * being unable to import from `frontend/src/lib`.
 */
function getDefaultP2KeyConfig(): KeyConfig {
  return {
    up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL',
    a: 'KeyN', b: 'KeyB', x: 'KeyH', y: 'KeyG',
    l: 'KeyT', r: 'KeyY', start: 'KeyO', select: 'KeyU'
  };
}

/** The d-pad by buttons 12-15 *and* by the stick, like the old reading did. */
function getStandardPadConfig(): PadConfig {
  return {
    up: ['PadButton12', 'PadAxis1Minus'],
    down: ['PadButton13', 'PadAxis1Plus'],
    left: ['PadButton14', 'PadAxis0Minus'],
    right: ['PadButton15', 'PadAxis0Plus'],
    a: ['PadButton1'], b: ['PadButton0'], x: ['PadButton3'], y: ['PadButton2'],
    l: ['PadButton4'], r: ['PadButton5'], start: ['PadButton9'], select: ['PadButton8']
  };
}

const PAD_CODE = /^(PadButton\d+|PadAxis\d+(Plus|Minus))$/;
const LEGACY_BUTTON = /^Gamepad\d+Button(\d+)$/;
const LEGACY_AXIS = /^Gamepad\d+Axis(\d+)(Plus|Minus)$/;

function legacyToPadCode(code: string): string | null {
  const button = LEGACY_BUTTON.exec(code);
  if (button) return `PadButton${button[1]}`;
  const axis = LEGACY_AXIS.exec(code);
  if (axis) return `PadAxis${axis[1]}${axis[2]}`;
  return null;
}

function defaultPlayer(keys: KeyConfig): PlayerControls {
  return { keys: { ...keys }, pad: getStandardPadConfig() };
}

export function getDefaultControlsConfig(): ControlsConfig {
  return {
    version: 2,
    p1: defaultPlayer(getDefaultKeyConfig()),
    p2: defaultPlayer(getDefaultP2KeyConfig())
  };
}

function normalisePlayer(raw: any, defaults: KeyConfig): PlayerControls {
  const player = defaultPlayer(defaults);
  const rawKeys = (raw && typeof raw.keys === 'object' && raw.keys) || {};
  const rawPad = (raw && typeof raw.pad === 'object' && raw.pad) || null;

  for (const button of BUTTONS) {
    if (rawPad) {
      const value = rawPad[button];
      if (Array.isArray(value)) {
        player.pad[button] = value.filter((code: unknown) => typeof code === 'string' && PAD_CODE.test(code));
      } else if (typeof value === 'string' && PAD_CODE.test(value)) {
        player.pad[button] = [value];
      }
    }

    const key = rawKeys[button];
    if (typeof key !== 'string') continue;
    const migrated = legacyToPadCode(key);
    if (migrated) {
      player.pad[button] = [migrated];
      player.keys[button] = '';
    } else {
      player.keys[button] = key;
    }
  }

  return player;
}

/**
 * Brings anything into the v2 shape.
 *
 * Called on every read, including on its own output: it must be idempotent,
 * and the test requires it.
 */
export function normaliseControlsConfig(raw: any): ControlsConfig {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.version === 2) {
      return {
        version: 2,
        p1: normalisePlayer(raw.p1, getDefaultKeyConfig()),
        p2: normalisePlayer(raw.p2, getDefaultP2KeyConfig())
      };
    }
    if (isValidKeyConfig(raw)) {
      return {
        version: 2,
        p1: normalisePlayer({ keys: raw }, getDefaultKeyConfig()),
        p2: defaultPlayer(getDefaultP2KeyConfig())
      };
    }
  }
  return getDefaultControlsConfig();
}

function isCompletePlayer(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false;
  if (!raw.keys || typeof raw.keys !== 'object') return false;
  if (!raw.pad || typeof raw.pad !== 'object') return false;
  return BUTTONS.every(
    (button) =>
      typeof raw.keys[button] === 'string' &&
      Array.isArray(raw.pad[button]) &&
      raw.pad[button].every((code: unknown) => typeof code === 'string')
  );
}

/**
 * What we accept to write into the database.
 *
 * Both shapes, because a tab left open on the old frontend still saves a bare
 * `KeyConfig`, and a 400 would be incomprehensible to it. Nothing incomplete,
 * though: a config with holes would produce a button that does not respond,
 * and nothing downstream would catch it.
 */
export function isValidControlsConfig(raw: any): boolean {
  if (isValidKeyConfig(raw)) return true;
  if (!raw || typeof raw !== 'object' || raw.version !== 2) return false;
  return isCompletePlayer(raw.p1) && isCompletePlayer(raw.p2);
}
