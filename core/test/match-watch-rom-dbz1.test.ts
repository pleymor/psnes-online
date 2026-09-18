/**
 * Les adresses de Super Butouden 1, contre la cartouche où elles ont été prises.
 *
 * Jumeau de `match-watch-rom.test.ts`, pour le premier des deux jeux. Ce qui
 * s'y joue de particulier tient en une ligne : cette cartouche **déborde**. Une
 * vie poussée sous zéro n'y est pas bornée, elle repasse à 65535, et un
 * observateur qui lirait la vie réelle jetterait le KO en silence parce qu'une
 * vie supérieure au maximum n'est pas plausible. La ligne lit donc la barre
 * dessinée, qui s'arrête à zéro - et le test ci-dessous est ce qui empêche de
 * « simplifier » ce choix sans s'en apercevoir.
 *
 * Il lui faut le dump exact, donc il se saute si ce dump n'est pas là.
 */

import assert from 'node:assert/strict';

import { optional } from './skip.js';
import { coreIsBuilt, findTestRomByCrc, makeCore } from './helpers.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import { MatchObserver, watcherFor } from '../../frontend/src/lib/games/match-watch.js';
import type { MatchVerdict } from '../../frontend/src/lib/games/match-watch.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

/** Dragon Ball Z: Super Butouden (France) - le premier, malgré son en-tête. */
const DBZ1 = 'EA7ABAD1';

const built = coreIsBuilt();
const rom = built ? findTestRomByCrc(DBZ1) : null;

const needsDbz1 = optional(
	!built
		? 'core not built - run ./core/build.sh'
		: !rom
			? `no ROM with checksum ${DBZ1} found - set PSNES_TEST_ROM`
			: false
);

/** Tient un bouton quelques images sur un port, puis laisse le jeu respirer. */
function tap(core: PsnesCore, mask: number, port: 1 | 2 = 1, after = 90): void {
	for (let i = 0; i < 6; i++) core.runFrame(port === 1 ? mask : 0, port === 2 ? mask : 0);
	for (let i = 0; i < after; i++) core.runFrame(0, 0);
}

/**
 * Amène le jeu à un combat 1P contre 2P.
 *
 * Le premier A quitte la démonstration d'attraction - ce dump n'ouvre pas sur
 * un écran-titre mais sur un combat que la machine joue toute seule, et une
 * recherche mémoire lancée là ne mesure rien. Le second ouvre le menu.
 */
function toVersusMatch(core: PsnesCore): void {
	for (let i = 0; i < 2400; i++) core.runFrame(0, 0);
	tap(core, PAD.A, 1, 150); // sortir de la démonstration
	tap(core, PAD.A, 1, 150); // ouvrir le menu
	tap(core, PAD.RIGHT, 1, 90); // HISTOIRE -> CHAMPIONNAT
	tap(core, PAD.DOWN, 1, 90); // -> COMBAT
	tap(core, PAD.A, 1, 200);
	tap(core, PAD.RIGHT, 1, 90); // 1P VS ORD -> 1P VS 2P
	tap(core, PAD.A, 1, 250);
	tap(core, PAD.A, 1, 150); // le port 1 prend le personnage sous son curseur
	tap(core, PAD.DOWN, 2, 60);
	tap(core, PAD.A, 2, 250); // le port 2 en prend un autre
	for (let i = 0; i < 400; i++) core.runFrame(0, 0);
	// L'écran d'options, qui affiche VIE 300 de chaque côté. A le laisse.
	tap(core, PAD.A, 1, 200);
	tap(core, PAD.START, 1, 200);
	for (let i = 0; i < 500; i++) core.runFrame(0, 0);
}

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

/**
 * Marcher jusqu'à l'adversaire, puis frapper.
 *
 * Deux temps, et pas un seul : les deux combattants commencent loin l'un de
 * l'autre sur cette cartouche, et une séquence qui frappe en avançant ne touche
 * jamais. Mille cinq cents images de coups dans le vide avant de s'en rendre
 * compte, la première fois.
 */
function beatDown(core: PsnesCore, port: 1 | 2, cycles: number): void {
	const toward = port === 1 ? PAD.RIGHT : PAD.LEFT;
	for (let c = 0; c < cycles; c++) {
		for (let f = 0; f < 150; f++) core.runFrame(port === 1 ? toward : 0, port === 2 ? toward : 0);
		for (let f = 0; f < 150; f++) {
			const mask = f % 12 < 4 ? PAD.B : f % 12 < 8 ? PAD.A : PAD.Y;
			core.runFrame(port === 1 ? mask : 0, port === 2 ? mask : 0);
		}
	}
}

const u16 = (w: Uint8Array, at: number) => w[at] | (w[at + 1] << 8);

needsDbz1('un combat neuf lit les deux camps à pleine vie', async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	const sample = watcherFor(DBZ1)!.read(core.wram())!;

	// 300 est ce qu'affiche l'écran d'options, et c'est ce qui rend ces quatre
	// adresses trouvables plutôt que noyées parmi cent autres.
	assert.deepEqual(sample, {
		p1: { max: 300, current: 300 },
		p2: { max: 300, current: 300 }
	});
});

needsDbz1('frapper le port 2 ne touche que le port 2', async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	beatDown(core, 1, 4);
	const sample = watcherFor(DBZ1)!.read(core.wram())!;

	assert.ok(sample.p2.current < 300, `le port 2 n'a rien pris (${sample.p2.current})`);
	assert.equal(sample.p1.current, 300, "celui qui frappe ne perd pas de vie");
	assert.equal(sample.p1.max, 300, 'et aucun maximum ne bouge en cours de match');
	assert.equal(sample.p2.max, 300);
});

needsDbz1('frapper le port 1 ne touche que le port 1, donc les ports ne sont pas inversés', async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	beatDown(core, 2, 4);
	const sample = watcherFor(DBZ1)!.read(core.wram())!;

	assert.ok(sample.p1.current < 300, `le port 1 n'a rien pris (${sample.p1.current})`);
	assert.equal(sample.p2.current, 300);
});

needsDbz1('la vie réelle déborde là où la barre dessinée s arrête à zéro', async () => {
	// LE test de ce fichier. Lire $7E0660 plutôt que $7E0664 rendrait 65535, que
	// `isPlausible` refuse parce qu'une vie ne dépasse pas son maximum - et le
	// KO serait jeté sans un mot. Ce test est ce qui interdit de « simplifier »
	// la ligne dans ce sens.
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	beatDown(core, 1, 14);
	const wram = core.wram();

	assert.equal(u16(wram, 0x0660), 65535, 'la vie réelle du port 2 est passée sous zéro');
	assert.equal(u16(wram, 0x0664), 0, 'la barre dessinée, elle, borne à zéro');
	assert.equal(watcherFor(DBZ1)!.read(wram)!.p2.current, 0, 'et la ligne lit la seconde');
});

needsDbz1('un KO est rapporté une fois, au joueur resté debout', async () => {
	const { core, atMatchStart } = await versusMatch();
	core.loadState(atMatchStart);

	const verdicts: MatchVerdict[] = [];
	const observer = new MatchObserver({
		watcher: watcherFor(DBZ1)!,
		readWram: () => core.wram(),
		onVerdict: (verdict) => verdicts.push(verdict)
	});

	// Un seul appel par image, comme en production : `note` avant `observe`.
	let frame = 0;
	const step = (pad1: number, pad2: number) => {
		core.runFrame(pad1, pad2);
		frame++;
		observer.note(pad1, pad2);
		observer.observe(frame);
	};

	for (let c = 0; c < 14; c++) {
		for (let f = 0; f < 150; f++) step(PAD.RIGHT, PAD.B);
		for (let f = 0; f < 150; f++) step(f % 12 < 4 ? PAD.B : f % 12 < 8 ? PAD.A : PAD.Y, PAD.B);
	}
	// L'animation de KO et les menus qui suivent, où la vie reste à zéro : un
	// guetteur qui rapporterait sur l'octet en annoncerait un par échantillon.
	for (let f = 0; f < 900; f++) step(0, 0);

	assert.equal(verdicts.length, 1, "l'animation de KO ne doit pas rapporter un vainqueur par échantillon");
	assert.equal(verdicts[0].winner, 1);
	assert.equal(verdicts[0].health.p2, 0);
});
