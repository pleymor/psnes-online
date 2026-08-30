/**
 * The Dragon Ball Z 2 addresses, against the cartridge they were measured on.
 *
 * The rest of the match-watch suite runs on synthetic work RAM: it pins the
 * state machine, which is the part that has bugs. This pins the part that
 * cannot be reasoned about at all - four numbers found by searching a running
 * game's memory - and it is the only thing that can tell a wrong address from
 * one a different dump moved.
 *
 * It needs the exact dump, so it skips unless that dump is on this machine.
 * The navigation below is not incidental: it is the memory-search session
 * written down, and it is what someone adding the Japanese Super Butouden 2 to
 * the table would copy and re-run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { coreIsBuilt, findTestRomByCrc, makeCore } from './helpers.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import { MatchObserver, watcherFor } from '../../frontend/src/lib/games/match-watch.js';
import type { MatchVerdict } from '../../frontend/src/lib/games/match-watch.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

/** Dragon Ball Z: La Legende Saien (France) - the French PAL Super Butouden 2. */
const DBZ2 = '8F24F886';

const built = coreIsBuilt();
const rom = built ? findTestRomByCrc(DBZ2) : null;

const needsDbz2 = {
	skip: !built
		? 'core not built - run ./core/build.sh'
		: !rom
			? `no ROM with checksum ${DBZ2} found - set PSNES_TEST_ROM`
			: false
};

/** Holds a button for a few frames on one port, then lets the game settle. */
function tap(core: PsnesCore, mask: number, port: 1 | 2, hold = 6, after = 40): void {
	for (let i = 0; i < hold; i++) core.runFrame(port === 1 ? mask : 0, port === 2 ? mask : 0);
	for (let i = 0; i < after; i++) core.runFrame(0, 0);
}

/**
 * Boots into round one of a two-player COMBAT match.
 *
 * Frame counts are generous rather than tight: this is a 50Hz machine with
 * animated transitions between every screen, and a sequence that only works
 * when each wait is exactly long enough is a sequence nobody can adapt.
 */
function toVersusMatch(core: PsnesCore): void {
	// Company logos and the animated intro, up to the title screen.
	for (let i = 0; i < 2400; i++) core.runFrame(0, 0);
	// START through the intro cutscene until the mode menu appears. START does
	// nothing on the menu itself, so over-pressing here is free.
	for (let k = 0; k < 21; k++) {
		for (let i = 0; i < 150; i++) core.runFrame(i < 6 ? PAD.START : 0, 0);
	}
	tap(core, PAD.DOWN, 1, 6, 40); // HISTOIRE -> COMBAT
	tap(core, PAD.A, 1, 6, 90); // COMBAT -> 1P VS 2P
	tap(core, PAD.A, 1, 6, 90); // -> CHOIX, the character select
	tap(core, PAD.A, 1, 6, 60); // player 1 takes the character under its cursor
	tap(core, PAD.DOWN, 2, 6, 30);
	tap(core, PAD.A, 2, 6, 90); // player 2 takes another
	for (let i = 0; i < 300; i++) core.runFrame(0, 0);
	// The HANDICAP screen: VIE 400 a side by default, which is where the value
	// the memory search looks for comes from. A leaves it.
	tap(core, PAD.A, 1, 6, 150);
	// The pre-fight dialogue, skipped a line at a time.
	for (let k = 0; k < 10; k++) tap(core, PAD.START, 1, 6, 60);
}

/**
 * One boot, reused.
 *
 * Reaching a match takes some eleven thousand emulated frames, about eight
 * seconds. Every test here starts from the same savestate rather than paying
 * that again, which also means they all start from a genuinely identical
 * machine.
 */
let fixture: Promise<{ core: PsnesCore; atMatchStart: Uint8Array }> | null = null;

function versusMatch() {
	fixture ??= (async () => {
		const core = await makeCore();
		core.loadRom(rom!.data);
		toVersusMatch(core);
		return { core, atMatchStart: core.saveState() };
	})();
	return fixture;
}

/** Walks into the other player and swings, which is all a damage test needs. */
const ATTACKS = [
	PAD.RIGHT,
	PAD.RIGHT | PAD.B,
	PAD.RIGHT,
	PAD.B,
	PAD.A,
	PAD.Y,
	PAD.RIGHT | PAD.A,
	PAD.X
];

test('a fresh match reads as both players on full health', needsDbz2, async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	const sample = watcherFor(DBZ2)!.read(core.wram())!;

	// 400 is what the HANDICAP screen showed, which is what makes these four
	// addresses findable at all rather than four numbers among a hundred.
	assert.deepEqual(sample, {
		p1: { max: 400, current: 400 },
		p2: { max: 400, current: 400 }
	});
});

test('hitting player 2 moves player 2 health and nothing else', needsDbz2, async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	for (let f = 0; f < 600; f++) core.runFrame(ATTACKS[f % ATTACKS.length], 0);
	const sample = watcherFor(DBZ2)!.read(core.wram())!;

	// The step that separates current health from the four other pairs of
	// addresses that also held 400 at the start of the match.
	assert.ok(sample.p2.current < 400, `player 2 took no damage (${sample.p2.current})`);
	assert.equal(sample.p1.current, 400, 'the attacker must not lose health');
	assert.equal(sample.p1.max, 400, 'nor may either maximum move mid-match');
	assert.equal(sample.p2.max, 400);
});

test('hitting player 1 moves player 1 health, so the ports are not swapped', needsDbz2, async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	// The mirror image: walk left instead of right, on the second port.
	const mirrored = ATTACKS.map((mask) => (mask & PAD.RIGHT ? (mask & ~PAD.RIGHT) | PAD.LEFT : mask));
	for (let f = 0; f < 600; f++) core.runFrame(0, mirrored[f % mirrored.length]);
	const sample = watcherFor(DBZ2)!.read(core.wram())!;

	assert.ok(sample.p1.current < 400, `player 1 took no damage (${sample.p1.current})`);
	assert.equal(sample.p2.current, 400);
});

test('a knockout is reported once, to the player left standing', needsDbz2, async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	const verdicts: MatchVerdict[] = [];
	const observer = new MatchObserver({
		watcher: watcherFor(DBZ2)!,
		readWram: () => core.wram(),
		onVerdict: (verdict) => verdicts.push(verdict)
	});

	// Sampled at full health first, which is what arms a match - and is what
	// the observer would see on any frame of a real one.
	observer.observe(0);

	// Player 2 is then put within one hit of losing rather than beaten down
	// over the five thousand frames a full health bar takes. The point of this
	// test is the machine's behaviour *after* the knockout - the animation, the
	// victory screen, the menus - and that is emulated in full below.
	const wram = core.wram();
	wram[0x0662] = 10;
	wram[0x0663] = 0;

	for (let f = 1; f < 900; f++) {
		core.runFrame(ATTACKS[f % ATTACKS.length], 0);
		observer.observe(f);
	}

	assert.equal(verdicts.length, 1, 'the KO animation must not report a winner every sample');
	assert.equal(verdicts[0].winner, 1);
	assert.equal(verdicts[0].health.p2, 0);
	assert.deepEqual([...observer.score], [1, 0]);
});

test('a versus match has no clock to run out', needsDbz2, async () => {
	// Worth pinning because the observer depends on it: with no time limit the
	// only way a match ends is a knockout, which is why there is no third
	// outcome to watch for. Two hundred emulated seconds of nobody moving.
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	for (let f = 0; f < 10_000; f++) core.runFrame(0, 0);
	const sample = watcherFor(DBZ2)!.read(core.wram())!;

	assert.deepEqual(sample, {
		p1: { max: 400, current: 400 },
		p2: { max: 400, current: 400 }
	});
});
