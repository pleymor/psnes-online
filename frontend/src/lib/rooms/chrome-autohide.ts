/**
 * Shows the in-game toolbar, then hides it again after a while.
 *
 * Sixty lines of timer bookkeeping in a component that had far too much of it.
 * `reveal` takes the fullscreen state as a parameter rather than reading it:
 * out of fullscreen the toolbar sits in normal flow and there is nothing to
 * hide, and passing it in keeps this module free of reactive state.
 */
export function createChromeAutohide(opts: {
	idleMs: number;
	onVisibility: (visible: boolean) => void;
}) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let held = false;

	function clear(): void {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	/** Shows the toolbar and restarts the countdown that hides it again. */
	function reveal(active: boolean): void {
		opts.onVisibility(true);
		clear();
		if (!active || held) return;
		timer = setTimeout(() => {
			timer = null;
			opts.onVisibility(false);
		}, opts.idleMs);
	}

	/**
	 * Whether the pointer or the focus is on the toolbar itself.
	 *
	 * A pointer resting on a button sends no further mousemove, so the
	 * countdown would hide the very control the player is reaching for - and a
	 * hidden toolbar takes `pointer-events: none`, so CSS `:hover` cannot
	 * rescue it. The hold has to be tracked here, where it can stop the timer.
	 */
	function hold(active: boolean): void {
		held = true;
		reveal(active);
	}

	function release(active: boolean): void {
		held = false;
		reveal(active);
	}

	function stop(): void {
		clear();
		held = false;
	}

	return { reveal, hold, release, stop };
}
