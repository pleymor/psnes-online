<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';

  export let roomId: string;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let audioContext: AudioContext;
  let audioQueue: AudioBufferSourceNode[] = [];

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
    audioContext = new AudioContext();

    // Listen for video frames
    $socket?.on('game:frame', (frame: any) => {
      renderFrame(frame);
    });

    // Listen for audio
    $socket?.on('game:audio', (audio: any) => {
      playAudio(audio);
    });

    // Input handling
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
  });

  onDestroy(() => {
    $socket?.off('game:frame');
    $socket?.off('game:audio');
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    audioContext?.close();
  });

  function renderFrame(frame: any) {
    if (!ctx) return;

    // Create ImageData from frame
    const imageData = new ImageData(
      new Uint8ClampedArray(frame.data),
      frame.width,
      frame.height
    );

    // Scale to canvas size
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
    } else if (Array.isArray(audio.data)) {
      audioData = new Float32Array(audio.data);
    } else if (audio.data.data) {
      // Socket.IO might wrap it in an object
      audioData = new Float32Array(audio.data.data);
    } else {
      console.warn('Unknown audio data format:', typeof audio.data);
      return;
    }

    // Check if we have valid audio data
    const numFrames = audioData.length / audio.channels;
    if (numFrames <= 0 || !isFinite(numFrames)) {
      console.warn('Invalid audio frame count:', numFrames);
      return;
    }

    const audioBuffer = audioContext.createBuffer(
      audio.channels,
      numFrames,
      audio.sampleRate
    );

    // Fill buffer with audio data
    for (let channel = 0; channel < audio.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = audioData[i * audio.channels + channel];
      }
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') return; // Let parent handle pause

    const button = keyConfig[e.code as keyof typeof keyConfig];
    if (button && !currentInput[button as keyof typeof currentInput]) {
      currentInput[button as keyof typeof currentInput] = true;
      sendInput();
      e.preventDefault();
    }
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
    width="512"
    height="448"
  />
</div>

<style>
  .canvas-container {
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
    max-width: 100%;
    max-height: 100%;
    border: 2px solid #333;
  }
</style>
