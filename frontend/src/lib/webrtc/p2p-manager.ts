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

        // Create peer connection
        this.peer = new SimplePeer({
          initiator: this.isHost, // Host initiates the connection
          stream: localStream,     // Host sends video/audio stream
          trickle: true,           // Use trickle ICE for faster connection
          channelName: 'input',    // Explicitly name the data channel
          offerOptions: {
            // Ensure data channel is created even with media stream
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            // Optimize for low latency
            voiceActivityDetection: false,
            iceRestart: false
          },
          answerOptions: {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            voiceActivityDetection: false
          },
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' }
            ],
            // Prefer direct P2P connection, avoid relay servers
            iceTransportPolicy: 'all', // 'all' tries direct first, 'relay' forces TURN
            iceCandidatePoolSize: 10 // Pre-gather ICE candidates for faster connection
          }
        });

        // Handle signaling data (offer/answer/ICE candidates)
        this.peer.on('signal', (data) => {
          this.socket.emit('webrtc:signal', {
            roomId: this.roomId,
            signal: data
          });
        });

        // Track if connection is being established
        let connectionResolved = false;

        // Connection established
        this.peer.on('connect', () => {
          // @ts-ignore - Check internal connection state
          this.callbacks.onConnect?.();
          if (!connectionResolved) {
            connectionResolved = true;

            // Log connection type for diagnostics
            this.logConnectionType();

            resolve();
          }
        });

        // Debug: Monitor data channel state directly
        // @ts-ignore - Access internal peer connection and data channel
        setTimeout(() => {
          const pc = this.peer?._pc;
          const channel = this.peer?._channel;

          if (pc) {
            // Optimize video encoding for minimal latency
            this.optimizeVideoEncoding(pc);

            // Monitor peer connection state
            pc.addEventListener('connectionstatechange', () => {
              if (pc.connectionState === 'connected' && !connectionResolved) {
                this.callbacks.onConnect?.();
                connectionResolved = true;
                resolve();
              }
            });

            // For host: monitor the data channel it creates
            if (this.isHost && channel) {
              channel.addEventListener('open', () => {
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
              const receivedChannel = event.channel;
              receivedChannel.addEventListener('open', () => {
              });
            });
          }
        }, 100);

        // Receive remote stream (for guests)
        this.peer.on('stream', (stream: MediaStream) => {
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
          this.callbacks.onClose?.();
        });

        // Listen for remote signals
        this.socket.on('webrtc:signal', (data: { signal: any; from?: string }) => {
          if (this.peer && !this.peer.destroyed) {
            this.peer.signal(data.signal);

            // For host (initiator), resolve after receiving answer
            // The data channel should be ready soon after
            if (this.isHost && data.signal.type === 'answer' && !connectionResolved) {
              connectionResolved = true;
              // Give a moment for data channel to open
              setTimeout(() => {
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
    if (!this.peer || this.peer.destroyed) {
      console.warn('⚠️ Cannot send data: peer not connected');
      return;
    }

    try {
      const jsonData = JSON.stringify(data);
      this.peer.send(jsonData);
    } catch (error) {
      console.error('Failed to send P2P data:', error);
    }
  }

  /**
   * Optimize video encoding for minimal latency
   */
  private async optimizeVideoEncoding(pc: RTCPeerConnection): Promise<void> {
    try {
      // Wait a bit for senders to be available
      await new Promise(resolve => setTimeout(resolve, 500));

      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track?.kind === 'video');

      if (videoSender) {
        const params = videoSender.getParameters();

        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }

        // Optimize for low latency
        params.encodings[0].maxBitrate = 2500000; // 2.5 Mbps max (balance quality/latency)
        params.encodings[0].maxFramerate = 60; // Match emulator framerate
        params.encodings[0].priority = 'high'; // Prioritize video
        params.encodings[0].networkPriority = 'high';

        // Degradation preference: prefer to maintain framerate over resolution
        params.degradationPreference = 'maintain-framerate';

        await videoSender.setParameters(params);
        console.log('✅ Video encoding optimized for low latency');
      }

      // Also optimize audio
      const audioSender = senders.find(s => s.track?.kind === 'audio');
      if (audioSender) {
        const params = audioSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
        await audioSender.setParameters(params);
      }

    } catch (error) {
      console.warn('Could not optimize video encoding:', error);
    }
  }

  /**
   * Log connection type (direct P2P vs relayed)
   */
  private async logConnectionType(): Promise<void> {
    try {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for ICE to complete

      const stats = await this.getStats();
      if (!stats) return;

      for (const [, stat] of stats) {
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
          const localCandidate = [...stats.values()].find(
            s => s.type === 'local-candidate' && s.id === stat.localCandidateId
          );
          const remoteCandidate = [...stats.values()].find(
            s => s.type === 'remote-candidate' && s.id === stat.remoteCandidateId
          );

          const localType = (localCandidate as any)?.candidateType || 'unknown';
          const remoteType = (remoteCandidate as any)?.candidateType || 'unknown';

          console.log('🔗 P2P Connection established:');
          console.log(`   Local: ${localType} (${(localCandidate as any)?.protocol})`);
          console.log(`   Remote: ${remoteType} (${(remoteCandidate as any)?.protocol})`);

          // Check if it's a direct connection
          if (localType === 'host' || localType === 'srflx') {
            console.log('   ✅ DIRECT P2P CONNECTION - Optimal latency!');
          } else if (localType === 'relay') {
            console.warn('   ⚠️ RELAYED CONNECTION - May have higher latency');
          }

          // Log estimated RTT
          if (stat.currentRoundTripTime) {
            console.log(`   RTT: ${(stat.currentRoundTripTime * 1000).toFixed(1)}ms`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to log connection type:', error);
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
   * Get connection quality metrics
   */
  async getConnectionMetrics(): Promise<{
    type: string;
    rtt: number;
    bytesReceived: number;
    bytesSent: number;
  } | null> {
    const stats = await this.getStats();
    if (!stats) return null;

    let connectionType = 'unknown';
    let rtt = 0;
    let bytesReceived = 0;
    let bytesSent = 0;

    for (const [, stat] of stats) {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        const localCandidate = [...stats.values()].find(
          s => s.type === 'local-candidate' && s.id === stat.localCandidateId
        );
        connectionType = (localCandidate as any)?.candidateType || 'unknown';
        rtt = (stat.currentRoundTripTime || 0) * 1000; // Convert to ms
      }

      if (stat.type === 'transport') {
        bytesReceived = stat.bytesReceived || 0;
        bytesSent = stat.bytesSent || 0;
      }
    }

    return { type: connectionType, rtt, bytesReceived, bytesSent };
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
 * Helper: Capture canvas stream for WebRTC (video only)
 */
export function captureCanvasStream(
  canvas: HTMLCanvasElement,
  frameRate: number = 60
): MediaStream {
  // @ts-ignore - captureStream is supported in modern browsers
  const stream = canvas.captureStream(frameRate);
  return stream;
}

/**
 * Helper: Get audio stream from emulator's AudioContext
 * Intercepts the global AudioContext used by RetroArch/Emscripten
 */
export function getEmulatorAudioStream(): MediaStream | null {
  try {
    // Try to find the AudioContext created by Emscripten/RetroArch
    // Emscripten stores it in SDL.audioContext
    // @ts-ignore
    const sdlAudio = window.SDL?.audioContext || window.SDL2?.audioContext;

    if (sdlAudio && sdlAudio instanceof AudioContext) {
      // Create a MediaStreamDestination to capture the audio
      const destination = sdlAudio.createMediaStreamDestination();

      // Connect the audio context's destination to our stream destination
      // We need to intercept at the source, but since we can't access internal nodes,
      // we'll use a different approach: create a MediaElementSource

      // Alternative: Look for existing audio nodes
      // @ts-ignore - Access internal Emscripten audio
      const audioNode = window.SDL?.audio;
      if (audioNode) {
        // Try to tap into the audio stream
        try {
          audioNode.connect(destination);
        } catch (e) {
          console.warn('Could not connect audio node:', e);
        }
      }

      return destination.stream;
    }
  } catch (error) {
    console.warn('Could not get emulator audio stream:', error);
  }

  return null;
}

/**
 * Helper: Combine canvas video with emulator audio
 */
export function captureCanvasWithAudio(
  canvas: HTMLCanvasElement,
  frameRate: number = 60
): MediaStream {
  // Get video stream from canvas
  // @ts-ignore
  const videoStream = canvas.captureStream(frameRate);

  // Try to get audio from the emulator
  try {
    const audioStream = getEmulatorAudioStream();
    if (audioStream) {
      const audioTracks = audioStream.getAudioTracks();
      if (audioTracks.length > 0) {
        console.log('✅ Adding audio tracks to video stream');
        audioTracks.forEach((track: MediaStreamTrack) => videoStream.addTrack(track));
      }
    } else {
      console.warn('⚠️ No audio stream available from emulator');
    }
  } catch (error) {
    console.warn('Could not add audio to stream:', error);
  }

  return videoStream;
}

/**
 * Helper: Create audio stream from AudioContext
 */
export function captureAudioStream(audioContext: AudioContext): MediaStream {
  // @ts-ignore - createMediaStreamDestination is standard Web Audio API
  const destination = audioContext.createMediaStreamDestination();
  return destination.stream;
}
