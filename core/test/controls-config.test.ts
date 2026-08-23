/**
 * Normalisation de la config de contrôles.
 *
 * Ce module est la seule porte par laquelle une config entre dans le front :
 * une forme v1 venue de la base, une v2 déjà normalisée, ou n'importe quoi.
 * Une normalisation qui laisse passer un trou produit un joueur dont un
 * bouton ne répond pas, et rien en amont ne le rattrape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BUTTONS,
	DEFAULT_P1_KEYS,
	DEFAULT_P2_KEYS,
	STANDARD_PAD,
	defaultControlsConfig,
	describeCode,
	findConflicts,
	isPadCode,
	legacyToPadCode,
	normaliseControlsConfig,
	parsePadCode,
	shortLabel,
	shortLabelList
} from '../../frontend/src/lib/controls/binding.js';

const V1 = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

test('les douze boutons SNES, et rien de plus', () => {
	assert.equal(BUTTONS.length, 12);
	assert.deepEqual([...BUTTONS].sort(), [
		'a', 'b', 'down', 'l', 'left', 'r', 'right', 'select', 'start', 'up', 'x', 'y'
	]);
});

test('les défauts des deux joueurs ne se croisent jamais', () => {
	const p1 = new Set(Object.values(DEFAULT_P1_KEYS));
	for (const code of Object.values(DEFAULT_P2_KEYS)) {
		assert.ok(!p1.has(code), `${code} est dans les deux jeux de défauts`);
	}
});

test('le mappage standard couvre la croix par les boutons ET par le stick', () => {
	// La table en dur qu'il remplace lisait les deux. Ne garder qu'un des deux
	// couperait le stick gauche sur toute manette XInput.
	assert.deepEqual(STANDARD_PAD.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(STANDARD_PAD.down, ['PadButton13', 'PadAxis1Plus']);
	assert.deepEqual(STANDARD_PAD.left, ['PadButton14', 'PadAxis0Minus']);
	assert.deepEqual(STANDARD_PAD.right, ['PadButton15', 'PadAxis0Plus']);
	assert.deepEqual(STANDARD_PAD.a, ['PadButton1']);
	assert.deepEqual(STANDARD_PAD.select, ['PadButton8']);
});

test('reconnaître et découper un code manette', () => {
	assert.ok(isPadCode('PadButton12'));
	assert.ok(isPadCode('PadAxis0Minus'));
	assert.ok(!isPadCode('KeyX'));
	assert.ok(!isPadCode('Gamepad0Button2'), 'un code legacy n’est pas un code manette');

	assert.deepEqual(parsePadCode('PadButton12'), { kind: 'button', index: 12 });
	assert.deepEqual(parsePadCode('PadAxis1Plus'), { kind: 'axis', index: 1, dir: 'plus' });
	assert.equal(parsePadCode('KeyX'), null);
});

test('les codes legacy perdent leur index de périphérique', () => {
	assert.equal(legacyToPadCode('Gamepad0Button2'), 'PadButton2');
	assert.equal(legacyToPadCode('Gamepad1Button11'), 'PadButton11');
	assert.equal(legacyToPadCode('Gamepad0Axis1Plus'), 'PadAxis1Plus');
	assert.equal(legacyToPadCode('KeyX'), null);
});

test('une KeyConfig nue devient un v2 complet', () => {
	const config = normaliseControlsConfig(V1);

	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1, 'les touches du J1 sont reprises telles quelles');
	assert.deepEqual(config.p1.pad, STANDARD_PAD, 'le J1 hérite du mappage standard');
	assert.deepEqual(config.p2.keys, DEFAULT_P2_KEYS, 'le J2 apparaît avec ses défauts');
	assert.deepEqual(config.p2.pad, STANDARD_PAD);
});

test('un code manette legacy migre vers la table manette et libère le clavier', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });

	assert.deepEqual(config.p1.pad.a, ['PadButton2'], 'la liaison passe côté manette');
	assert.equal(config.p1.keys.a, '', 'et l’emplacement clavier devient non lié');
	assert.deepEqual(config.p1.pad.b, STANDARD_PAD.b, 'les autres emplacements ne bougent pas');
});

test('un v2 traverse sans être réécrit, emplacements vidés compris', () => {
	const input = {
		version: 2,
		p1: { keys: { ...V1, l: '' }, pad: { ...STANDARD_PAD, l: [] } },
		p2: { keys: DEFAULT_P2_KEYS, pad: { ...STANDARD_PAD, a: ['PadButton7'] } }
	};
	const config = normaliseControlsConfig(input);

	assert.equal(config.p1.keys.l, '', 'un emplacement clavier vidé reste vide');
	assert.deepEqual(config.p1.pad.l, [], 'une liste vidée reste vide');
	assert.deepEqual(config.p2.pad.a, ['PadButton7'], 'une liaison choisie est conservée');
});

test('la normalisation est idempotente', () => {
	const once = normaliseControlsConfig(V1);
	assert.deepEqual(normaliseControlsConfig(once), once);
});

test('les clés manquantes sont complétées, la saleté est remplacée', () => {
	const partial = normaliseControlsConfig({ version: 2, p1: { keys: { a: 'KeyM' } } });
	assert.equal(partial.p1.keys.a, 'KeyM');
	assert.equal(partial.p1.keys.up, DEFAULT_P1_KEYS.up, 'le reste vient des défauts');
	assert.deepEqual(partial.p1.pad, STANDARD_PAD, 'une table pad absente vaut le standard');

	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 9 }]) {
		assert.deepEqual(
			normaliseControlsConfig(junk),
			defaultControlsConfig(),
			`${JSON.stringify(junk)} doit retomber sur les défauts`
		);
	}
});

test('les codes non-manette sont écartés de la table manette', () => {
	const config = normaliseControlsConfig({
		version: 2,
		p1: { keys: V1, pad: { ...STANDARD_PAD, a: ['KeyX', 'PadButton1', 7] } }
	});
	assert.deepEqual(config.p1.pad.a, ['PadButton1']);
});

/* ------------------------------------------------------------- affichage */

test('un code se décrit sans avoir besoin de mots', () => {
	assert.deepEqual(describeCode('KeyX'), { kind: 'keyboard', code: 'KeyX' });
	assert.deepEqual(describeCode('PadButton2'), { kind: 'padButton', index: 2 });
	assert.deepEqual(describeCode('PadAxis0Minus'), { kind: 'padAxis', index: 0, dir: 'minus' });
	assert.deepEqual(describeCode(''), { kind: 'unbound' });
});

test('les formes courtes tiennent sur un bouton', () => {
	assert.equal(shortLabel('KeyX'), 'X');
	assert.equal(shortLabel('Digit1'), '1');
	assert.equal(shortLabel('ArrowUp'), '↑');
	assert.equal(shortLabel('ArrowLeft'), '←');
	assert.equal(shortLabel('Enter'), '⏎');
	assert.equal(shortLabel('Space'), '␣');
	assert.equal(shortLabel('ShiftRight'), '⇧D');
	assert.equal(shortLabel('ShiftLeft'), '⇧G');
	assert.equal(shortLabel('ControlLeft'), '⌃G');
	assert.equal(shortLabel('AltRight'), '⌥D');
	assert.equal(shortLabel('Escape'), 'Esc', 'un code inconnu du dictionnaire garde un nom lisible');
	assert.equal(shortLabel('PadButton2'), 'B2');
	assert.equal(shortLabel('PadAxis0Minus'), 'A0−');
	assert.equal(shortLabel('PadAxis1Plus'), 'A1+');
	assert.equal(shortLabel(''), '—');
});

test('une liste dit son premier code et compte le reste', () => {
	assert.equal(shortLabelList([]), '—');
	assert.equal(shortLabelList(['PadButton12']), 'B12');
	assert.equal(shortLabelList(['PadButton12', 'PadAxis1Minus']), 'B12 +1');
	assert.equal(shortLabelList(['PadButton12', 'PadAxis1Minus', 'PadButton3']), 'B12 +2');
});

/* -------------------------------------------------------------- conflits */

const BOTH_KEYBOARD = {
	p1: { keyboard: true, pads: [] as number[] },
	p2: { keyboard: true, pads: [] as number[] }
};

function config(p1: unknown, p2: unknown = {}) {
	return normaliseControlsConfig({ version: 2, p1, p2 });
}

test('deux boutons du même joueur sur la même touche : conflit', () => {
	const report = findConflicts(
		config({ keys: { ...DEFAULT_P1_KEYS, b: 'KeyX' } }),
		BOTH_KEYBOARD
	);

	assert.deepEqual([...report.p1.keys.keys()].sort(), ['a', 'b']);
	assert.deepEqual(report.p1.keys.get('a'), [{ player: 1, button: 'b' }]);
	assert.deepEqual(report.p1.keys.get('b'), [{ player: 1, button: 'a' }]);
	assert.equal(report.count, 2);
});

test('un doublon est signalé même quand le joueur est inactif', () => {
	// Il le rebranchera, et découvrir le conflit à ce moment-là serait pire.
	const report = findConflicts(config({ keys: { ...DEFAULT_P1_KEYS, b: 'KeyX' } }), {
		p1: { keyboard: false, pads: [] },
		p2: { keyboard: false, pads: [] }
	});
	assert.equal(report.p1.keys.size, 2);
});

test('deux joueurs au clavier sur la même touche : conflit', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS }, { keys: { ...DEFAULT_P2_KEYS, a: 'KeyX' } }),
		BOTH_KEYBOARD
	);

	assert.deepEqual(report.p1.keys.get('a'), [{ player: 2, button: 'a' }]);
	assert.deepEqual(report.p2.keys.get('a'), [{ player: 1, button: 'a' }]);
});

test('même touche, mais le J2 n’a pas le clavier : aucun conflit', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS }, { keys: { ...DEFAULT_P2_KEYS, a: 'KeyX' } }),
		{ p1: { keyboard: true, pads: [] }, p2: { keyboard: false, pads: [] } }
	);

	assert.equal(report.count, 0, 'la touche du J2 est inatteignable');
});

test('même bouton manette sur DEUX manettes différentes : aucun conflit', () => {
	// La raison d'être du modèle par périphérique. Sans cette règle, deux
	// joueurs avec le mappage standard seraient en conflit sur les douze
	// boutons, et rien ne pourrait plus être sauvegardé.
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: [0] },
		p2: { keyboard: false, pads: [1] }
	});

	assert.equal(report.count, 0);
});

test('même bouton manette sur la MÊME manette : conflit', () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: [0] },
		p2: { keyboard: false, pads: [0] }
	});

	assert.equal(report.p1.pad.size, 12, 'les douze emplacements se marchent dessus');
	assert.deepEqual(report.p1.pad.get('a'), [{ player: 2, button: 'a' }]);
});

test("'all' intersecte tout ce qui est connecté", () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: 'all' },
		p2: { keyboard: false, pads: [1] }
	});

	assert.ok(report.count > 0, "'all' inclut le pad 1");
});

test('un doublon manette chez un seul joueur : conflit', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS, pad: { ...STANDARD_PAD, b: ['PadButton1'] } }),
		{ p1: { keyboard: true, pads: [0] }, p2: { keyboard: false, pads: [] } }
	);

	assert.deepEqual([...report.p1.pad.keys()].sort(), ['a', 'b']);
});

test('les emplacements non liés ne sont jamais en conflit', () => {
	const report = findConflicts(
		config({ keys: { ...DEFAULT_P1_KEYS, l: '', r: '' }, pad: { ...STANDARD_PAD, l: [], r: [] } }),
		BOTH_KEYBOARD
	);

	assert.equal(report.count, 0, 'trois emplacements vides ne se ressemblent pas');
});
