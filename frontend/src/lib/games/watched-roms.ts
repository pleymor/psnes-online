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

/**
 * Dragon Ball Z: Super Butouden - the French release of the FIRST one.
 *
 * Internal header title "SFX DRAGONBALLZ2", which is a quirk of this release
 * and not a mistake here: the cartridge announces Z2 and is Z1. The checksum is
 * what the table keys on, so the lie costs nothing.
 *
 * How the addresses were found, so they can be checked or redone:
 *
 *  1. The dump boots into an attract demo, not a title screen - 868 bytes of
 *     work RAM move with no pad touched at all, and both fighters take damage
 *     on their own. A differential search run there finds two hundred addresses
 *     and means nothing, which is worth knowing before spending an hour on it.
 *     A first A leaves the demo, a second opens the menu.
 *  2. The menu is a 2x2 grid - HISTOIRE and CHAMPIONNAT above, OPTION and
 *     COMBAT below. RIGHT then DOWN reaches COMBAT; A enters it; RIGHT moves
 *     from "1P VS ORD" to "1P VS 2P"; A takes it. Then one A per port on the
 *     character grid.
 *  3. The screen after the characters is this game's HANDICAP: it prints
 *     "VIE 300" for each side, in decimal, which is what makes the search a
 *     search rather than a trawl. Scanning 128KB for the 16-bit value 300 gives
 *     seven hits, six of them in two blocks 0x100 apart - the same per-player
 *     stride Z2 uses, the two games sharing an engine.
 *  4. Have player 1 walk in and swing while player 2 stands still: $7E0660 and
 *     $7E0664 fall, $7E0640 does not. Reverse it and $7E0560 and $7E0564 fall
 *     while $7E0540 holds. Raise VIE for player 1 alone on the options screen
 *     and $7E0540 and $7E0560 come up to the new number while player 2 keeps
 *     300 - which is what proves those are maxima and not a constant that
 *     happened to read 300.
 *
 * **Why this row reads $7E0564 and not $7E0560.** Both fall with damage, but
 * they are not the same number. $7E0560 is the real health and it UNDERFLOWS:
 * a finishing blow that overshoots leaves 65535, not 0. Z2 clamps and this one
 * does not, and `isPlausible` rejects a current above its maximum - so a
 * knockout read there would be discarded in silence, which is exactly the
 * failure this table exists to avoid. $7E0564 is the bar as drawn: it lags by a
 * few points, it stops at 0, and it stays there through the knockout animation
 * and every menu after it, measured over 1800 frames.
 *
 * One consequence of reading the drawn bar: it starts a round at 0 and fills,
 * so "both sides full" arrives a moment after the fight does rather than on its
 * first frame. The observer samples twice a second for the whole match, so it
 * arms either way.
 */
const DBZ1_FRANCE: MatchWatcher = {
	crc32: 'EA7ABAD1',
	rom: 'Dragon Ball Z: Super Butouden (France)',
	read(wram: Uint8Array) {
		// Same rule as the row above: the last byte this row needs, not the
		// console's nominal size.
		if (wram.length < 0x0666) return null;
		return {
			p1: { max: u16(wram, 0x0540), current: u16(wram, 0x0564) },
			p2: { max: u16(wram, 0x0640), current: u16(wram, 0x0664) }
		};
	}
};

export const WATCHED_ROMS: readonly MatchWatcher[] = [DBZ2_FRANCE, DBZ1_FRANCE];
