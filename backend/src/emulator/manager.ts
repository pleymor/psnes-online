import { EventEmitter } from 'events';
import { GameInput, VideoFrame, AudioFrame } from '../types/index.js';
import { PrismaClient } from '@prisma/client';
import { SNESEmulator, ControllerState } from './snes-emulator.js';

const prisma = new PrismaClient();

interface EmulatorInstance {
  roomId: string;
  gameId: string;
  romPath: string;
  emulator: SNESEmulator;
  lastInputs: Map<number, GameInput>;
  frameCount: number;
  lastFrameTime: number;
  audioBuffer: Float32Array[];
  audioFrameCount: number;
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
      lastFrameTime: Date.now(),
      audioBuffer: [],
      audioFrameCount: 0
    };

    this.instances.set(roomId, instance);

    // Set up event handlers - use arrow functions to avoid re-binding
    const videoHandler = (videoFrame: any) => {
      const handlerStart = performance.now();
      instance.frameCount++;

      // Send every frame for smooth playback
      // Socket.IO can handle Uint8Array directly
      const frame: VideoFrame = {
        width: videoFrame.width,
        height: videoFrame.height,
        data: videoFrame.data.buffer.slice(
          videoFrame.data.byteOffset,
          videoFrame.data.byteOffset + videoFrame.data.byteLength
        )
      };

      const prepTime = performance.now() - handlerStart;
      if (prepTime > 5) {
        console.log(`⚠️  VIDEO HANDLER: Frame prep took ${prepTime.toFixed(2)}ms`);
      }

      // Use setImmediate to avoid blocking the event loop
      setImmediate(() => {
        const emitStart = performance.now();
        this.emit(`frame:${roomId}`, frame);
        const emitTime = performance.now() - emitStart;
        if (emitTime > 5) {
          console.log(`⚠️  VIDEO EMIT: Took ${emitTime.toFixed(2)}ms`);
        }
      });
    };

    const audioHandler = (audioSamples: any) => {
      // Send audio immediately for every frame
      const audio: AudioFrame = {
        sampleRate: audioSamples.sampleRate,
        channels: audioSamples.channels,
        data: audioSamples.data.buffer.slice(
          audioSamples.data.byteOffset,
          audioSamples.data.byteOffset + audioSamples.data.byteLength
        )
      };

      this.emit(`audio:${roomId}`, audio);
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

    // Send input to emulator
    const controllerState = this.convertGameInputToControllerState(input);
    instance.emulator.setInput(input.port, controllerState);
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
