/**
 * Dual Emulator Manager - Seamless resync without black screen
 *
 * Manages two emulator instances running in parallel:
 * - Active emulator: Currently displayed, running the game
 * - Background emulator: Hidden, ready to receive state for next resync
 *
 * On resync:
 * 1. Load new state into background emulator
 * 2. Swap: background becomes active, active becomes background
 * 3. No visible interruption - instant swap
 */

import type { WasmEmulator } from '$lib/emulator';
import type { InputState } from '$lib/types';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('DualEmuMgr');

// Instance labels for logging
const INSTANCE_LABELS = ['[A]', '[B]'] as const;

export interface DualEmulatorCallbacks {
  /** Called when emulators are ready */
  onReady?: () => void;
  /** Called on swap completion */
  onSwap?: (newActiveIndex: 0 | 1) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

export interface EmulatorInstance {
  emulator: WasmEmulator;
  canvas: HTMLCanvasElement;
  isActive: boolean;
}

export class DualEmulatorManager {
  private instances: [EmulatorInstance | null, EmulatorInstance | null] = [null, null];
  private activeIndex: 0 | 1 = 0;
  private callbacks: DualEmulatorCallbacks;
  private isInitialized = false;
  private swapInProgress = false;

  constructor(callbacks: DualEmulatorCallbacks = {}) {
    this.callbacks = callbacks;
    logger.info('DualEmulatorManager created');
  }

  /**
   * Initialize with two emulator instances
   */
  initialize(
    emulator0: WasmEmulator,
    canvas0: HTMLCanvasElement,
    emulator1: WasmEmulator,
    canvas1: HTMLCanvasElement
  ): void {
    this.instances[0] = {
      emulator: emulator0,
      canvas: canvas0,
      isActive: true
    };

    this.instances[1] = {
      emulator: emulator1,
      canvas: canvas1,
      isActive: false
    };

    // Set initial visibility
    this.updateCanvasVisibility();

    // Mute audio on background emulator
    this.muteEmulator(1);

    this.isInitialized = true;
    this.activeIndex = 0;

    logger.info(`Initialized: ${INSTANCE_LABELS[0]}=active, ${INSTANCE_LABELS[1]}=background`);
    this.callbacks.onReady?.();
  }

  /**
   * Get the currently active emulator
   */
  getActiveEmulator(): WasmEmulator | null {
    return this.instances[this.activeIndex]?.emulator ?? null;
  }

  /**
   * Get the background emulator
   */
  getBackgroundEmulator(): WasmEmulator | null {
    const bgIndex = this.activeIndex === 0 ? 1 : 0;
    return this.instances[bgIndex]?.emulator ?? null;
  }

  /**
   * Get the active canvas
   */
  getActiveCanvas(): HTMLCanvasElement | null {
    return this.instances[this.activeIndex]?.canvas ?? null;
  }

  /**
   * Get active index
   */
  getActiveIndex(): 0 | 1 {
    return this.activeIndex;
  }

  /**
   * Check if initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Load state into the background emulator and swap
   * This is the key method for seamless resync
   */
  async loadStateAndSwap(stateBlob: Blob): Promise<void> {
    if (!this.isInitialized) {
      logger.error('Cannot swap: not initialized');
      return;
    }

    if (this.swapInProgress) {
      logger.warn('Swap already in progress, ignoring');
      return;
    }

    this.swapInProgress = true;
    const bgIndex = this.activeIndex === 0 ? 1 : 0;
    const bgInstance = this.instances[bgIndex];

    if (!bgInstance) {
      logger.error('Background emulator not available');
      this.swapInProgress = false;
      return;
    }

    try {
      logger.info(`Loading state into ${INSTANCE_LABELS[bgIndex]} (background)...`);

      // The active emulator is already paused by SimpleSyncManager during resync
      // 1. Load state into background emulator
      await bgInstance.emulator.loadState(stateBlob);
      logger.debug(`${INSTANCE_LABELS[bgIndex]} state loaded`);

      // 2. Swap active/background
      this.swap();

      logger.info(`SWAP: ${INSTANCE_LABELS[this.activeIndex]}=active, ${INSTANCE_LABELS[bgIndex]}=background`);
    } catch (error) {
      logger.error('Failed to load state and swap:', error);
      this.callbacks.onError?.(error as Error);
    } finally {
      this.swapInProgress = false;
    }
  }

  /**
   * Swap active and background emulators
   */
  private swap(): void {
    const oldActive = this.activeIndex;
    const newActive: 0 | 1 = oldActive === 0 ? 1 : 0;

    // Update instance states
    if (this.instances[oldActive]) {
      this.instances[oldActive]!.isActive = false;
    }
    if (this.instances[newActive]) {
      this.instances[newActive]!.isActive = true;
    }

    // Swap audio: mute old active, unmute new active
    this.muteEmulator(oldActive);
    this.unmuteEmulator(newActive);

    // Update active index
    this.activeIndex = newActive;

    // Update canvas visibility (CSS swap)
    this.updateCanvasVisibility();

    this.callbacks.onSwap?.(newActive);
  }

  /**
   * Update canvas visibility based on active state
   * Uses opacity instead of visibility to ensure background canvas keeps rendering
   */
  private updateCanvasVisibility(): void {
    for (let i = 0; i < 2; i++) {
      const instance = this.instances[i as 0 | 1];
      if (instance) {
        if (i === this.activeIndex) {
          // Active: visible, on top
          instance.canvas.style.opacity = '1';
          instance.canvas.style.pointerEvents = 'auto';
          instance.canvas.style.zIndex = '2';
        } else {
          // Background: invisible but still rendering (opacity keeps render active)
          instance.canvas.style.opacity = '0';
          instance.canvas.style.pointerEvents = 'none';
          instance.canvas.style.zIndex = '1';
        }
        // Both always positioned absolutely in the same spot
        instance.canvas.style.position = 'absolute';
        instance.canvas.style.top = '0';
        instance.canvas.style.left = '0';
        instance.canvas.style.width = '100%';
        instance.canvas.style.height = '100%';
      }
    }
  }

  /**
   * Mute audio for an emulator instance
   */
  private muteEmulator(index: 0 | 1): void {
    const instance = this.instances[index];
    if (!instance) return;

    try {
      const AL = instance.emulator.getEmscriptenAL();
      if (AL && AL.currentCtx && AL.currentCtx.gain) {
        AL.currentCtx.gain.gain.value = 0;
        logger.debug(`Muted emulator ${index}`);
      }
    } catch (error) {
      logger.debug(`Could not mute emulator ${index}:`, error);
    }
  }

  /**
   * Unmute audio for an emulator instance
   */
  private unmuteEmulator(index: 0 | 1): void {
    const instance = this.instances[index];
    if (!instance) return;

    try {
      const AL = instance.emulator.getEmscriptenAL();
      if (AL && AL.currentCtx && AL.currentCtx.gain) {
        AL.currentCtx.gain.gain.value = 1;
        logger.debug(`Unmuted emulator ${index}`);
      }
    } catch (error) {
      logger.debug(`Could not unmute emulator ${index}:`, error);
    }
  }

  /**
   * Apply inputs to BOTH emulators (they must stay in sync)
   */
  applyInputs(p1: InputState, p2: InputState): void {
    // Apply to both emulators to keep them synchronized
    for (const instance of this.instances) {
      if (instance) {
        this.applyInputToEmulator(instance.emulator, 1, p1);
        this.applyInputToEmulator(instance.emulator, 2, p2);
      }
    }
  }

  /**
   * Apply input to a specific emulator
   */
  private applyInputToEmulator(emulator: WasmEmulator, port: 1 | 2, input: InputState): void {
    const virtualGamepad = port === 1
      ? (window as any).__virtualGamepadP1
      : (window as any).__virtualGamepadP2;

    if (!virtualGamepad) return;

    const keyMapping: Record<keyof InputState, string> = {
      up: 'up', down: 'down', left: 'left', right: 'right',
      a: 'a', b: 'b', x: 'x', y: 'y',
      l: 'l', r: 'r', start: 'start', select: 'select'
    };

    const buttons: (keyof InputState)[] = ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select', 'up', 'down', 'left', 'right'];

    for (const button of buttons) {
      const mappedButton = keyMapping[button];
      const pressed = input[button];

      if (pressed) {
        virtualGamepad.pressButton(mappedButton);
      } else {
        virtualGamepad.releaseButton(mappedButton);
      }
    }

    virtualGamepad.updateTimestamp();
  }

  /**
   * Pause both emulators
   */
  pauseAll(): void {
    for (const instance of this.instances) {
      if (instance) {
        instance.emulator.pause();
      }
    }
    logger.debug('All emulators paused');
  }

  /**
   * Resume both emulators
   */
  resumeAll(): void {
    for (const instance of this.instances) {
      if (instance) {
        instance.emulator.resume();
      }
    }
    logger.debug('All emulators resumed');
  }

  /**
   * Get memory checksum from active emulator
   */
  getMemoryChecksum(): string {
    const active = this.getActiveEmulator();
    if (!active) return '';
    return active.getMemoryChecksum();
  }

  /**
   * Save state from active emulator
   */
  async saveState(): Promise<{ state: Blob; thumbnail?: Blob }> {
    const active = this.getActiveEmulator();
    if (!active) {
      throw new Error('No active emulator');
    }
    return await active.saveState();
  }

  /**
   * Destroy both emulators and clean up
   */
  destroy(): void {
    for (const instance of this.instances) {
      if (instance) {
        try {
          instance.emulator.exit({ removeCanvas: false });
        } catch (error) {
          logger.debug('Error exiting emulator:', error);
        }
      }
    }

    this.instances = [null, null];
    this.isInitialized = false;
    logger.info('DualEmulatorManager destroyed');
  }
}
