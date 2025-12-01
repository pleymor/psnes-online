/**
 * Rollback Netcode Types
 *
 * Types and interfaces for GGPO-style rollback netcode implementation.
 */

import type { InputState } from '$lib/types';

// ============================================================================
// Configuration
// ============================================================================

export interface NetplayConfig {
  /** Number of frames to delay local input (0-3). Higher = fewer rollbacks but more input lag */
  inputDelayFrames: number;

  /** Maximum number of frames we can rollback (7-15). Higher = more latency tolerance */
  maxRollbackFrames: number;

  /** How often to verify sync via checksum (in frames). 60 = once per second */
  syncCheckInterval: number;

  /** Whether this instance is the host (authoritative for initial state) */
  isHost: boolean;
}

export const DEFAULT_NETPLAY_CONFIG: NetplayConfig = {
  inputDelayFrames: 0,
  maxRollbackFrames: 8,
  syncCheckInterval: 60,
  isHost: false
};

// ============================================================================
// Frame State
// ============================================================================

export interface FrameInput {
  frame: number;
  input: InputState;
  confirmed: boolean; // true if received from network, false if predicted
}

export interface FrameState {
  frame: number;
  state: Blob; // Savestate data
  localInput: InputState;
  remoteInput: InputState;
  remoteConfirmed: boolean;
}

// ============================================================================
// Network Messages
// ============================================================================

export interface InputMessage {
  type: 'input';
  frame: number;
  player: 1 | 2;
  input: number[]; // Encoded InputState (2 bytes as array)
}

export interface InitialStateMessage {
  type: 'initial_state';
  state: number[]; // ArrayBuffer as array for JSON serialization
  frame: 0;
}

export interface InitialStateAckMessage {
  type: 'initial_state_ack';
}

export interface SyncCheckMessage {
  type: 'sync_check';
  frame: number;
  checksum: string;
  timestamp: number; // performance.now() for RTT measurement
  epoch: number; // Resync epoch - incremented on each resync to detect stale checksums
}

export interface SyncResultMessage {
  type: 'sync_result';
  frame: number;
  match: boolean;
  localChecksum?: string;
  remoteChecksum?: string;
}

export interface PeriodicSyncMessage {
  type: 'periodic_sync';
  frame: number;
  state: number[]; // ArrayBuffer as array for JSON serialization
}

export interface ResyncStateMessage {
  type: 'resync_state';
  frame: number;
  state: number[]; // ArrayBuffer as array for JSON serialization
}

export interface ResyncChunkMessage {
  type: 'resync_chunk';
  frame: number;
  chunkIndex: number;
  totalChunks: number;
  data: number[]; // Chunk of state data
}

export interface ResyncCompleteMessage {
  type: 'resync_complete';
  frame: number;
  totalSize: number;
}

export interface ResyncAckMessage {
  type: 'resync_ack';
  frame: number;
  epoch: number; // GUEST's new epoch after resync
}

export type NetplayMessage =
  | InputMessage
  | InitialStateMessage
  | InitialStateAckMessage
  | SyncCheckMessage
  | SyncResultMessage
  | PeriodicSyncMessage
  | ResyncStateMessage
  | ResyncChunkMessage
  | ResyncCompleteMessage
  | ResyncAckMessage;

// ============================================================================
// Rollback Info
// ============================================================================

export interface RollbackInfo {
  needed: boolean;
  rollbackToFrame: number;
  reason?: string;
}

// ============================================================================
// Stats
// ============================================================================

export interface NetplayStats {
  /** Current frame number */
  currentFrame: number;

  /** Number of rollbacks performed */
  rollbackCount: number;

  /** Average frames rolled back per rollback */
  avgRollbackFrames: number;

  /** Last confirmed remote frame */
  lastConfirmedRemoteFrame: number;

  /** Frames ahead of remote (positive = we're ahead) */
  frameAdvantage: number;

  /** Estimated round-trip time in ms */
  rtt: number;

  /** Number of sync mismatches detected */
  syncMismatches: number;
}

export function createEmptyStats(): NetplayStats {
  return {
    currentFrame: 0,
    rollbackCount: 0,
    avgRollbackFrames: 0,
    lastConfirmedRemoteFrame: -1,
    frameAdvantage: 0,
    rtt: 0,
    syncMismatches: 0
  };
}

// ============================================================================
// Callbacks
// ============================================================================

export interface RollbackCallbacks {
  /** Called when we need to send a message to the remote peer */
  onSendMessage: (msg: NetplayMessage) => void;

  /** Called when a desync is detected */
  onDesync: (localChecksum: string, remoteChecksum: string, frame: number) => void;

  /** Called when rollback stats are updated */
  onStatsUpdate?: (stats: NetplayStats) => void;

  /** Called to apply inputs to the emulator (lockstep mode) */
  onApplyInputs?: (p1: InputState, p2: InputState) => void;

  /** Called to get local input from the emulator (lockstep mode) */
  onGetLocalInput?: () => InputState;
}

// ============================================================================
// Utility functions
// ============================================================================

export function createEmptyInput(): InputState {
  return {
    a: false,
    b: false,
    x: false,
    y: false,
    l: false,
    r: false,
    start: false,
    select: false,
    up: false,
    down: false,
    left: false,
    right: false
  };
}

export function inputsEqual(a: InputState, b: InputState): boolean {
  return (
    a.a === b.a &&
    a.b === b.b &&
    a.x === b.x &&
    a.y === b.y &&
    a.l === b.l &&
    a.r === b.r &&
    a.start === b.start &&
    a.select === b.select &&
    a.up === b.up &&
    a.down === b.down &&
    a.left === b.left &&
    a.right === b.right
  );
}

export function cloneInput(input: InputState): InputState {
  return { ...input };
}
