/**
 * The on-screen pad, for a phone or a tablet.
 *
 * Split from the component that draws it on purpose: everything a wrong thumb
 * position can break is arithmetic, and arithmetic is testable without a DOM.
 * The component owns pixels and pointer ids; this file owns the mask.
 *
 * The mask itself joins the emulation exactly where a keyboard or a controller
 * does - `InputCollector.read()` - so nothing downstream, and lockstep least of
 * all, can tell a thumb from a key.
 */

import type { Button } from './binding.js';
import { PAD, type PadMask } from '../znet/protocol.js';

const BUTTON_BITS: Record<Button, number> = {
	a: PAD.A,
	b: PAD.B,
	x: PAD.X,
	y: PAD.Y,
	l: PAD.L,
	r: PAD.R,
	start: PAD.START,
	select: PAD.SELECT,
	up: PAD.UP,
	down: PAD.DOWN,
	left: PAD.LEFT,
	right: PAD.RIGHT
};

/**
 * How far the thumb must travel before the stick means anything, as a fraction
 * of the stick's radius.
 *
 * A radius rather than a per-axis threshold: a thumb resting on the stick
 * drifts by a couple of pixels on every axis at once, and a per-axis test would
 * let that drift through as a diagonal.
 */
const DEAD_ZONE = 0.25;

/**
 * cos(67.5°): a direction is pressed while the stick points within 67.5° of it.
 *
 * That splits the circle into eight equal 45° sectors - four pure directions
 * and four diagonals - which is the geometry a d-pad has and the one games are
 * written against.
 */
const SECTOR = 0.38268343236508984;

/**
 * Half-width of the flat middle of a cross, as a fraction of its radius.
 *
 * A third puts the drawing on a three-by-three grid: the middle cell holds
 * nothing, the four edge cells are the arms, the four corners are the
 * diagonals. That is the geometry the shape already shows the player, so where
 * the thumb *looks* like it is and what the machine reads never disagree.
 */
const CROSS_PLATEAU = 1 / 3;

/** Which shape the left thumb is given. */
export type DirectionMode = 'stick' | 'cross';

/**
 * The directions a cross pressed at (dx, dy) is holding.
 *
 * Same coordinates as the stick - relative to centre and radius, negative `dy`
 * is up - so the component measures a thumb once and the shape decides what it
 * means.
 *
 * Two things separate this from `stickMask`, and both are why the choice is
 * worth offering. The neutral middle is a *square* rather than a circle, and a
 * wide one: a thumb parked a third of the way out is resting, where on a stick
 * the same thumb is already a firm diagonal. And nothing is clamped at the
 * edge, because a cross is drawn at a fixed place and a thumb that slides past
 * the end of an arm is still pressing it.
 */
export function crossMask(dx: number, dy: number): PadMask {
	let mask = 0;
	if (dx >= CROSS_PLATEAU) mask |= PAD.RIGHT;
	if (dx <= -CROSS_PLATEAU) mask |= PAD.LEFT;
	if (dy <= -CROSS_PLATEAU) mask |= PAD.UP;
	if (dy >= CROSS_PLATEAU) mask |= PAD.DOWN;
	return mask;
}

/**
 * The directions a stick pushed to (dx, dy) is holding.
 *
 * Screen coordinates, so a negative `dy` is up. Both components are relative to
 * the stick's radius: (1, 0) is the edge, (0.5, 0) is halfway.
 */
export function stickMask(dx: number, dy: number): PadMask {
	const distance = Math.hypot(dx, dy);
	if (distance < DEAD_ZONE) return 0;

	const x = dx / distance;
	const y = dy / distance;
	let mask = 0;
	if (x >= SECTOR) mask |= PAD.RIGHT;
	if (x <= -SECTOR) mask |= PAD.LEFT;
	if (y <= -SECTOR) mask |= PAD.UP;
	if (y >= SECTOR) mask |= PAD.DOWN;
	return mask;
}

/**
 * What the thumbs are holding right now.
 *
 * Buttons and stick are kept apart rather than merged into one mask as they
 * arrive: the two thumbs move independently, and centring the stick must not
 * drop the button the other thumb is still holding.
 */
export class TouchPad {
	private buttons = 0;
	private stick = 0;
	private mode: DirectionMode = 'stick';

	get mask(): PadMask {
		return this.buttons | this.stick;
	}

	get directionMode(): DirectionMode {
		return this.mode;
	}

	/**
	 * Swaps the shape under the left thumb, letting go of what it was holding.
	 *
	 * Dropping the direction is not tidiness. The pointer that would have
	 * released it belongs to the control that just disappeared, so its release
	 * never arrives - and a direction held for the rest of the session is the
	 * worst failure this file has, since a phone has no second device to press
	 * the key again.
	 */
	setMode(mode: DirectionMode): void {
		this.mode = mode;
		this.stick = 0;
	}

	press(button: Button): void {
		this.buttons |= BUTTON_BITS[button];
	}

	release(button: Button): void {
		this.buttons &= ~BUTTON_BITS[button];
	}

	/**
	 * Where the thumb is, relative to the control's centre and radius.
	 *
	 * The caller measures pixels and does not care which shape is showing; the
	 * mode decides how those pixels read.
	 */
	setDirection(dx: number, dy: number): void {
		this.stick = this.mode === 'cross' ? crossMask(dx, dy) : stickMask(dx, dy);
	}

	/**
	 * Lets go of everything.
	 *
	 * Called when the pad is hidden or unmounted: a button whose pointer event
	 * never arrives because the element disappeared under the thumb would
	 * otherwise stay held for the rest of the session.
	 */
	releaseAll(): void {
		this.buttons = 0;
		this.stick = 0;
	}
}

/** What the room knows about the machine when it decides to draw the pad. */
export interface TouchEnvironment {
	/** `(pointer: coarse)`: the primary pointer is a finger. */
	coarsePointer: boolean;
	maxTouchPoints: number;
	/** Physical controllers the browser reports, from `connectedPads()`. */
	padCount: number;
}

/**
 * Whether this machine should be given an on-screen pad.
 *
 * A finger as the *primary* pointer is the test, not the mere presence of a
 * touch screen: a laptop that happens to have one still has a keyboard, and
 * taking a third of its picture away for a pad nobody will press is a
 * regression for a machine that was playing fine.
 *
 * A connected controller beats the drawing every time - and because the rooms
 * already listen for `gamepadconnected`, plugging one in makes the pad leave on
 * its own.
 */
export function shouldShowTouchPad(env: TouchEnvironment): boolean {
	return env.coarsePointer && env.maxTouchPoints > 0 && env.padCount === 0;
}

/** The pieces of `window` the question above needs. */
export interface TouchView {
	matchMedia?: (query: string) => { matches: boolean };
	navigator?: { maxTouchPoints?: number };
}

/**
 * The same question, asked of a real browser.
 *
 * The window is a parameter rather than a global read so this stays testable:
 * whether a finger is the primary pointer is knowable only through
 * `matchMedia`, and nothing else can stand in for it. It also makes the
 * server-rendered pass - where there is no window at all - answer no instead of
 * throwing.
 */
export function touchPadWanted(padCount: number, view: TouchView = globalThis): boolean {
	if (!view?.matchMedia) return false;
	return shouldShowTouchPad({
		coarsePointer: view.matchMedia('(pointer: coarse)').matches,
		maxTouchPoints: view.navigator?.maxTouchPoints ?? 0,
		padCount
	});
}

/** One face button, as a circle on the glass. */
export interface FaceTarget {
	button: Button;
	/** Centre, in whatever coordinates the caller measures the thumb in. */
	x: number;
	y: number;
	r: number;
}

/**
 * How much wider than a point a thumb is, in pixels.
 *
 * A contact patch, not a cursor: a thumb pressed on glass is roughly 35px
 * across, so it genuinely covers two adjacent face buttons when it lands in the
 * gap between them.
 */
const THUMB = 18;

/**
 * The face buttons a thumb at this point is holding.
 *
 * Nearest first, and never more than two: a SNES asks for A+B and Y+B in the
 * same moment, but no thumb means three at once, and letting a wide contact
 * reach a third button turns an intended pair into a mash.
 *
 * A thumb that reaches none of them still gets the nearest, provided it is not
 * far - otherwise the middle of the diamond, where the four circles all fall
 * just out of reach, would be a dead spot in the centre of the control the
 * player uses most.
 */
export function facesAt(px: number, py: number, targets: FaceTarget[]): Button[] {
	const byDistance = targets
		.map((t) => ({ button: t.button, gap: Math.hypot(px - t.x, py - t.y) - t.r }))
		.sort((a, b) => a.gap - b.gap);

	const touched = byDistance.filter((t) => t.gap <= THUMB).slice(0, 2);
	if (touched.length > 0) return touched.map((t) => t.button);

	const nearest = byDistance[0];
	return nearest && nearest.gap <= THUMB * 2 ? [nearest.button] : [];
}


/* ------------------------------------------------------- remembered shape */

/**
 * Where the chosen shape is kept.
 *
 * Per device, deliberately. The same account plays on a phone and on a
 * desktop, and a shape picked for a thumb has no business following the player
 * to a machine with a keyboard - which is also why this is `localStorage` and
 * not the profile on the server.
 */
const SHAPE_KEY = 'psnes-touch-shape';

/** The sliver of `localStorage` this needs, so a test can stand in for it. */
export interface ShapeStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function storage(view?: ShapeStore): ShapeStore | null {
	if (view) return view;
	try {
		return globalThis.localStorage ?? null;
	} catch {
		// Reading the property itself throws where site data is blocked.
		return null;
	}
}

/**
 * The shape this device last chose, or the stick.
 *
 * The stick is the default because a thumb on glass has no edges to feel - see
 * the header of `TouchControls.svelte`. The cross is for the player who has
 * decided otherwise, and only for them.
 *
 * Anything unreadable, absent or unrecognised answers `stick`: a stored value
 * from a future version must not leave the pad with no directions at all.
 */
export function readDirectionMode(view?: ShapeStore): DirectionMode {
	const store = storage(view);
	if (!store) return 'stick';
	try {
		return store.getItem(SHAPE_KEY) === 'cross' ? 'cross' : 'stick';
	} catch {
		return 'stick';
	}
}

/** Remembers the choice, and shrugs where storage is refused. */
export function writeDirectionMode(mode: DirectionMode, view?: ShapeStore): void {
	const store = storage(view);
	if (!store) return;
	try {
		store.setItem(SHAPE_KEY, mode);
	} catch {
		// Private browsing. The pad still works; it just forgets.
	}
}
