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
  speed?: number; // Speed multiplier (1.0 = normal, 2.0 = 2x speed, 0 = unlimited)
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
  // SNES NTSC runs at ~60.0988 Hz (21477272.727272 / 357366)
  private static readonly SNES_NTSC_FPS = 60.0988138974;
  // SNES PAL runs at ~50.0070 Hz (21281370 / 425568)
  private static readonly SNES_PAL_FPS = 50.0069789082;

  private romPath: string;
  private running: boolean = false;
  private paused: boolean = false;
  private frameInterval?: NodeJS.Timeout;
  private audioSampleRate: number;
  private videoScale: number;
  private speed: number;
  private unlimitedSpeedActive: boolean = false;
  private refreshRate: number = SNESEmulator.SNES_NTSC_FPS; // Detected from ROM

  // Precise timing for frame pacing
  private nextFrameTime: number = 0;
  private frameTimeout?: NodeJS.Timeout;

  // FPS measurement
  private fpsStartTime: number = 0;
  private fpsFrameCount: number = 0;

  // Controller states for port 1 and 2
  private controllerStates: Map<number, ControllerState> = new Map();

  // Emulator state (libretro core instance)
  private emulatorCore: any = null;
  private romData: Uint8Array | null = null;

  // Video and audio buffers
  private currentVideoFrame: VideoFrame | null = null;
  private videoFrameBuffer: Uint8Array = new Uint8Array(512 * 448 * 4); // Pre-allocated for max SNES resolution
  private audioSamples: Float32Array = new Float32Array(2048); // Pre-allocated buffer
  private audioSampleCount: number = 0;

  constructor(config: EmulatorConfig) {
    super();
    this.romPath = config.romPath;
    this.audioSampleRate = config.audioSampleRate || 48000;
    this.videoScale = config.videoScale || 1;
    this.speed = config.speed !== undefined ? config.speed : 1.0;

    // Initialize default controller states
    this.controllerStates.set(1, this.getEmptyControllerState());
    this.controllerStates.set(2, this.getEmptyControllerState());
  }

  private detectROMRegion(romData: Uint8Array): 'NTSC' | 'PAL' {
    // Skip 512-byte copier header if present
    const hasHeader = (romData.length % 1024) === 512;
    const offset = hasHeader ? 512 : 0;

    console.log(`ROM size: ${romData.length} bytes, has header: ${hasHeader}, offset: ${offset}`);

    // Try to read region code from ROM header
    // LoROM: header at 0x7FC0, HiROM: header at 0xFFC0
    const loromRegionOffset = offset + 0x7FD9;
    const hiromRegionOffset = offset + 0xFFD9;

    // Determine if ROM is LoROM or HiROM by checking checksum complement
    let isHiROM = false;

    if (offset + 0x7FDC + 1 < romData.length && offset + 0x7FDE + 1 < romData.length) {
      const loromChecksum = (romData[offset + 0x7FDF] << 8) | romData[offset + 0x7FDE];
      const loromComplement = (romData[offset + 0x7FDD] << 8) | romData[offset + 0x7FDC];
      const loromValid = (loromChecksum ^ loromComplement) === 0xFFFF;

      const hiromChecksum = (romData[offset + 0xFFDF] << 8) | romData[offset + 0xFFDE];
      const hiromComplement = (romData[offset + 0xFFDD] << 8) | romData[offset + 0xFFDC];
      const hiromValid = (hiromChecksum ^ hiromComplement) === 0xFFFF;

      isHiROM = hiromValid && !loromValid;
      console.log(`Checksum validation - LoROM valid: ${loromValid}, HiROM valid: ${hiromValid}`);
    }

    let regionCode = 0;
    let usedOffset = 'none';

    // Read from the correct offset based on ROM type
    const regionOffset = isHiROM ? hiromRegionOffset : loromRegionOffset;

    if (regionOffset < romData.length) {
      regionCode = romData[regionOffset];
      usedOffset = `${isHiROM ? 'HiROM' : 'LoROM'} (0x${regionOffset.toString(16)})`;
    }

    console.log(`Region code: 0x${regionCode.toString(16).padStart(2, '0')} from ${usedOffset}`);

    // Map region codes to NTSC/PAL
    // 0x00 = Japan (NTSC), 0x01 = USA (NTSC), 0x0D = Korea (NTSC)
    // 0x02-0x0C = Europe and other PAL regions, 0x11 = Australia (PAL)
    const palRegions = [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x11];
    const isPAL = palRegions.includes(regionCode);

    console.log(`PAL regions check: ${regionCode} in [${palRegions.join(', ')}] = ${isPAL}`);

    return isPAL ? 'PAL' : 'NTSC';
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
        const romEntry = zipEntries.find((entry: any) => {
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
        this.romData = new Uint8Array(extractedData);
        console.log(`Extracted ROM: ${romEntry.entryName} (${this.romData.length} bytes)`);
      } else {
        this.romData = rawData;
        console.log(`Using ROM file directly (${this.romData.length} bytes)`);
      }

      // Detect ROM region and set appropriate refresh rate
      if (!this.romData) {
        throw new Error('ROM data is not loaded');
      }
      const region = this.detectROMRegion(this.romData);
      this.refreshRate = region === 'PAL' ? SNESEmulator.SNES_PAL_FPS : SNESEmulator.SNES_NTSC_FPS;
      const videoSpec = region === 'PAL' ? '576i/50Hz (625 lines)' : '480i/60Hz (525 lines)';
      console.log(`✓ ROM Region: ${region} - ${videoSpec} - Actual refresh: ${this.refreshRate.toFixed(4)} Hz`)

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
          // pitch is the number of pixels per line in the source buffer (may include padding)
          // width is the actual display width
          const pixelCount = width * height;

          // Ensure our buffer is large enough (shouldn't need to grow for standard SNES resolutions)
          if (pixelCount * 4 > this.videoFrameBuffer.length) {
            this.videoFrameBuffer = new Uint8Array(pixelCount * 4);
          }

          // Use pitch to correctly read each scanline
          const pitchInPixels = pitch / 2; // pitch is in bytes, convert to pixels (16-bit)

          // Convert RGB565 to RGBA directly into pre-allocated buffer
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const srcIndex = y * pitchInPixels + x;
              const dstIndex = (y * width + x) * 4;
              const pixel = data[srcIndex];

              // RGB565 format: RRRR RGGG GGGB BBBB
              const r = ((pixel >> 11) & 0x1F) << 3; // 5 bits red
              const g = ((pixel >> 5) & 0x3F) << 2;   // 6 bits green
              const b = (pixel & 0x1F) << 3;          // 5 bits blue

              this.videoFrameBuffer[dstIndex + 0] = r | (r >> 5);     // Red with bit replication
              this.videoFrameBuffer[dstIndex + 1] = g | (g >> 6);     // Green with bit replication
              this.videoFrameBuffer[dstIndex + 2] = b | (b >> 5);     // Blue with bit replication
              this.videoFrameBuffer[dstIndex + 3] = 255;              // Alpha
            }
          }

          // Reuse the buffer view instead of copying
          // The subarray creates a view, not a copy - much more efficient
          this.currentVideoFrame = {
            width: width,
            height: height,
            data: this.videoFrameBuffer.subarray(0, pixelCount * 4)
          };
        });
      } catch (e) {
        console.error('Error setting video callback:', e);
        throw e;
      }

      // Set up audio callbacks BEFORE init
      try {
        this.emulatorCore.set_audio_sample((left: number, right: number) => {
          // Grow buffer if needed
          if (this.audioSampleCount + 2 > this.audioSamples.length) {
            const newBuffer = new Float32Array(this.audioSamples.length * 2);
            newBuffer.set(this.audioSamples);
            this.audioSamples = newBuffer;
          }

          // Add sample to buffer
          // Note: set_audio_sample receives raw int16 values, needs normalization
          this.audioSamples[this.audioSampleCount++] = left / 32768.0;
          this.audioSamples[this.audioSampleCount++] = right / 32768.0;
        });
      } catch (e) {
        console.error('Error setting audio sample callback:', e);
        throw e;
      }

      try {
        this.emulatorCore.set_audio_sample_batch((left: Float32Array, right: Float32Array, frames: number) => {
          if (!left || !right || frames <= 0) return;

          const samplesNeeded = frames * 2;

          // Grow buffer if needed
          if (this.audioSampleCount + samplesNeeded > this.audioSamples.length) {
            let newSize = this.audioSamples.length * 2;
            while (newSize < this.audioSampleCount + samplesNeeded) {
              newSize *= 2;
            }
            const newBuffer = new Float32Array(newSize);
            newBuffer.set(this.audioSamples);
            this.audioSamples = newBuffer;
          }

          // Interleave left and right channels directly into buffer
          // Note: set_audio_sample_batch receives already normalized floats from retro.js
          for (let i = 0; i < frames; i++) {
            this.audioSamples[this.audioSampleCount++] = left[i];
            this.audioSamples[this.audioSampleCount++] = right[i];
          }
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
    this.nextFrameTime = performance.now();

    // Start emulation loop
    if (this.speed === 0) {
      // Unlimited speed - run as fast as possible
      this.unlimitedSpeedActive = true;
      const runUnlimited = () => {
        if (!this.running || !this.unlimitedSpeedActive) return;
        if (!this.paused) {
          this.runFrame();
        }
        setImmediate(runUnlimited);
      };
      setImmediate(runUnlimited);
      console.log('Emulator started at UNLIMITED speed');
    } else {
      // Fixed speed with drift compensation
      this.unlimitedSpeedActive = false;
      this.scheduleNextFrame();
      console.log(`Emulator started at ${this.speed}x speed (${(this.refreshRate * this.speed).toFixed(2)} FPS)`);
    }

    this.emit('started');
  }

  private scheduleNextFrame(): void {
    if (!this.running || this.unlimitedSpeedActive || this.paused) return;

    const frameTime = (1000 / this.refreshRate) / this.speed; // milliseconds per frame
    const now = performance.now();

    // Calculate when next frame should run
    this.nextFrameTime += frameTime;

    // If we're too far behind, reset to current time
    if (this.nextFrameTime < now - 100) {
      console.log(`⚠️  SCHEDULER: Resetting timing (${(now - this.nextFrameTime).toFixed(2)}ms behind)`);
      this.nextFrameTime = now;
    }

    // Calculate delay until next frame
    const delay = Math.max(0, this.nextFrameTime - now);

    // Use setImmediate for 0 delay to avoid setTimeout overhead
    if (delay < 1) {
      setImmediate(() => {
        if (!this.paused && this.running) {
          this.runFrame();
        }
        this.scheduleNextFrame();
      });
    } else {
      this.frameTimeout = setTimeout(() => {
        if (!this.paused && this.running) {
          this.runFrame();
        }
        this.scheduleNextFrame();
      }, delay);
    }
  }

  private runFrame(): void {
    if (!this.emulatorCore) return;

    // Clear buffers
    this.currentVideoFrame = null;
    this.audioSampleCount = 0;

    // Run one frame of emulation
    this.emulatorCore.run();

    // Emit video frame if we got one
    if (this.currentVideoFrame) {
      this.emit('video', this.currentVideoFrame);
    }

    // Emit audio samples if we got any
    if (this.audioSampleCount > 0) {
      // Use subarray view instead of copying - more efficient
      this.emit('audio', {
        sampleRate: this.audioSampleRate,
        channels: 2,
        data: this.audioSamples.subarray(0, this.audioSampleCount)
      });
    }
  }

  setInput(port: number, state: ControllerState): void {
    if (port < 1 || port > 2) {
      throw new Error('Invalid port number (must be 1 or 2)');
    }

    this.controllerStates.set(port, { ...state });
  }

  pause(): void {
    if (this.paused) return;

    this.paused = true;

    // Clear frame timeout to stop scheduling
    if (this.frameTimeout) {
      clearTimeout(this.frameTimeout);
      this.frameTimeout = undefined;
    }

    this.emit('paused');
  }

  resume(): void {
    if (!this.paused) return;

    this.paused = false;

    // Reset timing to avoid frame burst
    this.nextFrameTime = performance.now();

    // Restart scheduling based on speed mode
    if (this.running && this.speed === 0 && !this.unlimitedSpeedActive) {
      this.unlimitedSpeedActive = true;
      const runUnlimited = () => {
        if (!this.running || !this.unlimitedSpeedActive) return;
        if (!this.paused) {
          this.runFrame();
        }
        setImmediate(runUnlimited);
      };
      setImmediate(runUnlimited);
    } else if (this.running && this.speed > 0) {
      this.scheduleNextFrame();
    }

    this.emit('resumed');
  }

  async stop(): Promise<void> {
    // Stop both timing mechanisms
    this.running = false;
    this.unlimitedSpeedActive = false;

    // Clear timeout if using fixed speed
    if (this.frameTimeout) {
      clearTimeout(this.frameTimeout);
      this.frameTimeout = undefined;
    }

    // Clear interval if exists (legacy)
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = undefined;
    }

    // Give unlimited speed loop time to check flags
    await new Promise(resolve => setTimeout(resolve, 10));

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

  setSpeed(speed: number): void {
    if (this.speed === speed) return; // No change needed

    this.speed = speed;

    // Restart timing loop with new speed if running and not paused
    if (this.running && !this.paused) {
      // Stop current timing
      this.unlimitedSpeedActive = false;

      if (this.frameTimeout) {
        clearTimeout(this.frameTimeout);
        this.frameTimeout = undefined;
      }

      if (this.frameInterval) {
        clearInterval(this.frameInterval);
        this.frameInterval = undefined;
      }

      // Reset timing
      this.nextFrameTime = performance.now();

      // Start new timing loop with updated speed
      if (speed === 0) {
        // Unlimited speed - run as fast as possible
        this.unlimitedSpeedActive = true;
        const runUnlimited = () => {
          if (!this.running || !this.unlimitedSpeedActive) return;
          if (!this.paused) {
            this.runFrame();
          }
          setImmediate(runUnlimited);
        };
        setImmediate(runUnlimited);
        console.log('Switched to UNLIMITED speed');
      } else {
        // Fixed speed with drift compensation
        this.scheduleNextFrame();
        console.log(`Switched to ${speed}x speed (${(this.refreshRate * speed).toFixed(2)} FPS)`);
      }
    }
  }

  getSpeed(): number {
    return this.speed;
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
