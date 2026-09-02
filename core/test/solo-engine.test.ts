/**
 * The solo boot sequence, without a DOM.
 *
 * `SoloRoom.boot()` held this as 120 lines of component script, so a VR shell
 * that wanted the same sequence had to copy it - and the next SRAM fix would
 * then have reached only one of the two copies. What is under test is the
 * ordering that a copy gets wrong: the ROM is loaded before the session exists,
 * the stored SRAM is applied before the first frame runs, and `stop()` writes
 * the SRAM one last time. Without that final write, up to 30 seconds of
 * progress dies with the session, because the periodic timer is all there was.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSoloEngine } from '../../frontend/src/lib/rooms/solo-engine.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';

/** Enough of `PsnesCore` for the engine: what it loads, runs and reports. */
function fakeCore() {
  const calls: string[] = [];
  let frame = 0;
  const core = {
    fps: 60.0988,
    sampleRate: 32040,
    frame: 0,
    loadRom(bytes: Uint8Array) { calls.push(`loadRom:${bytes.length}`); },
    loadSram(bytes: Uint8Array) { calls.push(`loadSram:${bytes.length}`); },
    // `core.sram()`, not `saveSram()` - see `rooms/sram.ts`'s `SramCore`.
    sram: () => new Uint8Array([7, 7, 7]),
    runFrame() { frame++; core.frame = frame; calls.push('runFrame'); },
    audio: () => new Int16Array(0),
    videoSurface: () => ({ data: new Uint8Array(0), width: 256, height: 224, stride: 512 })
  };
  return { core: core as unknown as PsnesCore, calls };
}

function fakePorts() {
  const saved: Uint8Array[] = [];
  const started: number[] = [];
  return {
    saved,
    started,
    sram: { load: async () => new Uint8Array([1, 2]), save: (b: Uint8Array) => void saved.push(b) },
    audio: { start: async (rate: number) => void started.push(rate), push: () => {} }
  };
}

test('the ROM is loaded, then the stored SRAM, before any frame runs', async () => {
  const { core, calls } = fakeCore();
  const ports = fakePorts();
  const engine = await createSoloEngine({
    core,
    rom: new Uint8Array(1024),
    sram: ports.sram,
    audio: ports.audio,
    readPads: () => ({ pad1: 0, pad2: 0 }),
    onFrame: () => {},
    onError: (e) => assert.fail(String(e))
  });

  assert.deepEqual(
    calls.filter((c) => c !== 'runFrame'),
    ['loadRom:1024', 'loadSram:2'],
    'a ROM applied after the SRAM would discard the save'
  );
  assert.deepEqual(ports.started, [32040], 'audio starts at the core\'s rate, not a guess');
  await engine.stop();
});

test('stop() writes the SRAM one last time', async () => {
  const { core } = fakeCore();
  const ports = fakePorts();
  const engine = await createSoloEngine({
    core,
    rom: new Uint8Array(8),
    sram: ports.sram,
    audio: ports.audio,
    readPads: () => ({ pad1: 0, pad2: 0 }),
    onFrame: () => {},
    onError: (e) => assert.fail(String(e))
  });

  assert.equal(ports.saved.length, 0, 'nothing is written before the session ends');
  await engine.stop();
  assert.equal(ports.saved.length, 1, 'the last 30 seconds must not die with the session');
  assert.deepEqual([...ports.saved[0]], [7, 7, 7]);
});

test('onFrame receives the core and a rising frame number', async () => {
  const { core } = fakeCore();
  const ports = fakePorts();
  const seen: number[] = [];
  const engine = await createSoloEngine({
    core,
    rom: new Uint8Array(8),
    sram: ports.sram,
    audio: ports.audio,
    readPads: () => ({ pad1: 0, pad2: 0 }),
    onFrame: (c, frame) => { assert.equal(c, core); seen.push(frame); },
    onError: (e) => assert.fail(String(e))
  });

  engine.session.tick();
  engine.session.tick();
  assert.deepEqual(seen, [1, 2], 'the presentation port is the only thing the engine tells');
  await engine.stop();
});
