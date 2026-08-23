import type { Socket } from 'socket.io-client';
import { fetchSaves } from './api';
import { captureShot, captureState, type CapturableEmulator } from './capture';
import { findQuickSave, QUICK_SAVE_NAME } from './quick';
import { notifications } from '$lib/services/notification';
import { t } from '$lib/i18n/translations';

/**
 * What F2 and F4 actually do.
 *
 * Orchestration only - every decision it makes lives in `quick.ts` or
 * `base64.ts`, where a test can reach it. This file is the part that talks to
 * the network and is therefore checked by hand.
 *
 * Neither function invents a socket event. Quick save is `game:save` with the
 * sentinel name, so it takes the ordinary overwrite path; quick load is
 * `game:load`, which the server already broadcasts to the whole room - which is
 * why loading mid-game does not desync lockstep, and why this needed no netplay
 * work of its own.
 */

interface QuickContext {
	socket: Socket | null;
	roomId: string;
	gameId: string;
	locale: string;
}

export async function quickSave(
	ctx: QuickContext & { emulator: CapturableEmulator | null }
): Promise<void> {
	const { socket, roomId, gameId, locale, emulator } = ctx;
	if (!socket) return;

	// The list is read first so the sentinel can be overwritten rather than
	// duplicated. A failure to read is not a reason to create a second quick
	// save - that is exactly how the single slot stops being single.
	const listed = await fetchSaves(gameId);
	if (!listed.ok) {
		notifications.show(t(locale as never, listed.reason), 'error');
		return;
	}

	const existing = findQuickSave(listed.saves);
	const screenshot = captureShot(emulator);
	const saveData = await captureState(emulator);

	const onSaved = () => {
		socket.off('error', onError);
		notifications.show(t(locale as never, 'quickSaved'), 'success');
	};
	const onError = () => {
		socket.off('game:saved', onSaved);
		notifications.show(t(locale as never, 'failedToSave'), 'error');
	};
	socket.once('game:saved', onSaved);
	socket.once('error', onError);

	socket.emit('game:save', {
		roomId,
		saveId: existing?.id,
		name: QUICK_SAVE_NAME,
		saveData,
		screenshot
	});
}

export async function quickLoad(ctx: QuickContext): Promise<void> {
	const { socket, roomId, gameId, locale } = ctx;
	if (!socket) return;

	const listed = await fetchSaves(gameId);
	if (!listed.ok) {
		notifications.show(t(locale as never, listed.reason), 'error');
		return;
	}

	const existing = findQuickSave(listed.saves);
	if (!existing) {
		// Said out loud rather than ignored: a shortcut that does nothing is
		// indistinguishable from a shortcut that is broken.
		notifications.show(t(locale as never, 'noQuickSave'), 'info');
		return;
	}

	// No success toast here. `game:loaded` goes to the whole room and each room
	// component already reacts to it; announcing it from the presser's side too
	// would say it twice for them and not at all for their partner.
	socket.emit('game:load', { roomId, saveId: existing.id });
}
