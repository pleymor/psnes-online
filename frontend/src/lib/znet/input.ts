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

import type { PlayerControls, InputSources, Button } from '../controls/binding.js';
import { BUTTONS, parsePadCode } from '../controls/binding.js';
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

/** Tout écouter : le défaut d'un joueur seul, et rien d'autre. */
const EVERYTHING: InputSources = { keyboard: true, pads: 'all' };

export class InputCollector {
	private held = new Set<string>();
	/**
	 * Des paires plutôt qu'une Map : un code lié à deux boutons est un conflit
	 * que l'écran de config refuse de sauvegarder, mais une Map le perdrait en
	 * silence si jamais il arrivait quand même jusqu'ici.
	 */
	private keyBits: Array<[string, number]> = [];
	private padBits: Array<[string, number]> = [];
	private sources: InputSources = EVERYTHING;
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
				if (code) this.padBits.push([code, bit]);
			}
		}
	}

	/**
	 * Change les périphériques que ce joueur écoute.
	 *
	 * Vide ce qui est tenu au clavier quand le clavier s'en va : sinon une
	 * direction enfoncée au moment du changement n'aurait plus jamais son
	 * keyup, et resterait bloquée pour la vie de la session.
	 */
	setSources(sources: InputSources): void {
		if (this.sources.keyboard && !sources.keyboard) this.held.clear();
		this.sources = sources;
	}

	getSources(): InputSources {
		return this.sources;
	}

	attach(target: Window = window): void {
		if (this.attached) return;
		target.addEventListener('keydown', this.onKeyDown);
		target.addEventListener('keyup', this.onKeyUp);
		// Perdre le focus une touche enfoncée la laisserait tenue pour
		// toujours, et en lockstep c'est un bouton bloqué sur les deux machines.
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

	/** Le masque à envoyer pour la prochaine frame. */
	read(): PadMask {
		let mask = 0;
		if (this.sources.keyboard) {
			for (const [code, bit] of this.keyBits) {
				if (this.held.has(code)) mask |= bit;
			}
		}
		return sanitise(mask | this.readPads());
	}

	private readPads(): number {
		const { pads } = this.sources;
		if (pads !== 'all' && pads.length === 0) return 0;
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;

		let mask = 0;
		for (const pad of navigator.getGamepads()) {
			if (!pad?.connected) continue;
			if (pads !== 'all' && !pads.includes(pad.index)) continue;
			for (const [code, bit] of this.padBits) {
				if (readPadCode(pad, code)) mask |= bit;
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

function readPadCode(pad: Gamepad, code: string): boolean {
	const described = parsePadCode(code);
	if (!described) return false;
	if (described.kind === 'button') return pad.buttons[described.index]?.pressed ?? false;
	const value = pad.axes[described.index] ?? 0;
	return described.dir === 'minus' ? value < -AXIS_THRESHOLD : value > AXIS_THRESHOLD;
}

/**
 * Une vraie manette ne peut pas rapporter deux directions opposées à la fois,
 * et certains jeux prennent des chemins réellement indéfinis quand ils en
 * voient. Laisser tomber la seconde garde les deux pairs sur le chemin défini.
 */
function sanitise(mask: number): number {
	if ((mask & (PAD.LEFT | PAD.RIGHT)) === (PAD.LEFT | PAD.RIGHT)) mask &= ~PAD.RIGHT;
	if ((mask & (PAD.UP | PAD.DOWN)) === (PAD.UP | PAD.DOWN)) mask &= ~PAD.DOWN;
	return mask & 0x0fff;
}
