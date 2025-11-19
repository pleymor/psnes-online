import SimplePeer from 'simple-peer';
import type { Socket } from 'socket.io-client';

export interface P2PConnectionCallbacks {
  onStream?: (stream: MediaStream) => void;
  onData?: (data: any) => void;
  onConnect?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export class P2PManager {
  private peer: SimplePeer.Instance | null = null;
  private socket: Socket;
  private roomId: string;
  private isHost: boolean;
  private callbacks: P2PConnectionCallbacks;

  constructor(
    socket: Socket,
    roomId: string,
    isHost: boolean,
    callbacks: P2PConnectionCallbacks = {}
  ) {
    this.socket = socket;
    this.roomId = roomId;
    this.isHost = isHost;
    this.callbacks = callbacks;
  }

  /**
   * Initialize P2P connection
   * Host: Creates offer
   * Guest: Waits for offer, creates answer
   */
  async initConnection(localStream?: MediaStream): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log(`🔗 Initializing P2P as ${this.isHost ? 'HOST' : 'GUEST'}`);

        // Create peer connection
        this.peer = new SimplePeer({
          initiator: this.isHost, // Host initiates the connection
          stream: localStream,     // Host sends video/audio stream
          trickle: true,           // Use trickle ICE for faster connection
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' }
            ]
          }
        });

        // Handle signaling data (offer/answer/ICE candidates)
        this.peer.on('signal', (data) => {
          console.log('📤 Sending WebRTC signal');
          this.socket.emit('webrtc:signal', {
            roomId: this.roomId,
            signal: data
          });
        });

        // Connection established
        this.peer.on('connect', () => {
          console.log('✅ P2P connection established!');
          this.callbacks.onConnect?.();
          resolve();
        });

        // Receive remote stream (for guests)
        this.peer.on('stream', (stream: MediaStream) => {
          console.log('📺 Received remote stream');
          this.callbacks.onStream?.(stream);
        });

        // Receive data via data channel
        this.peer.on('data', (data: Uint8Array) => {
          try {
            const decoded = JSON.parse(data.toString());
            this.callbacks.onData?.(decoded);
          } catch (error) {
            console.error('Failed to parse P2P data:', error);
          }
        });

        // Handle errors
        this.peer.on('error', (error: Error) => {
          console.error('P2P error:', error);
          this.callbacks.onError?.(error);
          reject(error);
        });

        // Handle connection close
        this.peer.on('close', () => {
          console.log('❌ P2P connection closed');
          this.callbacks.onClose?.();
        });

        // Listen for remote signals
        this.socket.on('webrtc:signal', (data: { signal: any }) => {
          console.log('📥 Received WebRTC signal');
          if (this.peer && !this.peer.destroyed) {
            this.peer.signal(data.signal);
          }
        });

      } catch (error) {
        console.error('Failed to initialize P2P:', error);
        reject(error);
      }
    });
  }

  /**
   * Send data to remote peer via data channel
   */
  sendData(data: any): void {
    if (this.peer && !this.peer.destroyed) {
      try {
        this.peer.send(JSON.stringify(data));
      } catch (error) {
        console.error('Failed to send P2P data:', error);
      }
    }
  }

  /**
   * Get connection stats for monitoring
   */
  async getStats(): Promise<RTCStatsReport | null> {
    if (!this.peer || this.peer.destroyed) return null;

    try {
      // @ts-ignore - SimplePeer exposes _pc (RTCPeerConnection)
      const pc = this.peer._pc;
      if (pc) {
        return await pc.getStats();
      }
    } catch (error) {
      console.error('Failed to get stats:', error);
    }

    return null;
  }

  /**
   * Close P2P connection
   */
  destroy(): void {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.socket.off('webrtc:signal');
  }

  /**
   * Check if connection is active
   */
  isConnected(): boolean {
    return this.peer !== null && !this.peer.destroyed;
  }
}

/**
 * Helper: Capture canvas stream for WebRTC
 */
export function captureCanvasStream(
  canvas: HTMLCanvasElement,
  frameRate: number = 60
): MediaStream {
  // @ts-ignore - captureStream is supported in modern browsers
  const stream = canvas.captureStream(frameRate);
  console.log(`📹 Capturing canvas stream at ${frameRate} FPS`);
  return stream;
}

/**
 * Helper: Create audio stream from AudioContext
 */
export function captureAudioStream(audioContext: AudioContext): MediaStream {
  // @ts-ignore - createMediaStreamDestination is standard Web Audio API
  const destination = audioContext.createMediaStreamDestination();
  console.log('🔊 Created audio stream');
  return destination.stream;
}
