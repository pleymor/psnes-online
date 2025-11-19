<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';

  export let roomId: string;
  export let keyConfig: KeyConfig;
  export let port: 1 | 2 | null = null; // Controller port for this player (null if spectator)

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let audioContext: AudioContext;
  let audioQueue: AudioBufferSourceNode[] = [];
  let nextAudioTime = 0; // For audio scheduling
  let currentSpeed = 1.0;
  let showSpeedIndicator = false;
  let speedIndicatorTimeout: NodeJS.Timeout;
  let isFullscreen = false;
  let canvasContainer: HTMLDivElement;
  let gamepadPollInterval: number | null = null;

  // Reusable ImageData for better performance
  let imageData: ImageData | null = null;
  let pendingFrame: any = null;
  let rafId: number | null = null;

  // Latency measurement
  let lastInputTimestamp = 0;
  let latencyHistory: number[] = [];
  let averageLatency = 0;

  // Scale factor for crisp rendering (4x native SNES resolution)
  const SCALE_FACTOR = 4;

  // Offscreen canvas for native resolution
  let offscreenCanvas: OffscreenCanvas | null = null;
  let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

  const speedPresets = [0.5, 1.0, 2.0, 3.0, 0]; // 0 = unlimited
  const speedLabels: { [key: number]: string } = {
    0: 'MAX',
    0.5: '0.5x',
    1: '1x',
    2: '2x',
    3: '3x'
  };

  // Create a reverse mapping from key codes to button names
  let keyCodeToButton: Record<string, keyof typeof currentInput> = {};
  $: {
    keyCodeToButton = {};
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      keyCodeToButton[keyCode] = button as keyof typeof currentInput;
    }
  }

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
    ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true  // Better performance for animations
    })!;
    audioContext = new AudioContext({
      latencyHint: 'interactive', // Optimize for low latency over power consumption
      sampleRate: 48000
    });

    // Request low latency mode if available
    if ('baseLatency' in audioContext) {
      console.log(`Audio base latency: ${audioContext.baseLatency * 1000}ms`);
    }

    // Start render loop
    startRenderLoop();

    // Listen for video frames - measure latency and render
    $socket?.on('game:frame', (frame: any) => {
      // Measure input-to-render latency
      if (frame.inputTimestamp && lastInputTimestamp > 0) {
        const latency = performance.now() - frame.inputTimestamp;
        latencyHistory.push(latency);
        if (latencyHistory.length > 60) latencyHistory.shift(); // Keep last 60 frames
        averageLatency = latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length;

        if (latency > 100) {
          console.warn(`⚠️  HIGH LATENCY: ${latency.toFixed(1)}ms (avg: ${averageLatency.toFixed(1)}ms)`);
        }
      }

      pendingFrame = frame;
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

    // Start gamepad polling
    startGamepadPolling();

    // Listen for fullscreen changes
    document.addEventListener('fullscreenchange', handleFullscreenChange);
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    $socket?.off('game:frame');
    $socket?.off('game:audio');
    $socket?.off('game:speedChanged');
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    stopGamepadPolling();
    audioContext?.close();
    if (speedIndicatorTimeout) clearTimeout(speedIndicatorTimeout);
  });

  function startRenderLoop() {
    const render = () => {
      // Render immediately if frame is available (no buffering)
      if (pendingFrame) {
        renderFrameOptimized(pendingFrame);
        pendingFrame = null;
      }
      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);
  }

  function renderFrameOptimized(frame: any) {
    if (!ctx || !canvas) return;

    const startTime = performance.now();

    // Fast path: Skip initialization checks if already set up
    const needsSetup = !offscreenCanvas ||
                       offscreenCanvas.width !== frame.width ||
                       offscreenCanvas.height !== frame.height;

    // Initialize or resize offscreen canvas only if needed
    if (needsSetup) {
      offscreenCanvas = new OffscreenCanvas(frame.width, frame.height);
      offscreenCtx = offscreenCanvas.getContext('2d', {
        alpha: false,
        desynchronized: true,
        willReadFrequently: false
      });
      imageData = null;
    }

    // Calculate display dimensions to preserve 4:3 aspect ratio
    // SNES outputs 256×224 (or similar), but should be displayed as 4:3
    const scaledHeight = frame.height * SCALE_FACTOR;
    const scaledWidth = Math.round((scaledHeight * 4) / 3); // Force 4:3 ratio

    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
    }

    // Reuse ImageData object for offscreen canvas
    if (!imageData || !offscreenCtx) {
      imageData = offscreenCtx!.createImageData(frame.width, frame.height);
    }

    // Decode base64 data to Uint8Array (for nginx proxy compatibility)
    let data: Uint8Array;
    if (typeof frame.data === 'string') {
      // Base64 encoded (production mode with nginx)
      const binaryString = atob(frame.data);
      data = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        data[i] = binaryString.charCodeAt(i);
      }
    } else {
      // Direct binary data (development mode)
      data = new Uint8Array(frame.data);
    }

    imageData.data.set(data);
    offscreenCtx!.putImageData(imageData, 0, 0);

    // Disable image smoothing for sharp, pixelated upscaling
    ctx.imageSmoothingEnabled = false;

    // Scale up from offscreen canvas to display canvas with 4:3 ratio
    ctx.drawImage(
      offscreenCanvas,
      0, 0, frame.width, frame.height,
      0, 0, scaledWidth, scaledHeight
    );

    const renderTime = performance.now() - startTime;
    if (renderTime > 3) {
      console.log(`⚠️  CLIENT RENDER: Took ${renderTime.toFixed(2)}ms`);
    }
  }

  function playAudio(audio: any) {
    if (!audioContext) return;

    // Convert audio data to Float32Array
    let audioData: Float32Array;

    if (typeof audio.data === 'string') {
      // Base64 encoded (production mode with nginx)
      const binaryString = atob(audio.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      audioData = new Float32Array(bytes.buffer);
    } else if (audio.data instanceof Float32Array) {
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

    // Schedule audio playback with low-latency buffering
    const currentTime = audioContext.currentTime;
    const targetLatency = 0.05; // 50ms target buffer (reduced for lower latency)
    const minLatency = 0.02; // 20ms minimum
    const maxLatency = 0.15; // 150ms maximum

    // Initialize on first audio packet
    if (nextAudioTime === 0) {
      nextAudioTime = currentTime + targetLatency;
    }

    // If we're behind current time, catch up smoothly
    if (nextAudioTime < currentTime) {
      nextAudioTime = currentTime + targetLatency;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(nextAudioTime);

    // Update next audio time
    nextAudioTime += audioBuffer.duration;

    // Gentle drift correction to prevent audio artifacts
    const latency = nextAudioTime - currentTime;

    // Only apply correction if latency is outside acceptable range
    if (latency > maxLatency) {
      // Buffer growing too large - reduce gradually (5% correction)
      const excess = latency - targetLatency;
      nextAudioTime -= excess * 0.05;
    } else if (latency < minLatency && latency > 0) {
      // Buffer shrinking - add gradually (5% correction)
      const deficit = targetLatency - latency;
      nextAudioTime += deficit * 0.05;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') return; // Let parent handle pause

    // Fullscreen toggle with Alt+Enter
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

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

    const button = keyCodeToButton[e.code];
    if (button && !currentInput[button]) {
      currentInput[button] = true;
      lastInputTimestamp = performance.now(); // Track input timing
      sendInput();
      e.preventDefault();
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        // Enter fullscreen
        await canvasContainer.requestFullscreen();
        isFullscreen = true;
      } else {
        // Exit fullscreen
        await document.exitFullscreen();
        isFullscreen = false;
      }
    } catch (error) {
      console.error('Erreur lors du changement de mode plein écran:', error);
    }
  }

  function handleFullscreenChange() {
    isFullscreen = !!document.fullscreenElement;
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
    const button = keyCodeToButton[e.code];
    if (button) {
      currentInput[button] = false;
      sendInput();
      e.preventDefault();
    }
  }

  function sendInput() {
    // Only send input if player has selected a port
    if (!port) return;

    $socket?.emit('game:input', {
      roomId,
      input: {
        port,
        buttons: currentInput,
        timestamp: lastInputTimestamp || performance.now()
      }
    });
  }

  // Poll gamepad state for gameplay
  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;

    gamepadPollInterval = window.setInterval(() => {
      const gamepads = navigator.getGamepads();
      let inputChanged = false;

      for (let i = 0; i < gamepads.length; i++) {
        const gamepad = gamepads[i];
        if (!gamepad) continue;

        // Check buttons
        for (let j = 0; j < gamepad.buttons.length; j++) {
          const inputCode = `Gamepad${i}Button${j}`;
          const button = keyCodeToButton[inputCode];

          if (button) {
            const isPressed = gamepad.buttons[j].pressed;
            if (currentInput[button] !== isPressed) {
              currentInput[button] = isPressed;
              inputChanged = true;
            }
          }
        }

        // Check axes (for d-pad on some controllers)
        for (let j = 0; j < gamepad.axes.length; j++) {
          const axisValue = gamepad.axes[j];

          if (Math.abs(axisValue) > 0.5) {
            const direction = axisValue > 0 ? 'Plus' : 'Minus';
            const inputCode = `Gamepad${i}Axis${j}${direction}`;
            const button = keyCodeToButton[inputCode];

            if (button && !currentInput[button]) {
              currentInput[button] = true;
              inputChanged = true;
            }
          } else {
            // Release both directions when axis is centered
            const inputCodePlus = `Gamepad${i}Axis${j}Plus`;
            const inputCodeMinus = `Gamepad${i}Axis${j}Minus`;
            const buttonPlus = keyCodeToButton[inputCodePlus];
            const buttonMinus = keyCodeToButton[inputCodeMinus];

            if (buttonPlus && currentInput[buttonPlus]) {
              currentInput[buttonPlus] = false;
              inputChanged = true;
            }
            if (buttonMinus && currentInput[buttonMinus]) {
              currentInput[buttonMinus] = false;
              inputChanged = true;
            }
          }
        }
      }

      if (inputChanged) {
        lastInputTimestamp = performance.now();
        sendInput();
      }
    }, 8); // Poll every 8ms (~120Hz) for better responsiveness
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
    }
  }
</script>

<div class="canvas-container" bind:this={canvasContainer}>
  <canvas
    bind:this={canvas}
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
    /* Canvas already has 4:3 ratio from JS, scale to fill viewport height */
    object-fit: contain;
    height: 100vh;
    width: auto;
    max-width: 100%;
    border: none;
  }

  .canvas-container:fullscreen {
    background: #000;
  }

  .canvas-container:fullscreen canvas {
    object-fit: contain;
    height: 100vh;
    width: auto;
    max-width: 100vw;
    border: none;
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
