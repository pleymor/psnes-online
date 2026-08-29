import type { LatencyMode } from '../types/index.js';

/**
 * Frames of delay the name `low` used to stand for.
 *
 * Kept so a client from before the count could be chosen is understood rather
 * than ignored. frontend/src/lib/stores/latency-preference.ts holds the same
 * number for the same reason.
 */
const LOW_DELAY_FRAMES = 2;

/**
 * The bounds the emulator itself enforces, repeated here by hand.
 *
 * They live in frontend/src/lib/znet/delay-control.ts, which this image does
 * not ship. Refusing outside them rather than clamping is deliberate: a clamped
 * value would leave the room announcing a delay neither peer is running, and
 * every menu drawing it would be wrong.
 */
const MIN_FRAMES = 1;
const MAX_FRAMES = 16;

/**
 * A latency setting out of whatever arrived on the socket, or null.
 *
 * The room's delay is chosen by one player and lived with by both, so the value
 * is checked here and not only where it is typed: `room:setLatencyMode` is
 * reachable by anyone signed in, and the creator check alone would still let a
 * hand-rolled client pin its partner at a hundred frames.
 */
export function parseLatencyMode(value: unknown): LatencyMode | null {
  if (value === 'auto') return 'auto';
  if (value === 'low') return LOW_DELAY_FRAMES;

  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value)) return null;
  if (value < MIN_FRAMES || value > MAX_FRAMES) return null;
  return value;
}
