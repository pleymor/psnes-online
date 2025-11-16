import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * SNES Emulator Wrapper
 *
 * This is a Node.js wrapper for SNES9x emulation.
 *
 * IMPLEMENTATION OPTIONS:
 *
 * 1. WebAssembly + VM Context (Current - Lightweight)
 *    - Use WASM in Node.js VM
 *    - Requires some browser API polyfills
 *
 * 2. Native Binary (Recommended for Production)
 *    - Use snes9x native binary via child_process
 *    - Best performance, lowest latency
 *
 * 3. Headless Browser (Heavy but works)
 *    - Use Puppeteer to run emulator in Chrome
 *    - High resource usage
 */

export interface EmulatorConfig {
  romPath: string;
  audioSampleRate?: number;
  videoScale?: number;
}

export interface VideoFrame {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

export interface AudioSamples {
  sampleRate: number;
  channels: number;
  data: Float32Array;
}

export interface ControllerState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  l: boolean;
  r: boolean;
  start: boolean;
  select: boolean;
}

const SNES_BUTTON_MAP = {
  up: 0x0001,
  down: 0x0002,
  left: 0x0004,
  right: 0x0008,
  a: 0x0080,
  b: 0x0100,
  x: 0x0040,
  y: 0x0200,
  l: 0x0020,
  r: 0x0010,
  start: 0x1000,
  select: 0x2000
};

export class SNESEmulator extends EventEmitter {
  private romPath: string;
  private running: boolean = false;
  private paused: boolean = false;
  private frameInterval?: NodeJS.Timeout;
  private audioSampleRate: number;
  private videoScale: number;

  // Controller states for port 1 and 2
  private controllerStates: Map<number, ControllerState> = new Map();

  // Emulator state (placeholder for actual emulator instance)
  private emulatorCore: any = null;
  private romData: Uint8Array | null = null;

  constructor(config: EmulatorConfig) {
    super();
    this.romPath = config.romPath;
    this.audioSampleRate = config.audioSampleRate || 32000;
    this.videoScale = config.videoScale || 1;

    // Initialize default controller states
    this.controllerStates.set(1, this.getEmptyControllerState());
    this.controllerStates.set(2, this.getEmptyControllerState());
  }

  async initialize(): Promise<void> {
    try {
      // Load ROM file
      this.romData = await fs.readFile(this.romPath);
      console.log(`Loaded ROM: ${path.basename(this.romPath)} (${this.romData.length} bytes)`);

      // TODO: Initialize actual emulator core here
      // For now, we'll use a mock implementation that generates test patterns

      this.emulatorCore = {
        loaded: true,
        frame: 0
      };

      console.log('SNES Emulator initialized (MOCK MODE)');
      console.log('⚠️  To use real emulation, implement one of:');
      console.log('   1. Native snes9x binary integration');
      console.log('   2. WebAssembly core with proper VM context');
      console.log('   3. Headless browser approach');

    } catch (error) {
      throw new Error(`Failed to initialize emulator: ${error}`);
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Emulator already running');
    }

    if (!this.emulatorCore) {
      await this.initialize();
    }

    this.running = true;
    this.paused = false;

    // Start emulation loop at 60 FPS
    const frameTime = 1000 / 60.0;

    this.frameInterval = setInterval(() => {
      if (!this.paused) {
        this.runFrame();
      }
    }, frameTime);

    this.emit('started');
    console.log('Emulator started at 60 FPS');
  }

  private runFrame(): void {
    if (!this.emulatorCore) return;

    // Encode controller inputs
    const input1 = this.encodeControllerState(1);
    const input2 = this.encodeControllerState(2);

    // TODO: Pass inputs to actual emulator
    // emulatorCore.setInput(1, input1);
    // emulatorCore.setInput(2, input2);

    // TODO: Run emulator for one frame
    // const result = emulatorCore.runFrame();

    // For now, generate mock video and audio data
    this.emulatorCore.frame++;

    const videoFrame = this.generateMockVideoFrame();
    const audioSamples = this.generateMockAudioSamples();

    // Emit to listeners
    this.emit('video', videoFrame);
    this.emit('audio', audioSamples);
  }

  private generateMockVideoFrame(): VideoFrame {
    // SNES native resolution
    const width = 256;
    const height = 224;

    // Create a test pattern (color bars)
    const data = new Uint8Array(width * height * 4);
    const frame = this.emulatorCore.frame;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;

        // Animated color bars
        const barWidth = width / 8;
        const bar = Math.floor(x / barWidth);
        const colors = [
          [255, 255, 255], // White
          [255, 255, 0],   // Yellow
          [0, 255, 255],   // Cyan
          [0, 255, 0],     // Green
          [255, 0, 255],   // Magenta
          [255, 0, 0],     // Red
          [0, 0, 255],     // Blue
          [0, 0, 0]        // Black
        ];

        const color = colors[bar] || [128, 128, 128];
        const brightness = 0.8 + 0.2 * Math.sin(frame / 30 + bar);

        data[i] = color[0] * brightness;     // R
        data[i + 1] = color[1] * brightness; // G
        data[i + 2] = color[2] * brightness; // B
        data[i + 3] = 255;                   // A
      }
    }

    return { width, height, data };
  }

  private generateMockAudioSamples(): AudioSamples {
    // Generate ~735 samples per frame at 44.1kHz
    // Or ~533 samples at 32kHz
    const samplesPerFrame = Math.floor(this.audioSampleRate / 60);
    const data = new Float32Array(samplesPerFrame * 2); // Stereo

    // Generate a simple tone (440 Hz A note) for testing
    const frequency = 440;
    const frame = this.emulatorCore.frame;

    for (let i = 0; i < samplesPerFrame; i++) {
      const t = (frame * samplesPerFrame + i) / this.audioSampleRate;
      const sample = Math.sin(2 * Math.PI * frequency * t) * 0.1; // Low volume

      data[i * 2] = sample;     // Left
      data[i * 2 + 1] = sample; // Right
    }

    return {
      sampleRate: this.audioSampleRate,
      channels: 2,
      data
    };
  }

  setInput(port: number, state: ControllerState): void {
    if (port < 1 || port > 2) {
      throw new Error('Invalid port number (must be 1 or 2)');
    }

    this.controllerStates.set(port, { ...state });
  }

  private encodeControllerState(port: number): number {
    const state = this.controllerStates.get(port);
    if (!state) return 0;

    let encoded = 0;

    for (const [button, value] of Object.entries(state)) {
      if (value && button in SNES_BUTTON_MAP) {
        encoded |= SNES_BUTTON_MAP[button as keyof typeof SNES_BUTTON_MAP];
      }
    }

    return encoded;
  }

  pause(): void {
    this.paused = true;
    this.emit('paused');
  }

  resume(): void {
    this.paused = false;
    this.emit('resumed');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = undefined;
    }

    // TODO: Cleanup emulator core

    this.emit('stopped');
    console.log('Emulator stopped');
  }

  async saveState(): Promise<Uint8Array> {
    if (!this.running) {
      throw new Error('Cannot save state: emulator not running');
    }

    // TODO: Get save state from actual emulator
    // return emulatorCore.saveState();

    // Mock save state
    return new Uint8Array([0x53, 0x4E, 0x45, 0x53]); // "SNES" magic bytes
  }

  async loadState(stateData: Uint8Array): Promise<void> {
    if (!this.running) {
      throw new Error('Cannot load state: emulator not running');
    }

    // TODO: Load save state into actual emulator
    // emulatorCore.loadState(stateData);

    console.log(`Loaded save state (${stateData.length} bytes)`);
    this.emit('stateLoaded');
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused;
  }

  private getEmptyControllerState(): ControllerState {
    return {
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
  }
}
