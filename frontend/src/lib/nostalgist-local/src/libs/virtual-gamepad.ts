/**
 * Virtual Gamepad
 * Creates a fake gamepad that RetroArch will recognize as a real controller
 */

export class VirtualGamepad implements Gamepad {
  public readonly id: string
  public readonly index: number
  public readonly connected: boolean = true
  public timestamp: number = performance.now()
  public readonly mapping: GamepadMappingType = 'standard'
  public readonly axes: readonly number[] = [0, 0, 0, 0]
  public readonly buttons: GamepadButton[]
  public readonly vibrationActuator: null = null
  public readonly hapticActuators: readonly GamepadHapticActuator[] = []

  constructor(index: number = 1) {
    this.index = index
    this.id = `Virtual Gamepad (Player ${index + 1})`

    // Initialize buttons (16 standard gamepad buttons) - create mutable objects
    this.buttons = Array.from({ length: 16 }, (_, i) => ({
      pressed: false,
      touched: false,
      value: 0,
    }))
  }

  /**
   * Map SNES button names to standard gamepad button indices
   */
  private buttonMap: Record<string, number> = {
    b: 0,      // A button (Xbox: A, PS: Cross)
    a: 1,      // B button (Xbox: B, PS: Circle)
    y: 2,      // X button (Xbox: X, PS: Square)
    x: 3,      // Y button (Xbox: Y, PS: Triangle)
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
   * Press a button
   */
  pressButton(button: string) {
    const index = this.buttonMap[button]
    if (index !== undefined) {
      // Mutate the existing button object instead of replacing it
      this.buttons[index].pressed = true
      this.buttons[index].touched = true
      this.buttons[index].value = 1
      console.log(`🎮 Virtual gamepad: Button ${button} (${index}) pressed`, this.buttons[index])
    } else {
      console.warn(`⚠️ Unknown button: ${button}`)
    }
  }

  /**
   * Release a button
   */
  releaseButton(button: string) {
    const index = this.buttonMap[button]
    if (index !== undefined) {
      // Mutate the existing button object instead of replacing it
      this.buttons[index].pressed = false
      this.buttons[index].touched = false
      this.buttons[index].value = 0
      console.log(`🎮 Virtual gamepad: Button ${button} (${index}) released`, this.buttons[index])
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

      // Add all installed virtual gamepads
      installedGamepads.forEach((gp, index) => {
        result[index] = gp as any;
      });

      return result as unknown as Gamepad[];
    };
  }

  console.log(`🎮 Virtual gamepad installed at index ${gamepad.index}`);
  console.log(`🎮 Total installed gamepads: ${installedGamepads.size}`);

  // Test that it's accessible
  setTimeout(() => {
    const gamepads = navigator.getGamepads();
    console.log(`🎮 Gamepads after installation:`, Array.from(gamepads).map((gp, i) =>
      gp ? `[${i}] ${gp.id}` : `[${i}] null`
    ));
  }, 100);

  // Return cleanup function
  return () => {
    installedGamepads.delete(gamepad.index);
    console.log(`🎮 Virtual gamepad removed from index ${gamepad.index}`);

    // Restore original if no more virtual gamepads
    if (installedGamepads.size === 0 && originalGetGamepads) {
      navigator.getGamepads = originalGetGamepads;
      originalGetGamepads = null;
    }
  };
}
