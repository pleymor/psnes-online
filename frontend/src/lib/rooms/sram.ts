/**
 * Reading the battery save out of a machine and putting one back.
 *
 * Three components did this, with three different encodings, one of which
 * built an 800KB string a character at a time. The encoding itself lives in
 * `saves/base64.ts`; this is the part that knows a core has an empty SRAM when
 * the cartridge has no battery.
 */
import { toBase64, fromBase64 } from '$lib/saves/base64';

export interface SramCore {
	sram(): Uint8Array;
	loadSram(bytes: Uint8Array): void;
}

/** The machine's battery save, or null when the cartridge has none. */
export function encodeSram(core: SramCore): string | null {
	const sram = core.sram();
	if (sram.length === 0) return null;
	return toBase64(sram);
}

export function decodeSram(base64: string): Uint8Array {
	return fromBase64(base64);
}
