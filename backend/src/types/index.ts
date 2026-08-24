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
  /**
   * Which way this room trades input latency against the other player's
   * smoothness. A property of the game rather than of the link: where the two
   * players take turns, a frame dropped on the partner's screen costs nobody
   * anything and the lowest delay is simply right; where they fight frame by
   * frame, the automatic loop should decide.
   *
   * Unlike `emulationMode` this one may change mid-game. Changing the input
   * delay while playing is already safe - pads are keyed by absolute frame, so
   * past the priming window the delay is a local matter - and the whole point of
   * the setting is to be reachable from the pause menu.
   */
  latencyMode: LatencyMode;
  /**
   * The save this room will start on, staged from the lobby, or absent to start
   * the game from the beginning.
   *
   * On the room rather than in one browser's URL because both players have to
   * agree on it: in lockstep the two machines must boot from the same state, and
   * the guest has to be able to see what they are about to join. The library's
   * `?save=` still works and means the same thing - it is the creator staging a
   * save before the room screen has drawn once.
   *
   * The name travels alongside so that a guest can be told which save without
   * asking for a list whose rows carry a megabyte of savestate each.
   */
  resumeSaveId?: string;
  resumeSaveName?: string;
  createdAt: Date;
  /**
   * When the last member went away, or absent while somebody is still here.
   *
   * A room no longer dies when it empties, so this is what eventually kills
   * one. Set and cleared in exactly one place - `rooms/presence.ts` - because
   * three call sites trigger the transition and a room whose flag disagrees
   * with its occupants either lives for ever or vanishes under two players.
   */
  abandonedAt?: Date;
}

export type LatencyMode = 'auto' | 'low';

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

/** A list of gamepad codes per SNES button. Empty list = unbound. */
export type PadConfig = Record<keyof KeyConfig, string[]>;

export interface PlayerControls {
  keys: KeyConfig;
  pad: PadConfig;
}

export interface ControlsConfig {
  version: 2;
  p1: PlayerControls;
  p2: PlayerControls;
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
