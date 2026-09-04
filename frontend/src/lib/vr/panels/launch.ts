/**
 * The launch screen: which game, from where, on which controller.
 *
 * Drawn on the curved screen rather than on a lectern, and that is the point:
 * it is the only surface straight ahead. The lecterns sit at plus and minus
 * sixty degrees, which is how a whole panel went unnoticed on the first
 * hardware test, and a choice nobody finds is worse than no choice at all.
 *
 * Three rules the layout enforces rather than merely honours:
 *
 *   - A save list the player may not act on is DRAWN and carries no regions.
 *     The server refuses a save staged by anyone but the room's creator, so
 *     the click would earn an `error` no headset displays; hiding the list
 *     instead would leave a guest unable to see what they are joining, which
 *     is the thing that rule exists to prevent.
 *   - A blocked launch has no `launch` region at all. A present, dead button
 *     is indistinguishable from a headset that has stopped responding.
 *   - The chosen save is marked with a glyph, not only a fill. Two states
 *     differing by a colour draw an identical set of `fillText` calls, and the
 *     test for "the choice is visible" would have nothing to compare.
 */

import type { PanelSize, Region } from '../panel';
import type { LaunchOptions, LaunchSave } from '../launch-options';

export const LAUNCH_PANEL_SIZE: PanelSize = { width: 1024, height: 768 };

const PAD = 40;
const TITLE_Y = 56;
const COVER = { x: PAD, y: 96, w: 240, h: 168 };

/** The save list: left column, clear of the ports on the right. */
const SAVE_X = PAD;
const SAVE_Y = 312;
const SAVE_W = 470;
const SAVE_H = 56;
const SAVE_GAP = 12;
/** Beyond this the list scrolls nowhere: it is simply capped. */
const SAVE_LIMIT = 5;

const PORT_X = 560;
const PORT_Y = 312;
const PORT_W = 240;
const PORT_H = 76;
const PORT_GAP = 16;
const FRIEND_Y = 268;

/*
 * The launch button lives in the RIGHT column, under the ports, and that is a
 * correction rather than a preference.
 *
 * Centred at 400px wide it spanned x 312..712, which crosses the save column
 * (40..510). With four saves or more the fifth and sixth rows reach y 584..708
 * and collide with it - two hit-testable regions overlapping, on a curved
 * texture with no layout engine to notice. The no-overlap test never saw it
 * because it only ever built the two-save arrangement.
 *
 * Out of the save column's x range, no number of rows can reach it, so the
 * bug cannot come back by adding a save.
 */
const LAUNCH_X = PORT_X;
const LAUNCH_W = 384;
const LAUNCH_H = 96;
const LAUNCH_Y = 620;

export interface LaunchLabels {
	newGame: string;
	saveLockedByCreator: string;
	launch: string;
	port1: string;
	port2: string;
	waitingForFriend: string;
	friendReady: string;
	/** The friend line's short state word when `FriendState.online` is false. */
	friendAway: string;
	romMissing: string;
	alreadyPlaying: string;
	noSeat: string;
	/** The blocked-launch banner for `'friend-away'` - a full sentence, like
	 * the other three `blockedLabel` cases, not the short word above. */
	friendAwayBlocked: string;
}

/** The rows the list shows, capped, with "start fresh" always first. */
function saveRows(options: LaunchOptions): Array<{ id: string; save: LaunchSave | null }> {
	const rows: Array<{ id: string; save: LaunchSave | null }> = [{ id: 'save:none', save: null }];
	for (const save of options.saves.slice(0, SAVE_LIMIT)) {
		rows.push({ id: `save:${save.id}`, save });
	}
	return rows;
}

export function layoutLaunchPanel(options: LaunchOptions, _labels: LaunchLabels): Region[] {
	const regions: Region[] = [];

	// Drawn either way; clickable only when the server would accept it.
	if (options.mayChooseSave) {
		saveRows(options).forEach((row, index) => {
			regions.push({
				id: row.id,
				x: SAVE_X,
				y: SAVE_Y + index * (SAVE_H + SAVE_GAP),
				w: SAVE_W,
				h: SAVE_H
			});
		});
	}

	// No port to pick alone: `readVrPad` is the only pad on this machine.
	if (options.friend) {
		regions.push({ id: 'port:1', x: PORT_X, y: PORT_Y, w: PORT_W, h: PORT_H });
		regions.push({
			id: 'port:2',
			x: PORT_X,
			y: PORT_Y + PORT_H + PORT_GAP,
			w: PORT_W,
			h: PORT_H
		});
	}

	// Absent rather than dead. See the header.
	if (options.blocked === null) {
		regions.push({ id: 'launch', x: LAUNCH_X, y: LAUNCH_Y, w: LAUNCH_W, h: LAUNCH_H });
	}

	return regions;
}

/** Cuts a string to fit `width` at the current font, with an ellipsis. */
function truncate(ctx: CanvasRenderingContext2D, text: string, width: number): string {
	if (ctx.measureText(text).width <= width) return text;
	let cut = text;
	while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) {
		cut = cut.slice(0, -1);
	}
	return `${cut}…`;
}

function drawRow(
	ctx: CanvasRenderingContext2D,
	region: Region,
	text: string,
	chosen: boolean,
	live: boolean,
	hovered: boolean
): void {
	ctx.fillStyle = chosen ? '#232a44' : '#1c1c26';
	ctx.fillRect(region.x, region.y, region.w, region.h);

	ctx.font = '22px system-ui, sans-serif';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	// Dimmed when the row cannot be acted on, so "drawn but inert" is visible
	// rather than only true.
	ctx.fillStyle = live ? '#e8e8f0' : '#79798a';
	ctx.fillText(
		truncate(ctx, text, region.w - 64),
		region.x + 16,
		region.y + region.h / 2
	);

	if (chosen) {
		// A glyph, not just the fill. See the header.
		ctx.fillStyle = '#7aa2ff';
		ctx.textAlign = 'right';
		ctx.fillText('●', region.x + region.w - 16, region.y + region.h / 2);
		ctx.textAlign = 'left';
	}
	if (hovered) {
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
	}
}

function drawButton(
	ctx: CanvasRenderingContext2D,
	region: Region,
	label: string,
	active: boolean,
	hovered: boolean
): void {
	ctx.fillStyle = active ? '#2f3a5c' : '#1c1c26';
	ctx.fillRect(region.x, region.y, region.w, region.h);
	ctx.fillStyle = '#ffffff';
	ctx.font = '600 26px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, region.x + region.w / 2, region.y + region.h / 2);
	if (hovered) {
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 2;
		ctx.strokeRect(region.x - 3, region.y - 3, region.w + 6, region.h + 6);
	}
}

function blockedLabel(options: LaunchOptions, labels: LaunchLabels): string | null {
	switch (options.blocked) {
		case 'rom-missing':
			return labels.romMissing;
		case 'already-playing':
			return labels.alreadyPlaying;
		case 'no-seat':
			return labels.noSeat;
		case 'friend-away':
			return labels.friendAwayBlocked;
		case null:
			return null;
		default: {
			// Exhaustiveness the compiler enforces: a new `LaunchBlock` member
			// with no case here is a type error, not a silently blank banner.
			const _exhaustive: never = options.blocked;
			return _exhaustive;
		}
	}
}

export function drawLaunchPanel(
	ctx: CanvasRenderingContext2D,
	options: LaunchOptions,
	regions: readonly Region[],
	opts: { labels: LaunchLabels; hoverId: string | null }
): void {
	const { width, height } = LAUNCH_PANEL_SIZE;
	const { labels } = opts;

	ctx.save();
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = '#101018';
	ctx.fillRect(0, 0, width, height);

	ctx.fillStyle = '#ffffff';
	ctx.font = '600 34px system-ui, sans-serif';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.fillText(truncate(ctx, options.game.title, width - PAD * 2), PAD, TITLE_Y);

	// A placeholder rectangle, always - no caller passes this function an
	// actual cover image today, so the reason a fetch belongs to a caller
	// rather than to this module still applies but is not yet exercised:
	// `VrShell`'s library panel already draws its own covers into a canvas
	// through `<img crossOrigin>`, and a cross-origin one drawn without that
	// taints the whole texture, which WebGL then refuses to upload. Wiring an
	// actual cover through here would mean passing this module the same
	// `covers` map and the same per-URL CORS handling `VrShell` already has -
	// left undone rather than duplicated, so the title is what identifies the
	// game on this screen for now.
	ctx.fillStyle = '#1c1c26';
	ctx.fillRect(COVER.x, COVER.y, COVER.w, COVER.h);

	const byId = new Map(regions.map((region) => [region.id, region]));

	// Drawn from the rows, not from the regions: the list exists even when it
	// has no regions at all.
	saveRows(options).forEach((row, index) => {
		const region = byId.get(row.id) ?? {
			id: row.id,
			x: SAVE_X,
			y: SAVE_Y + index * (SAVE_H + SAVE_GAP),
			w: SAVE_W,
			h: SAVE_H
		};
		drawRow(
			ctx,
			region,
			row.save ? row.save.name : labels.newGame,
			options.chosenSaveId === (row.save?.id ?? null),
			options.mayChooseSave,
			opts.hoverId === row.id
		);
	});

	if (!options.mayChooseSave) {
		ctx.font = '20px system-ui, sans-serif';
		ctx.fillStyle = '#8a8a98';
		ctx.textAlign = 'left';
		// Not SAVE_W: this is a banner line above the list, not a row within it,
		// so it is free to run the same full width the title and the blocked
		// reason already use.
		/*
		 * Bounded by the save column, never by the panel.
		 *
		 * At full width this line ran to x 589 while the friend's name starts
		 * at 560, sixteen pixels away vertically - the banner ran into it in
		 * the one case it exists for, a guest who cannot pick the save looking
		 * at a room their friend occupies. The wording is short enough to fit
		 * 470px whole, so nothing is truncated away either.
		 */
		ctx.fillText(
			truncate(ctx, labels.saveLockedByCreator, SAVE_W),
			SAVE_X,
			SAVE_Y - 28
		);
	}

	if (options.friend) {
		ctx.font = '22px system-ui, sans-serif';
		ctx.fillStyle = '#c2c2d2';
		ctx.textAlign = 'left';
		// Away outranks ready/waiting: a closed tab keeps both the port and
		// `isReady`, so those two would otherwise go on describing a friend who
		// is not there to have either.
		const state = !options.friend.online
			? labels.friendAway
			: options.friend.isReady
				? labels.friendReady
				: labels.waitingForFriend;
		ctx.fillText(`${options.friend.pseudo} — ${state}`, PORT_X, FRIEND_Y);

		const one = byId.get('port:1');
		const two = byId.get('port:2');
		if (one) drawButton(ctx, one, labels.port1, options.myPort === 1, opts.hoverId === 'port:1');
		if (two) drawButton(ctx, two, labels.port2, options.myPort === 2, opts.hoverId === 'port:2');
	}

	const launch = byId.get('launch');
	if (launch) {
		drawButton(ctx, launch, labels.launch, true, opts.hoverId === 'launch');
	} else {
		const why = blockedLabel(options, labels);
		if (why) {
			ctx.font = '24px system-ui, sans-serif';
			ctx.fillStyle = '#e8b0b0';
			ctx.textAlign = 'center';
			ctx.fillText(truncate(ctx, why, width - PAD * 2), width / 2, LAUNCH_Y + LAUNCH_H / 2);
		}
	}

	ctx.restore();
}
