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

function normalisePlayer(raw: unknown, defaults: KeyConfig): PlayerControls {
  const player = defaultPlayer(defaults);
  const source = (raw && typeof raw === 'object' ? raw : {}) as { keys?: unknown; pad?: unknown };
  const rawKeys = (source.keys && typeof source.keys === 'object' ? source.keys : {}) as Record<string, unknown>;
  const rawPad = (source.pad && typeof source.pad === 'object' ? source.pad : null) as Record<string, unknown> | null;

  for (const button of BUTTONS) {
    if (rawPad) {
      const value = rawPad[button];
      if (Array.isArray(value)) {
        player.pad[button] = value.filter((code): code is string => typeof code === 'string' && PAD_CODE.test(code));
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
export function normaliseControlsConfig(raw: unknown): ControlsConfig {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>;
    if (source.version === 2) {
      return {
        version: 2,
        p1: normalisePlayer(source.p1, getDefaultKeyConfig()),
        p2: normalisePlayer(source.p2, getDefaultP2KeyConfig())
      };
    }
    if (isValidKeyConfig(source)) {
      return {
        version: 2,
        p1: normalisePlayer({ keys: source }, getDefaultKeyConfig()),
        p2: defaultPlayer(getDefaultP2KeyConfig())
      };
    }
  }
  return getDefaultControlsConfig();
}

/**
 * Whether `raw` has the complete v2 shape: all twelve buttons present, each
 * `keys[b]` a string and each `pad[b]` an array of strings.
 *
 * Deliberately permissive on *value*: `''` and `[]` are the documented way to
 * mark a button unbound (the sequence-binding UI has a Tab-to-skip step for
 * exactly this, `shortLabel('')` renders an unbound slot as `—`, and the
 * input collector skips falsy codes) - so a button with nothing bound on
 * either table is a choice, not a hole, and passes here. What this guards
 * against is a missing slot: a button absent from `keys` or `pad` entirely,
 * which nothing downstream would notice until that button silently never
 * fires.
 */
function isCompletePlayer(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const source = raw as Record<string, unknown>;
  if (!source.keys || typeof source.keys !== 'object') return false;
  if (!source.pad || typeof source.pad !== 'object') return false;
  const keys = source.keys as Record<string, unknown>;
  const pad = source.pad as Record<string, unknown>;
  return BUTTONS.every((button) => {
    const padValue = pad[button];
    return (
      typeof keys[button] === 'string' &&
      Array.isArray(padValue) &&
      padValue.every((code: unknown) => typeof code === 'string')
    );
  });
}

/**
 * What we accept to write into the database.
 *
 * Both shapes, because a tab left open on the old frontend still saves a bare
 * `KeyConfig`, and a 400 would be incomprehensible to it. What "valid" means
 * differs between the two, though: `isValidKeyConfig` (the v1 path, kept
 * unchanged for its other callers) still requires every key non-empty, so a
 * legacy client cannot save an unbound button at all. The v2 path is looser
 * by design - `''` and `[]` are legitimate values there, see
 * `isCompletePlayer` - so it only enforces *shape*: every button present,
 * with a string in `keys` and an array in `pad`. What is refused either way
 * is an incomplete shape: a missing button produces one that silently never
 * fires, and nothing downstream would catch it.
 */
export function isValidControlsConfig(raw: unknown): boolean {
  if (isValidKeyConfig(raw)) return true;
  if (!raw || typeof raw !== 'object') return false;
  const source = raw as Record<string, unknown>;
  if (source.version !== 2) return false;
  return isCompletePlayer(source.p1) && isCompletePlayer(source.p2);
}
