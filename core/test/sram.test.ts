/**
 * `sram.ts`: reading the battery save out of a machine and putting one back.
 *
 * Small on purpose - the encoding itself is `saves/base64.ts`'s job (already
 * tested); this only decides when there is nothing to encode.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { encodeSram, decodeSram, type SramCore } from '../../frontend/src/lib/rooms/sram.js';

function coreWith(bytes: Uint8Array): SramCore {
	return {
		sram: () => bytes,
		loadSram: () => {}
	};
}

test('a cartridge with no battery (empty SRAM) encodes to null, not an empty string', () => {
	const core = coreWith(new Uint8Array(0));

	assert.equal(encodeSram(core), null);
});

test('a non-empty SRAM encodes to a base64 string', () => {
	const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
	const core = coreWith(bytes);

	const encoded = encodeSram(core);

	assert.equal(typeof encoded, 'string');
	assert.notEqual(encoded, null);
});

test('decodeSram is the inverse of encodeSram: bytes survive the round trip', () => {
	const bytes = new Uint8Array([0, 1, 2, 3, 254, 255, 128, 64]);
	const core = coreWith(bytes);

	const encoded = encodeSram(core);
	assert.notEqual(encoded, null);
	const decoded = decodeSram(encoded as string);

	assert.deepEqual([...decoded], [...bytes]);
});

test('a single-byte SRAM (length is not what null-checks) still encodes and decodes', () => {
	const bytes = new Uint8Array([42]);
	const core = coreWith(bytes);

	const encoded = encodeSram(core);
	assert.notEqual(encoded, null, 'length 1 is not length 0');
	assert.deepEqual([...decodeSram(encoded as string)], [42]);
});
