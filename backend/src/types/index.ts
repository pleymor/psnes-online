import { User as PrismaUser } from '@prisma/client';

export interface User extends PrismaUser {}

export interface Room {
  id: string;
  gameId: string;
  gameTitle: string;
  hostId: string;
  players: RoomPlayer[];
  status: 'waiting' | 'playing' | 'paused';
  createdAt: Date;
}

export interface RoomPlayer {
  userId: string;
  displayName: string;
  avatar?: string;
  port: 1 | 2 | null; // null = spectator
  isReady: boolean;
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
  data: Float32Array;
}

declare module 'express-session' {
  interface SessionData {
    passport?: {
      user?: string;
    };
  }
}
