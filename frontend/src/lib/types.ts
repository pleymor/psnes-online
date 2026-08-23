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

export interface RoomPlayer {
  userId: string;
  displayName: string;
  avatar?: string;
  port: 1 | 2 | null;
  isReady: boolean;
  keyConfig: KeyConfig;
}

// Emulation Mode types
export enum EmulationMode {
  SINGLE = 'single',          // Single player, simple local emulation
  STREAMING = 'streaming',    // Host emulates, guest receives stream
  DUAL = 'dual',              // Both emulate locally with input sync
  LOCKSTEP = 'lockstep'       // ZSNES-style: deterministic core, no frame runs
                              // until every player's pad for it has arrived
}

/**
 * Re-declared rather than imported from the store that owns it, so the Room
 * shape stays readable on its own. The two must agree; there is one test that
 * checks the store's own values.
 */
export type LatencyMode = 'auto' | 'low';

export interface Room {
  id: string;
  /**
   * Absent until a game is chosen: a room is a place where players meet, and
   * the game can be picked once they are both there. Optional here so every
   * reader has to say what it shows in the meantime - the compiler names the
   * sites that forgot.
   */
  gameId?: string;
  gameTitle?: string;
  gameCoverUrl?: string;
  /** CRC32 of the room's ROM, which each player resolves against their own files. */
  gameCrc32?: string;
  hostId: string;
  createdBy: string; // Original creator of the room
  players: RoomPlayer[];
  status: 'waiting' | 'playing';
  emulationMode: EmulationMode;
  /**
   * How this room trades input latency against the other player's smoothness.
   * Belongs to the game, not the link: turn-taking games do not care about a
   * frame dropped on the partner's screen, simultaneous ones care about little
   * else. Unlike the emulation mode it may change mid-game.
   */
  latencyMode: LatencyMode;
  /**
   * An ISO string, not a Date: this arrives over Socket.IO, which serialises
   * dates and never revives them. It was typed `Date` here and no caller had
   * yet trusted that enough to call a method on it; parse with `new Date(...)`
   * before doing anything with it.
   */
  createdAt: string;
}

export interface InputState {
  // SNES controller state
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  l: boolean;
  r: boolean;
  start: boolean;
  select: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}
