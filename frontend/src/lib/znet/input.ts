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

import type { KeyConfig } from '$lib/types';
import { PAD, type PadMask } from './protocol.js';

const BUTTONS = [
	'a',
	'b',
	'x',
	'y',
	'l',
	'r',
	'start',
	'select',
	'up',
	'down',
	'left',
	'right'
] as const;

type Button = (typeof BUTTONS)[number];

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

/** Standard gamepad button indices, matching the layout browsers report. */
const GAMEPAD_BITS: Array<[number, number]> = [
	[0, PAD.B],
	[1, PAD.A],
	[2, PAD.Y],
	[3, PAD.X],
	[4, PAD.L],
	[5, PAD.R],
	[8, PAD.SELECT],
	[9, PAD.START],
	[12, PAD.UP],
	[13, PAD.DOWN],
	[14, PAD.LEFT],
	[15, PAD.RIGHT]
];

const AXIS_THRESHOLD = 0.5;

/**
 * Which gamepad a player is driving.
 *
 * 'auto' merges every connected pad, which is right when one player sits at one
 * machine. It is wrong the moment two windows share a machine - both read the
 * same physical pad, so one controller drives both players. 'off' and an
 * explicit index exist for that case.
 */
export type GamepadSource = 'auto' | 'off' | number;

export class InputCollector {
	private held = new Set<string>();
	private codeToBit = new Map<string, number>();
	private gamepadSource: GamepadSource = 'auto';
	private attached = false;
	private onKeyDown = (e: KeyboardEvent) => this.handleKey(e, true);
	private onKeyUp = (e: KeyboardEvent) => this.handleKey(e, false);
	private onBlur = () => this.held.clear();

	constructor(keyConfig: KeyConfig, gamepadSource: GamepadSource = 'auto') {
		this.setKeyConfig(keyConfig);
		this.gamepadSource = gamepadSource;
	}

	setGamepadSource(source: GamepadSource): void {
		this.gamepadSource = source;
	}

	getGamepadSource(): GamepadSource {
		return this.gamepadSource;
	}

	/** Indices of the pads the browser currently reports, for a picker. */
	connectedGamepads(): number[] {
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
		const out: number[] = [];
		for (const pad of navigator.getGamepads()) {
			if (pad?.connected) out.push(pad.index);
		}
		return out;
	}

	setKeyConfig(keyConfig: KeyConfig): void {
		this.codeToBit.clear();
		for (const button of BUTTONS) {
			const code = keyConfig[button];
			if (code) this.codeToBit.set(code, BUTTON_BITS[button]);
		}
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
		for (const code of this.held) {
			mask |= this.codeToBit.get(code) ?? 0;
		}
		mask |= this.readGamepad();
		return sanitise(mask);
	}

	private readGamepad(): number {
		if (this.gamepadSource === 'off') return 0;
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
		let mask = 0;
		for (const pad of navigator.getGamepads()) {
			if (!pad?.connected) continue;
			if (this.gamepadSource !== 'auto' && pad.index !== this.gamepadSource) continue;
			for (const [index, bit] of GAMEPAD_BITS) {
				if (pad.buttons[index]?.pressed) mask |= bit;
			}
			const [x = 0, y = 0] = pad.axes;
			if (x < -AXIS_THRESHOLD) mask |= PAD.LEFT;
			if (x > AXIS_THRESHOLD) mask |= PAD.RIGHT;
			if (y < -AXIS_THRESHOLD) mask |= PAD.UP;
			if (y > AXIS_THRESHOLD) mask |= PAD.DOWN;
		}
		return mask;
	}

	private handleKey(event: KeyboardEvent, down: boolean): void {
		if (!this.codeToBit.has(event.code)) return;
		event.preventDefault();
		if (down) this.held.add(event.code);
		else this.held.delete(event.code);
	}
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
