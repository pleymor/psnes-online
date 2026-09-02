/**
 * The solo boot sequence, with the presentation as a port.
 *
 * This was 120 lines inside `SoloRoom.boot()`. A VR shell needs the same
 * sequence with a different picture, and copying it would guarantee that the
 * next SRAM or teardown fix reaches only one of the two.
 *
 * What is deliberately NOT here: the core load, the ROM resolution and the
 * input collectors. The first two are one line each at the call site; the third
 * differs completely between the two presentations - keyboard, pads and a touch
 * pad on a flat screen, `XRInputSource` in a headset - and `InputCollector`
 * reaches `window`, which would make this untestable for no gain.
 *
 * Everything a browser provides arrives as a parameter, for the reason
 * `stores/shader-preference.ts:10` gives: so it can be tested without one.
 */

import { FrameGovernor } from '$lib/znet/governor';
import { SoloSession } from '$lib/znet/solo';
import { normaliseRom } from '$lib/znet';
import type { PsnesCore } from '$lib/znet/core';

/** Where a cartridge save comes from and goes. Room- and socket-shaped at the
 * call site; the engine only needs the two verbs. */
export interface SramPort {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): void;
}

/** The part of `AudioSink` the engine drives. */
export interface AudioPort {
  start(sampleRate: number): Promise<void>;
  push(samples: Int16Array): void;
}

export interface SoloEngineOptions {
  /** Already loaded by the caller: `await loadCore()`. */
  core: PsnesCore;
  /** Already resolved by the caller. In VR there is no file picker to fall back
   * on, so the resolution cannot live behind this boundary. */
  rom: Uint8Array;
  sram: SramPort;
  audio: AudioPort;
  readPads: () => { pad1: number; pad2: number };
  /** The only thing the engine tells anyone. `SoloRoom` draws; `VrShell`
   * uploads a texture. */
  onFrame: (core: PsnesCore, frame: number) => void;
  onError: (err: unknown) => void;
  /**
   * Where the governor schedules its next slice, when it must not be window
   * rAF.
   *
   * Omitted on the flat path, which keeps today's behaviour. Passed by the VR
   * shell, because window rAF is not the display's clock once a headset is
   * presenting - see `znet/governor.ts`'s note on this option. Without this
   * field the injectable scheduler could never reach the emulator, since the
   * governor is constructed in here and nowhere else.
   */
  schedule?: (run: () => void) => void;
}

export interface SoloEngine {
  session: SoloSession;
  governor: FrameGovernor;
  stop(): Promise<void>;
}

/** How often the cartridge save is written while playing. `stop()` writes once
 * more, so this interval is the worst case for a crash, not for a clean exit. */
const SRAM_INTERVAL_MS = 30_000;

export async function createSoloEngine(options: SoloEngineOptions): Promise<SoloEngine> {
  const { core, rom, sram, audio, readPads, onFrame, onError } = options;

  // Order matters and is the thing a copy gets wrong: a ROM loaded after the
  // SRAM discards the save, and a session that exists before the ROM would run
  // a frame on an empty machine.
  core.loadRom(normaliseRom(rom));

  const stored = await sram.load();
  if (stored && stored.length > 0) core.loadSram(stored);

  await audio.start(Math.round(core.sampleRate));

  const session = new SoloSession({
    core,
    readLocalInput: readPads,
    onFrame: (frame) => {
      try {
        onFrame(core, frame);
        audio.push(core.audio());
      } catch (err) {
        onError(err);
      }
    }
  });

  const governor = new FrameGovernor(session, {
    fps: core.fps || 60.0988,
    // Solo has no peer to freeze by pausing, which is the reason
    // `SoloRoom.svelte:552` gives for the same value.
    keepRunningWhenHidden: false,
    // Undefined on the flat path, which leaves the governor on rAF exactly as
    // before: `GovernorOptions.schedule` is optional and the constructor
    // already falls back to `null` with `options.schedule ?? null`.
    schedule: options.schedule
  });

  const timer = setInterval(() => persist(), SRAM_INTERVAL_MS);

  function persist(): void {
    try {
      // `core.sram()` (`znet/core.ts:259`), not `saveSram` - that name belongs
      // to savestates. An empty array means the cartridge has no battery,
      // which `rooms/sram.ts` is the module that knows.
      const bytes = core.sram();
      if (bytes && bytes.length > 0) sram.save(bytes);
    } catch (err) {
      onError(err);
    }
  }

  async function stop(): Promise<void> {
    governor.stop();
    clearInterval(timer);
    // Last, and unconditionally: without it the periodic timer is all there
    // was, so a clean exit loses up to SRAM_INTERVAL_MS of play.
    persist();
  }

  return { session, governor, stop };
}
