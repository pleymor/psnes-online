/**
 * Streaming Mode Handler
 *
 * In streaming mode:
 * - HOST: Runs emulator locally, captures canvas as video stream, sends to guest
 * - GUEST: Receives video stream, sends button inputs via data channel
 */

import { P2PManager, captureCanvasStream } from '$lib/webrtc/p2p-manager';
import type { KeyConfig } from '$lib/types';
import { createLogger } from '$lib/utils/logger';
import type { Socket } from 'socket.io-client';

const logger = createLogger('StreamingMode');

export interface StreamingModeCallbacks {
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: string) => void;
  onStreamReceived: (stream: MediaStream) => void;
  onRemoteInput: (button: string, pressed: boolean) => void;
  onLatencyUpdate: (inputLatency: number, totalLatency: number) => void;
}

export class StreamingModeHandler {
  private p2pManager: P2PManager | null = null;
  private latencyHistoryInput: number[] = [];
  private latencyHistoryTotal: number[] = [];
  private readonly LATENCY_HISTORY_SIZE = 10;

  constructor(
    private socket: Socket,
    private roomId: string,
    private isHost: boolean,
    private keyConfig: KeyConfig,
    private callbacks: StreamingModeCallbacks
  ) {}

  /**
   * Initialize streaming mode for HOST
   * Must be called after emulator is ready (needs canvas)
   */
  async initAsHost(canvas: HTMLCanvasElement): Promise<void> {
    logger.info('📺 Initializing STREAMING mode as HOST');

    await this.joinSocketRoom();

    this.p2pManager = this.createP2PManager();

    // Capture canvas as video stream
    const stream = captureCanvasStream(canvas, 60);
    await this.p2pManager.initConnection(stream);

    logger.info('✅ HOST streaming initialized');
  }

  /**
   * Initialize streaming mode for GUEST
   */
  async initAsGuest(): Promise<void> {
    logger.info('📺 Initializing STREAMING mode as GUEST');

    await this.joinSocketRoom();

    this.p2pManager = this.createP2PManager();
    await this.p2pManager.initConnection();

    logger.info('✅ GUEST streaming initialized');
  }

  /**
   * Send input from guest to host (streaming mode uses button-by-button)
   */
  sendInput(button: string, pressed: boolean): void {
    if (!this.p2pManager || this.isHost) return;

    const timestamp = performance.now();
    const inputId = `${button}_${timestamp}`;

    this.p2pManager.sendData({
      type: 'input',
      button,
      pressed,
      timestamp,
      inputId
    });
  }

  destroy(): void {
    this.p2pManager?.destroy();
    this.p2pManager = null;
  }

  private async joinSocketRoom(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.emit('p2p:join', { roomId: this.roomId });
      this.socket.once('p2p:joined', () => {
        logger.debug('✅ Joined Socket.IO room:', this.roomId);
        resolve();
      });
    });
  }

  private createP2PManager(): P2PManager {
    return new P2PManager(this.socket, this.roomId, this.isHost, {
      onStream: (stream) => {
        logger.debug('📺 Received video stream from host');
        this.callbacks.onStreamReceived(stream);
        this.callbacks.onConnected();
      },
      onData: (data) => this.handleData(data),
      onConnect: () => {
        logger.info('✅ P2P connected');
        this.callbacks.onConnected();
      },
      onClose: () => {
        logger.info('❌ P2P connection closed');
        this.callbacks.onDisconnected();
      },
      onError: (err) => {
        logger.error('P2P error:', err);
        this.callbacks.onError(err.message);
      }
    });
  }

  private handleData(data: any): void {
    // HOST: Receive input from guest
    if (data.type === 'input' && this.isHost) {
      this.callbacks.onRemoteInput(data.button, data.pressed);

      // Send ACK back to guest
      if (this.p2pManager && data.inputId && data.timestamp) {
        this.p2pManager.sendData({
          type: 'input_ack',
          inputId: data.inputId,
          timestamp: data.timestamp
        });
      }
    }

    // GUEST: Receive ACK from host (for latency measurement)
    if (data.type === 'input_ack' && !this.isHost) {
      this.updateLatency(data.timestamp);
    }
  }

  private updateLatency(sendTime: number): void {
    const now = performance.now();
    const latency = now - sendTime;

    // Update input latency
    this.latencyHistoryInput.push(latency);
    if (this.latencyHistoryInput.length > this.LATENCY_HISTORY_SIZE) {
      this.latencyHistoryInput.shift();
    }
    const inputLatency = this.latencyHistoryInput.reduce((a, b) => a + b, 0) / this.latencyHistoryInput.length;

    // Estimate total latency (input + video encoding/decoding ~33ms)
    const estimatedVideoLatency = 33;
    const totalLat = latency + estimatedVideoLatency;

    this.latencyHistoryTotal.push(totalLat);
    if (this.latencyHistoryTotal.length > this.LATENCY_HISTORY_SIZE) {
      this.latencyHistoryTotal.shift();
    }
    const totalLatency = this.latencyHistoryTotal.reduce((a, b) => a + b, 0) / this.latencyHistoryTotal.length;

    this.callbacks.onLatencyUpdate(inputLatency, totalLatency);
  }
}
