import { EventEmitter } from 'events';
import { GameInput, VideoFrame, AudioFrame } from '../types/index.js';
import { prisma } from '../db/prisma.js';
import { SNESEmulator, ControllerState } from './snes-emulator.js';

interface EmulatorInstance {
  roomId: string;
  gameId: string;
  romPath: string;
  emulator: SNESEmulator;
  lastInputs: Map<number, GameInput>;
  frameCount: number;
  lastFrameTime: number;
  inputTimestamp?: number; // Track input timing for latency measurement
}

export class EmulatorManager extends EventEmitter {
  private instances = new Map<string, EmulatorInstance>();

  async startEmulator(roomId: string, gameId: string) {
    if (this.instances.has(roomId)) {
      throw new Error('Emulator already running for this room');
    }

    // Get game ROM path
    const game = await prisma.game.findUnique({
      where: { id: gameId }
    });

    if (!game) {
      throw new Error('Game not found');
    }

    // Create SNES emulator instance
    const emulator = new SNESEmulator({
      romPath: game.romPath,
      audioSampleRate: 32000
    });

    await emulator.initialize();

    const instance: EmulatorInstance = {
      roomId,
      gameId,
      romPath: game.romPath,
      emulator,
      lastInputs: new Map(),
      frameCount: 0,
      lastFrameTime: Date.now()
    };

    this.instances.set(roomId, instance);

    // Set up event handlers - use arrow functions to avoid re-binding
    // Socket.IO handles binary data efficiently, no need to slice/copy buffers
    const videoHandler = (videoFrame: any) => {
      this.emit(`frame:${roomId}`, {
        width: videoFrame.width,
        height: videoFrame.height,
        data: videoFrame.data, // Pass TypedArray directly
        inputTimestamp: instance.inputTimestamp // Pass through for latency measurement
      });

      // Clear timestamp after using it
      instance.inputTimestamp = undefined;
    };

    const audioHandler = (audioSamples: any) => {
      this.emit(`audio:${roomId}`, {
        sampleRate: audioSamples.sampleRate,
        channels: audioSamples.channels,
        data: audioSamples.data // Pass TypedArray directly
      });
    };

    emulator.on('video', videoHandler);
    emulator.on('audio', audioHandler);

    // Start emulation
    await emulator.start();
    console.log(`Emulator started for room ${roomId}`);
  }

  private convertGameInputToControllerState(input: GameInput): ControllerState {
    return {
      up: input.buttons.up,
      down: input.buttons.down,
      left: input.buttons.left,
      right: input.buttons.right,
      a: input.buttons.a,
      b: input.buttons.b,
      x: input.buttons.x,
      y: input.buttons.y,
      l: input.buttons.l,
      r: input.buttons.r,
      start: input.buttons.start,
      select: input.buttons.select
    };
  }

  handleInput(roomId: string, input: GameInput) {
    const instance = this.instances.get(roomId);
    if (!instance) return;

    instance.lastInputs.set(input.port, input);

    // Send input to emulator immediately (no queuing for lower latency)
    const controllerState = this.convertGameInputToControllerState(input);
    instance.emulator.setInput(input.port, controllerState);
  }

  setInputTimestamp(roomId: string, timestamp: number) {
    const instance = this.instances.get(roomId);
    if (instance) {
      instance.inputTimestamp = timestamp;
    }
  }

  pauseEmulator(roomId: string) {
    const instance = this.instances.get(roomId);
    if (instance) {
      instance.emulator.pause();
    }
  }

  resumeEmulator(roomId: string) {
    const instance = this.instances.get(roomId);
    if (instance) {
      instance.emulator.resume();
    }
  }

  setEmulatorSpeed(roomId: string, speed: number) {
    const instance = this.instances.get(roomId);
    if (instance) {
      instance.emulator.setSpeed(speed);
      console.log(`Emulator speed set to ${speed}x for room ${roomId}`);
    }
  }

  getEmulatorSpeed(roomId: string): number | null {
    const instance = this.instances.get(roomId);
    return instance ? instance.emulator.getSpeed() : null;
  }

  setEmulatorTargetFPS(roomId: string, targetFPS: number) {
    const instance = this.instances.get(roomId);
    if (instance) {
      instance.emulator.setTargetFPS(targetFPS);
      console.log(`Emulator target FPS set to ${targetFPS === 0 ? 'auto' : targetFPS} for room ${roomId}`);
    }
  }

  getEmulatorTargetFPS(roomId: string): number | null {
    const instance = this.instances.get(roomId);
    return instance ? instance.emulator.getTargetFPS() : null;
  }

  async stopEmulator(roomId: string) {
    const instance = this.instances.get(roomId);
    if (!instance) return;

    await instance.emulator.stop();
    this.instances.delete(roomId);
  }

  async saveState(
    roomId: string,
    gameId: string,
    userId: string,
    slotNumber: number,
    name: string
  ) {
    const instance = this.instances.get(roomId);
    if (!instance) {
      throw new Error('Emulator not running');
    }

    // Get save state data from emulator
    const saveStateData = await instance.emulator.saveState();
    const saveData = Buffer.from(saveStateData);

    // Save to database
    await prisma.save.upsert({
      where: {
        gameId_slotNumber: {
          gameId,
          slotNumber
        }
      },
      update: {
        name,
        data: saveData,
        updatedAt: new Date()
      },
      create: {
        gameId,
        name,
        slotNumber,
        data: saveData
      }
    });
  }

  async loadState(roomId: string, saveId: string) {
    const instance = this.instances.get(roomId);
    if (!instance) {
      throw new Error('Emulator not running');
    }

    const save = await prisma.save.findUnique({
      where: { id: saveId }
    });

    if (!save) {
      throw new Error('Save state not found');
    }

    // Load save state into emulator
    const saveStateData = new Uint8Array(save.data);
    await instance.emulator.loadState(saveStateData);
    console.log('Loaded save state:', saveId);
  }
}
