<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';

  export let roomId: string;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let audioContext: AudioContext;
  let audioQueue: AudioBufferSourceNode[] = [];
  let nextAudioTime = 0; // For audio scheduling
  let currentSpeed = 1.0;
  let showSpeedIndicator = false;
  let speedIndicatorTimeout: NodeJS.Timeout;

  const speedPresets = [0.5, 1.0, 2.0, 3.0, 0]; // 0 = unlimited
  const speedLabels: { [key: number]: string } = {
    0: 'MAX',
    0.5: '0.5x',
    1: '1x',
    2: '2x',
    3: '3x'
  };

  const keyConfig = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    KeyX: 'a',
    KeyZ: 'b',
    KeyS: 'x',
    KeyA: 'y',
    KeyQ: 'l',
    KeyW: 'r',
    Enter: 'start',
    ShiftRight: 'select'
  };

  let currentInput = {
    up: false,
    down: false,
    left: false,
    right: false,
    a: false,
    b: false,
    x: false,
    y: false,
    l: false,
    r: false,
    start: false,
    select: false
  };

  onMount(() => {
    ctx = canvas.getContext('2d')!;
    audioContext = new AudioContext({ latencyHint: 'interactive' });

    // Listen for video frames
    $socket?.on('game:frame', (frame: any) => {
      renderFrame(frame);
    });

    // Listen for audio
    $socket?.on('game:audio', (audio: any) => {
      playAudio(audio);
    });

    // Listen for speed changes
    $socket?.on('game:speedChanged', (data: { speed: number }) => {
      currentSpeed = data.speed;
      showSpeedIndicatorBriefly();
    });

    // Input handling
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
  });

  onDestroy(() => {
    $socket?.off('game:frame');
    $socket?.off('game:audio');
    $socket?.off('game:speedChanged');
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    audioContext?.close();
    if (speedIndicatorTimeout) clearTimeout(speedIndicatorTimeout);
  });

  function renderFrame(frame: any) {
    if (!ctx || !canvas) return;

    // Resize canvas if frame dimensions changed
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }

    // Create ImageData from frame
    const imageData = new ImageData(
      new Uint8ClampedArray(frame.data),
      frame.width,
      frame.height
    );

    // Disable image smoothing for sharp pixels
    ctx.imageSmoothingEnabled = false;

    // Draw directly to canvas at native resolution
    ctx.putImageData(imageData, 0, 0);
  }

  function playAudio(audio: any) {
    if (!audioContext) return;

    // Convert audio data to Float32Array if needed
    let audioData: Float32Array;

    if (audio.data instanceof Float32Array) {
      audioData = audio.data;
    } else if (audio.data instanceof ArrayBuffer) {
      audioData = new Float32Array(audio.data);
    } else if (audio.data instanceof Uint8Array || audio.data instanceof Int8Array ||
               audio.data instanceof Uint16Array || audio.data instanceof Int16Array ||
               audio.data instanceof Uint32Array || audio.data instanceof Int32Array) {
      // Convert other typed arrays to Float32Array
      audioData = new Float32Array(audio.data.buffer);
    } else if (Array.isArray(audio.data)) {
      audioData = new Float32Array(audio.data);
    } else if (typeof audio.data === 'object' && audio.data !== null) {
      // Socket.IO binary data might come as an object with numeric keys
      // Try to extract the buffer from various possible formats
      if (audio.data.buffer instanceof ArrayBuffer) {
        audioData = new Float32Array(audio.data.buffer);
      } else if (audio.data.data) {
        // Nested data property
        if (audio.data.data instanceof ArrayBuffer) {
          audioData = new Float32Array(audio.data.data);
        } else if (typeof audio.data.data === 'object') {
          // Convert object with numeric keys to array
          const arr = Object.values(audio.data.data);
          audioData = new Float32Array(arr as number[]);
        } else {
          console.warn('Unknown nested audio data format:', typeof audio.data.data, audio.data.data);
          return;
        }
      } else {
        // Try to convert object with numeric keys directly to array
        const keys = Object.keys(audio.data);
        if (keys.length > 0 && !isNaN(Number(keys[0]))) {
          const arr = Object.values(audio.data);
          audioData = new Float32Array(arr as number[]);
        } else {
          console.warn('Unknown audio data object format:', audio.data);
          return;
        }
      }
    } else {
      console.warn('Unknown audio data format:', typeof audio.data, audio.data);
      return;
    }

    // Check if we have valid audio data
    const numFrames = audioData.length / audio.channels;
    if (numFrames <= 0 || !isFinite(numFrames)) {
      console.warn('Invalid audio frame count:', numFrames, 'from', audioData.length, 'samples');
      return;
    }

    const audioBuffer = audioContext.createBuffer(
      audio.channels,
      numFrames,
      audio.sampleRate
    );

    // Fill buffer with audio data (interleaved to separate channels)
    for (let channel = 0; channel < audio.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = audioData[i * audio.channels + channel];
      }
    }

    // Schedule audio playback
    const currentTime = audioContext.currentTime;

    // Initialize nextAudioTime if needed or if we're too far behind/ahead
    if (nextAudioTime === 0 || nextAudioTime < currentTime || nextAudioTime > currentTime + 0.5) {
      // Start with a small buffer (50ms) for smooth playback
      nextAudioTime = currentTime + 0.05;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(nextAudioTime);

    // Update next audio time
    nextAudioTime += audioBuffer.duration;

    // Keep audio latency in check (between 30ms and 150ms)
    const latency = nextAudioTime - currentTime;
    if (latency > 0.15) {
      // Too much latency, speed up by reducing buffer
      nextAudioTime = currentTime + 0.15;
    } else if (latency < 0.03) {
      // Too little buffer, add a small gap to prevent underruns
      nextAudioTime = currentTime + 0.03;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') return; // Let parent handle pause

    // Speed controls
    if (e.key === 'Tab') {
      e.preventDefault();
      toggleSpeed();
      return;
    }

    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      increaseSpeed();
      return;
    }

    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      decreaseSpeed();
      return;
    }

    const button = keyConfig[e.code as keyof typeof keyConfig];
    if (button && !currentInput[button as keyof typeof currentInput]) {
      currentInput[button as keyof typeof currentInput] = true;
      sendInput();
      e.preventDefault();
    }
  }

  function toggleSpeed() {
    // Toggle between 1x and unlimited (0)
    const newSpeed = currentSpeed === 1 ? 0 : 1;
    setSpeed(newSpeed);
  }

  function increaseSpeed() {
    const currentIndex = speedPresets.indexOf(currentSpeed);
    const nextIndex = Math.min(currentIndex + 1, speedPresets.length - 1);
    setSpeed(speedPresets[nextIndex]);
  }

  function decreaseSpeed() {
    const currentIndex = speedPresets.indexOf(currentSpeed);
    const prevIndex = Math.max(currentIndex - 1, 0);
    setSpeed(speedPresets[prevIndex]);
  }

  function setSpeed(speed: number) {
    $socket?.emit('game:setSpeed', { roomId, speed });
    currentSpeed = speed;
    showSpeedIndicatorBriefly();
  }

  function showSpeedIndicatorBriefly() {
    showSpeedIndicator = true;
    if (speedIndicatorTimeout) clearTimeout(speedIndicatorTimeout);
    speedIndicatorTimeout = setTimeout(() => {
      showSpeedIndicator = false;
    }, 2000);
  }

  function handleKeyUp(e: KeyboardEvent) {
    const button = keyConfig[e.code as keyof typeof keyConfig];
    if (button) {
      currentInput[button as keyof typeof currentInput] = false;
      sendInput();
      e.preventDefault();
    }
  }

  function sendInput() {
    $socket?.emit('game:input', {
      roomId,
      input: {
        port: 1, // TODO: Get from player's selected port
        buttons: currentInput
      }
    });
  }
</script>

<div class="canvas-container">
  <canvas
    bind:this={canvas}
    width="256"
    height="224"
  />

  {#if showSpeedIndicator}
    <div class="speed-indicator" class:unlimited={currentSpeed === 0}>
      <div class="speed-icon">⚡</div>
      <div class="speed-text">
        {speedLabels[currentSpeed] || `${currentSpeed}x`}
      </div>
      <div class="speed-hint">
        Tab: Toggle | +/-: Adjust
      </div>
    </div>
  {/if}
</div>

<style>
  .canvas-container {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    height: 100vh;
    background: #000;
  }

  canvas {
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    image-rendering: -moz-crisp-edges;
    /* Force 4:3 aspect ratio like a CRT TV */
    aspect-ratio: 4 / 3;
    width: auto;
    height: 90vh;
    max-width: 100%;
    max-height: 90vh;
    border: 2px solid #333;
  }

  .speed-indicator {
    position: absolute;
    top: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.85);
    border: 2px solid #4a9eff;
    border-radius: 12px;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    animation: slideIn 0.3s ease-out;
    box-shadow: 0 4px 20px rgba(74, 158, 255, 0.3);
  }

  .speed-indicator.unlimited {
    border-color: #ff4a4a;
    box-shadow: 0 4px 20px rgba(255, 74, 74, 0.3);
  }

  .speed-icon {
    font-size: 32px;
    animation: pulse 1s ease-in-out infinite;
  }

  .speed-text {
    font-size: 28px;
    font-weight: bold;
    color: #fff;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
  }

  .speed-hint {
    font-size: 11px;
    color: #aaa;
    margin-top: 4px;
    text-align: center;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes pulse {
    0%, 100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.1);
    }
  }
</style>
