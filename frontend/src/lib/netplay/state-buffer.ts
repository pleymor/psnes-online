/**
 * State Buffer - Ring buffer for savestate management
 *
 * Maintains a rolling window of savestates for rollback purposes.
 * Each savestate captures the complete emulator state at a specific frame.
 */

import type { WasmEmulator } from '$lib/emulator';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('StateBuffer');

export class StateBuffer {
  private buffer: Map<number, Blob> = new Map();
  private maxSize: number;
  private oldestFrame: number = 0;

  /**
   * @param maxSize Maximum number of states to keep (default: 10 frames)
   */
  constructor(maxSize: number = 10) {
    this.maxSize = maxSize;
  }

  /**
   * Save the current emulator state for a frame
   */
  async saveState(frame: number, emulator: WasmEmulator): Promise<void> {
    try {
      const result = await emulator.saveState();
      if (!result || !result.state) {
        logger.warn(`Failed to save state for frame ${frame}: no state returned`);
        return;
      }

      this.buffer.set(frame, result.state);
      this.cleanup(frame);

      logger.debug(`Saved state for frame ${frame} (buffer size: ${this.buffer.size})`);
    } catch (error) {
      logger.error(`Failed to save state for frame ${frame}:`, error);
    }
  }

  /**
   * Save state from raw Blob data (used when receiving initial state)
   */
  saveStateFromBlob(frame: number, state: Blob): void {
    this.buffer.set(frame, state);
    this.cleanup(frame);
    logger.debug(`Saved external state for frame ${frame}`);
  }

  /**
   * Get the saved state for a specific frame
   */
  getState(frame: number): Blob | null {
    return this.buffer.get(frame) || null;
  }

  /**
   * Check if we have a state for a specific frame
   */
  hasState(frame: number): boolean {
    return this.buffer.has(frame);
  }

  /**
   * Get the oldest frame we have state for
   */
  getOldestFrame(): number {
    if (this.buffer.size === 0) return -1;

    let oldest = Infinity;
    for (const frame of this.buffer.keys()) {
      if (frame < oldest) oldest = frame;
    }
    return oldest === Infinity ? -1 : oldest;
  }

  /**
   * Get the newest frame we have state for
   */
  getNewestFrame(): number {
    if (this.buffer.size === 0) return -1;

    let newest = -1;
    for (const frame of this.buffer.keys()) {
      if (frame > newest) newest = frame;
    }
    return newest;
  }

  /**
   * Get all frames we have states for (sorted)
   */
  getAvailableFrames(): number[] {
    return Array.from(this.buffer.keys()).sort((a, b) => a - b);
  }

  /**
   * Find the closest frame at or before the target frame
   */
  findClosestFrame(targetFrame: number): number {
    let closest = -1;
    for (const frame of this.buffer.keys()) {
      if (frame <= targetFrame && frame > closest) {
        closest = frame;
      }
    }
    return closest;
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.buffer.size;
  }

  /**
   * Clear all saved states
   */
  clear(): void {
    this.buffer.clear();
    this.oldestFrame = 0;
    logger.debug('State buffer cleared');
  }

  /**
   * Remove old states to stay within maxSize
   */
  private cleanup(currentFrame: number): void {
    if (this.buffer.size <= this.maxSize) return;

    // Get all frames sorted
    const frames = this.getAvailableFrames();

    // Remove oldest frames until we're at maxSize
    while (frames.length > this.maxSize) {
      const frameToRemove = frames.shift()!;
      this.buffer.delete(frameToRemove);
      logger.debug(`Removed old state for frame ${frameToRemove}`);
    }

    // Update oldest frame tracker
    this.oldestFrame = frames.length > 0 ? frames[0] : currentFrame;
  }

  /**
   * Get approximate memory usage in bytes
   */
  async getMemoryUsage(): Promise<number> {
    let total = 0;
    for (const state of this.buffer.values()) {
      total += state.size;
    }
    return total;
  }

  /**
   * Debug: print buffer status
   */
  debugPrint(): void {
    const frames = this.getAvailableFrames();
    logger.info(`StateBuffer: ${this.buffer.size}/${this.maxSize} states`);
    logger.info(`  Frames: [${frames.join(', ')}]`);
  }
}
