/**
 * ZSNES-style lockstep netplay.
 *
 * See session.ts for the design. In short: one deterministic core per player,
 * pads exchanged with a fixed input delay, no frame runs until every player's
 * pad for it has arrived, and a periodic checksum that triggers a full
 * savestate resync if the two machines ever disagree.
 */

export { PsnesCore } from './core.js';
export type { PsnesCoreModule, PsnesCoreFactory, VideoFrame, VideoSurface } from './core.js';
export { loadCore, coreAvailable } from './loader.js';

export { NetplaySession, suggestInputDelay } from './session.js';
export type {
	NetplayCore,
	SessionEvent,
	SessionOptions,
	SessionState,
	SessionStats,
	TickResult,
	TickSource
} from './session.js';

export { FrameGovernor } from './governor.js';
export type { GovernorOptions } from './governor.js';

export { SoloSession } from './solo.js';
export type { SoloOptions, SoloPads } from './solo.js';

export { PAD, MsgType, PROTOCOL_VERSION, encode, decode } from './protocol.js';
export type { NetMsg, PadMask } from './protocol.js';

export { SimulatedLink, SimulatedTransport, Rng } from './transport.js';
export type { Transport, SimulatedLinkOptions } from './transport.js';

export { SocketTransport } from './socket-transport.js';
export type { SocketLike } from './socket-transport.js';
export { LagTransport, parseLag } from './lag-transport.js';
export type { LagOptions } from './lag-transport.js';

export { CanvasRenderer, AudioSink, DEFAULT_DISPLAY } from './output.js';
export type { DisplayOptions, Renderer } from './output.js';
export { WebglRenderer } from './webgl-renderer.js';
export { aspectRatioOf, fitToBox } from './fit.js';
export type { PixelAspect } from './fit.js';
export { parsePreset, resolveShaderUrl, SUPPORTED_DIRECTIVES } from './preset.js';
export type { Preset, PresetPass, PresetResult } from './preset.js';
export { loadShaderPreset, presetUrl, SHADER_BASE_URL } from './shader-source.js';
export type { LoadedPreset, LoadedPass, LoadResult } from './shader-source.js';
export { InputCollector } from './input.js';
export type { GamepadSource } from './input.js';

/** CRC32 of the ROM, used to refuse a session between mismatched cartridges. */
export function romCrc32(data: Uint8Array): number {
	let table = CRC_TABLE;
	if (!table) {
		table = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[i] = c >>> 0;
		}
		CRC_TABLE = table;
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

let CRC_TABLE: Uint32Array | null = null;

/**
 * Strips a 512-byte copier header if present, so a headered and an unheadered
 * dump of the same game hash the same and can play together.
 */
export function normaliseRom(data: Uint8Array): Uint8Array {
	return data.length % 1024 === 512 ? data.subarray(512) : data;
}
