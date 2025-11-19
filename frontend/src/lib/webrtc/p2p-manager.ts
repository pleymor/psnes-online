// Import polyfills BEFORE SimplePeer to ensure they're available
import '$lib/polyfills';
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
          channelName: 'input',    // Explicitly name the data channel
          offerOptions: {
            // Ensure data channel is created even with media stream
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          },
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
          console.log('📤 Sending WebRTC signal:', data.type || 'candidate');
          this.socket.emit('webrtc:signal', {
            roomId: this.roomId,
            signal: data
          });
        });

        // Track if connection is being established
        let connectionResolved = false;

        // Connection established
        this.peer.on('connect', () => {
          console.log('✅ P2P connection established!');
          console.log('[P2PManager] Data channel ready, can send/receive data');
          // @ts-ignore - Check internal connection state
          console.log('[P2PManager] Peer connected:', this.peer.connected);
          this.callbacks.onConnect?.();
          if (!connectionResolved) {
            connectionResolved = true;
            resolve();
          }
        });

        // Debug: Monitor data channel state directly
        // @ts-ignore - Access internal peer connection and data channel
        setTimeout(() => {
          const pc = this.peer?._pc;
          const channel = this.peer?._channel;

          console.log('[P2PManager] Checking connection state:', {
            hasPC: !!pc,
            hasChannel: !!channel,
            pcState: pc?.connectionState,
            channelState: channel?.readyState
          });

          if (pc) {
            // Monitor peer connection state
            pc.addEventListener('connectionstatechange', () => {
              console.log('[P2PManager] PC connection state:', pc.connectionState);
              if (pc.connectionState === 'connected' && !connectionResolved) {
                console.log('[P2PManager] Peer connection is CONNECTED, triggering callbacks');
                this.callbacks.onConnect?.();
                connectionResolved = true;
                resolve();
              }
            });

            // For host: monitor the data channel it creates
            if (this.isHost && channel) {
              console.log('[P2PManager] Host data channel state:', channel.readyState);
              channel.addEventListener('open', () => {
                console.log('[P2PManager] Host data channel OPENED');
                if (!connectionResolved) {
                  this.callbacks.onConnect?.();
                  connectionResolved = true;
                  resolve();
                }
              });
              channel.addEventListener('error', (err) => {
                console.error('[P2PManager] Host data channel ERROR:', err);
              });
            }

            // For guest: receive data channel
            pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
              console.log('[P2PManager] Guest received data channel:', event.channel.label);
              const receivedChannel = event.channel;
              receivedChannel.addEventListener('open', () => {
                console.log('[P2PManager] Guest data channel OPENED');
              });
            });
          }
        }, 100);

        // Receive remote stream (for guests)
        this.peer.on('stream', (stream: MediaStream) => {
          console.log('📺 Received remote stream');
          this.callbacks.onStream?.(stream);
        });

        // Receive data via data channel
        this.peer.on('data', (data: Uint8Array) => {
          try {
            const decoded = JSON.parse(data.toString());
            console.log('[P2PManager] Received data:', decoded);
            // Pass data to callback (logging happens in handler)
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
        this.socket.on('webrtc:signal', (data: { signal: any; from?: string }) => {
          console.log('📥 Received WebRTC signal:', data.signal.type || 'candidate', 'from:', data.from);
          if (this.peer && !this.peer.destroyed) {
            this.peer.signal(data.signal);

            // For host (initiator), resolve after receiving answer
            // The data channel should be ready soon after
            if (this.isHost && data.signal.type === 'answer' && !connectionResolved) {
              console.log('[P2PManager] Host received answer, connection negotiated');
              connectionResolved = true;
              // Give a moment for data channel to open
              setTimeout(() => {
                console.log('[P2PManager] Host connection ready (via answer)');
                resolve();
              }, 500);
            }
          } else {
            console.warn('⚠️ Received signal but peer not ready');
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
    console.log('[P2PManager] sendData called:', {
      hasPeer: !!this.peer,
      destroyed: this.peer?.destroyed,
      // @ts-ignore - Check connection state
      connected: this.peer?.connected,
      data
    });

    if (!this.peer || this.peer.destroyed) {
      console.warn('⚠️ Cannot send data: peer not connected');
      return;
    }

    // @ts-ignore - Check if data channel is ready
    if (!this.peer.connected) {
      console.warn('⚠️ Data channel not ready yet, buffering may fail');
    }

    try {
      const jsonData = JSON.stringify(data);
      console.log('📡 Sending P2P data:', data.type, data.button);
      this.peer.send(jsonData);
    } catch (error) {
      console.error('Failed to send P2P data:', error);
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
