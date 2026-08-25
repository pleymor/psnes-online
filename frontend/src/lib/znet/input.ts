/**
 * Collects local input into a libretro pad mask.
 *
 * This is the only place a browser event can influence emulation, and it does
 * so through exactly one value: the 12-bit mask the session samples once per
 * frame. Keyboard state is latched here rather than polled from the emulator,
 * so a key that is pressed and released between two frames still registers,
 * and so a burst of catch-up frames cannot read the same physical press twice
 * at different times on the two peers.
 */

import type { PlayerControls, InputSources, Button, PadCodeDescriptor } from '../controls/binding.js';
import { BUTTONS, parsePadCode } from '../controls/binding.js';
import type { TouchPad } from '../controls/touch.js';
import { PAD, type PadMask } from './protocol.js';

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

const AXIS_THRESHOLD = 0.5;

/**
 * Listen to everything: the default for a lone player, and nothing else.
 *
 * Frozen, and shared by every collector that does not pass its own sources:
 * `getSources()` must never hand out this exact object, or a caller mutating
 * it would corrupt the default for every collector created afterwards.
 */
const EVERYTHING: InputSources = Object.freeze({ keyboard: true, pads: 'all' });

export class InputCollector {
	private held = new Set<string>();
	/**
	 * Pairs rather than a Map: a code bound to two buttons is a conflict the
	 * config screen refuses to save, but a Map would lose it silently if one
	 * ever reached here anyway.
	 */
	private keyBits: Array<[string, number]> = [];
	/**
	 * Already-resolved descriptors rather than raw codes: `read()` runs at 60 Hz,
	 * and reparsing every controller code every frame for every pad would make
	 * on the order of a thousand objects a second of garbage - a GC pause in the
	 * emulator is audible as an audio glitch.
	 */
	private padBits: Array<[PadCodeDescriptor, number]> = [];
	private sources: InputSources = EVERYTHING;
	/**
	 * The on-screen pad, when there is one. Not part of `InputSources`: that
	 * describes hardware the browser enumerates, and a touch pad is drawn by the
	 * room rather than plugged into the machine.
	 */
	private touch: TouchPad | null = null;
	private attached = false;
	private onKeyDown = (e: KeyboardEvent) => this.handleKey(e, true);
	private onKeyUp = (e: KeyboardEvent) => this.handleKey(e, false);
	private onBlur = () => this.held.clear();

	constructor(controls: PlayerControls, sources: InputSources = EVERYTHING) {
		this.setControls(controls);
		this.sources = sources;
	}

	setControls(controls: PlayerControls): void {
		this.keyBits = [];
		this.padBits = [];
		for (const button of BUTTONS) {
			const bit = BUTTON_BITS[button];
			const key = controls.keys[button];
			if (key) this.keyBits.push([key, bit]);
			for (const code of controls.pad[button] ?? []) {
				if (!code) continue;
				const descriptor = parsePadCode(code);
				if (descriptor) this.padBits.push([descriptor, bit]);
			}
		}
	}

	/**
	 * Changes the devices this player listens to.
	 *
	 * Clears what is held on the keyboard when the keyboard goes away: otherwise
	 * a direction pressed at the moment of the change would never get its keyup,
	 * and would stay jammed for the life of the session.
	 */
	setSources(sources: InputSources): void {
		if (this.sources.keyboard && !sources.keyboard) this.held.clear();
		this.sources = sources;
	}

	/** A copy: mutating the returned value must not touch this player. */
	getSources(): InputSources {
		return { ...this.sources };
	}

	/**
	 * Attaches, or drops, the on-screen pad this player plays with.
	 *
	 * Passing `null` silences it immediately rather than waiting for a release
	 * event: the pad is dropped precisely when it stops being drawn - a
	 * controller was plugged in, or the room is going away - and the button
	 * under the thumb at that moment would never get its `pointerup`.
	 */
	setTouchPad(pad: TouchPad | null): void {
		this.touch = pad;
	}

	attach(target: Window = window): void {
		if (this.attached) return;
		target.addEventListener('keydown', this.onKeyDown);
		target.addEventListener('keyup', this.onKeyUp);
		// Losing focus with a key down would otherwise leave it held forever,
		// and in lockstep that is a stuck button on both machines.
		target.addEventListener('blur', this.onBlur);
		this.attached = true;
	}

	detach(target: Window = window): void {
		if (!this.attached) return;
		target.removeEventListener('keydown', this.onKeyDown);
		target.removeEventListener('keyup', this.onKeyUp);
		target.removeEventListener('blur', this.onBlur);
		this.held.clear();
		this.attached = false;
	}

	/** The pad mask to send for the next scheduled frame. */
	read(): PadMask {
		let mask = 0;
		if (this.sources.keyboard) {
			for (const [code, bit] of this.keyBits) {
				if (this.held.has(code)) mask |= bit;
			}
		}
		return sanitise(mask | this.readPads() | (this.touch?.mask ?? 0));
	}

	private readPads(): number {
		const { pads } = this.sources;
		if (pads !== 'all' && pads.length === 0) return 0;
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;

		let mask = 0;
		for (const pad of navigator.getGamepads()) {
			if (!pad?.connected) continue;
			if (pads !== 'all' && !pads.includes(pad.index)) continue;
			for (const [descriptor, bit] of this.padBits) {
				if (readPadCode(pad, descriptor)) mask |= bit;
			}
		}
		return mask;
	}

	private handleKey(event: KeyboardEvent, down: boolean): void {
		if (!this.sources.keyboard) return;
		if (!this.keyBits.some(([code]) => code === event.code)) return;
		event.preventDefault();
		if (down) this.held.add(event.code);
		else this.held.delete(event.code);
	}
}

function readPadCode(pad: Gamepad, described: PadCodeDescriptor): boolean {
	if (described.kind === 'button') return pad.buttons[described.index]?.pressed ?? false;
	const value = pad.axes[described.index] ?? 0;
	return described.dir === 'minus' ? value < -AXIS_THRESHOLD : value > AXIS_THRESHOLD;
}

/**
 * Real controllers cannot report opposing directions at once, and some games
 * take genuinely undefined paths when they see it. Dropping the second
 * direction here keeps both peers on the defined path.
 */
function sanitise(mask: number): number {
	if ((mask & (PAD.LEFT | PAD.RIGHT)) === (PAD.LEFT | PAD.RIGHT)) mask &= ~PAD.RIGHT;
	if ((mask & (PAD.UP | PAD.DOWN)) === (PAD.UP | PAD.DOWN)) mask &= ~PAD.DOWN;
	return mask & 0x0fff;
}
