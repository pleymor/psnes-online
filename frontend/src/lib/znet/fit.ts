/**
 * Sizing the picture to the window, at a chosen display ratio.
 *
 * This is arithmetic rather than CSS on purpose. "The largest box of ratio R
 * that fits in this container" is not expressible with `aspect-ratio` plus
 * `max-width` and `max-height`: when one axis is clamped the other is not
 * recomputed, so the ratio breaks in whichever orientation is not the
 * constrained one. The tricks that do work need the container's size in
 * viewport units, which is false here - a toolbar of variable height sits
 * above the picture.
 *
 * So the container measures itself and publishes the answer as two custom
 * properties. Both canvases read them from CSS, which keeps this to one
 * observer per room rather than one per canvas.
 */

/** How the SNES frame should be presented, independent of its buffer size. */
export type PixelAspect = 'square' | 'crt';

/**
 * The display ratio for a pixel aspect.
 *
 * The usual SNES output is 256x224, so square pixels give 8:7. A CRT stretched
 * that to 4:3, which is the shape the games were actually composed for - faces
 * are meant to be a little wider than the square-pixel version shows them.
 */
export function aspectRatioOf(aspect: PixelAspect): number {
	return aspect === 'crt' ? 4 / 3 : 8 / 7;
}

/**
 * Svelte action: publishes the largest `ratio`-shaped box that fits this
 * element, as `--fit-width` and `--fit-height`.
 *
 * Floors both values. A fractional CSS pixel makes the browser resample the
 * final blit, which is exactly the blur this is meant to avoid.
 */
export function fitToBox(node: HTMLElement, ratio: number) {
	let current = ratio;

	const apply = () => {
		const boxWidth = node.clientWidth;
		const boxHeight = node.clientHeight;
		// Before first layout, or a hidden room: leave the properties unset so the
		// CSS fallback applies rather than pinning the canvas to zero.
		if (boxWidth === 0 || boxHeight === 0) return;

		// Width-limited when the box is narrower than the ratio wants.
		const widthLimited = boxWidth / current <= boxHeight;
		const width = widthLimited ? boxWidth : boxHeight * current;
		const height = widthLimited ? boxWidth / current : boxHeight;

		node.style.setProperty('--fit-width', `${Math.floor(width)}px`);
		node.style.setProperty('--fit-height', `${Math.floor(height)}px`);
	};

	const observer = new ResizeObserver(apply);
	observer.observe(node);
	apply();

	return {
		update(next: number) {
			current = next;
			apply();
		},
		destroy() {
			observer.disconnect();
		}
	};
}
