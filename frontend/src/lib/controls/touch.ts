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

	get mask(): PadMask {
		return this.buttons | this.stick;
	}

	press(button: Button): void {
		this.buttons |= BUTTON_BITS[button];
	}

	release(button: Button): void {
		this.buttons &= ~BUTTON_BITS[button];
	}

	/** Where the thumb is, relative to the stick's centre and radius. */
	setStick(dx: number, dy: number): void {
		this.stick = stickMask(dx, dy);
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
