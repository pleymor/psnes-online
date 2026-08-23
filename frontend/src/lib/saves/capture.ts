import { captureThumbnail } from './thumbnail';
import { createLogger } from '$lib/utils/logger';
import { toBase64 } from './base64';

const logger = createLogger('SaveCapture');

/**
 * Taking a picture and a state off a running emulator.
 *
 * Lifted out of `SaveGameMenu` when the quick-save shortcut needed the same
 * three functions from two room components. Third copy avoided rather than
 * refactoring for its own sake.
 */

/** Needs `saveState()`; `getCanvas()` is optional and only costs a thumbnail. */
export interface CapturableEmulator {
	saveState?: () => Promise<unknown>;
	getCanvas?: () => HTMLCanvasElement | null | undefined;
}

export async function captureState(
	emulator: CapturableEmulator | null
): Promise<string | undefined> {
	if (!emulator?.saveState) return undefined;
	try {
		const result = (await emulator.saveState()) as { state?: unknown } | Uint8Array | Blob;
		const blob = (result as { state?: unknown })?.state ?? result;
		if (blob instanceof Blob) {
			return toBase64(new Uint8Array(await blob.arrayBuffer()));
		}
		if (result instanceof Uint8Array) return toBase64(result);
	} catch (error) {
		logger.error('Failed to capture emulator state:', error);
	}
	return undefined;
}

/** A save without a picture is fine; a save that failed because of one is not. */
export function captureShot(emulator: CapturableEmulator | null): string | undefined {
	try {
		const canvas = emulator?.getCanvas?.();
		return canvas ? (captureThumbnail(canvas) ?? undefined) : undefined;
	} catch (error) {
		logger.error('Failed to capture thumbnail:', error);
		return undefined;
	}
}
