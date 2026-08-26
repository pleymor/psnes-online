/**
 * Fullscreen, and the difference between leaving it and being thrown out of it.
 *
 * The distinction is the whole reason this is not two lines inline: the only
 * way out of fullscreen the page did not ask for is Escape, and in a room
 * Escape means "open the menu" - but the keydown never arrives, the browser
 * consumes it. So a change that was not deliberate has to be recognisable.
 *
 * `element` is a getter, not a value: the stage does not exist when the
 * component's script runs, and passing the binding directly would capture
 * undefined for the lifetime of the room.
 */
export function createFullscreen(opts: {
	element: () => HTMLElement | undefined;
	onChange: (isFullscreen: boolean, deliberate: boolean) => void;
}) {
	let deliberate = false;

	function onFullscreenChange(): void {
		const wasDeliberate = deliberate;
		deliberate = false;
		opts.onChange(!!document.fullscreenElement, wasDeliberate);
	}

	async function toggle(): Promise<void> {
		deliberate = true;
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await opts.element()?.requestFullscreen();
		} catch (err) {
			deliberate = false;
			throw err;
		}
	}

	/** Goes back to fullscreen after a menu that was opened from it. */
	function restore(): void {
		if (document.fullscreenElement) return;
		deliberate = true;
		void opts.element()?.requestFullscreen().catch(() => {
			deliberate = false;
		});
	}

	function attach(): void {
		document.addEventListener('fullscreenchange', onFullscreenChange);
	}
	function detach(): void {
		document.removeEventListener('fullscreenchange', onFullscreenChange);
	}

	return { toggle, restore, attach, detach };
}
