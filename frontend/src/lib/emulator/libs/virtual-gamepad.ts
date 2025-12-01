/**
 * Virtual Gamepad
 * Creates a fake gamepad that RetroArch will recognize as a real controller
 */

import { createLogger } from '$lib/utils/logger';

const logger = createLogger('VirtualGamepad');

export class VirtualGamepad implements Gamepad {
  public readonly id: string
  public readonly index: number
  public readonly connected: boolean = true
  public timestamp: number = performance.now()
  public readonly mapping: GamepadMappingType = 'standard'
  public axes: number[] = [0, 0, 0, 0]
  public buttons: GamepadButton[]
  public readonly vibrationActuator: GamepadHapticActuator = null as unknown as GamepadHapticActuator
  public readonly hapticActuators: readonly GamepadHapticActuator[] = []

  constructor(index: number = 1) {
    this.index = index
    this.id = `Virtual Gamepad (Player ${index + 1})`

    // Initialize buttons (16 standard gamepad buttons) - create mutable objects
    // Cast to any to bypass readonly constraints of GamepadButton interface
    this.buttons = Array.from({ length: 16 }, (_, i) => ({
      pressed: false,
      touched: false,
      value: 0,
    })) as any

    logger.debug(`Created virtual gamepad P${index + 1} (index=${index})`);
  }

  /**
   * Map SNES button names to standard gamepad button indices
   * Must use standard gamepad layout that RetroArch expects:
   * Button 0 = B (bottom), Button 1 = A (right), Button 2 = Y (left), Button 3 = X (top)
   */
  private buttonMap: Record<string, number> = {
    b: 0,      // B at bottom position (standard button 0)
    a: 1,      // A at right position (standard button 1)
    y: 2,      // Y at left position (standard button 2)
    x: 3,      // X at top position (standard button 3)
    l: 4,      // Left shoulder
    r: 5,      // Right shoulder
    select: 8, // Select
    start: 9,  // Start
    up: 12,    // D-pad up
    down: 13,  // D-pad down
    left: 14,  // D-pad left
    right: 15, // D-pad right
  }

  /**
   * Dispatch a gamepad event to notify RetroArch of state changes
   */
  private dispatchGamepadEvent() {
    try {
      const event = new Event('gamepadconnected') as any
      event.gamepad = this
      globalThis.dispatchEvent(event)
    } catch (err) {
      // Ignore errors
    }
  }

  /**
   * Press a button
   */
  pressButton(button: string) {
    const index = this.buttonMap[button]
    if (index !== undefined) {
      // Mutate the existing button object instead of replacing it
      const btn = this.buttons[index] as any
      btn.pressed = true
      btn.touched = true
      btn.value = 1

      // Also update axes for D-pad (RetroArch expects D-pad on axes)
      if (button === 'left') this.axes[0] = -1
      else if (button === 'right') this.axes[0] = 1
      else if (button === 'up') this.axes[1] = -1
      else if (button === 'down') this.axes[1] = 1

      // Update timestamp so RetroArch sees fresh input
      this.timestamp = performance.now()
    }
  }

  /**
   * Release a button
   */
  releaseButton(button: string) {
    const index = this.buttonMap[button]
    if (index !== undefined) {
      // Mutate the existing button object instead of replacing it
      const btn = this.buttons[index] as any
      btn.pressed = false
      btn.touched = false
      btn.value = 0

      // Also reset axes for D-pad
      if (button === 'left' || button === 'right') this.axes[0] = 0
      else if (button === 'up' || button === 'down') this.axes[1] = 0

      // Update timestamp so RetroArch sees fresh input
      this.timestamp = performance.now()
    }
  }

  /**
   * Update timestamp (call this on every input change)
   */
  updateTimestamp() {
    this.timestamp = performance.now()
  }
}

// Store all installed gamepads globally
const installedGamepads = new Map<number, VirtualGamepad>();
let originalGetGamepads: typeof navigator.getGamepads | null = null;

/**
 * Get the original getGamepads function (before virtual gamepad override)
 * Use this to poll physical gamepads
 */
export function getOriginalGetGamepads(): typeof navigator.getGamepads | null {
  return originalGetGamepads;
}

/**
 * Install virtual gamepad into the browser's gamepad API
 */
export function installVirtualGamepad(gamepad: VirtualGamepad): () => void {
  // Capture original getGamepads only once
  if (!originalGetGamepads) {
    originalGetGamepads = navigator.getGamepads.bind(navigator);
  }

  // Add gamepad to the map
  installedGamepads.set(gamepad.index, gamepad);

  // Override getGamepads to include ALL virtual gamepads
  // Only override once (first installation)
  if (installedGamepads.size === 1) {
    navigator.getGamepads = function() {
      const gamepads = originalGetGamepads!();
      const result = Array.from(gamepads);

      // HIDE physical gamepads by setting them to null
      // This prevents RetroArch from using them directly
      for (let i = 0; i < result.length; i++) {
        if (result[i] && !result[i]!.id.includes('Virtual Gamepad')) {
          result[i] = null;
        }
      }

      // Add all installed virtual gamepads at their configured indices
      installedGamepads.forEach((gp, index) => {
        result[index] = gp as any;
      });

      return result as unknown as Gamepad[];
    };
  }

  // Return cleanup function
  return () => {
    installedGamepads.delete(gamepad.index);

    // Restore original if no more virtual gamepads
    if (installedGamepads.size === 0 && originalGetGamepads) {
      navigator.getGamepads = originalGetGamepads;
      originalGetGamepads = null;
    }
  };
}
