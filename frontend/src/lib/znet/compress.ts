/**
 * Run-length coding for the savestate transfer.
 *
 * A snes9x state is ~823KB and most of it is zeroes and repeated patterns;
 * this brings it to ~81KB in about 4ms. That matters more than it looks: the
 * state travels down the same socket as the pad packets, so until it has
 * drained every pad queues behind it. In production it showed up as a minute
 * of "waiting for the other player" at the start of a session, with a measured
 * round trip of 320ms decaying to 62ms as the backlog cleared.
 *
 * Gzip via CompressionStream reaches ~60KB, but it is asynchronous, and that
 * costs more than the 2.6 points it wins: the netplay tests drive whole
 * sessions through a synchronous virtual clock, which is what makes them fast
 * and reproducible, and an await inside the session would strand them. It also
 * introduces a window in which the epoch can change while a state is being
 * compressed, so a superseded machine could be shipped. Neither is worth
 * 20KB on a transfer that happens once per session.
 *
 * Format: a stream of tokens.
 *   0, count, byte    - `count` copies of `byte`   (count 3..255)
 *   1, count, bytes…  - `count` literal bytes      (count 1..254)
 */

const RUN = 0;
const LITERAL = 1;
const MAX_RUN = 255;
const MAX_LITERAL = 254;
/** Shorter runs cost more to encode than they save. */
const MIN_RUN = 3;

export function compress(src: Uint8Array): Uint8Array {
	// Worst case is all literals: two bytes of header per 254 payload bytes.
	const out = new Uint8Array(src.length + Math.ceil(src.length / MAX_LITERAL) * 2 + 8);
	let o = 0;
	let i = 0;

	while (i < src.length) {
		let run = 1;
		while (run < MAX_RUN && i + run < src.length && src[i + run] === src[i]) run++;

		if (run >= MIN_RUN) {
			out[o++] = RUN;
			out[o++] = run;
			out[o++] = src[i];
			i += run;
			continue;
		}

		const start = i;
		let literal = 0;
		while (i < src.length && literal < MAX_LITERAL) {
			// Stop the literal run as soon as a worthwhile repeat begins.
			let ahead = 1;
			while (ahead < MIN_RUN && i + ahead < src.length && src[i + ahead] === src[i]) ahead++;
			if (ahead >= MIN_RUN) break;
			i++;
			literal++;
		}
		out[o++] = LITERAL;
		out[o++] = literal;
		out.set(src.subarray(start, start + literal), o);
		o += literal;
	}

	return out.subarray(0, o);
}

export function decompress(src: Uint8Array): Uint8Array {
	// Two passes: the first sizes the output exactly, so no reallocation and no
	// chance of silently truncating a state.
	let size = 0;
	for (let i = 0; i < src.length; ) {
		const token = src[i];
		const count = src[i + 1];
		if (token === RUN) {
			size += count;
			i += 3;
		} else if (token === LITERAL) {
			size += count;
			i += 2 + count;
		} else {
			throw new Error(`corrupt compressed state: token ${token} at ${i}`);
		}
	}

	const out = new Uint8Array(size);
	let o = 0;
	for (let i = 0; i < src.length; ) {
		const token = src[i];
		const count = src[i + 1];
		if (token === RUN) {
			out.fill(src[i + 2], o, o + count);
			o += count;
			i += 3;
		} else {
			out.set(src.subarray(i + 2, i + 2 + count), o);
			o += count;
			i += 2 + count;
		}
	}
	return out;
}
