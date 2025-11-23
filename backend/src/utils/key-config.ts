import { KeyConfig } from '../types/index.js';

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
