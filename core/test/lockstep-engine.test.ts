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
import { normaliseRom, romCrc32 } from '../../frontend/src/lib/znet/index.js';
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
    close() { log.push('session.close'); },
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
  const pushed: number[] = [];
  const framed: number[] = [];
  /*
   * What the engine handed NetplaySession, kept rather than discarded.
   *
   * The first version of this harness took no argument, so the whole options
   * object - playerIndex, romCrc, onEvent, and the onFrame closure - was
   * built by the code under test and thrown away untested. Swapping
   * `isHost ? 0 : 1` would have passed every assertion in this file.
   */
  let built: Record<string, unknown> | null = null;
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
      push: (samples: Int16Array) => { pushed.push(samples.length); log.push('audio.push'); },
      flush: () => { log.push('audio.flush'); }
    },
    transport: {} as unknown as Transport,
    joinRelay: over.joinRelay ?? (async () => { log.push('joinRelay'); }),
    readLocalInput: () => 0x1234,
    onEvent: () => {},
    onFrame: (_c: unknown, frame: number) => { framed.push(frame); log.push('onFrame'); },
    onError: () => {},
    // The seam: the ordering is what matters here, not NetplaySession, which
    // `core/test/lockstep.test.ts` already covers.
    makeSession: (opts: Record<string, unknown>) => {
      built = opts;
      return fakeSession(log);
    }
  };
  return { options, log, saved, pushed, framed, session: () => built };
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

/*
 * What the engine hands NetplaySession.
 *
 * None of the tests above look at it: the harness used to discard the options
 * object entirely, so `playerIndex`, `romCrc`, `onEvent` and the `onFrame`
 * closure were built by the code under test and never checked. A swap of
 * `isHost ? 0 : 1` puts both players on the same pad and desynchronises on
 * frame one, and it would have passed this whole file.
 */

test('the host takes seat 0 and the guest seat 1', async () => {
  const host = harness({ isHost: true });
  const h = await createLockstepEngine(host.options);
  assert.equal(host.session()!.playerIndex, 0);
  assert.equal(host.session()!.isHost, true);
  await h.stop();

  const guest = harness({ isHost: false });
  const g = await createLockstepEngine(guest.options);
  assert.equal(guest.session()!.playerIndex, 1, 'both peers on seat 0 desync on frame one');
  assert.equal(guest.session()!.isHost, false);
  await g.stop();
});

test('the cartridge and the local pad reach the session', async () => {
  // Both peers must agree on the ROM before a frame runs, and the session
  // reads this machine's pad through the callback it was given.
  const { options, session } = harness();
  const engine = await createLockstepEngine(options);

  // A number, not a string: `romCrc32` (`znet/index.ts:77`) returns the CRC
  // itself. And it must be OF THE NORMALISED ROM - the peers compare this
  // value, so a header stripped on one side and not the other refuses a
  // session between two copies of the same cartridge.
  assert.equal(session()!.romCrc, romCrc32(normaliseRom(options.rom)));
  assert.equal(session()!.transport, options.transport, 'a session on the wrong link');
  assert.equal((session()!.readLocalInput as () => number)(), 0x1234);
  assert.equal(session()!.onEvent, options.onEvent, 'the six session events reach nobody');
  await engine.stop();
});

test('the checksum is of the normalised cartridge, not of the file', async () => {
  /*
   * The peers compare this value to refuse a session between mismatched
   * cartridges. `normaliseRom` strips a 512-byte copier header when
   * `length % 1024 === 512`, so a headered dump and a clean one of the same
   * game must hash alike - otherwise netplay refuses a session over a
   * difference that does not exist.
   *
   * A 1024-byte fixture cannot see this: it has no header, so hashing the
   * file and hashing the cartridge give the same answer and the rule reads as
   * guarded while being unguarded. 1536 is `1024 + 512`, which does.
   */
  const headered = new Uint8Array(1536);
  for (let i = 0; i < headered.length; i++) headered[i] = i & 0xff;

  const { options, session } = harness();
  options.rom = headered;
  const engine = await createLockstepEngine(options);

  assert.equal(session()!.romCrc, romCrc32(normaliseRom(headered)));
  assert.notEqual(
    session()!.romCrc,
    romCrc32(headered),
    'hashing the file rather than the cartridge refuses a session between two copies of one game'
  );
  await engine.stop();
});

test('a frame draws before its audio is queued', async () => {
  const { options, log, framed, pushed, session } = harness();
  const engine = await createLockstepEngine(options);

  // The closure the engine built and handed to the session, not one of ours.
  (session()!.onFrame as (n: number) => void)(7);

  assert.deepEqual(framed, [7], 'the caller was not told about the frame');
  assert.deepEqual(pushed, [0], 'the audio for that frame was not queued');
  assert.ok(
    log.indexOf('onFrame') < log.indexOf('audio.push'),
    'audio queued for a frame the caller has not drawn yet'
  );
  await engine.stop();
});

test('a throw while drawing is reported, not lost', async () => {
  // Without the try/catch the exception escapes into the frame loop, which in
  // a headset stops the picture with nothing anywhere to say why.
  const errors: unknown[] = [];
  const { options, session } = harness();
  options.onFrame = () => {
    throw new Error('the renderer went away');
  };
  options.onError = (err: unknown) => void errors.push(err);
  const engine = await createLockstepEngine(options);

  assert.doesNotThrow(() => (session()!.onFrame as (n: number) => void)(1));
  assert.equal(errors.length, 1, 'the frame loop swallowed a renderer failure');
  await engine.stop();
});

test('stopping releases the link, and still writes the cartridge save', async () => {
  /*
   * `LockstepRoom.svelte`'s teardown calls `session.close()`. This engine did
   * not, so every VR lockstep game that ended left a netplay session open -
   * a leak per game rather than per session.
   *
   * And the close must not be able to cost the save: `persist()` reads the
   * core, not the link, so a throw from `close` is reported and the write
   * still happens.
   */
  const { options, log } = harness();
  const engine = await createLockstepEngine(options);
  await engine.stop();

  assert.ok(log.includes('session.close'), 'the netplay session was left open');
  assert.ok(
    log.lastIndexOf('sram.save') > log.indexOf('session.close'),
    'the cartridge save must outlive the link, not race it'
  );
});
