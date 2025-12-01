/**
 * Frame Controller - Intercepts requestAnimationFrame for lockstep netplay
 *
 * This class allows us to control exactly when frames execute by intercepting
 * the browser's requestAnimationFrame. Instead of letting RetroArch run freely,
 * we hold frames until both players' inputs are ready.
 *
 * Usage:
 * 1. Call install() BEFORE creating the emulator
 * 2. The emulator will call RAF but frames won't execute automatically
 * 3. Call advanceFrame() when ready to execute one frame
 * 4. Call uninstall() when done
 */

import { createLogger } from '$lib/utils/logger';

const logger = createLogger('FrameController');

export class FrameController {
  private originalRAF: typeof requestAnimationFrame;
  private originalCAF: typeof cancelAnimationFrame;
  private pendingCallback: FrameRequestCallback | null = null;
  private frameReady = false;
  private frameCompleteResolver: (() => void) | null = null;
  private installed = false;
  private frameCount = 0;

  constructor() {
    this.originalRAF = window.requestAnimationFrame.bind(window);
    this.originalCAF = window.cancelAnimationFrame.bind(window);
  }

  /**
   * Install the RAF interception
   * MUST be called BEFORE creating the emulator
   */
  install(): void {
    if (this.installed) {
      logger.warn('FrameController already installed');
      return;
    }

    logger.info('🎮 Installing FrameController - intercepting requestAnimationFrame');
    logger.info('Original RAF:', typeof this.originalRAF);

    // Override requestAnimationFrame
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      // Store the callback but DON'T execute it automatically
      this.pendingCallback = callback;

      // If frame is already marked ready (advanceFrame was called before RAF),
      // execute immediately
      if (this.frameReady) {
        this.executeFrame();
      }

      // Return a dummy handle (we don't support cancellation in lockstep mode)
      return -1;
    };

    // Override cancelAnimationFrame to be a no-op in lockstep mode
    window.cancelAnimationFrame = (_handle: number): void => {
      // Ignore cancellation requests - we control frame timing
    };

    this.installed = true;
    this.frameCount = 0;
  }

  /**
   * Restore original RAF behavior
   */
  uninstall(): void {
    if (!this.installed) {
      return;
    }

    logger.info('Uninstalling FrameController - restoring requestAnimationFrame');

    window.requestAnimationFrame = this.originalRAF;
    window.cancelAnimationFrame = this.originalCAF;
    this.installed = false;
    this.pendingCallback = null;
    this.frameReady = false;
  }

  /**
   * Check if FrameController is installed
   */
  isInstalled(): boolean {
    return this.installed;
  }

  /**
   * Advance exactly one frame
   * Returns a promise that resolves when the frame has been executed
   */
  async advanceFrame(): Promise<void> {
    if (!this.installed) {
      logger.warn('advanceFrame called but FrameController not installed');
      return;
    }

    return new Promise<void>((resolve) => {
      this.frameCompleteResolver = resolve;
      this.frameReady = true;

      // If we already have a pending callback, execute it
      if (this.pendingCallback) {
        this.executeFrame();
      } else {
        // No pending callback - wait a bit then check again
        // This handles the case where RAF hasn't been called yet
        const checkInterval = setInterval(() => {
          if (this.pendingCallback && this.frameReady) {
            clearInterval(checkInterval);
            this.executeFrame();
          }
        }, 1);

        // Timeout after 50ms to prevent infinite wait
        setTimeout(() => {
          clearInterval(checkInterval);
          if (this.frameReady) {
            // Frame was never executed, resolve anyway to prevent deadlock
            this.frameReady = false;
            if (this.frameCompleteResolver) {
              this.frameCompleteResolver();
              this.frameCompleteResolver = null;
            }
          }
        }, 50);
      }
    });
  }

  /**
   * Execute the pending frame
   */
  private executeFrame(): void {
    if (!this.pendingCallback || !this.frameReady) {
      if (this.frameCount % 60 === 0) {
        logger.warn(`executeFrame: no callback=${!this.pendingCallback}, not ready=${!this.frameReady}`);
      }
      return;
    }

    const callback = this.pendingCallback;
    this.pendingCallback = null;
    this.frameReady = false;

    const now = performance.now();

    // Execute the frame callback via a microtask to allow proper async behavior
    // This is important because the emulator expects RAF to be asynchronous
    queueMicrotask(() => {
      try {
        callback(now);
        this.frameCount++;

        // Log periodically
        if (this.frameCount % 300 === 0) {
          logger.debug(`FrameController: frame ${this.frameCount} executed`);
        }
      } catch (e) {
        logger.error('Frame callback error:', e);
      }

      // Signal frame complete
      if (this.frameCompleteResolver) {
        this.frameCompleteResolver();
        this.frameCompleteResolver = null;
      }
    });
  }

  /**
   * Check if there's a frame waiting to be executed
   */
  hasPendingFrame(): boolean {
    return this.pendingCallback !== null;
  }

  /**
   * Get current frame count
   */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Reset frame counter
   */
  resetFrameCount(): void {
    this.frameCount = 0;
  }
}

// Singleton instance for global access
let globalFrameController: FrameController | null = null;

/**
 * Get or create the global FrameController instance
 */
export function getFrameController(): FrameController {
  if (!globalFrameController) {
    globalFrameController = new FrameController();
  }
  return globalFrameController;
}

/**
 * Destroy the global FrameController instance
 */
export function destroyFrameController(): void {
  if (globalFrameController) {
    globalFrameController.uninstall();
    globalFrameController = null;
  }
}
