/**
 * Simple Sync Manager - Deterministic synchronization for dual emulation mode
 *
 * Uses Kaillera-style input delay synchronization:
 * 1. Both emulators start from the same state (host sends state to guest)
 * 2. Inputs are tagged with a target frame = currentFrame + inputDelay
 * 3. Both emulators wait until they have inputs from both players for a frame
 * 4. Only then do they apply the inputs and advance
 *
 * This ensures both emulators apply the same inputs at the same logical frame.
 */

import type { WasmEmulator } from '$lib/emulator';
import type { InputState } from '$lib/types';
import { InputManager } from '$lib/emulator/input-manager';
import { createLogger } from '$lib/utils/logger';
import type { NetplayMessage, InputMessage } from './types';
import { createEmptyInput } from './types';
import type { ChecksumWorkerResponse, CompareResultResponse, SerializedStateResponse } from './checksum-worker';
import ChecksumWorker from './checksum-worker?worker';

const logger = createLogger('SimpleSyncManager');

export interface SimpleSyncCallbacks {
  /** Send a message to the remote peer */
  onSendMessage: (msg: NetplayMessage) => void;
  /** Apply inputs to the emulator (called before each frame) */
  onApplyInputs: (p1: InputState, p2: InputState) => void;
  /** Get the current local input state */
  onGetLocalInput: () => InputState;
  /** Called when a desync is detected */
  onDesync?: (localChecksum: string, remoteChecksum: string, frame: number) => void;
  /** Called to report checksum to the server (for server-side comparison) */
  onReportChecksum?: (frame: number, checksum: string) => void;
  /** Called to load state with seamless swap (for dual emulator mode) */
  onLoadStateForSwap?: (stateBlob: Blob) => Promise<void>;
  /** Called before loading state - freeze canvas to prevent black screen */
  onFreezeCanvas?: () => void;
  /** Called after loading state - unfreeze canvas */
  onUnfreezeCanvas?: () => void;
  /** Called after resync completes successfully */
  onResyncComplete?: () => void;
}

export interface SimpleSyncConfig {
  isHost: boolean;
  /** Interval (in frames) for checksum verification. 0 = disabled */
  checksumInterval?: number;
  /** Frame rate target (default 60) */
  targetFps?: number;
  /** Input delay in frames - gives time for remote inputs to arrive (default 3) */
  inputDelayFrames?: number;
}

export class SimpleSyncManager {
  private emulator: WasmEmulator;
  private callbacks: SimpleSyncCallbacks;
  private config: SimpleSyncConfig;
  private inputManager = new InputManager();

  // Getter function for dynamic emulator reference (used in dual emulator mode)
  private emulatorGetter: (() => WasmEmulator) | null = null;

  // Frame tracking
  private currentFrame = 0;        // Current execution frame
  private inputFrame = 0;          // Frame for which we're collecting inputs (currentFrame + delay)
  private isRunning = false;

  // Input buffering - keyed by target frame
  private localInputs: Map<number, InputState> = new Map();
  private remoteInputs: Map<number, InputState> = new Map();

  // Initial state sync
  private initialStateSent = false;
  private initialStateReceived = false;
  private initialStateAckReceived = false;
  private ackResolver: (() => void) | null = null;

  // Stats
  private lastFrameTime = 0;
  private waitingForInput = false;
  private consecutiveWaits = 0;

  // Checksum worker
  private checksumWorker: Worker | null = null;

  // Pending checksums from GUEST (HOST stores these until reaching that frame)
  private pendingRemoteChecksums: Map<number, string> = new Map();

  // Resync chunk assembly (GUEST only)
  private resyncChunks: Map<number, number[]> = new Map(); // chunkIndex -> data
  private resyncFrame = -1;
  private resyncTotalChunks = 0;

  // Resync cooldown - pause checksum verification until both sides have resynced
  private resyncInProgress = false;
  private resyncAckResolver: (() => void) | null = null;
  private resyncAckTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastResyncFrame = 0; // Ignore sync_checks for frames before this
  private resyncEpoch = 0; // Incremented on each resync, used to detect stale checksums
  private consecutiveMismatches = 0; // Only trigger resync after multiple consecutive mismatches
  private readonly MISMATCH_THRESHOLD = 3; // Require 3 consecutive mismatches before resync
  private skipSyncChecksUntilFrame = 0; // Skip sync checks until this frame (cooldown after resync)
  private pendingResync = false; // Flag to trigger resync at end of next frame

  constructor(
    emulator: WasmEmulator,
    callbacks: SimpleSyncCallbacks,
    config: SimpleSyncConfig
  ) {
    this.emulator = emulator;
    this.callbacks = callbacks;
    this.config = {
      checksumInterval: 0, // Disabled by default (causes errors during gameplay)
      targetFps: 60,
      inputDelayFrames: 3, // 3 frames of input delay (~50ms at 60fps) - Kaillera style
      ...config
    };

    logger.info('SimpleSyncManager created', {
      isHost: config.isHost,
      inputDelay: this.config.inputDelayFrames
    });

    // Initialize checksum worker (both HOST and GUEST need it)
    this.initChecksumWorker();
  }

  /**
   * Set a getter function to dynamically retrieve the current emulator
   * Used in dual emulator mode where the active emulator changes on swap
   */
  setEmulatorGetter(getter: () => WasmEmulator): void {
    this.emulatorGetter = getter;
    logger.info('Emulator getter set for dynamic emulator reference');
  }

  /**
   * Trigger a resync at the end of the current frame (HOST only)
   * This is called when server detects desync
   */
  triggerResync(frame: number): void {
    if (!this.config.isHost) {
      logger.warn('triggerResync called on non-host');
      return;
    }

    if (this.resyncInProgress) {
      logger.info(`[HOST] Resync already in progress, ignoring trigger at frame ${frame}`);
      return;
    }

    if (this.pendingResync) {
      logger.info(`[HOST] Resync already pending, ignoring trigger at frame ${frame}`);
      return;
    }

    // Add cooldown - don't resync too frequently
    if (this.currentFrame < this.skipSyncChecksUntilFrame) {
      logger.info(`[HOST] Skipping resync trigger at frame ${this.currentFrame} (cooldown until frame ${this.skipSyncChecksUntilFrame})`);
      return;
    }

    logger.info(`[HOST] Resync triggered by server at frame ${frame}, will execute at end of next frame`);
    this.pendingResync = true;
  }

  /**
   * Check if a resync is in progress or pending
   */
  isResyncActive(): boolean {
    return this.resyncInProgress || this.pendingResync;
  }

  /**
   * Get the current active emulator
   * Uses the getter if set, otherwise returns the static reference
   */
  private getEmulator(): WasmEmulator {
    if (this.emulatorGetter) {
      return this.emulatorGetter();
    }
    return this.emulator;
  }

  /**
   * Initialize the checksum worker
   */
  private initChecksumWorker(): void {
    try {
      this.checksumWorker = new ChecksumWorker();
      this.checksumWorker.onmessage = (event: MessageEvent<ChecksumWorkerResponse>) => {
        this.onChecksumResult(event.data);
      };
      logger.info('Checksum worker initialized');
    } catch (error) {
      logger.error('Failed to initialize checksum worker:', error);
    }
  }

  /**
   * Handle checksum result from worker
   */
  private onChecksumResult(result: ChecksumWorkerResponse): void {
    if (result.type === 'checksum_result') {
      // GUEST: Send only last 4 chars of checksum to HOST (stable game state part)
      const checksumSuffix = result.checksum.slice(-4);
      this.callbacks.onSendMessage({
        type: 'sync_check',
        frame: result.frame,
        checksum: checksumSuffix,
        timestamp: performance.now(),
        epoch: this.resyncEpoch
      });
      logger.debug(`[GUEST] Sent checksum for frame ${result.frame} (epoch ${this.resyncEpoch}): ...${checksumSuffix}`);
    } else if (result.type === 'compare_result') {
      // HOST: Handle comparison result from worker
      this.onCompareResult(result);
    } else if (result.type === 'serialized_state') {
      // HOST: Send serialized state to GUEST
      this.onSerializedState(result);
    }
  }

  /**
   * HOST: Handle serialized state from worker, send to GUEST in chunks
   */
  private async onSerializedState(result: SerializedStateResponse): Promise<void> {
    const CHUNK_SIZE = 8000; // ~8KB per chunk (safe for WebRTC ~16KB limit)
    const stateArray = result.stateArray;
    const totalChunks = Math.ceil(stateArray.length / CHUNK_SIZE);

    logger.info(`[HOST] Sending resync state in ${totalChunks} chunks (${stateArray.length} bytes total)`);

    // Note: resyncInProgress is already set to true in onSyncCheck when desync is detected

    // Send chunks
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, stateArray.length);
      const chunk = stateArray.slice(start, end);

      this.callbacks.onSendMessage({
        type: 'resync_chunk',
        frame: result.frame,
        chunkIndex: i,
        totalChunks,
        data: chunk
      });
    }

    // Send completion message
    this.callbacks.onSendMessage({
      type: 'resync_complete',
      frame: result.frame,
      totalSize: stateArray.length
    });

    logger.info(`[HOST] Resync state sent (${stateArray.length} bytes in ${totalChunks} chunks), waiting for ACK...`);

    // Wait for GUEST ACK before continuing
    await this.waitForResyncAck(result.frame);

    logger.info(`[HOST] Resync ACK received, resuming at frame ${result.frame}`);
  }

  /**
   * HOST: Wait for resync ACK from GUEST (with timeout)
   */
  private waitForResyncAck(frame: number): Promise<void> {
    return new Promise((resolve) => {
      // Clear any previous timeout
      if (this.resyncAckTimeout) {
        clearTimeout(this.resyncAckTimeout);
        this.resyncAckTimeout = null;
      }

      // Store resolver for when ACK arrives
      this.resyncAckResolver = resolve;

      // Timeout after 10 seconds
      this.resyncAckTimeout = setTimeout(() => {
        if (this.resyncAckResolver) {
          logger.warn(`[HOST] Resync ACK timeout for frame ${frame}, resuming anyway`);
          this.resyncAckResolver = null;
          this.resyncAckTimeout = null;
          this.resyncInProgress = false;
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * HOST: Handle comparison result from worker
   */
  private onCompareResult(result: CompareResultResponse): void {
    if (result.match) {
      logger.debug(`[HOST] Frame ${result.frame} SYNC OK (checksum: ${result.localChecksum})`);
    } else {
      logger.debug(`[HOST] Frame ${result.frame} DESYNC! Local: ${result.localChecksum}, Remote: ${result.remoteChecksum}`);
      this.callbacks.onDesync?.(result.localChecksum, result.remoteChecksum, result.frame);

      // Send resync state to GUEST
      this.sendResyncState(result.frame);
    }
  }

  /**
   * HOST: Send current state to GUEST for resync
   */
  private async sendResyncState(frame: number): Promise<void> {
    if (!this.checksumWorker) {
      logger.error('[HOST] Checksum worker not available for resync');
      return;
    }

    logger.info(`[HOST] Preparing resync state for frame ${frame}...`);

    try {
      const { state } = await this.getEmulator().saveState();
      const arrayBuffer = await state.arrayBuffer();
      const stateData = new Uint8Array(arrayBuffer);

      logger.info(`[HOST] State captured (${arrayBuffer.byteLength} bytes), sending to worker...`);

      // Send to worker for serialization (Array.from is slow on main thread)
      this.checksumWorker.postMessage({
        type: 'serialize_state',
        frame: this.currentFrame, // Use current frame, not the desync frame
        stateData
      }, [stateData.buffer]); // Transfer buffer for efficiency
    } catch (error) {
      logger.error('[HOST] Failed to prepare resync state:', error);
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Send initial state to guest (HOST only)
   */
  async sendInitialState(): Promise<void> {
    if (!this.config.isHost) {
      logger.warn('sendInitialState called on non-host');
      return;
    }

    logger.info('HOST: Creating and sending initial state...');

    try {
      // Resume to let the game fully initialize (random world generation, etc.)
      logger.info('HOST: Resuming emulator for initialization...');
      this.getEmulator().resume();
      await new Promise(r => setTimeout(r, 1000)); // Wait 1 second for game init

      // Pause before capturing state
      logger.info('HOST: Pausing emulator...');
      this.getEmulator().pause();
      await new Promise(r => setTimeout(r, 100));

      // frameAdvance to process any pending commands (like sync-test does)
      this.getEmulator().frameAdvance();
      await new Promise(r => setTimeout(r, 50));

      // Capture state
      const { state } = await this.getEmulator().saveState();
      const arrayBuffer = await state.arrayBuffer();

      // Compute checksum
      const checksum = await this.computeChecksumFromBuffer(arrayBuffer);
      logger.info(`HOST: Initial state captured (${arrayBuffer.byteLength} bytes, checksum: ${checksum})`);

      // Send to guest
      this.callbacks.onSendMessage({
        type: 'initial_state',
        state: Array.from(new Uint8Array(arrayBuffer)),
        frame: 0
      });

      this.initialStateSent = true;
      this.currentFrame = 0;

      logger.info('HOST: Initial state sent, waiting for ACK...');

      // Wait for ACK from guest (with timeout)
      await this.waitForAck();

      logger.info('HOST: ACK received, ready to start');
    } catch (error) {
      logger.error('HOST: Failed to send initial state:', error);
      throw error;
    }
  }

  /**
   * Wait for ACK from guest (with timeout)
   */
  private waitForAck(): Promise<void> {
    return new Promise((resolve) => {
      if (this.initialStateAckReceived) {
        resolve();
        return;
      }

      // Store resolver for when ACK arrives
      this.ackResolver = resolve;

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.ackResolver) {
          logger.warn('HOST: ACK timeout, starting anyway');
          this.ackResolver = null;
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * Load initial state from host (GUEST only)
   */
  async loadInitialState(stateData: number[]): Promise<void> {
    if (this.config.isHost) {
      logger.warn('loadInitialState called on host');
      return;
    }

    logger.info(`GUEST: Loading initial state (${stateData.length} bytes)...`);

    try {
      const arrayBuffer = new Uint8Array(stateData).buffer;
      const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });

      // Compute checksum of received state for logging
      const checksum = await this.computeChecksumFromBuffer(arrayBuffer);
      logger.info(`GUEST: Received state checksum: ${checksum}`);

      // Load the state directly - emulator should be paused already (startPaused=true)
      logger.info('GUEST: Loading state...');
      await this.getEmulator().loadState(blob);

      // Wait for state to load
      await new Promise(r => setTimeout(r, 200));

      // Verify checksum after load
      const loadedChecksum = await this.computeChecksum();
      logger.info(`GUEST: State loaded, verify checksum: ${loadedChecksum}`);

      this.initialStateReceived = true;
      this.currentFrame = 0;

      // Send ACK
      this.callbacks.onSendMessage({ type: 'initial_state_ack' });

      logger.info('GUEST: Initial state loaded and ACK sent');
    } catch (error) {
      logger.error('GUEST: Failed to load initial state:', error);
      throw error;
    }
  }

  /**
   * Check if ready to start
   */
  isReady(): boolean {
    return this.config.isHost ? this.initialStateSent : this.initialStateReceived;
  }

  // ===========================================================================
  // Main Loop
  // ===========================================================================

  /**
   * Start the sync loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('SimpleSyncManager already running');
      return;
    }

    if (!this.isReady()) {
      logger.error('Cannot start: not ready (initial state not synced)');
      return;
    }

    const inputDelay = this.config.inputDelayFrames || 3;
    logger.info(`Starting Kaillera-style sync loop with ${inputDelay} frames input delay...`);

    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.currentFrame = 0;
    this.inputFrame = 0;

    // Pre-buffer empty inputs for the first N frames (input delay frames)
    // This allows both sides to start immediately without waiting
    for (let i = 0; i < inputDelay; i++) {
      this.localInputs.set(i, createEmptyInput());
      this.remoteInputs.set(i, createEmptyInput());
    }

    // Let emulator run freely - we control inputs via the sync loop
    this.getEmulator().resume();

    // Start the synchronized input loop
    this.runSyncLoop();
  }

  /**
   * Stop the sync loop
   */
  stop(): void {
    this.isRunning = false;
    logger.info('Simple sync loop stopped');
  }

  /**
   * Kaillera-style synchronized input loop
   *
   * Key principle: Inputs are sent with a target frame = currentFrame + inputDelay
   * We only advance when we have BOTH local and remote inputs for the current frame
   */
  private runSyncLoop(): void {
    if (!this.isRunning) return;

    const inputDelay = this.config.inputDelayFrames || 3;
    const targetFrame = this.inputFrame + inputDelay;

    // 1. Capture and send current local input for future frame
    const localInput = this.callbacks.onGetLocalInput();
    this.localInputs.set(targetFrame, localInput);

    const player = this.config.isHost ? 1 : 2;
    const encoded = this.inputManager.encodeInput(localInput);


    this.callbacks.onSendMessage({
      type: 'input',
      frame: targetFrame,
      player: player as 1 | 2,
      input: Array.from(encoded)
    });

    // 2. Check if we have inputs for the current execution frame
    const execFrame = this.currentFrame;
    const hasLocalInput = this.localInputs.has(execFrame);
    const hasRemoteInput = this.remoteInputs.has(execFrame);


    if (hasLocalInput && hasRemoteInput) {
      // We have both inputs - apply them and advance
      const localExecInput = this.localInputs.get(execFrame)!;
      const remoteExecInput = this.remoteInputs.get(execFrame)!;

      // Determine P1 and P2 based on role
      const p1Input = this.config.isHost ? localExecInput : remoteExecInput;
      const p2Input = this.config.isHost ? remoteExecInput : localExecInput;

      // Apply inputs to emulator
      this.callbacks.onApplyInputs(p1Input, p2Input);

      // Reset wait counter
      if (this.waitingForInput) {
        this.waitingForInput = false;
        this.consecutiveWaits = 0;
      }

      // Clean up old inputs periodically
      if (execFrame % 60 === 0) {
        this.cleanupOldInputs(execFrame);
      }

      // Log checksum every 5 seconds (300 frames at 60fps) for debugging
      // Uses fast memory checksum - no saveState() needed
      if (execFrame > 0 && execFrame % 300 === 0) {
        this.logChecksum(execFrame);
      }

      // Advance both frame counters
      this.currentFrame++;
      this.inputFrame++;

      // Check for pending resync (triggered by server desync detection)
      // This happens AFTER frame advancement to ensure clean state
      if (this.config.isHost && this.pendingResync && !this.resyncInProgress) {
        this.pendingResync = false;
        this.resyncInProgress = true;
        logger.info(`[HOST] Executing pending resync at frame ${this.currentFrame}`);
        this.getEmulator().pause();
        this.sendResyncState(this.currentFrame);
        return; // Stop sync loop, will restart after resync completes
      }
    } else {
      // Waiting for remote input - this causes the "lag" in Kaillera style
      if (!this.waitingForInput) {
        this.waitingForInput = true;
      }
      this.consecutiveWaits++;

      // Still advance input frame to keep sending our inputs
      this.inputFrame++;
    }

    // Schedule next iteration
    // Note: During resync, the loop is paused and will be restarted by onResyncComplete/onResyncAck
    if (!this.resyncInProgress) {
      requestAnimationFrame(() => this.runSyncLoop());
    }
    // If resyncInProgress is true, the loop stops here and will be restarted after resync
  }

  /**
   * Clean up old inputs to prevent memory leak
   */
  private cleanupOldInputs(currentFrame: number): void {
    const keepFrames = 60; // Keep last 60 frames of input history
    const cutoff = currentFrame - keepFrames;

    Array.from(this.localInputs.keys()).forEach(frame => {
      if (frame < cutoff) this.localInputs.delete(frame);
    });
    Array.from(this.remoteInputs.keys()).forEach(frame => {
      if (frame < cutoff) this.remoteInputs.delete(frame);
    });

    // Also clean up old pending checksums (HOST only)
    Array.from(this.pendingRemoteChecksums.keys()).forEach(frame => {
      if (frame < cutoff) this.pendingRemoteChecksums.delete(frame);
    });
  }

  // ===========================================================================
  // Network Message Handling
  // ===========================================================================

  /**
   * Handle incoming message from remote peer
   */
  onMessage(msg: NetplayMessage): void {
    switch (msg.type) {
      case 'input':
        this.onRemoteInput(msg);
        break;
      case 'initial_state':
        // Handled via loadInitialState()
        break;
      case 'initial_state_ack':
        logger.info('HOST: Received initial state ACK from guest');
        this.initialStateAckReceived = true;
        if (this.ackResolver) {
          this.ackResolver();
          this.ackResolver = null;
        }
        break;
      case 'sync_check':
        this.onSyncCheck(msg);
        break;
      case 'sync_result':
        if (!msg.match) {
          logger.error(`DESYNC at frame ${msg.frame}!`);
          this.callbacks.onDesync?.(msg.localChecksum || '', msg.remoteChecksum || '', msg.frame);
        }
        break;
      case 'resync_state':
        this.onResyncState(msg);
        break;
      case 'resync_chunk':
        this.onResyncChunk(msg);
        break;
      case 'resync_complete':
        this.onResyncComplete(msg);
        break;
      case 'resync_ack':
        this.onResyncAck(msg);
        break;
    }
  }

  /**
   * HOST: Handle resync ACK from GUEST
   */
  private onResyncAck(msg: { frame: number; epoch: number }): void {
    if (!this.config.isHost) {
      return;
    }

    logger.info(`[HOST] Received resync ACK for frame ${msg.frame}, epoch ${msg.epoch}`);

    // Update HOST's epoch to match GUEST's
    this.resyncEpoch = msg.epoch;

    // Reset mismatch counter after successful resync
    this.consecutiveMismatches = 0;

    // Skip periodic sync for a while after resync
    this.skipSyncChecksUntilFrame = msg.frame + 300; // Skip for 5 seconds
    logger.info(`[HOST] Skipping sync checks until frame ${this.skipSyncChecksUntilFrame}`);

    // Clear the timeout
    if (this.resyncAckTimeout) {
      clearTimeout(this.resyncAckTimeout);
      this.resyncAckTimeout = null;
    }

    // Reset HOST to the same frame as GUEST
    this.currentFrame = msg.frame;
    this.inputFrame = msg.frame;

    // Clear input buffers
    this.localInputs.clear();
    this.remoteInputs.clear();

    // Pre-buffer empty inputs for input delay frames
    const inputDelay = this.config.inputDelayFrames || 3;
    for (let i = 0; i < inputDelay; i++) {
      const frame = this.currentFrame + i;
      this.localInputs.set(frame, createEmptyInput());
      this.remoteInputs.set(frame, createEmptyInput());
    }

    // Send a batch of empty inputs for frames that remote will need soon
    // This primes the remote with inputs before their sync loop needs them
    const player = this.config.isHost ? 1 : 2;
    for (let i = 0; i < inputDelay * 3; i++) {
      const frame = this.currentFrame + inputDelay + i;
      const encoded = this.inputManager.encodeInput(createEmptyInput());
      this.callbacks.onSendMessage({
        type: 'input',
        frame: frame,
        player: player as 1 | 2,
        input: Array.from(encoded)
      });
    }

    // Clear pending checksums (stale after resync)
    this.pendingRemoteChecksums.clear();

    // Update lastResyncFrame
    this.lastResyncFrame = msg.frame;

    // Mark resync complete
    this.resyncInProgress = false;

    // Notify callback that resync is complete
    this.callbacks.onResyncComplete?.();

    // Resume emulator
    this.getEmulator().resume();
    logger.info(`[HOST] Resumed after resync at frame ${this.currentFrame}, sent ${inputDelay * 3} priming inputs`);

    // Resolve the waiting promise
    if (this.resyncAckResolver) {
      this.resyncAckResolver();
      this.resyncAckResolver = null;
    }

    // Restart the sync loop
    this.waitingForInput = false;
    this.consecutiveWaits = 0;
    requestAnimationFrame(() => this.runSyncLoop());
  }

  /**
   * GUEST: Handle resync state from HOST
   */
  private async onResyncState(msg: { frame: number; state: number[] }): Promise<void> {
    if (this.config.isHost) {
      logger.warn('[HOST] Received resync_state but HOST should not receive this');
      return;
    }

    logger.info(`[GUEST] Received resync state for frame ${msg.frame} (${msg.state.length} bytes)`);

    try {
      const arrayBuffer = new Uint8Array(msg.state).buffer;
      const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });

      // Load the state
      await this.getEmulator().loadState(blob);

      // Update our frame counter to match HOST
      this.currentFrame = msg.frame;
      this.inputFrame = msg.frame;

      // Clear input buffers to avoid stale inputs
      this.localInputs.clear();
      this.remoteInputs.clear();

      // Pre-buffer empty inputs for input delay frames
      const inputDelay = this.config.inputDelayFrames || 3;
      for (let i = 0; i < inputDelay; i++) {
        const frame = this.currentFrame + i;
        this.localInputs.set(frame, createEmptyInput());
        this.remoteInputs.set(frame, createEmptyInput());
      }

      logger.info(`[GUEST] Resync complete, now at frame ${this.currentFrame}`);
    } catch (error) {
      logger.error('[GUEST] Failed to load resync state:', error);
    }
  }

  /**
   * GUEST: Handle resync chunk from HOST
   */
  private onResyncChunk(msg: { frame: number; chunkIndex: number; totalChunks: number; data: number[] }): void {
    if (this.config.isHost) {
      return;
    }

    // If a different resync is already in progress, ignore chunks for other frames
    if (this.resyncInProgress && this.resyncFrame !== -1 && this.resyncFrame !== msg.frame) {
      logger.debug(`[GUEST] Ignoring chunk for frame ${msg.frame}, already processing frame ${this.resyncFrame}`);
      return;
    }

    // Initialize for new resync
    if (this.resyncFrame !== msg.frame) {
      this.resyncChunks.clear();
      this.resyncFrame = msg.frame;
      this.resyncTotalChunks = msg.totalChunks;
      this.resyncInProgress = true; // Pause checksum sending and sync loop during resync

      // Pause emulator during resync
      this.getEmulator().pause();

      // Freeze canvas AFTER pausing to capture the last rendered frame
      // This prevents black screen during resync
      this.callbacks.onFreezeCanvas?.();

      logger.info(`[GUEST] Starting to receive resync state for frame ${msg.frame} (${msg.totalChunks} chunks), paused emulator`);
    }

    // Store the chunk
    this.resyncChunks.set(msg.chunkIndex, msg.data);
    logger.debug(`[GUEST] Received chunk ${msg.chunkIndex + 1}/${msg.totalChunks}`);
  }

  /**
   * GUEST: Handle resync complete message from HOST
   */
  private async onResyncComplete(msg: { frame: number; totalSize: number }): Promise<void> {
    if (this.config.isHost) {
      return;
    }

    logger.info(`[GUEST] Received resync_complete for frame ${msg.frame}, assembling ${this.resyncChunks.size} chunks...`);

    // Verify we have all chunks
    if (this.resyncChunks.size !== this.resyncTotalChunks) {
      logger.error(`[GUEST] Missing chunks: have ${this.resyncChunks.size}, expected ${this.resyncTotalChunks}`);
      this.resyncChunks.clear();
      return;
    }

    // Assemble chunks in order
    const stateArray: number[] = [];
    for (let i = 0; i < this.resyncTotalChunks; i++) {
      const chunk = this.resyncChunks.get(i);
      if (!chunk) {
        logger.error(`[GUEST] Missing chunk ${i}`);
        this.resyncChunks.clear();
        return;
      }
      stateArray.push(...chunk);
    }

    // Clear chunks
    this.resyncChunks.clear();
    this.resyncFrame = -1;
    this.resyncTotalChunks = 0;

    // Verify size
    if (stateArray.length !== msg.totalSize) {
      logger.error(`[GUEST] Size mismatch: assembled ${stateArray.length}, expected ${msg.totalSize}`);
      return;
    }

    logger.info(`[GUEST] Assembled resync state (${stateArray.length} bytes), loading...`);

    // Load the state using the same logic as onResyncState
    try {
      const arrayBuffer = new Uint8Array(stateArray).buffer;
      const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });

      // Use seamless swap if available (dual emulator mode), otherwise direct load
      if (this.callbacks.onLoadStateForSwap) {
        logger.info('[GUEST] Using seamless swap for resync');
        await this.callbacks.onLoadStateForSwap(blob);
      } else {
        // Canvas was frozen in onResyncChunk before pausing emulator
        await this.getEmulator().loadState(blob);
      }

      // Unfreeze canvas after state is loaded (frozen in onResyncChunk)
      this.callbacks.onUnfreezeCanvas?.();

      // Update frame counter
      this.currentFrame = msg.frame;
      this.inputFrame = msg.frame;

      // Clear input buffers
      this.localInputs.clear();
      this.remoteInputs.clear();

      // Pre-buffer empty inputs for input delay frames
      const inputDelay = this.config.inputDelayFrames || 3;
      for (let i = 0; i < inputDelay; i++) {
        const frame = this.currentFrame + i;
        this.localInputs.set(frame, createEmptyInput());
        this.remoteInputs.set(frame, createEmptyInput());
      }

      // Increment epoch
      this.resyncEpoch++;

      // Set cooldown - skip periodic syncs for 5 seconds
      this.skipSyncChecksUntilFrame = msg.frame + 300;

      // Update lastResyncFrame
      this.lastResyncFrame = msg.frame;

      // Send a batch of empty inputs for frames that HOST will need soon
      const player = 2; // GUEST is always player 2
      for (let i = 0; i < inputDelay * 3; i++) {
        const frame = this.currentFrame + inputDelay + i;
        const encoded = this.inputManager.encodeInput(createEmptyInput());
        this.callbacks.onSendMessage({
          type: 'input',
          frame: frame,
          player: player as 1 | 2,
          input: Array.from(encoded)
        });
      }

      // Send ACK to HOST - HOST will resume when it receives this
      this.callbacks.onSendMessage({
        type: 'resync_ack',
        frame: msg.frame,
        epoch: this.resyncEpoch
      });

      logger.info(`[GUEST] Resync complete at frame ${this.currentFrame}, epoch ${this.resyncEpoch}, sent ${inputDelay * 3} priming inputs + ACK`);

      // Small delay to let HOST process ACK and start sending inputs
      await new Promise(r => setTimeout(r, 100));

      // Mark resync complete on GUEST side
      this.resyncInProgress = false;

      // Resume emulator
      this.getEmulator().resume();

      // Restart the sync loop
      this.waitingForInput = false;
      this.consecutiveWaits = 0;
      requestAnimationFrame(() => this.runSyncLoop());
    } catch (error) {
      logger.error('[GUEST] Failed to load resync state from chunks:', error);
    }
  }

  /**
   * Handle remote input message
   */
  private onRemoteInput(msg: InputMessage): void {
    const input = this.inputManager.decodeInput(new Uint8Array(msg.input));
    // Store input for the target frame specified in the message
    this.remoteInputs.set(msg.frame, input);

  }

  // ===========================================================================
  // Sync Checking
  // ===========================================================================

  /**
   * Log checksum for debugging (no network exchange)
   * Uses fast memory checksum instead of saveState()
   */
  private logChecksum(frame: number): void {
    try {
      const checksum = this.getEmulator().getMemoryChecksum();
      const role = this.config.isHost ? 'HOST' : 'GUEST';
      logger.debug(`[${role}] Frame ${frame} checksum: ${checksum}`);

      // Report to server for comparison
      if (this.callbacks.onReportChecksum) {
        this.callbacks.onReportChecksum(frame, checksum);
      }
    } catch (error) {
      logger.debug('Failed to compute checksum for logging:', error);
    }
  }

  /**
   * GUEST: Request checksum computation from worker
   */
  private sendChecksumToHost(frame: number): void {
    if (!this.checksumWorker) {
      logger.debug('Checksum worker not available');
      return;
    }

    try {
      // Get memory snapshot from emulator (main thread)
      const memorySnapshot = this.getMemorySnapshot();
      if (!memorySnapshot) {
        logger.debug('Failed to get memory snapshot');
        return;
      }

      // Send to worker for checksum computation
      this.checksumWorker.postMessage({
        type: 'compute_checksum',
        frame,
        memorySnapshot
      }, [memorySnapshot.buffer]); // Transfer buffer for efficiency
    } catch (error) {
      logger.debug('Failed to send to checksum worker:', error);
    }
  }

  /**
   * Get a snapshot of relevant WASM memory for checksum computation
   */
  private getMemorySnapshot(): Uint8Array | null {
    try {
      const emscripten = this.getEmulator().getEmscripten();
      const heap = (emscripten.Module as any).HEAPU8 as Uint8Array | undefined;

      if (!heap) {
        return null;
      }

      // Copy first 2MB of memory (where SNES RAM typically is)
      const len = Math.min(heap.length, 2 * 1024 * 1024);
      const snapshot = new Uint8Array(len);
      snapshot.set(heap.subarray(0, len));
      return snapshot;
    } catch (error) {
      logger.debug('Failed to get memory snapshot:', error);
      return null;
    }
  }

  /**
   * Perform a sync check at the given frame
   */
  private async performSyncCheck(frame: number): Promise<void> {
    try {
      const checksum = await this.computeChecksum();

      this.callbacks.onSendMessage({
        type: 'sync_check',
        frame,
        checksum,
        timestamp: performance.now(),
        epoch: 0
      });

      logger.debug(`Sync check at frame ${frame}: ${checksum}`);
    } catch (error) {
      logger.error('Sync check failed:', error);
    }
  }

  /**
   * Handle sync check from remote (GUEST sends to HOST)
   *
   * IMPORTANT: We store the checksum and compare when HOST reaches that frame,
   * since HOST and GUEST may be at different frames when the message arrives.
   */
  private onSyncCheck(msg: { frame: number; checksum: string; timestamp: number; epoch: number }): void {
    // Only HOST receives sync_check messages from GUEST
    if (!this.config.isHost) {
      return;
    }

    // Skip checksum verification during resync
    if (this.resyncInProgress) {
      logger.debug(`[HOST] Skipping checksum verification at frame ${msg.frame} - resync in progress`);
      return;
    }

    // Ignore sync_checks from different epochs (must match exactly)
    if (msg.epoch !== this.resyncEpoch) {
      logger.debug(`[HOST] Ignoring stale sync_check for frame ${msg.frame} (epoch ${msg.epoch} != current ${this.resyncEpoch})`);
      return;
    }

    // Skip sync checks during cooldown period after resync
    if (msg.frame < this.skipSyncChecksUntilFrame) {
      logger.debug(`[HOST] Skipping sync_check for frame ${msg.frame} (cooldown until ${this.skipSyncChecksUntilFrame})`);
      return;
    }

    // Store the checksum to compare when we reach that frame
    // This is critical because HOST and GUEST may be at different frames
    this.pendingRemoteChecksums.set(msg.frame, msg.checksum);
    logger.debug(`[HOST] Stored sync_check for frame ${msg.frame} (epoch ${msg.epoch}), will compare when reaching that frame`);
  }

  /**
   * HOST: Check if we have a pending checksum to compare
   * Since messages arrive with latency, we compare immediately when
   * HOST is within a reasonable range of the checksum frame.
   */
  private checkPendingChecksums(): void {
    if (!this.config.isHost) {
      return;
    }

    // Skip during resync
    if (this.resyncInProgress) {
      return;
    }

    // Skip during cooldown
    if (this.currentFrame < this.skipSyncChecksUntilFrame) {
      return;
    }

    // Find any pending checksum within a reasonable frame window (±30 frames = 0.5 sec)
    // This accounts for network latency between GUEST sending and HOST receiving
    const FRAME_TOLERANCE = 30;
    let checksumFrame: number | null = null;
    let remoteChecksum: string | null = null;

    for (const [frame, checksum] of this.pendingRemoteChecksums.entries()) {
      if (Math.abs(frame - this.currentFrame) <= FRAME_TOLERANCE) {
        checksumFrame = frame;
        remoteChecksum = checksum;
        break;
      }
    }

    if (checksumFrame === null || remoteChecksum === null) {
      return;
    }

    // Remove from pending
    this.pendingRemoteChecksums.delete(checksumFrame);

    // Compute local checksum and compare directly
    try {
      const localChecksum = this.getEmulator().getMemoryChecksum();
      const localSuffix = localChecksum.slice(-4);
      const remoteSuffix = remoteChecksum; // Already just 4 chars from GUEST

      if (localSuffix === remoteSuffix) {
        logger.debug(`[HOST] Frame ${this.currentFrame} (check for ${checksumFrame}) SYNC OK (suffix: ${localSuffix})`);
        this.consecutiveMismatches = 0;
      } else {
        this.consecutiveMismatches++;
        logger.debug(`[HOST] Frame ${this.currentFrame} (check for ${checksumFrame}) MISMATCH ${this.consecutiveMismatches}/${this.MISMATCH_THRESHOLD}: Local: ...${localSuffix}, Remote: ...${remoteSuffix}`);

        if (this.consecutiveMismatches >= this.MISMATCH_THRESHOLD) {
          logger.info(`[HOST] Frame ${this.currentFrame} DESYNC confirmed after ${this.consecutiveMismatches} consecutive mismatches`);

          this.consecutiveMismatches = 0;
          this.resyncInProgress = true;
          this.getEmulator().pause();
          logger.info(`[HOST] Paused emulator for resync`);

          this.callbacks.onDesync?.(localChecksum, remoteChecksum, this.currentFrame);
          this.sendResyncState(this.currentFrame);
        }
      }
    } catch (error) {
      logger.debug('[HOST] Failed to compute checksum for comparison:', error);
    }
  }

  /**
   * Compute checksum of current emulator state
   */
  private async computeChecksum(): Promise<string> {
    const { state } = await this.getEmulator().saveState();
    const arrayBuffer = await state.arrayBuffer();
    return this.computeChecksumFromBuffer(arrayBuffer);
  }

  /**
   * Compute checksum from array buffer using fast XOR-based hash
   * Much faster than SHA-256, good enough for desync detection
   */
  private computeChecksumFromBuffer(buffer: ArrayBuffer): string {
    const data = new Uint8Array(buffer);
    const len = data.length;

    // Simple but fast: XOR all bytes in chunks of 8, with position mixing
    let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
    let h5 = 0, h6 = 0, h7 = 0, h8 = 0;

    for (let i = 0; i < len; i += 8) {
      h1 ^= (data[i] || 0) ^ (i & 0xFF);
      h2 ^= (data[i + 1] || 0) ^ ((i >> 8) & 0xFF);
      h3 ^= (data[i + 2] || 0) ^ ((i >> 16) & 0xFF);
      h4 ^= (data[i + 3] || 0) ^ (i & 0xFF);
      h5 ^= (data[i + 4] || 0) ^ ((i >> 8) & 0xFF);
      h6 ^= (data[i + 5] || 0) ^ ((i >> 16) & 0xFF);
      h7 ^= (data[i + 6] || 0) ^ (i & 0xFF);
      h8 ^= (data[i + 7] || 0) ^ ((i >> 8) & 0xFF);
    }

    return [h7, h8]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ===========================================================================
  // Stats & Debug
  // ===========================================================================

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  getStats() {
    return {
      currentFrame: this.currentFrame,
      inputFrame: this.inputFrame,
      isRunning: this.isRunning,
      localInputsBuffered: this.localInputs.size,
      remoteInputsBuffered: this.remoteInputs.size,
      waitingForInput: this.waitingForInput,
      inputDelay: this.config.inputDelayFrames,
      isHost: this.config.isHost
    };
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  destroy(): void {
    this.stop();
    this.localInputs.clear();
    this.remoteInputs.clear();
    this.pendingRemoteChecksums.clear();

    // Terminate checksum worker
    if (this.checksumWorker) {
      this.checksumWorker.terminate();
      this.checksumWorker = null;
    }

    logger.info('SimpleSyncManager destroyed');
  }
}
