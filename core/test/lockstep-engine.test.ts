/**
 * The netplay boot sequence, without a DOM.
 *
 * `LockstepRoom.svelte` holds this as part of 1814 lines, so a VR shell that
 * wants the same sequence would have to copy it - and the next SRAM or
 * handshake fix would then reach only one of the two. `solo-engine.ts` is the
 * same extraction for solo play, and this is its netplay twin.
 *
 * What is under test is the ordering a copy gets wrong:
 *
 *   - the ROM is loaded before anything can run a frame;
 *   - the cartridge SRAM is loaded by the HOST ONLY, because the host's state
 *     is what both peers adopt and loading it on the guest would change one
 *     machine and not the other;
 *   - the SRAM is in place before the session exists, for the same reason;
 *   - nothing starts until the relay has confirmed the join, because a session
 *     started over an unjoined relay stalls on its first frame with no
 *     explanation;
 *   - and `stop()` writes the SRAM one last time, without which up to thirty
 *     seconds of progress dies with the session.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  createLockstepEngine,
  type LockstepSessionLike
} from '../../frontend/src/lib/rooms/lockstep-engine.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import type { Transport } from '../../frontend/src/lib/znet/index.js';

/** Enough of `PsnesCore` for the engine: what it loads, runs and reports. */
function fakeCore(log: string[]) {
  const core = {
    fps: 60.0988,
    sampleRate: 32040,
    frame: 0,
    loadRom(bytes: Uint8Array) { log.push(`loadRom:${bytes.length}`); },
    loadSram(bytes: Uint8Array) { log.push(`loadSram:${bytes.length}`); },
    sram: () => new Uint8Array([7, 7, 7]),
    reset() { log.push('reset'); },
    runFrame() { log.push('runFrame'); },
    audio: () => new Int16Array(0),
    videoSurface: () => ({ data: new Uint8Array(0), width: 256, height: 224, stride: 512 })
  };
  return core as unknown as PsnesCore;
}

function fakeSession(log: string[]): LockstepSessionLike {
  return {
    coreReset: null,
    pump() {},
    tick: () => 'idle',
    start() { log.push('session.start'); },
    loadAuthoritativeState(state, reason) {
      log.push(`adopt:${state.length}:${reason}`);
      return true;
    }
  };
}

function harness(over: { isHost?: boolean; joinRelay?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const saved: Uint8Array[] = [];
  const options = {
    core: fakeCore(log),
    rom: new Uint8Array(1024),
    isHost: over.isHost ?? true,
    sram: {
      load: async () => { log.push('sram.load'); return new Uint8Array([1, 2]); },
      save: (bytes: Uint8Array) => { log.push('sram.save'); saved.push(bytes); }
    },
    audio: {
      start: async (rate: number) => { log.push(`audio.start:${rate}`); },
      push: () => {},
      flush: () => { log.push('audio.flush'); }
    },
    transport: {} as unknown as Transport,
    joinRelay: over.joinRelay ?? (async () => { log.push('joinRelay'); }),
    readLocalInput: () => 0,
    onEvent: () => {},
    onFrame: () => {},
    onError: () => {},
    // The seam: the ordering is what matters here, not NetplaySession, which
    // `core/test/lockstep.test.ts` already covers.
    makeSession: () => fakeSession(log)
  };
  return { options, log, saved };
}

test('the ROM, the audio and the relay all precede the session', async () => {
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);

  assert.deepEqual(log, [
    'loadRom:1024',
    'audio.start:32040',
    'sram.load',
    'loadSram:2',
    'joinRelay',
    'session.start'
  ]);
  await engine.stop();
});

test('only the host loads the cartridge SRAM', async () => {
  // The host's state is what both peers adopt. Loading SRAM on the guest
  // changes one machine and not the other, and lockstep diverges on frame one.
  const { options, log } = harness({ isHost: false });
  const engine = await createLockstepEngine(options);

  assert.ok(!log.includes('sram.load'), 'the guest asked for a save it must not apply');
  assert.ok(!log.some((line) => line.startsWith('loadSram')), 'and must not have applied one');
  assert.ok(log.includes('session.start'), 'the guest still boots');
  await engine.stop();
});

test('a relay that never confirms starts nothing', async () => {
  // A session over an unjoined relay stalls on its first frame with nothing
  // to explain why, which in a headset is a black screen.
  const { options, log } = harness({
    joinRelay: async () => { throw new Error('the server did not confirm'); }
  });

  await assert.rejects(() => createLockstepEngine(options), /did not confirm/);
  assert.ok(!log.includes('session.start'), 'a session was started over a dead relay');
});

test('stop writes the cartridge save one last time', async () => {
  // Without this, up to thirty seconds of progress dies with the session,
  // because the periodic timer was all there was.
  const { options, log, saved } = harness();
  const engine = await createLockstepEngine(options);
  const before = log.filter((line) => line === 'sram.save').length;

  await engine.stop();

  assert.equal(log.filter((line) => line === 'sram.save').length, before + 1);
  assert.deepEqual([...saved[saved.length - 1]], [7, 7, 7]);
});

test('the core reset is handed to the session', async () => {
  // NetplayCore does not require a reset, so the session leaves the hook null
  // unless it is given one. Ours has one.
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);

  assert.equal(typeof engine.session.coreReset, 'function');
  engine.session.coreReset!();
  assert.ok(log.includes('reset'));
  await engine.stop();
});

test('adopting a savestate reseeds the session and drops the stale audio', async () => {
  // The queued audio belongs to a timeline that no longer exists.
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);

  assert.equal(engine.adoptState(new Uint8Array([9, 9]), 'save "boss"'), true);
  const adopt = log.indexOf('adopt:2:save "boss"');
  const flush = log.indexOf('audio.flush');
  assert.ok(adopt >= 0, 'the session was not reseeded');
  assert.ok(flush > adopt, 'the stale audio outlived the timeline it belonged to');
  await engine.stop();
});
