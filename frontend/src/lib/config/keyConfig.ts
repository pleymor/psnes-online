export interface KeyConfig {
  up: string;
  down: string;
  left: string;
  right: string;
  a: string;
  b: string;
  x: string;
  y: string;
  l: string;
  r: string;
  start: string;
  select: string;
}

export const DEFAULT_KEY_CONFIG: KeyConfig = {
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

// Retroarch button mapping (for emulator)
export const RETROARCH_BUTTON_MAP = {
  up: 0,
  down: 1,
  left: 2,
  right: 3,
  a: 8,
  b: 0,
  x: 9,
  y: 1,
  l: 10,
  r: 11,
  start: 3,
  select: 2
} as const;

// Button display names
export const BUTTON_NAMES: Record<keyof KeyConfig, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  a: 'A',
  b: 'B',
  x: 'X',
  y: 'Y',
  l: 'L',
  r: 'R',
  start: 'Start',
  select: 'Select'
};
