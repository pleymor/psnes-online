/**
 * La parallaxe du mur de la chambre : quelques calques qui glissent, rien de plus.
 *
 * Chaque calque porte `data-depth`, de 0 (le mur, qui ne bouge pas) à 1 (ce
 * qui pend devant, qui bouge de `MAX_SHIFT` pixels au plus). La souris sur un
 * ordinateur, l'inclinaison du téléphone s'il la donne : deux sources, une
 * seule cible entre -1 et 1 sur chaque axe. Le mur défile avec la page, et
 * les calques glissent autour de leur place défilée.
 *
 * Le défilement n'est PAS une source. Il l'a été, sur téléphone, mais des
 * calques qui défilent à une autre vitesse que les étagères contredisent un
 * mur où elles sont accrochées, et suivre le défilement demandait un script à
 * chaque `scroll`, là où le navigateur fait défiler le mur tout seul. Même
 * le ciel derrière la fenêtre du mur bleu, seul calque vraiment « dehors »,
 * n'y a pas droit : il suit la souris et l'inclinaison comme les autres.
 * Un téléphone sans inclinaison a donc un mur immobile, ce qui vaut mieux
 * qu'un mur qui glisse sous ses étagères.
 *
 * LE COÛT, et c'est lui qui a décidé de la forme :
 *
 * - une seule boucle `requestAnimationFrame`, et seulement tant qu'un calque
 *   n'est pas arrivé : immobile, la parallaxe ne coûte rien, pas même un
 *   rappel par frame ;
 * - un `translate3d` par calque, rien d'autre - pas de mise en page, pas de
 *   peinture, le compositeur déplace des couches déjà peintes ;
 * - `paused` coupe tout, écouteurs compris : la page le pose dès qu'une
 *   partie tourne, pour que l'émulateur n'ait pas à partager ses frames.
 *
 * `prefers-reduced-motion: reduce`, ou `enabled: false` (l'interrupteur du
 * profil), et les calques reviennent au repos, sans boucle ni écouteur - y
 * compris si l'un ou l'autre change en cours de route. Le mur, lui, reste.
 *
 * L'inclinaison n'est jamais demandée : `DeviceOrientationEvent.requestPermission`
 * n'est appelé nulle part. Là où le navigateur la réserve à une permission
 * (iOS), `deviceorientation` n'arrive simplement pas et les calques restent au
 * repos ; coupée, la parallaxe n'écoute même pas.
 */

export interface ParallaxOptions {
	paused?: boolean;
	/** L'interrupteur du profil. Allumé à défaut. */
	enabled?: boolean;
}

/** Le déplacement du calque le plus proche, en pixels. Discret par décision. */
export const MAX_SHIFT = 18;

/** La part du chemin restant parcourue à chaque frame : un ressort très doux. */
const EASE = 0.08;

interface Layer {
	el: HTMLElement;
	depth: number;
}

function clamp(value: number): number {
	return Math.max(-1, Math.min(1, value));
}

export function parallax(root: HTMLElement, options: ParallaxOptions = {}) {
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

	let layers: Layer[] = [];
	let paused = !!options.paused;
	let enabled = options.enabled ?? true;
	let listening = false;
	let frame = 0;

	const target = { x: 0, y: 0 };
	const current = { x: 0, y: 0 };

	function collect() {
		layers = [...root.querySelectorAll<HTMLElement>('[data-depth]')].map((el) => ({
			el,
			depth: Number(el.dataset.depth) || 0
		}));
	}

	function paint() {
		for (const { el, depth } of layers) {
			// Arrondi au demi-pixel : un calque de pixel art ne doit pas baver.
			const x = Math.round(-current.x * depth * MAX_SHIFT * 2) / 2;
			const y = Math.round(-current.y * depth * MAX_SHIFT * 2) / 2;
			el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
		}
	}

	function step() {
		current.x += (target.x - current.x) * EASE;
		current.y += (target.y - current.y) * EASE;
		const settled =
			Math.abs(target.x - current.x) < 0.002 && Math.abs(target.y - current.y) < 0.002;
		if (settled) {
			current.x = target.x;
			current.y = target.y;
		}
		paint();
		frame = settled ? 0 : requestAnimationFrame(step);
	}

	function wake() {
		if (!frame) frame = requestAnimationFrame(step);
	}

	function onPointer(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		target.x = clamp((event.clientX / window.innerWidth) * 2 - 1);
		target.y = clamp((event.clientY / window.innerHeight) * 2 - 1);
		wake();
	}

	function onTilt(event: DeviceOrientationEvent) {
		if (event.gamma === null || event.beta === null) return;
		// Un téléphone se tient penché vers soi, vers 45° : c'est le repos.
		target.x = clamp(event.gamma / 30);
		target.y = clamp((event.beta - 45) / 30);
		wake();
	}

	function listen(on: boolean) {
		if (on === listening) return;
		listening = on;
		const method = on ? 'addEventListener' : 'removeEventListener';
		window[method]('pointermove', onPointer as EventListener, { passive: true });
		window[method]('deviceorientation', onTilt as EventListener, { passive: true });
	}

	function apply() {
		const off = motion.matches || !enabled;
		const still = off || paused;
		listen(!still);
		if (still) {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			if (off) {
				// Au repos, et non figés là où ils étaient.
				target.x = target.y = current.x = current.y = 0;
				paint();
			}
		}
	}

	collect();
	motion.addEventListener('change', apply);
	apply();

	return {
		update(next: ParallaxOptions = {}) {
			paused = !!next.paused;
			enabled = next.enabled ?? true;
			collect();
			apply();
		},
		destroy() {
			motion.removeEventListener('change', apply);
			listen(false);
			if (frame) cancelAnimationFrame(frame);
		}
	};
}
