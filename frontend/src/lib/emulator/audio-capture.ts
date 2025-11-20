/**
 * Audio capture utility for streaming emulator audio via WebRTC
 */

let globalAudioStream: MediaStream | null = null;
let globalAudioContext: AudioContext | null = null;
let globalDestination: MediaStreamAudioDestinationNode | null = null;

/**
 * Initialize audio capture by intercepting AudioContext creation
 * This should be called before the emulator starts
 */
export function initializeAudioCapture(): void {
  // Store original AudioContext constructor
  const OriginalAudioContext = window.AudioContext || (window as any).webkitAudioContext;

  if (!OriginalAudioContext) {
    console.warn('AudioContext not supported');
    return;
  }

  // Create a proxy to intercept AudioContext creation
  const AudioContextProxy = new Proxy(OriginalAudioContext, {
    construct(target, args) {
      const audioContext = new target(...args);

      // Store the first AudioContext (likely from the emulator)
      if (!globalAudioContext) {
        console.log('✅ Captured emulator AudioContext');
        globalAudioContext = audioContext;

        // Create a MediaStreamDestination to capture audio
        globalDestination = audioContext.createMediaStreamDestination();
        globalAudioStream = globalDestination.stream;

        // Hook into the destination property to intercept audio
        const originalDestination = audioContext.destination;

        // Create a gain node to split the audio
        const splitter = audioContext.createGain();
        splitter.gain.value = 1.0;

        // Monkey-patch connect to intercept audio nodes
        const originalConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(this: AudioNode, destination: any, ...args: any[]) {
          const result = originalConnect.call(this, destination, ...args);

          // If connecting to the main destination, also connect to our stream
          if (destination === originalDestination && globalDestination) {
            try {
              originalConnect.call(this, globalDestination as any);
              console.log('🎵 Audio node connected to stream destination');
            } catch (e) {
              // Ignore connection errors
            }
          }

          return result;
        };
      }

      return audioContext;
    }
  });

  // Replace global AudioContext
  window.AudioContext = AudioContextProxy as any;
  (window as any).webkitAudioContext = AudioContextProxy;

  console.log('🎧 Audio capture initialized');
}

/**
 * Get the captured audio stream
 */
export function getAudioStream(): MediaStream | null {
  return globalAudioStream;
}

/**
 * Get the audio context
 */
export function getAudioContext(): AudioContext | null {
  return globalAudioContext;
}

/**
 * Cleanup audio capture
 */
export function cleanupAudioCapture(): void {
  globalAudioStream = null;
  globalAudioContext = null;
  globalDestination = null;
}
