import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import { createRequire } from 'module';

// @ts-ignore - snes9x-next and adm-zip don't have ES module exports
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const snes9xCore = require('snes9x-next');

/**
 * SNES Emulator Wrapper using snes9x-next (libretro core compiled to WASM)
 *
 * This implementation uses the snes9x-next npm package, which is a
 * libretro emulator core compiled into JavaScript/WebAssembly.
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

export class SNESEmulator extends EventEmitter {
  private romPath: string;
  private running: boolean = false;
  private paused: boolean = false;
  private frameInterval?: NodeJS.Timeout;
  private audioSampleRate: number;
  private videoScale: number;

  // Controller states for port 1 and 2
  private controllerStates: Map<number, ControllerState> = new Map();

  // Emulator state (libretro core instance)
  private emulatorCore: any = null;
  private romData: Uint8Array | null = null;

  // Video and audio buffers
  private currentVideoFrame: VideoFrame | null = null;
  private audioBuffer: Float32Array[] = [];

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
      let rawData = await fs.readFile(this.romPath);
      console.log(`Loaded file: ${path.basename(this.romPath)} (${rawData.length} bytes)`);

      // Check if it's a ZIP file and extract if needed
      const ext = path.extname(this.romPath).toLowerCase();
      if (ext === '.zip') {
        console.log('Extracting ROM from ZIP archive...');
        const zip = new AdmZip(rawData);
        const zipEntries = zip.getEntries();

        // Find first ROM file in ZIP
        const romEntry = zipEntries.find(entry => {
          const entryExt = path.extname(entry.entryName).toLowerCase();
          return ['.smc', '.sfc', '.fig', '.swc', '.mgd'].includes(entryExt);
        });

        if (!romEntry) {
          throw new Error('No ROM file found in ZIP archive');
        }

        const extractedData = zip.readFile(romEntry);
        if (!extractedData) {
          throw new Error('Failed to extract ROM from ZIP');
        }
        this.romData = extractedData;
        console.log(`Extracted ROM: ${romEntry.entryName} (${this.romData.length} bytes)`);
      } else {
        this.romData = rawData;
        console.log(`Using ROM file directly (${this.romData.length} bytes)`);
      }

      // Use the libretro core directly
      this.emulatorCore = snes9xCore;

      // Set up ALL callbacks BEFORE calling init()

      // Set up environment callback
      try {
        const environmentCallback = (cmd: number, data: any) => {
          // Command 10: SET_PIXEL_FORMAT
          if (cmd === 10) {
            return true;
          }

          // Command 27: GET_LOG_INTERFACE - provide a logging function
          if (cmd === 27) {
            return (level: number, ...args: any[]) => {
              const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
              const levelName = levelNames[level] || 'LOG';
              if (level >= 2) { // Only log warnings and errors
                console.log(`[SNES9x ${levelName}]`, ...args);
              }
            };
          }

          return false;
        };

        this.emulatorCore.set_environment(environmentCallback);
      } catch (e) {
        console.error('Error setting environment callback:', e);
        throw e;
      }

      // Set up video callback BEFORE init
      try {
        this.emulatorCore.set_video_refresh((data: Uint16Array, width: number, height: number, pitch: number) => {
          if (!data || data.length === 0) {
            console.log('Video callback received null or empty data');
            return;
          }

          // data is Uint16Array in RGB565 format
          // Convert to RGBA for the frontend
          const pixelCount = width * height;
          const rgbaData = new Uint8Array(pixelCount * 4);

          for (let i = 0; i < pixelCount; i++) {
            const pixel = data[i];

            // RGB565 format: RRRR RGGG GGGB BBBB
            const r = ((pixel >> 11) & 0x1F) << 3; // 5 bits red
            const g = ((pixel >> 5) & 0x3F) << 2;   // 6 bits green
            const b = (pixel & 0x1F) << 3;          // 5 bits blue

            rgbaData[i * 4 + 0] = r | (r >> 5);     // Red with bit replication
            rgbaData[i * 4 + 1] = g | (g >> 6);     // Green with bit replication
            rgbaData[i * 4 + 2] = b | (b >> 5);     // Blue with bit replication
            rgbaData[i * 4 + 3] = 255;              // Alpha
          }

          this.currentVideoFrame = {
            width: width,
            height: height,
            data: rgbaData
          };
        });
      } catch (e) {
        console.error('Error setting video callback:', e);
        throw e;
      }

      // Set up audio callbacks BEFORE init
      try {
        this.emulatorCore.set_audio_sample((left: number, right: number) => {
          // Single sample - convert to normalized float
          this.audioBuffer.push(new Float32Array([left / 32768.0, right / 32768.0]));
        });
      } catch (e) {
        console.error('Error setting audio sample callback:', e);
        throw e;
      }

      try {
        this.emulatorCore.set_audio_sample_batch((left: Float32Array, right: Float32Array, frames: number) => {
          if (!left || !right || frames <= 0) return;

          // Interleave left and right channels
          const interleavedSamples = new Float32Array(frames * 2);
          for (let i = 0; i < frames; i++) {
            interleavedSamples[i * 2] = left[i];
            interleavedSamples[i * 2 + 1] = right[i];
          }

          this.audioBuffer.push(interleavedSamples);
        });
      } catch (e) {
        console.error('Error setting audio batch callback:', e);
        throw e;
      }

      // Set up input callbacks BEFORE init
      try {
        this.emulatorCore.set_input_poll(() => {
          // Poll input
        });
      } catch (e) {
        console.error('Error setting input poll callback:', e);
        throw e;
      }

      try {
        this.emulatorCore.set_input_state((port: number, _device: number, _index: number, id: number) => {
          const state = this.controllerStates.get(port + 1);
          if (!state) return 0;
          return this.getButtonState(state, id) ? 1 : 0;
        });
      } catch (e) {
        console.error('Error setting input state callback:', e);
        throw e;
      }

      // NOW initialize the core (after all callbacks are set)
      try {
        this.emulatorCore.init();
      } catch (e) {
        console.error('Error initializing core:', e);
        throw e;
      }

      // Load the ROM
      try {
        const loaded = this.emulatorCore.load_game(this.romData);
        if (!loaded) {
          throw new Error('Failed to load ROM into emulator core');
        }
      } catch (e) {
        console.error('Error loading ROM:', e);
        throw e;
      }

      console.log('✅ SNES Emulator initialized with real snes9x-next core');

    } catch (error) {
      throw new Error(`Failed to initialize emulator: ${error}`);
    }
  }

  private getButtonState(state: ControllerState, buttonId: number): boolean {
    // Map libretro button IDs to our controller state
    const buttonMap: { [key: number]: keyof ControllerState } = {
      0: 'b',      // RETRO_DEVICE_ID_JOYPAD_B
      1: 'y',      // RETRO_DEVICE_ID_JOYPAD_Y
      2: 'select', // RETRO_DEVICE_ID_JOYPAD_SELECT
      3: 'start',  // RETRO_DEVICE_ID_JOYPAD_START
      4: 'up',     // RETRO_DEVICE_ID_JOYPAD_UP
      5: 'down',   // RETRO_DEVICE_ID_JOYPAD_DOWN
      6: 'left',   // RETRO_DEVICE_ID_JOYPAD_LEFT
      7: 'right',  // RETRO_DEVICE_ID_JOYPAD_RIGHT
      8: 'a',      // RETRO_DEVICE_ID_JOYPAD_A
      9: 'x',      // RETRO_DEVICE_ID_JOYPAD_X
      10: 'l',     // RETRO_DEVICE_ID_JOYPAD_L
      11: 'r'      // RETRO_DEVICE_ID_JOYPAD_R
    };

    const button = buttonMap[buttonId];
    return button ? state[button] : false;
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

    // Clear buffers
    this.currentVideoFrame = null;
    this.audioBuffer = [];

    // Run one frame of emulation
    // This will trigger the video_refresh and audio callbacks
    this.emulatorCore.run();

    // Emit video frame if we got one
    if (this.currentVideoFrame) {
      this.emit('video', this.currentVideoFrame);
    }

    // Emit audio samples if we got any
    if (this.audioBuffer.length > 0) {
      // Combine all audio buffers
      const totalSamples = this.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
      const combinedAudio = new Float32Array(totalSamples);
      let offset = 0;
      for (const buf of this.audioBuffer) {
        combinedAudio.set(buf, offset);
        offset += buf.length;
      }

      const audioSamples: AudioSamples = {
        sampleRate: this.audioSampleRate,
        channels: 2,
        data: combinedAudio
      };

      this.emit('audio', audioSamples);
    }
  }

  setInput(port: number, state: ControllerState): void {
    if (port < 1 || port > 2) {
      throw new Error('Invalid port number (must be 1 or 2)');
    }

    this.controllerStates.set(port, { ...state });
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

    // Cleanup emulator core
    if (this.emulatorCore) {
      try {
        this.emulatorCore.unload_game();
        this.emulatorCore.deinit();
      } catch (error) {
        console.error('Error cleaning up emulator core:', error);
      }
    }

    this.emit('stopped');
    console.log('Emulator stopped');
  }

  async saveState(): Promise<Uint8Array> {
    if (!this.running) {
      throw new Error('Cannot save state: emulator not running');
    }

    try {
      // Serialize the current state
      const stateData = this.emulatorCore.serialize();

      console.log(`Saved state (${stateData.length} bytes)`);
      return new Uint8Array(stateData);
    } catch (error) {
      throw new Error(`Failed to save state: ${error}`);
    }
  }

  async loadState(stateData: Uint8Array): Promise<void> {
    if (!this.running) {
      throw new Error('Cannot load state: emulator not running');
    }

    try {
      // Load the save state
      const result = this.emulatorCore.unserialize(stateData);

      if (!result) {
        throw new Error('Failed to load state data');
      }

      console.log(`Loaded save state (${stateData.length} bytes)`);
      this.emit('stateLoaded');
    } catch (error) {
      throw new Error(`Failed to load state: ${error}`);
    }
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
