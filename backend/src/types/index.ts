export type { User } from '../db/types.js';

export type EmulationMode = 'single' | 'streaming' | 'dual' | 'lockstep';

export interface Room {
  id: string;
  gameId?: string;
  gameTitle?: string;
  gameCoverUrl?: string;
  /**
   * Which ROM this room is for, as the CRC32 of its contents.
   *
   * The guest does not own the host's game row and the server no longer holds
   * any ROM, so this checksum is the only thing that tells them which file on
   * their own machine to load - and confirms both players hold the same dump.
   */
  gameCrc32?: string;
  hostId: string;
  createdBy: string; // Original creator of the room
  players: RoomPlayer[];
  status: 'waiting' | 'playing' | 'paused';
  emulationMode: EmulationMode;
  createdAt: Date;
}

export interface RoomPlayer {
  userId: string;
  displayName: string;
  avatar?: string;
  port: 1 | 2 | null; // null = spectator
  isReady: boolean;
  emulationReady: boolean; // true when player's emulator is ready to start
  /**
   * Whether this member currently has a socket connected.
   *
   * Optional because rooms read back from a snapshot written before this field
   * existed have no value for it, and absent has to mean away.
   */
  online?: boolean;
  keyConfig: KeyConfig;
}

export interface KeyConfig {
  up: string;
  down: string;
  left: string;
  right: string;
  a: string;
  b: string;
  x: string;
  y: string;
  l: string;
  r: string;
  start: string;
  select: string;
}

export interface GameInput {
  port: 1 | 2;
  buttons: {
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
  };
}

export interface VideoFrame {
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface AudioFrame {
  sampleRate: number;
  channels: number;
  data: ArrayBuffer;
}

declare module 'express-session' {
  interface SessionData {
    passport?: {
      user?: string;
    };
  }
}
