/**
 * Virtual Gamepad for Player 2
 * Creates a fake gamepad that RetroArch will recognize as a real controller
 */

export class VirtualGamepad implements Gamepad {
  public readonly id: string = 'Virtual Gamepad (Player 2)'
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

/**
 * Install virtual gamepad into the browser's gamepad API
 */
export function installVirtualGamepad(gamepad: VirtualGamepad): () => void {
  const originalGetGamepads = navigator.getGamepads.bind(navigator)

  let pollCount = 0
  let lastPollTime = 0

  // Wrap the buttons array in a proxy to detect accesses
  let buttonsAccessCount = 0
  const buttonsProxy = new Proxy(gamepad.buttons, {
    get(target, prop) {
      buttonsAccessCount++
      const now = performance.now()

      // Log every access when buttons are pressed, or every second otherwise
      if (prop === '15' || (typeof prop === 'string' && !isNaN(Number(prop)))) {
        const idx = Number(prop)
        const anyPressed = (target as GamepadButton[]).some(b => b.pressed)
        if (anyPressed || now - lastPollTime > 1000) {
          const pressedButtons = (target as GamepadButton[])
            .map((b, i) => b.pressed ? i : null)
            .filter(i => i !== null)

          console.log(`🎮 RetroArch reading button[${prop}] (access #${buttonsAccessCount})`)
          console.log(`  All pressed: [${pressedButtons.join(', ')}]`)
          console.log(`  buttons[${prop}]:`, target[idx])
          lastPollTime = now
        }
      }
      return target[prop as any]
    }
  })

  // Wrap gamepad in a proxy to return our proxied buttons array
  const gamepadProxy = new Proxy(gamepad, {
    get(target, prop) {
      if (prop === 'buttons') {
        return buttonsProxy
      }
      return (target as any)[prop]
    }
  })

  // Override getGamepads to include our virtual gamepad
  navigator.getGamepads = function() {
    const gamepads = originalGetGamepads()
    const result = Array.from(gamepads)
    result[gamepad.index] = gamepadProxy as any
    return result as unknown as Gamepad[]
  }

  console.log(`🎮 Virtual gamepad installed at index ${gamepad.index}`)
  console.log(`🎮 RetroArch will detect it via gamepad polling`)

  // Test that it's accessible
  setTimeout(() => {
    const gamepads = navigator.getGamepads()
    console.log(`🎮 Gamepads after installation:`, Array.from(gamepads).map((gp, i) =>
      gp ? `[${i}] ${gp.id}` : `[${i}] null`
    ))
  }, 100)

  // Return cleanup function
  return () => {
    navigator.getGamepads = originalGetGamepads
    console.log(`🎮 Virtual gamepad removed from index ${gamepad.index}`)
  }
}
