/**
 * Where the health values live, per ROM.
 *
 * Addresses are per-ROM, not per-game. There are several Dragon Ball Z 2s -
 * the Japanese *Super Butouden 2*, the French PAL release, and a fan
 * translation of the first - and they are different dumps with different
 * layouts. Reading the right address in the wrong one gives a plausible
 * number, not an error, which is why this table is keyed on `Game.crc32` and
 * why an unknown checksum is refused rather than guessed at.
 *
 * A table with one row in it is the same work as one hardcoded game, and
 * admits what it is: the next title is a row, not a rewrite.
 *
 * Every row carries how it was found. Finding an address is a memory-search
 * session against a running game, not a code-reading task, and without the
 * method written down the next person redoes the search from scratch and
 * cannot tell a wrong address from one the game moved.
 */

import type { MatchWatcher } from './match-watch.js';

/** Work RAM is byte-addressed from $7E0000, so an offset is an SNES address. */
function u16(wram: Uint8Array, at: number): number {
	return wram[at] | (wram[at + 1] << 8);
}

/**
 * Dragon Ball Z: La Legende Saien - the French PAL release of Super Butouden 2.
 *
 * Internal header title "DRAGONBALL Z 2", destination 0x06 (France), LoROM,
 * 2MB unheadered, 50.007Hz. CRC32 of the normalised dump, which is what
 * `Game.crc32` holds.
 *
 * How the addresses were found, so they can be checked or redone:
 *
 *  1. Boot the dump headless and drive it to a versus match - title screen,
 *     START to the mode menu, DOWN to COMBAT, A, A for 1P VS 2P, a character
 *     each, then A past the HANDICAP screen and START through the pre-fight
 *     dialogue. The HANDICAP screen is the hint that matters: it shows VIE
 *     400 per side, so the value being looked for is a known decimal number.
 *  2. Scan all 128KB of work RAM for the 16-bit little-endian value 400 at the
 *     moment the fight starts. Ten hits, in five pairs: $7E0560/$7E0562,
 *     $7E0660/$7E0662, $7E169C/$7E169E, $7E4D20/$7E4D22, $7E4E20/$7E4E22.
 *  3. Have player 1 attack while player 2 stands still. Only $7E0662 falls.
 *     Reverse the roles: only $7E0562 falls. That is current health, and the
 *     0x100 stride between the two ports is the per-player struct.
 *  4. Change VIE on the HANDICAP screen before starting. The pair comes up
 *     340/340 and 40/40 rather than 400/400, which is what proves $7E0560 and
 *     $7E0660 are each port's *maximum* - written together with current health
 *     when the round begins - and not a constant that happened to read 400.
 *
 * Two behaviours were measured at the same time and the observer depends on
 * both. A versus match has no time limit: left untouched for 200 emulated
 * seconds nothing moves and nothing ends. And a single knockout ends the whole
 * match - there are no rounds to count - after which the loser's health sits
 * at zero through the KO animation, the victory screen and every menu after
 * it, until a new fight writes both sides back to full.
 */
const DBZ2_FRANCE: MatchWatcher = {
	crc32: '8F24F886',
	rom: 'Dragon Ball Z: La Legende Saien (France)',
	read(wram: Uint8Array) {
		// The last byte the row needs, not the console's nominal size: a dump
		// read through a short view must yield nothing rather than undefined
		// arithmetic that reads as a plausible zero.
		if (wram.length < 0x0664) return null;
		return {
			p1: { max: u16(wram, 0x0560), current: u16(wram, 0x0562) },
			p2: { max: u16(wram, 0x0660), current: u16(wram, 0x0662) }
		};
	}
};

export const WATCHED_ROMS: readonly MatchWatcher[] = [DBZ2_FRANCE];
