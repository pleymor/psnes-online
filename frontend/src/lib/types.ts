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
  /**
   * Whether this member has a socket connected right now.
   *
   * Optional because `room:updated` carries the raw server room, where a member
   * restored from an older snapshot has no value for it. Absent means away.
   */
  online?: boolean;
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
