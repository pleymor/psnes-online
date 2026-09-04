/**
 * The netplay boot sequence, with the presentation as a port.
 *
 * `LockstepRoom.svelte` holds this inside 1814 lines of component. A VR shell
 * wanting the same sequence would have to copy it, and the next SRAM or
 * handshake fix would then reach only one of the two copies - which is the
 * argument `solo-engine.ts` was written from, and this is its netplay twin.
 *
 * What is deliberately NOT here: the core load, the ROM resolution, the
 * renderer and the input collector. The first two are one line each at the
 * call site, and the last two differ completely between the two
 * presentations - a canvas and a keyboard on a flat page, a curved screen and
 * `XRInputSource` in a headset.
 *
 * The transport is a parameter rather than built here, and that is not
 * fastidiousness: `SocketTransport` needs the socket, and
 * `webrtc-transport.ts` reaches `simple-peer` and `import.meta.env`, which the
 * node test suites cannot resolve. `LockstepRoom.svelte` imports it by path
 * for that exact reason.
 */

import { FrameGovernor } from '$lib/znet';
import { NetplaySession, normaliseRom, romCrc32 } from '$lib/znet';
import type { SessionEvent, Transport } from '$lib/znet';
import type { TickResult } from '$lib/znet/session';
import type { PsnesCore } from '$lib/znet/core';

/** Where a cartridge save comes from and goes. */
export interface SramPort {
	load(): Promise<Uint8Array | null>;
	save(bytes: Uint8Array): void;
}

/** The part of `AudioSink` this engine drives. `flush` matters here and not in
 * solo: a resync throws away a timeline, and the audio queued for it with it. */
export interface AudioPort {
	start(sampleRate: number): Promise<void>;
	push(samples: Int16Array): void;
	flush(): void;
}

/** The part of `NetplaySession` this engine drives, and nothing more. */
export interface LockstepSessionLike {
	pump(): void;
	tick(): TickResult;
	start(): void;
	coreReset: (() => void) | null;
	loadAuthoritativeState(state: Uint8Array, reason: string): boolean;
}

export interface LockstepEngineOptions {
	/** Already loaded by the caller: `await loadCore()`. */
	core: PsnesCore;
	/** Already resolved by the caller. In VR there is no file picker to fall
	 * back on, so the resolution cannot live behind this boundary. */
	rom: Uint8Array;
	isHost: boolean;
	sram: SramPort;
	audio: AudioPort;
	transport: Transport;
	/** Emits `znet:join` and resolves on `znet:joined`. Rejecting is correct
	 * and must not be swallowed - see the ordering test. */
	joinRelay(): Promise<void>;
	/** One mask: this machine's player. The other arrives over the transport,
	 * which is exactly the shape `vr/pad.ts`'s `readVrPad` produces. */
	readLocalInput(): number;
	onEvent(event: SessionEvent): void;
	onFrame(core: PsnesCore, frame: number): void;
	onError(err: unknown): void;
	onSlice?(ran: number, stalled: boolean): void;
	/** Left undefined so the host sizes it from the link it measures. A
	 * hardcoded guess gave one stall per frame once a link drifted. */
	inputDelay?: number;
	/** Where the governor schedules its next slice. Passed by the VR shell,
	 * because window rAF is not the display's clock once a headset presents. */
	schedule?(run: () => void): void;
	/** The session constructor. Defaulted, and a seam for the ordering test. */
	makeSession?(options: ConstructorParameters<typeof NetplaySession>[0]): LockstepSessionLike;
}

export interface LockstepEngine {
	session: LockstepSessionLike;
	governor: FrameGovernor;
	/** The host adopting a savestate: the guest receives it as an ordinary
	 * resync through the netplay protocol. */
	adoptState(state: Uint8Array, reason: string): boolean;
	stop(): Promise<void>;
}

/** How often the cartridge save is written while playing. `stop()` writes once
 * more, so this is the worst case for a crash, not for a clean exit. */
const SRAM_INTERVAL_MS = 30_000;

export async function createLockstepEngine(
	options: LockstepEngineOptions
): Promise<LockstepEngine> {
	const { core, rom, isHost, sram, audio, transport, readLocalInput, onEvent, onError } = options;

	const bytes = normaliseRom(rom);
	core.loadRom(bytes);

	await audio.start(Math.round(core.sampleRate));

	/*
	 * The host, and only the host.
	 *
	 * Battery saves are part of the emulated machine, so they must be in place
	 * before the session starts: the host's state is what both peers adopt, and
	 * loading SRAM afterwards - or on the guest - would change one machine and
	 * not the other. The guest inherits it inside that state.
	 */
	if (isHost) {
		const stored = await sram.load();
		if (stored && stored.length > 0) core.loadSram(stored);
	}

	// Before anything starts, and not caught: a session over an unjoined relay
	// stalls on its first frame with nothing anywhere to say why.
	await options.joinRelay();

	const make = options.makeSession ?? ((opts) => new NetplaySession(opts) as LockstepSessionLike);

	const session = make({
		core,
		transport,
		playerIndex: isHost ? 0 : 1,
		isHost,
		// Both peers must agree on the cartridge before a single frame runs.
		romCrc: romCrc32(bytes),
		// The machine's own cadence, not an assumption: a PAL cartridge runs at
		// 50.007 Hz, which changes both how many frames a round trip needs and
		// what one frame of delay costs the player.
		fps: core.fps || undefined,
		inputDelay: options.inputDelay || undefined,
		readLocalInput,
		onEvent,
		onFrame: (frame: number) => {
			try {
				options.onFrame(core, frame);
				audio.push(core.audio());
			} catch (err) {
				onError(err);
			}
		}
	} as ConstructorParameters<typeof NetplaySession>[0]);

	// The session declares this hook rather than calling `core.reset()` itself:
	// NetplayCore does not require a reset, so a core without one leaves it
	// null. Ours has one, so hand it over.
	session.coreReset = () => core.reset();

	const governor = new FrameGovernor(session, {
		fps: core.fps || 60.0988,
		onSlice: options.onSlice,
		schedule: options.schedule
	});

	const timer = setInterval(() => persist(), SRAM_INTERVAL_MS);

	function persist(): void {
		try {
			const saved = core.sram();
			if (saved && saved.length > 0) sram.save(saved);
		} catch (err) {
			onError(err);
		}
	}

	session.start();
	// Not started here: `solo-engine.ts` leaves this to the caller too, and for
	// the same reason - `FrameGovernor.start()` falls back to
	// `requestAnimationFrame` when no `schedule` is given, which does not exist
	// under the node test runner. `SoloRoom.svelte:582` and
	// `VrShell.svelte:509` both call `engine.governor.start()` themselves once
	// the engine resolves; the netplay call sites do the same.

	return {
		session,
		governor,
		adoptState(state, reason) {
			const adopted = session.loadAuthoritativeState(state, reason);
			// After, not before: the queued audio belongs to a timeline that no
			// longer exists, and flushing first would only clear the old one a
			// frame early.
			if (adopted) audio.flush();
			return adopted;
		},
		async stop(): Promise<void> {
			governor.stop();
			clearInterval(timer);
			// Last, and unconditionally: without it the periodic timer is all
			// there was, so a clean exit loses up to SRAM_INTERVAL_MS of play.
			persist();
		}
	};
}
