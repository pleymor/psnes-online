/**
 * Rollback Manager - Core rollback netcode logic
 *
 * Implements GGPO-style rollback netcode for deterministic multiplayer.
 * Manages state saving, input prediction, and rollback/replay when
 * predictions are wrong.
 */

import type { WasmEmulator } from '$lib/emulator';
import type { InputState } from '$lib/types';
import { StateBuffer } from './state-buffer';
import { InputBuffer } from './input-buffer';
import { getFrameController } from './frame-controller';
import type { FrameController } from './frame-controller';
import type {
  NetplayConfig,
  NetplayStats,
  RollbackCallbacks,
  InputMessage,
  NetplayMessage,
  SyncCheckMessage,
  PeriodicSyncMessage
} from './types';
import { DEFAULT_NETPLAY_CONFIG, createEmptyStats, createEmptyInput } from './types';
import { InputManager } from '$lib/emulator/input-manager';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('RollbackManager');

export class RollbackManager {
  private emulator: WasmEmulator;
  private config: NetplayConfig;
  private callbacks: RollbackCallbacks;

  // Buffers
  private stateBuffer: StateBuffer;
  private inputBuffer: InputBuffer;
  private inputManager: InputManager;

  // Frame tracking
  private currentFrame: number = 0;
  private lastSyncCheckFrame: number = 0;
  private lastSaveStateFrame: number = -1;
  private saveStateInterval: number = 600; // Save state every 10 seconds (rollback buffer) - reduced frequency to minimize errors
  private isSavingState: boolean = false; // Prevent concurrent saveState calls
  private syncCheckEnabled: boolean = false; // Disable sync checks by default (too expensive)

  // Stats
  private stats: NetplayStats = createEmptyStats();
  private rollbackFrameHistory: number[] = [];

  // State
  private isRunning: boolean = false;
  private isRollingBack: boolean = false;
  private initialStateSent: boolean = false;
  private initialStateReceived: boolean = false;

  // Frame stepping mode (deterministic)
  // NOTE: Frame stepping is DISABLED because FRAMEADVANCE command doesn't work when emulator is paused
  // RetroArch only processes stdin commands when the main loop is running
  // Instead, we let the emulator run freely and sync inputs at each frame
  private useFrameStepping: boolean = false;

  // Lockstep mode - both players must have inputs before frame advances
  // Uses FrameController to control RAF execution
  private useLockstep: boolean = true; // Default enabled for true sync
  private frameController: FrameController | null = null;
  private lockstepLoopRunning: boolean = false;
  private lockstepInputReady: boolean = false;

  // Periodic state sync (host sends state to guest every N frames to prevent drift)
  // DISABLED: WebRTC data channel can't handle large state transfers (~80KB)
  // The initial state sync works because it happens before heavy traffic
  // For now, we rely on initial sync only
  private periodicSyncEnabled: boolean = false;
  private periodicSyncInterval: number = 600; // Every 10 seconds at 60fps
  private lastPeriodicSyncFrame: number = 0;

  constructor(
    emulator: WasmEmulator,
    callbacks: RollbackCallbacks,
    config: Partial<NetplayConfig> = {}
  ) {
    this.emulator = emulator;
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_NETPLAY_CONFIG, ...config };

    this.stateBuffer = new StateBuffer(this.config.maxRollbackFrames + 2);
    this.inputBuffer = new InputBuffer();
    this.inputManager = new InputManager();

    // Get frame controller for lockstep mode
    if (this.useLockstep) {
      this.frameController = getFrameController();
    }

    logger.info('RollbackManager created', {
      isHost: this.config.isHost,
      maxRollbackFrames: this.config.maxRollbackFrames,
      inputDelayFrames: this.config.inputDelayFrames,
      useLockstep: this.useLockstep
    });
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Create and send initial state (HOST only)
   * Must be called after emulator is running
   */
  async createAndSendInitialState(): Promise<void> {
    if (!this.config.isHost) {
      logger.warn('createAndSendInitialState called on non-host');
      return;
    }

    logger.info('🎮 HOST: Creating initial state...');

    try {
      // Give emulator a moment to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Save current state
      logger.info('🎮 HOST: Calling emulator.saveState...');
      const { state } = await this.emulator.saveState();
      const arrayBuffer = await state.arrayBuffer();
      logger.info('🎮 HOST: saveState completed', { size: arrayBuffer.byteLength });

      // Compute checksum of the state we're about to send
      const stateHashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const stateChecksum = Array.from(new Uint8Array(stateHashBuffer.slice(0, 8)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      logger.info(`🎮 HOST: State to send checksum: ${stateChecksum}`);

      // Store it locally
      this.stateBuffer.saveStateFromBlob(0, state);

      // Verify the host's current state matches what we just saved
      const hostVerifyChecksum = await this.computeChecksum();
      logger.info(`🎮 HOST: Current state checksum (should match sent): ${hostVerifyChecksum}`);

      // Send to guest
      this.callbacks.onSendMessage({
        type: 'initial_state',
        state: Array.from(new Uint8Array(arrayBuffer)),
        frame: 0
      });

      this.initialStateSent = true;
      this.currentFrame = 0;
      this.lastSaveStateFrame = 0;

      logger.info('Initial state sent', { size: arrayBuffer.byteLength, checksum: stateChecksum });
    } catch (error) {
      logger.error('Failed to create initial state:', error);
      throw error;
    }
  }

  /**
   * Load initial state received from host (GUEST only)
   */
  async loadInitialState(stateData: number[]): Promise<void> {
    if (this.config.isHost) {
      logger.warn('loadInitialState called on host');
      return;
    }

    logger.info('🎮 GUEST: Loading initial state...', { size: stateData.length });

    try {
      // Convert array back to Blob
      const arrayBuffer = new Uint8Array(stateData).buffer;
      const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });

      // Compute checksum of RECEIVED state (before loading)
      const receivedHashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const receivedChecksum = Array.from(new Uint8Array(receivedHashBuffer.slice(0, 8)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      logger.info(`🎮 GUEST: Received state checksum: ${receivedChecksum}`);

      logger.info('🎮 GUEST: Calling emulator.loadState...');

      // Verify the blob size matches
      const blobSize = blob.size;
      logger.info(`🎮 GUEST: Blob to load: ${blobSize} bytes`);

      // Resume emulator - RetroArch needs to be running to process LOAD_STATE command
      this.emulator.resume();

      // Small delay to ensure emulator is running
      await new Promise(resolve => setTimeout(resolve, 50));

      // Send load state command
      await this.emulator.loadState(blob);
      logger.info(`🎮 GUEST: loadState() returned`);

      // IMPORTANT: Run a few frames to let RetroArch process the LOAD_STATE command
      // The _cmd_load_state function sets a flag that's processed in the main loop
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }

      // Wait a bit more
      await new Promise(resolve => setTimeout(resolve, 200));

      // Now pause
      this.emulator.pause();

      logger.info('🎮 GUEST: loadState completed');

      // Verify the state was loaded by computing checksum immediately
      const verifyChecksum = await this.computeChecksum();
      logger.info(`🎮 GUEST: Verify checksum after load: ${verifyChecksum}`);

      // Store in our buffer
      this.stateBuffer.saveStateFromBlob(0, blob);

      // Verify we're in sync by computing checksum of current emulator state
      const checksum = await this.computeChecksum();
      logger.info(`🎮 GUEST: Current emulator state checksum: ${checksum}`);

      this.initialStateReceived = true;
      this.currentFrame = 0;
      this.lastSaveStateFrame = 0;

      // Send ACK
      this.callbacks.onSendMessage({ type: 'initial_state_ack' });

      logger.info('Initial state loaded and ACK sent', { checksum });
    } catch (error) {
      logger.error('Failed to load initial state:', error);
      throw error;
    }
  }

  /**
   * Mark initial state as received (GUEST only)
   * Called when using initialState prop on emulator creation
   */
  markInitialStateReceived(): void {
    if (this.config.isHost) {
      logger.warn('markInitialStateReceived called on host');
      return;
    }

    logger.info('🎮 GUEST: Initial state marked as received');
    this.initialStateReceived = true;
    this.currentFrame = 0;
    this.lastSaveStateFrame = 0;

    // Send ACK
    this.callbacks.onSendMessage({ type: 'initial_state_ack' });
  }

  /**
   * Check if ready to start (both sides synchronized)
   */
  isReady(): boolean {
    if (this.config.isHost) {
      return this.initialStateSent;
    }
    return this.initialStateReceived;
  }

  /**
   * Start the rollback loop
   */
  start(): void {
    this.isRunning = true;
    logger.info('Rollback manager started at frame', this.currentFrame);

    // Start lockstep loop if enabled
    if (this.useLockstep && this.frameController) {
      this.startLockstepLoop();
    }
  }

  /**
   * Stop the rollback loop
   */
  stop(): void {
    this.isRunning = false;
    this.lockstepLoopRunning = false;
    logger.info('Rollback manager stopped at frame', this.currentFrame);
  }

  /**
   * Check if lockstep mode is enabled
   */
  isLockstepEnabled(): boolean {
    return this.useLockstep && this.frameController !== null;
  }

  // ===========================================================================
  // Main Loop Integration
  // ===========================================================================

  /**
   * Execute exactly one frame with the given inputs.
   * This is the core of deterministic netplay - we control exactly when each frame runs.
   *
   * @param localInput - The local player's input for this frame
   * @returns Promise that resolves when the frame has been executed
   */
  async executeFrame(localInput: InputState): Promise<void> {
    if (!this.isRunning) return;

    const frameNum = this.currentFrame;

    // Store local input
    this.inputBuffer.setLocalInput(frameNum, localInput);

    // Send input to remote
    const player = this.config.isHost ? 1 : 2;
    const encoded = this.inputManager.encodeInput(localInput);
    this.callbacks.onSendMessage({
      type: 'input',
      frame: frameNum,
      player: player as 1 | 2,
      input: Array.from(encoded)
    });

    // Log every 60 frames for debugging
    if (frameNum % 60 === 0) {
      const lastConfirmed = this.inputBuffer.getLastConfirmedRemoteFrame();
      logger.debug(`Frame ${frameNum} | Remote confirmed: ${lastConfirmed} | Ahead by: ${frameNum - lastConfirmed}`);
    }

    // Check if we need to rollback due to misprediction
    if (!this.isRollingBack) {
      const rollbackInfo = this.inputBuffer.checkRollback(frameNum);
      if (rollbackInfo.needed) {
        logger.info(`Rollback needed at frame ${frameNum} -> ${rollbackInfo.rollbackToFrame}`);
        await this.performRollback(rollbackInfo.rollbackToFrame);
      }
    }

    // Save state periodically (not every frame - too expensive!)
    const shouldSaveState =
      !this.isSavingState &&
      (frameNum - this.lastSaveStateFrame >= this.saveStateInterval);

    if (shouldSaveState) {
      // Fire and forget
      this.saveCurrentStateAsync();
    }

    // Execute the frame using FRAMEADVANCE
    if (this.useFrameStepping) {
      this.emulator.frameAdvance();
    }

    // Periodic sync check (disabled by default)
    if (this.shouldPerformSyncCheck()) {
      // Don't await - fire and forget
      this.performSyncCheck();
    }

    // Update stats
    this.stats.currentFrame = frameNum;
    this.stats.lastConfirmedRemoteFrame = this.inputBuffer.getLastConfirmedRemoteFrame();
    this.stats.frameAdvantage = frameNum - this.stats.lastConfirmedRemoteFrame;

    // Advance frame counter
    this.currentFrame++;
  }

  /**
   * Called BEFORE each frame execution (legacy mode - when not using frame stepping)
   * Saves state periodically and checks for needed rollbacks
   */
  async preFrame(): Promise<void> {
    if (!this.isRunning || this.isRollingBack) return;

    // Save state periodically (not every frame - too expensive!)
    // Only save if we're not already saving and enough frames have passed
    const shouldSaveState =
      !this.isSavingState &&
      (this.currentFrame - this.lastSaveStateFrame >= this.saveStateInterval);

    if (shouldSaveState) {
      // Fire and forget - don't await to avoid blocking the game loop
      this.saveCurrentStateAsync();
    }

    // Check if we need to rollback due to misprediction
    const rollbackInfo = this.inputBuffer.checkRollback(this.currentFrame);
    if (rollbackInfo.needed) {
      // Wait for any pending save to complete before rollback
      if (this.isSavingState) {
        logger.debug('Waiting for pending saveState before rollback...');
        await this.waitForSaveComplete();
      }
      await this.performRollback(rollbackInfo.rollbackToFrame);
    }
  }

  /**
   * Wait for any pending save operation to complete
   */
  private async waitForSaveComplete(): Promise<void> {
    const maxWait = 500; // 500ms max
    const startTime = Date.now();
    while (this.isSavingState && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /**
   * Check if using frame stepping mode
   */
  isFrameSteppingEnabled(): boolean {
    return this.useFrameStepping;
  }

  /**
   * Get inputs for the current frame
   * Returns both P1 and P2 inputs (local or predicted remote)
   */
  getInputsForFrame(): { p1: InputState; p2: InputState } {
    return this.inputBuffer.getInputsForFrame(this.currentFrame, this.config.isHost);
  }

  /**
   * Store local input for the current frame (call BEFORE getInputsForFrame)
   */
  setLocalInput(localInput: InputState): void {
    if (!this.isRunning) return;
    this.inputBuffer.setLocalInput(this.currentFrame, localInput);
  }

  /**
   * Called AFTER each frame execution with the local input that was used
   * Sends input to remote and advances frame counter
   */
  postFrame(localInput: InputState): void {
    if (!this.isRunning) return;

    // Ensure local input is stored (may already be stored via setLocalInput)
    this.inputBuffer.setLocalInput(this.currentFrame, localInput);

    // Send input to remote
    const player = this.config.isHost ? 1 : 2;
    const encoded = this.inputManager.encodeInput(localInput);

    this.callbacks.onSendMessage({
      type: 'input',
      frame: this.currentFrame,
      player: player as 1 | 2,
      input: Array.from(encoded)
    });

    // Periodic sync check (checksum comparison)
    if (this.shouldPerformSyncCheck()) {
      this.performSyncCheck();
    }

    // Periodic state sync (host sends full state to guest)
    if (this.shouldPerformPeriodicSync()) {
      this.performPeriodicSync();
    }

    // Update stats
    this.stats.currentFrame = this.currentFrame;
    this.stats.lastConfirmedRemoteFrame = this.inputBuffer.getLastConfirmedRemoteFrame();
    this.stats.frameAdvantage = this.currentFrame - this.stats.lastConfirmedRemoteFrame;

    // Advance frame
    this.currentFrame++;
  }

  /**
   * Get current frame number
   */
  getCurrentFrame(): number {
    return this.currentFrame;
  }

  // ===========================================================================
  // Lockstep Mode
  // ===========================================================================

  /**
   * Start the lockstep game loop
   * This runs independently and controls frame execution
   */
  private startLockstepLoop(): void {
    if (this.lockstepLoopRunning) {
      logger.warn('Lockstep loop already running');
      return;
    }

    this.lockstepLoopRunning = true;
    logger.info('🚀 Starting lockstep loop');
    logger.info('FrameController ready:', this.frameController?.isInstalled());

    const runLoop = async () => {
      logger.info('Lockstep loop running...');
      while (this.lockstepLoopRunning && this.isRunning) {
        try {
          await this.executeLockstepFrame();
        } catch (error) {
          logger.error('Lockstep frame error:', error);
          // Continue despite errors
        }
      }
      logger.info('Lockstep loop stopped');
    };

    // Start the loop
    runLoop();
  }

  /**
   * Execute one frame in lockstep mode
   * Waits for both inputs before advancing
   */
  private async executeLockstepFrame(): Promise<void> {
    if (!this.frameController) {
      logger.error('No frame controller in lockstep mode');
      return;
    }

    const frameNum = this.currentFrame;

    // Wait for remote input for this frame (with timeout)
    // We allow a small amount of frame advantage to reduce latency
    const maxFrameAdvantage = 2; // Allow up to 2 frames ahead
    const waitStart = performance.now();
    const maxWait = 100; // 100ms max wait (about 6 frames)

    while (
      this.isRunning &&
      this.lockstepLoopRunning &&
      !this.inputBuffer.hasRemoteInput(frameNum) &&
      (frameNum - this.inputBuffer.getLastConfirmedRemoteFrame()) > maxFrameAdvantage
    ) {
      // Check for timeout
      if (performance.now() - waitStart > maxWait) {
        logger.warn(`Frame ${frameNum}: Timeout waiting for remote input, proceeding with prediction`);
        break;
      }
      // Small yield to allow message processing
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    // Get local input via callback
    if (!this.callbacks.onGetLocalInput) {
      if (frameNum % 300 === 0) {
        logger.warn('onGetLocalInput callback not set!');
      }
    }
    const localInput = this.callbacks.onGetLocalInput?.() || createEmptyInput();

    // Store local input
    this.inputBuffer.setLocalInput(frameNum, localInput);

    // Send local input to remote
    const player = this.config.isHost ? 1 : 2;
    const encoded = this.inputManager.encodeInput(localInput);

    this.callbacks.onSendMessage({
      type: 'input',
      frame: frameNum,
      player: player as 1 | 2,
      input: Array.from(encoded)
    });

    // Get both inputs (local is stored, remote may be predicted)
    const inputs = this.inputBuffer.getInputsForFrame(frameNum, this.config.isHost);

    // Apply inputs to emulator RIGHT BEFORE advancing frame
    if (this.callbacks.onApplyInputs) {
      this.callbacks.onApplyInputs(inputs.p1, inputs.p2);
    }

    // Advance exactly one frame using the frame controller
    await this.frameController.advanceFrame();

    // Check for misprediction and potential rollback
    if (!this.isRollingBack) {
      const rollbackInfo = this.inputBuffer.checkRollback(frameNum);
      if (rollbackInfo.needed) {
        logger.info(`Frame ${frameNum}: Rollback needed -> ${rollbackInfo.rollbackToFrame}`);
        // For now, just log - full rollback implementation is complex
        // and may cause issues with RAF interception
        this.stats.rollbackCount++;
      }
    }

    // Save state periodically (disabled for now - causes ErrnoError spam)
    // if (!this.isSavingState && (frameNum - this.lastSaveStateFrame >= this.saveStateInterval)) {
    //   this.saveCurrentStateAsync();
    // }

    // Update stats
    this.stats.currentFrame = frameNum;
    this.stats.lastConfirmedRemoteFrame = this.inputBuffer.getLastConfirmedRemoteFrame();
    this.stats.frameAdvantage = frameNum - this.stats.lastConfirmedRemoteFrame;

    // Log periodically (every 5 seconds at 60fps = 300 frames)
    if (frameNum % 300 === 0) {
      logger.debug(`Lockstep frame ${frameNum} | Remote: ${this.stats.lastConfirmedRemoteFrame} | Ahead: ${this.stats.frameAdvantage}`);

      // Compute and log checksum for sync verification
      this.computeChecksum().then(checksum => {
        logger.info(`Frame ${frameNum} checksum: ${checksum}`);
      }).catch(() => {});
    }

    // Advance frame counter
    this.currentFrame++;
  }

  /**
   * Get the inputs for the current frame (called by P2PRoom to apply to virtual gamepads)
   * This is the interface for lockstep mode
   */
  getLockstepInputs(): { p1: InputState; p2: InputState } | null {
    if (!this.isRunning) return null;
    return this.inputBuffer.getInputsForFrame(this.currentFrame, this.config.isHost);
  }

  // ===========================================================================
  // Network Message Handling
  // ===========================================================================

  /**
   * Handle incoming network message
   */
  onMessage(msg: NetplayMessage): void {
    switch (msg.type) {
      case 'input':
        this.onRemoteInput(msg);
        break;
      case 'initial_state':
        // Handled externally via loadInitialState
        break;
      case 'initial_state_ack':
        logger.info('Received initial state ACK');
        break;
      case 'sync_check':
        this.onSyncCheck(msg);
        break;
      case 'sync_result':
        if (!msg.match) {
          logger.error('Sync mismatch detected!', msg);
          this.stats.syncMismatches++;
          this.callbacks.onDesync(
            msg.localChecksum || '',
            msg.remoteChecksum || '',
            msg.frame
          );
        }
        break;
      case 'periodic_sync':
        this.onPeriodicSync(msg);
        break;
    }
  }

  /**
   * Handle remote input message
   */
  private onRemoteInput(msg: InputMessage): void {
    const input = this.inputManager.decodeInput(new Uint8Array(msg.input));
    this.inputBuffer.setRemoteInput(msg.frame, input);
  }

  // ===========================================================================
  // Rollback Logic
  // ===========================================================================

  /**
   * Save current emulator state (async, non-blocking)
   */
  private async saveCurrentStateAsync(): Promise<void> {
    if (this.isSavingState) return; // Already saving

    this.isSavingState = true;
    const frameToSave = this.currentFrame;

    try {
      const { state } = await this.emulator.saveState();
      this.stateBuffer.saveStateFromBlob(frameToSave, state);
      this.lastSaveStateFrame = frameToSave;
      logger.debug(`Saved state for frame ${frameToSave}`);
    } catch (error) {
      logger.warn(`Failed to save state for frame ${frameToSave}:`, error);
      // Don't throw - just skip this save
    } finally {
      this.isSavingState = false;
    }
  }

  /**
   * Perform rollback to a specific frame and replay
   */
  private async performRollback(toFrame: number): Promise<void> {
    if (toFrame >= this.currentFrame) {
      logger.warn('Invalid rollback: target frame >= current frame');
      return;
    }

    const framesToReplay = this.currentFrame - toFrame;
    if (framesToReplay > this.config.maxRollbackFrames) {
      logger.error(`Rollback too far: ${framesToReplay} frames (max: ${this.config.maxRollbackFrames})`);
      return;
    }

    this.isRollingBack = true;
    logger.debug(`Rolling back ${framesToReplay} frames (${this.currentFrame} → ${toFrame})`);

    // Update stats
    this.stats.rollbackCount++;
    this.rollbackFrameHistory.push(framesToReplay);
    if (this.rollbackFrameHistory.length > 100) {
      this.rollbackFrameHistory.shift();
    }
    this.stats.avgRollbackFrames =
      this.rollbackFrameHistory.reduce((a, b) => a + b, 0) / this.rollbackFrameHistory.length;

    try {
      // Find closest available state
      const closestFrame = this.stateBuffer.findClosestFrame(toFrame);
      if (closestFrame < 0) {
        logger.error('No state available for rollback');
        this.isRollingBack = false;
        return;
      }

      // Load the state
      const state = this.stateBuffer.getState(closestFrame);
      if (!state) {
        logger.error(`State for frame ${closestFrame} not found`);
        this.isRollingBack = false;
        return;
      }

      await this.emulator.loadState(state);
      logger.debug(`Loaded state from frame ${closestFrame}`);

      // Replay frames from closestFrame to currentFrame
      const targetFrame = this.currentFrame;
      this.currentFrame = closestFrame;

      while (this.currentFrame < targetFrame) {
        const inputs = this.getInputsForFrame();

        // Apply inputs and advance one frame
        // Note: The actual frame execution happens in the emulator's main loop
        // We just need to ensure inputs are correct for each frame
        this.applyInputsToEmulator(inputs);

        // Emulator runs one frame (this happens via RetroArch's main loop)
        // For now, we assume the frame has executed
        // TODO: May need to call a specific frame-advance function

        this.currentFrame++;
      }

      logger.debug(`Replay complete, now at frame ${this.currentFrame}`);
    } catch (error) {
      logger.error('Rollback failed:', error);
    }

    this.isRollingBack = false;
    this.inputBuffer.clearMispredictions();
  }

  /**
   * Apply inputs to the emulator for the current frame
   */
  private applyInputsToEmulator(inputs: { p1: InputState; p2: InputState }): void {
    // This is called during rollback replay
    // The actual input application happens via virtual gamepads in ClientEmulator
    // During normal operation, inputs are applied each frame by the main loop

    // For rollback, we need to temporarily store these inputs so the next
    // frame execution uses them. This is handled by the InputBuffer.
    logger.debug(`Applying inputs for frame ${this.currentFrame}:`, inputs);
  }

  // ===========================================================================
  // Sync Checking
  // ===========================================================================

  private shouldPerformSyncCheck(): boolean {
    // Sync checks are expensive (require saveState) - only do if enabled
    if (!this.syncCheckEnabled) return false;

    return (
      this.currentFrame > 0 &&
      this.currentFrame - this.lastSyncCheckFrame >= this.config.syncCheckInterval
    );
  }

  /**
   * Enable or disable sync checks (disabled by default due to performance)
   */
  setSyncCheckEnabled(enabled: boolean): void {
    this.syncCheckEnabled = enabled;
    logger.info(`Sync checks ${enabled ? 'enabled' : 'disabled'}`);
  }

  private async performSyncCheck(): Promise<void> {
    this.lastSyncCheckFrame = this.currentFrame;

    try {
      const checksum = await this.computeChecksum();

      this.callbacks.onSendMessage({
        type: 'sync_check',
        frame: this.currentFrame,
        checksum,
        timestamp: performance.now(),
        epoch: 0
      });

      logger.debug(`Sync check at frame ${this.currentFrame}: ${checksum}`);
    } catch (error) {
      logger.error('Sync check failed:', error);
    }
  }

  private async onSyncCheck(msg: SyncCheckMessage): Promise<void> {
    try {
      const localChecksum = await this.computeChecksum();
      const match = localChecksum === msg.checksum;

      this.callbacks.onSendMessage({
        type: 'sync_result',
        frame: msg.frame,
        match,
        localChecksum,
        remoteChecksum: msg.checksum
      });

      if (!match) {
        logger.error(`Desync at frame ${msg.frame}!`);
        logger.error(`  Local:  ${localChecksum}`);
        logger.error(`  Remote: ${msg.checksum}`);
        this.stats.syncMismatches++;
        this.callbacks.onDesync(localChecksum, msg.checksum, msg.frame);
      } else {
        logger.debug(`Sync OK at frame ${msg.frame}`);
      }
    } catch (error) {
      logger.error('Sync check response failed:', error);
    }
  }

  private async computeChecksum(): Promise<string> {
    try {
      const { state } = await this.emulator.saveState();
      const arrayBuffer = await state.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);

      // Truncate to 2 bytes for shorter display
      return Array.from(new Uint8Array(hashBuffer.slice(0, 2)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (error) {
      logger.error('Checksum computation failed:', error);
      return '';
    }
  }

  /**
   * Public method to compute sync checksum (for debugging)
   */
  async computeSyncChecksum(): Promise<string> {
    return this.computeChecksum();
  }

  // ===========================================================================
  // Periodic State Sync (Host sends full state to guest to prevent drift)
  // ===========================================================================

  private shouldPerformPeriodicSync(): boolean {
    // Only host sends periodic sync
    if (!this.config.isHost) return false;
    if (!this.periodicSyncEnabled) return false;
    if (this.isSavingState) return false; // Don't overlap with saveState

    return (
      this.currentFrame > 0 &&
      this.currentFrame - this.lastPeriodicSyncFrame >= this.periodicSyncInterval
    );
  }

  private async performPeriodicSync(): Promise<void> {
    this.lastPeriodicSyncFrame = this.currentFrame;

    try {
      logger.info(`Sending periodic sync at frame ${this.currentFrame}`);
      const { state } = await this.emulator.saveState();
      const arrayBuffer = await state.arrayBuffer();

      this.callbacks.onSendMessage({
        type: 'periodic_sync',
        frame: this.currentFrame,
        state: Array.from(new Uint8Array(arrayBuffer))
      });

      logger.info(`Periodic sync sent (${arrayBuffer.byteLength} bytes)`);
    } catch (error) {
      logger.error('Periodic sync failed:', error);
    }
  }

  private async onPeriodicSync(msg: PeriodicSyncMessage): Promise<void> {
    // Only guest processes periodic sync
    if (this.config.isHost) {
      logger.warn('Host received periodic_sync, ignoring');
      return;
    }

    logger.info(`Received periodic sync for frame ${msg.frame}, loading...`);

    try {
      // Convert array back to Blob
      const arrayBuffer = new Uint8Array(msg.state).buffer;
      const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });

      // Load into emulator
      await this.emulator.loadState(blob);

      // Sync our frame counter with host
      this.currentFrame = msg.frame;

      logger.info(`Periodic sync loaded, now at frame ${this.currentFrame}`);
    } catch (error) {
      logger.error('Failed to load periodic sync:', error);
    }
  }

  /**
   * Enable or disable periodic state sync
   */
  setPeriodicSyncEnabled(enabled: boolean): void {
    this.periodicSyncEnabled = enabled;
    logger.info(`Periodic sync ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set periodic sync interval (in frames)
   */
  setPeriodicSyncInterval(frames: number): void {
    this.periodicSyncInterval = frames;
    logger.info(`Periodic sync interval set to ${frames} frames`);
  }

  // ===========================================================================
  // Stats & Debug
  // ===========================================================================

  getStats(): NetplayStats {
    return { ...this.stats };
  }

  debugPrint(): void {
    logger.info('=== RollbackManager Debug ===');
    logger.info(`Frame: ${this.currentFrame}`);
    logger.info(`Running: ${this.isRunning}`);
    logger.info(`Rolling back: ${this.isRollingBack}`);
    logger.info('Stats:', this.stats);
    this.stateBuffer.debugPrint();
    this.inputBuffer.debugPrint();
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  reset(): void {
    this.currentFrame = 0;
    this.lastSyncCheckFrame = 0;
    this.isRunning = false;
    this.isRollingBack = false;
    this.initialStateSent = false;
    this.initialStateReceived = false;
    this.stats = createEmptyStats();
    this.rollbackFrameHistory = [];
    this.stateBuffer.clear();
    this.inputBuffer.reset();
    logger.info('RollbackManager reset');
  }

  destroy(): void {
    this.stop();
    this.reset();
    logger.info('RollbackManager destroyed');
  }
}
