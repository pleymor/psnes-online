/**
 * Audio capture utility for streaming emulator audio via WebRTC
 */

import { createLogger } from '$lib/utils/logger';

const logger = createLogger('AudioCapture');

let globalAudioStream: MediaStream | null = null;
let globalAudioContext: AudioContext | null = null;
let globalDestination: MediaStreamAudioDestinationNode | null = null;
let connectedNodes = new Set<AudioNode>(); // Track connected nodes to avoid duplicates

/**
 * Initialize audio capture by intercepting AudioContext creation
 * This should be called before the emulator starts
 */
export function initializeAudioCapture(): void {
  // Store original AudioContext constructor
  const OriginalAudioContext = window.AudioContext || (window as any).webkitAudioContext;

  if (!OriginalAudioContext) {
    logger.warn('AudioContext not supported');
    return;
  }

  // Create a proxy to intercept AudioContext creation
  const AudioContextProxy = new Proxy(OriginalAudioContext, {
    construct(target, args) {
      const audioContext = new target(...args);

      // Store the first AudioContext (likely from the emulator)
      if (!globalAudioContext) {
        logger.debug('✅ Captured emulator AudioContext');
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
        let isPatching = false; // Prevent infinite recursion

        AudioNode.prototype.connect = function(this: AudioNode, destination: any, ...args: any[]): any {
          // If connecting to the main destination, also connect to our stream
          if (!isPatching && destination === originalDestination && globalDestination && !connectedNodes.has(this)) {
            try {
              isPatching = true;
              originalConnect.call(this, globalDestination as any);
              connectedNodes.add(this); // Track to avoid reconnecting
              isPatching = false;
            } catch (e) {
              isPatching = false;
              // Ignore connection errors
            }
          }

          const result = originalConnect.call(this, destination, ...args);
          return result;
        };
      }

      return audioContext;
    }
  });

  // Replace global AudioContext
  window.AudioContext = AudioContextProxy as any;
  (window as any).webkitAudioContext = AudioContextProxy;

  logger.debug('🎧 Audio capture initialized');
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
