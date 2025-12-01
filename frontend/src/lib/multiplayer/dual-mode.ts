/**
 * Dual Emulation Mode Handler
 *
 * In dual mode:
 * - HOST: Runs emulator locally, exchanges inputs via P2P
 * - GUEST: Downloads ROM from server, runs emulator locally, exchanges inputs via P2P
 *
 * Both players run the emulator independently with synchronized inputs.
 * ROM is downloaded directly from server (faster than P2P transfer).
 *
 * With rollback netcode:
 * - Initial state is synchronized from HOST to GUEST
 * - Inputs are predicted locally and corrected via rollback when wrong
 * - Periodic sync checks detect desyncs
 */

import { P2PManager } from '$lib/webrtc/p2p-manager';
import { InputManager } from '$lib/emulator/input-manager';
import type { KeyConfig, InputState } from '$lib/types';
import type { NetplayMessage, InitialStateMessage } from '$lib/netplay/types';
import { createLogger } from '$lib/utils/logger';
import type { Socket } from 'socket.io-client';

const logger = createLogger('DualMode');

export interface DualModeCallbacks {
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: string) => void;
  /** Legacy callback for direct input application (deprecated with rollback) */
  onRemoteInput: (player: 1 | 2, inputState: InputState) => void;
  /** New callback for rollback netcode messages */
  onNetplayMessage?: (msg: NetplayMessage) => void;
  /** Called when initial state is received (GUEST only) */
  onInitialState?: (stateData: number[]) => void;
  /** Called when initial state ACK is received (HOST only) */
  onInitialStateAck?: () => void;
}

export class DualModeHandler {
  private p2pManager: P2PManager | null = null;
  private inputManager = new InputManager();
  private currentFrame = 0;
  private inputInterval: ReturnType<typeof setInterval> | null = null;

  // Rollback mode flag
  private useRollback: boolean = false;

  constructor(
    private socket: Socket,
    private roomId: string,
    private isHost: boolean,
    private keyConfig: KeyConfig,
    private callbacks: DualModeCallbacks
  ) {}

  /**
   * Enable rollback netcode mode
   */
  enableRollback(): void {
    this.useRollback = true;
    logger.info('Rollback netcode enabled');
  }

  /**
   * Check if rollback mode is enabled
   */
  isRollbackEnabled(): boolean {
    return this.useRollback;
  }

  /**
   * Initialize dual mode for HOST
   */
  async initAsHost(): Promise<void> {
    logger.info('⚡ Initializing DUAL mode as HOST');

    // Join Socket.IO room
    await this.joinSocketRoom();

    // Signal host is ready
    this.socket.emit('p2p:host_ready', { roomId: this.roomId });
    logger.info('📡 Signaled host_ready');

    // Wait for guest to join
    await this.waitForGuest();

    // Give guest time to setup P2P manager
    await this.delay(1000);

    // Setup P2P (data channel only, no video stream)
    this.p2pManager = this.createP2PManager();
    await this.p2pManager.initConnection();

    logger.info('✅ HOST dual mode initialized');
  }

  /**
   * Initialize dual mode for GUEST
   */
  async initAsGuest(): Promise<void> {
    logger.info('⚡ Initializing DUAL mode as GUEST');

    // Wait for host to be ready
    await this.waitForHost();

    // Join Socket.IO room and setup P2P
    await this.joinSocketRoom();

    this.p2pManager = this.createP2PManager();
    await this.p2pManager.initConnection();

    logger.info('✅ GUEST dual mode initialized');
  }

  /**
   * Send a netplay message to the remote peer
   */
  sendMessage(msg: NetplayMessage): void {
    if (!this.p2pManager) {
      logger.warn('Cannot send message: P2P not ready');
      return;
    }
    this.p2pManager.sendData(msg);
  }

  /**
   * Send initial state to guest (HOST only, rollback mode)
   */
  sendInitialState(stateData: ArrayBuffer): void {
    if (!this.isHost) {
      logger.warn('sendInitialState called on non-host');
      return;
    }

    const msg: InitialStateMessage = {
      type: 'initial_state',
      state: Array.from(new Uint8Array(stateData)),
      frame: 0
    };

    this.sendMessage(msg);
    logger.info('Initial state sent', { size: stateData.byteLength });
  }

  /**
   * Wait for initial state from host (GUEST only, rollback mode)
   */
  async waitForInitialState(): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for initial state'));
      }, 30000);

      // The initial state will come through onNetplayMessage -> onInitialState
      // We need to set up a one-time handler
      const originalCallback = this.callbacks.onInitialState;
      this.callbacks.onInitialState = (stateData: number[]) => {
        clearTimeout(timeout);
        this.callbacks.onInitialState = originalCallback;
        resolve(stateData);
      };
    });
  }

  /**
   * Start sending inputs at 60 FPS (legacy mode, non-rollback)
   * @deprecated Use RollbackManager.postFrame instead when rollback is enabled
   */
  startInputSync(getInputState: () => InputState | null): void {
    if (this.useRollback) {
      logger.warn('startInputSync called but rollback mode is enabled - use RollbackManager instead');
      return;
    }

    if (!this.p2pManager) {
      logger.warn('Cannot start input sync: P2P not ready');
      return;
    }

    const player = this.isHost ? 1 : 2;
    logger.info(`✅ Started input sync as Player ${player}`);

    let lastHasInput = false;

    this.inputInterval = setInterval(() => {
      if (!this.p2pManager) {
        this.stopInputSync();
        return;
      }

      const inputState = getInputState();
      if (!inputState) {
        this.currentFrame++;
        return;
      }

      const hasInput = Object.values(inputState).some(v => v === true);
      if (hasInput !== lastHasInput) {
        logger.debug(`📤 P${player} input:`, inputState);
        lastHasInput = hasInput;
      }

      const encoded = this.inputManager.encodeInput(inputState);

      this.p2pManager.sendData({
        type: 'dual_input',
        frame: this.currentFrame,
        player,
        data: Array.from(encoded)
      });

      this.currentFrame++;
    }, 16); // ~60 FPS
  }

  stopInputSync(): void {
    if (this.inputInterval) {
      clearInterval(this.inputInterval);
      this.inputInterval = null;
    }
  }

  destroy(): void {
    this.stopInputSync();
    this.p2pManager?.destroy();
    this.p2pManager = null;
  }

  /**
   * Get P2P connection state
   */
  isConnected(): boolean {
    return this.p2pManager !== null;
  }

  // --- Private methods ---

  private async joinSocketRoom(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.emit('p2p:join', { roomId: this.roomId });
      this.socket.once('p2p:joined', () => {
        logger.debug('✅ Joined Socket.IO room');
        resolve();
      });
    });
  }

  private async waitForGuest(): Promise<void> {
    return new Promise((resolve) => {
      const onPeerJoined = () => {
        logger.info('✅ Guest joined');
        this.socket.off('p2p:peer-joined', onPeerJoined);
        resolve();
      };
      this.socket.on('p2p:peer-joined', onPeerJoined);
    });
  }

  private async waitForHost(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.emit('p2p:check_host_ready', { roomId: this.roomId });

      const onHostReady = () => {
        logger.info('✅ Host is ready');
        this.socket.off('p2p:host_ready', onHostReady);
        resolve();
      };

      this.socket.on('p2p:host_ready', onHostReady);

      // Timeout after 30 seconds
      setTimeout(() => {
        this.socket.off('p2p:host_ready', onHostReady);
        logger.warn('Timeout waiting for host');
        resolve();
      }, 30000);
    });
  }

  private createP2PManager(): P2PManager {
    return new P2PManager(this.socket, this.roomId, this.isHost, {
      onStream: () => {}, // Not used in dual mode
      onData: (data) => this.handleData(data),
      onConnect: async () => {
        logger.info('✅ P2P connected');
        this.callbacks.onConnected();
      },
      onClose: () => {
        logger.info('❌ P2P disconnected');
        this.callbacks.onDisconnected();
      },
      onError: (err) => {
        logger.error('P2P error:', err);
        this.callbacks.onError(err.message);
      }
    });
  }

  private handleData(data: any): void {
    // Handle netplay messages (rollback mode)
    if (this.useRollback && this.isNetplayMessage(data)) {
      this.handleNetplayMessage(data as NetplayMessage);
      return;
    }

    // Legacy handling
    switch (data.type) {
      case 'dual_input':
        this.handleRemoteInput(data);
        break;
    }
  }

  private isNetplayMessage(data: any): boolean {
    return data && typeof data.type === 'string' && [
      'input',
      'initial_state',
      'initial_state_ack',
      'sync_check',
      'sync_result',
      'periodic_sync',
      'resync_state',
      'resync_chunk',
      'resync_complete',
      'resync_ack'
    ].includes(data.type);
  }

  private handleNetplayMessage(msg: NetplayMessage): void {
    // Special handling for initial state
    if (msg.type === 'initial_state') {
      if (this.callbacks.onInitialState) {
        this.callbacks.onInitialState(msg.state);
      }
      return;
    }

    if (msg.type === 'initial_state_ack') {
      if (this.callbacks.onInitialStateAck) {
        this.callbacks.onInitialStateAck();
      }
      // Also forward to netplay manager
      if (this.callbacks.onNetplayMessage) {
        this.callbacks.onNetplayMessage(msg);
      }
      return;
    }

    // Forward to RollbackManager via callback
    if (this.callbacks.onNetplayMessage) {
      this.callbacks.onNetplayMessage(msg);
    }
  }

  private handleRemoteInput(data: any): void {
    const { player, data: inputData } = data;

    // HOST receives P2 inputs, GUEST receives P1 inputs
    if ((this.isHost && player === 2) || (!this.isHost && player === 1)) {
      const inputState = this.inputManager.decodeInput(new Uint8Array(inputData));
      this.callbacks.onRemoteInput(player, inputState);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
