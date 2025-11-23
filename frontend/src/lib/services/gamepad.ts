import { writable, type Writable } from 'svelte/store';
import {
  GAMEPAD_POLL_INTERVAL_MS,
  GAMEPAD_AXIS_DEADZONE,
  GAMEPAD_BUTTON_THRESHOLD
} from '$lib/config/performance';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('Gamepad');

export interface GamepadState {
  connected: boolean;
  buttons: boolean[];
  axes: number[];
}

export interface GamepadInputCallback {
  (buttonIndex: number, pressed: boolean): void;
}

export class GamepadPoller {
  private pollInterval: number | null = null;
  private lastButtonStates: Map<number, boolean> = new Map();
  private callbacks: Set<GamepadInputCallback> = new Set();
  public state: Writable<GamepadState>;

  constructor() {
    this.state = writable<GamepadState>({
      connected: false,
      buttons: [],
      axes: []
    });
  }

  /**
   * Start polling for gamepad input
   */
  start(): void {
    if (this.pollInterval !== null) {
      logger.warn('Gamepad polling already started');
      return;
    }

    this.pollInterval = window.setInterval(() => {
      this.poll();
    }, GAMEPAD_POLL_INTERVAL_MS);
  }

  /**
   * Stop polling for gamepad input
   */
  stop(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.lastButtonStates.clear();
    this.state.set({
      connected: false,
      buttons: [],
      axes: []
    });
  }

  /**
   * Register a callback for gamepad button changes
   */
  onInput(callback: GamepadInputCallback): void {
    this.callbacks.add(callback);
  }

  /**
   * Unregister a callback
   */
  offInput(callback: GamepadInputCallback): void {
    this.callbacks.delete(callback);
  }

  /**
   * Poll the gamepad state
   */
  private poll(): void {
    const gamepads = navigator.getGamepads();
    const gamepad = gamepads[0]; // Use first gamepad

    if (!gamepad) {
      this.state.update((state) => {
        if (state.connected) {
          this.lastButtonStates.clear();
          return { connected: false, buttons: [], axes: [] };
        }
        return state;
      });
      return;
    }

    // Update state
    const buttons = gamepad.buttons.map((button) => button.pressed);
    const axes = gamepad.axes.map((axis) =>
      Math.abs(axis) < GAMEPAD_AXIS_DEADZONE ? 0 : axis
    );

    this.state.set({
      connected: true,
      buttons,
      axes
    });

    // Detect button changes and trigger callbacks
    gamepad.buttons.forEach((button, index) => {
      const pressed = button.value > GAMEPAD_BUTTON_THRESHOLD;
      const lastPressed = this.lastButtonStates.get(index) ?? false;

      if (pressed !== lastPressed) {
        this.lastButtonStates.set(index, pressed);
        this.callbacks.forEach((callback) => callback(index, pressed));
      }
    });
  }

  /**
   * Get current gamepad state (synchronous)
   */
  getCurrentState(): GamepadState {
    let currentState: GamepadState = {
      connected: false,
      buttons: [],
      axes: []
    };
    this.state.subscribe((state) => {
      currentState = state;
    })();
    return currentState;
  }
}

/**
 * Factory function for convenience
 */
export function createGamepadPoller(): GamepadPoller {
  return new GamepadPoller();
}

/**
 * Map gamepad button index to SNES button name
 */
export function mapGamepadButtonToSNES(buttonIndex: number): string | null {
  const mapping: Record<number, string> = {
    0: 'b', // A button (cross on PlayStation)
    1: 'a', // B button (circle on PlayStation)
    2: 'y', // X button (square on PlayStation)
    3: 'x', // Y button (triangle on PlayStation)
    4: 'l', // L button
    5: 'r', // R button
    8: 'select', // Select button
    9: 'start', // Start button
    12: 'up', // D-pad up
    13: 'down', // D-pad down
    14: 'left', // D-pad left
    15: 'right' // D-pad right
  };

  return mapping[buttonIndex] || null;
}
