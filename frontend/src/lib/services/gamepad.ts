import { writable, type Writable } from 'svelte/store';
import {
  GAMEPAD_POLL_INTERVAL_MS,
  GAMEPAD_AXIS_DEADZONE,
  GAMEPAD_BUTTON_THRESHOLD
} from '$lib/config/performance';

export interface GamepadState {
  connected: boolean;
  buttons: boolean[];
  axes: number[];
}

export interface GamepadInputCallback {
  (buttonIndex: number, pressed: boolean, isAxis?: boolean, axisDirection?: 'plus' | 'minus'): void;
}

export class GamepadPoller {
  private pollInterval: number | null = null;
  private lastButtonStates: Map<number, boolean> = new Map();
  private lastAxisStates: Map<string, boolean> = new Map(); // Track axis-based D-pad
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
    this.lastAxisStates.clear();
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
        this.callbacks.forEach((callback) => callback(index, pressed, false));
      }
    });

    // Handle axes (D-pad or analog sticks)
    const axisThreshold = GAMEPAD_AXIS_DEADZONE;

    for (let axis = 0; axis < gamepad.axes.length; axis++) {
      const value = gamepad.axes[axis];
      const negPressed = value < -axisThreshold;
      const posPressed = value > axisThreshold;

      const lastNegPressed = this.lastAxisStates.get(`${axis}-neg`) ?? false;
      const lastPosPressed = this.lastAxisStates.get(`${axis}-pos`) ?? false;

      if (negPressed !== lastNegPressed) {
        this.lastAxisStates.set(`${axis}-neg`, negPressed);
        // Pass axis index and direction for user config matching
        this.callbacks.forEach((callback) => callback(axis, negPressed, true, 'minus'));
      }

      if (posPressed !== lastPosPressed) {
        this.lastAxisStates.set(`${axis}-pos`, posPressed);
        // Pass axis index and direction for user config matching
        this.callbacks.forEach((callback) => callback(axis, posPressed, true, 'plus'));
      }
    }
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
