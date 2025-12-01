/**
 * Input Buffer - Manages input history with prediction
 *
 * Handles both local and remote inputs, with prediction for remote inputs
 * when they haven't arrived yet. Tracks which frames need rollback when
 * predictions turn out to be wrong.
 */

import type { InputState } from '$lib/types';
import type { RollbackInfo } from './types';
import { createEmptyInput, inputsEqual, cloneInput } from './types';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('InputBuffer');

interface StoredInput {
  input: InputState;
  confirmed: boolean;
  predictedInput?: InputState; // What we predicted before receiving confirmed
}

export class InputBuffer {
  // Local inputs (always confirmed)
  private localInputs: Map<number, InputState> = new Map();

  // Remote inputs (may be predicted or confirmed)
  private remoteInputs: Map<number, StoredInput> = new Map();

  // Last confirmed remote input (for prediction)
  private lastConfirmedRemoteInput: InputState = createEmptyInput();
  private lastConfirmedRemoteFrame: number = -1;

  // Track frames where prediction was wrong (need rollback)
  private mispredictedFrames: Set<number> = new Set();

  // How many frames of history to keep
  private maxHistorySize: number;

  constructor(maxHistorySize: number = 120) {
    this.maxHistorySize = maxHistorySize;
  }

  // ===========================================================================
  // Local Input Management
  // ===========================================================================

  /**
   * Record a local input for a specific frame
   */
  setLocalInput(frame: number, input: InputState): void {
    this.localInputs.set(frame, cloneInput(input));
    this.cleanup(frame);
  }

  /**
   * Get local input for a frame (returns empty if not found)
   */
  getLocalInput(frame: number): InputState {
    return this.localInputs.get(frame) || createEmptyInput();
  }

  /**
   * Check if we have local input for a frame
   */
  hasLocalInput(frame: number): boolean {
    return this.localInputs.has(frame);
  }

  // ===========================================================================
  // Remote Input Management
  // ===========================================================================

  /**
   * Receive a confirmed remote input from the network
   * Returns true if this causes a misprediction (need rollback)
   */
  setRemoteInput(frame: number, input: InputState): boolean {
    const existing = this.remoteInputs.get(frame);
    let mispredicted = false;

    if (existing) {
      // We already had a prediction for this frame
      if (existing.confirmed) {
        // Already confirmed, ignore duplicate
        logger.debug(`Ignoring duplicate input for frame ${frame}`);
        return false;
      }

      // Check if our prediction was wrong
      if (!inputsEqual(existing.input, input)) {
        mispredicted = true;
        this.mispredictedFrames.add(frame);
        logger.debug(`Misprediction at frame ${frame}`);
      }

      // Store confirmed input (keep prediction for debugging)
      existing.input = cloneInput(input);
      existing.confirmed = true;
      existing.predictedInput = existing.input;
    } else {
      // First time seeing this frame
      this.remoteInputs.set(frame, {
        input: cloneInput(input),
        confirmed: true
      });
    }

    // Update last confirmed tracker
    if (frame > this.lastConfirmedRemoteFrame) {
      this.lastConfirmedRemoteFrame = frame;
      this.lastConfirmedRemoteInput = cloneInput(input);
    }

    this.cleanup(frame);
    return mispredicted;
  }

  /**
   * Get remote input for a frame (predicts if not confirmed)
   */
  getRemoteInput(frame: number): InputState {
    const stored = this.remoteInputs.get(frame);

    if (stored) {
      return stored.input;
    }

    // Need to predict - use last confirmed input
    const predicted = this.predictInput();
    this.remoteInputs.set(frame, {
      input: predicted,
      confirmed: false
    });

    return predicted;
  }

  /**
   * Check if we have remote input for a frame (confirmed or predicted)
   */
  hasRemoteInput(frame: number): boolean {
    return this.remoteInputs.has(frame) && this.remoteInputs.get(frame)?.confirmed === true;
  }

  /**
   * Check if remote input for a frame is confirmed
   */
  isRemoteInputConfirmed(frame: number): boolean {
    const stored = this.remoteInputs.get(frame);
    return stored?.confirmed ?? false;
  }

  /**
   * Get the last frame where remote input is confirmed
   */
  getLastConfirmedRemoteFrame(): number {
    return this.lastConfirmedRemoteFrame;
  }

  // ===========================================================================
  // Rollback Detection
  // ===========================================================================

  /**
   * Check if we need to rollback
   * Returns info about the rollback needed
   */
  checkRollback(currentFrame: number): RollbackInfo {
    if (this.mispredictedFrames.size === 0) {
      return { needed: false, rollbackToFrame: currentFrame };
    }

    // Find the earliest mispredicted frame
    let earliestMispredict = currentFrame;
    for (const frame of this.mispredictedFrames) {
      if (frame < earliestMispredict) {
        earliestMispredict = frame;
      }
    }

    // Clear mispredictions (they'll be resolved by the rollback)
    this.mispredictedFrames.clear();

    return {
      needed: true,
      rollbackToFrame: earliestMispredict,
      reason: `Misprediction at frame ${earliestMispredict}`
    };
  }

  /**
   * Clear all pending mispredictions (call after rollback)
   */
  clearMispredictions(): void {
    this.mispredictedFrames.clear();
  }

  /**
   * Mark a range of frames as needing re-simulation
   * (used when we receive late inputs)
   */
  invalidateFrameRange(fromFrame: number, toFrame: number): void {
    for (let f = fromFrame; f <= toFrame; f++) {
      if (this.remoteInputs.has(f)) {
        const stored = this.remoteInputs.get(f)!;
        if (!stored.confirmed) {
          this.mispredictedFrames.add(f);
        }
      }
    }
  }

  // ===========================================================================
  // Combined Input Access
  // ===========================================================================

  /**
   * Get both inputs for a frame
   * @param isHost - If true, local=P1, remote=P2. Otherwise local=P2, remote=P1
   */
  getInputsForFrame(frame: number, isHost: boolean): { p1: InputState; p2: InputState } {
    const local = this.getLocalInput(frame);
    const remote = this.getRemoteInput(frame);

    if (isHost) {
      return { p1: local, p2: remote };
    } else {
      return { p1: remote, p2: local };
    }
  }

  // ===========================================================================
  // Prediction
  // ===========================================================================

  /**
   * Predict what the remote input will be
   * Strategy: Repeat the last confirmed input
   */
  private predictInput(): InputState {
    return cloneInput(this.lastConfirmedRemoteInput);
  }

  // ===========================================================================
  // Housekeeping
  // ===========================================================================

  /**
   * Clean up old inputs to prevent memory growth
   */
  private cleanup(currentFrame: number): void {
    const oldestToKeep = currentFrame - this.maxHistorySize;

    // Clean local inputs
    for (const frame of this.localInputs.keys()) {
      if (frame < oldestToKeep) {
        this.localInputs.delete(frame);
      }
    }

    // Clean remote inputs
    for (const frame of this.remoteInputs.keys()) {
      if (frame < oldestToKeep) {
        this.remoteInputs.delete(frame);
      }
    }

    // Clean mispredicted frames
    for (const frame of this.mispredictedFrames) {
      if (frame < oldestToKeep) {
        this.mispredictedFrames.delete(frame);
      }
    }
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.localInputs.clear();
    this.remoteInputs.clear();
    this.mispredictedFrames.clear();
    this.lastConfirmedRemoteInput = createEmptyInput();
    this.lastConfirmedRemoteFrame = -1;
  }

  // ===========================================================================
  // Debug
  // ===========================================================================

  /**
   * Get statistics about the buffer state
   */
  getStats(): {
    localInputCount: number;
    remoteInputCount: number;
    confirmedRemoteCount: number;
    predictedRemoteCount: number;
    mispredictedCount: number;
    lastConfirmedFrame: number;
  } {
    let confirmedCount = 0;
    let predictedCount = 0;

    for (const stored of this.remoteInputs.values()) {
      if (stored.confirmed) {
        confirmedCount++;
      } else {
        predictedCount++;
      }
    }

    return {
      localInputCount: this.localInputs.size,
      remoteInputCount: this.remoteInputs.size,
      confirmedRemoteCount: confirmedCount,
      predictedRemoteCount: predictedCount,
      mispredictedCount: this.mispredictedFrames.size,
      lastConfirmedFrame: this.lastConfirmedRemoteFrame
    };
  }

  debugPrint(): void {
    const stats = this.getStats();
    logger.info('InputBuffer stats:', stats);
  }
}
