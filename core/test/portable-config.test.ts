/**
 * The configuration a player can carry to another machine.
 *
 * "My configuration" did not exist before this module: the controls lived in
 * SQLite, the language and the shader in `localStorage`, the picture shape
 * nowhere at all. This is the one shape all of it now has, plus the two
 * directions it travels in.
 *
 * The export half is nearly trivial and the import half is not: a file a
 * player hands us is untrusted input on the way to `config.p1.keys`, which the
 * room protocol sends to the other peer. Most of what is asserted below is
 * about what an import REFUSES, and about the one thing it cannot refuse but
 * must not accept silently either - a mapping that names controller buttons on
 * a machine that has no controller.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	CONFIG_KIND,
	CONFIG_VERSION,
	MAX_CONFIG_BYTES,
	MAX_LATENCY_ENTRIES,
	applyConfig,
	configFileName,
	gatherConfig,
	readConfigFile,
	serialiseConfig
} from '../../frontend/src/lib/config/portable-config.js';
import {
	DEFAULT_P1_KEYS,
	defaultControlsConfig,
	normaliseControlsConfig
} from '../../frontend/src/lib/controls/binding.js';

/** A storage that behaves like `localStorage`, enumeration included. */
function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		get length() {
			return data.size;
		},
		key(index: number) {
			return [...data.keys()][index] ?? null;
		},
		getItem(key: string) {
			return data.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			data.set(key, value);
		},
		removeItem(key: string) {
			data.delete(key);
		}
	};
}

const NOW = new Date('2026-08-30T12:00:00.000Z');

function fullStorage() {
	return fakeStorage({
		language: 'fr',
		'psnes-shader': 'xbrz/4xbrz-linear',
		'psnes-aspect': 'crt',
		'psnes-latency:game-mario': '3',
		'psnes-latency:game-fighter': '2',
		// Not configuration, and not this module's business either.
		'some-other-app': 'x'
	});
}

/** A file as it comes back off the disk: text, not an object. */
function fileOf(patch: Record<string, unknown>): string {
	return JSON.stringify({
		kind: CONFIG_KIND,
		version: CONFIG_VERSION,
		exportedAt: NOW.toISOString(),
		controls: defaultControlsConfig(),
		language: 'fr',
		display: { aspect: 'crt', shader: 'xbrz/4xbrz-linear' },
		latency: { 'game-mario': 3 },
		...patch
	});
}

function expectOk(text: string) {
	const result = readConfigFile(text);
	assert.equal(result.ok, true, `expected the file to be accepted, got ${JSON.stringify(result)}`);
	if (!result.ok) throw new Error('unreachable');
	return result;
}

function expectRefused(text: string) {
	const result = readConfigFile(text);
	assert.equal(result.ok, false, 'expected the file to be refused');
	if (result.ok) throw new Error('unreachable');
	return result;
}

/* ------------------------------------------------------------------ export */

test('the export carries every durable setting, from wherever it lives', () => {
	const controls = defaultControlsConfig();
	controls.p1.keys.a = 'KeyM';

	const config = gatherConfig(fullStorage(), controls, NOW);

	assert.equal(config.kind, CONFIG_KIND);
	assert.equal(config.version, CONFIG_VERSION);
	assert.equal(config.exportedAt, NOW.toISOString());
	assert.equal(config.controls.p1.keys.a, 'KeyM');
	assert.equal(config.language, 'fr');
	assert.equal(config.display.aspect, 'crt');
	assert.equal(config.display.shader, 'xbrz/4xbrz-linear');
	assert.deepEqual(config.latency, { 'game-mario': 3, 'game-fighter': 2 });
});

test('the export carries nothing that identifies the player', () => {
	// pseudo, discriminator, avatar and googleId are an account, not a
	// configuration. The unique index would reject them on the way back in,
	// with a message about an index rather than about anything the player did.
	const config = gatherConfig(fullStorage(), defaultControlsConfig(), NOW);

	assert.deepEqual(
		Object.keys(config).sort(),
		['controls', 'display', 'exportedAt', 'kind', 'language', 'latency', 'version']
	);
	const text = serialiseConfig(config);
	for (const field of ['pseudo', 'discriminator', 'avatar', 'googleId', 'email', 'id']) {
		assert.ok(!text.includes(field), `${field} must not appear in an exported file`);
	}
});

test('an empty profile still exports a complete, re-importable file', () => {
	const config = gatherConfig(fakeStorage(), defaultControlsConfig(), NOW);

	assert.equal(config.language, 'en');
	assert.equal(config.display.aspect, 'square');
	assert.equal(config.display.shader, '');
	assert.deepEqual(config.latency, {});

	const back = expectOk(serialiseConfig(config));
	assert.deepEqual(back.notices, []);
	assert.deepEqual(back.config.controls, defaultControlsConfig());
});

test('the file is named for the day it was exported', () => {
	assert.equal(configFileName(NOW), 'psnes-config-2026-08-30.json');
});

/* ------------------------------------------------ refusals, not guesswork */

test('anything that is not JSON is refused as such', () => {
	assert.equal(expectRefused('not json at all').reason, 'notJson');
	assert.equal(expectRefused('').reason, 'notJson');
});

test('JSON that is not one of our files is refused as such', () => {
	assert.equal(expectRefused('[1,2,3]').reason, 'notAConfigFile');
	assert.equal(expectRefused('null').reason, 'notAConfigFile');
	assert.equal(expectRefused('"psnes.config"').reason, 'notAConfigFile');
	assert.equal(expectRefused(fileOf({ kind: 'psnes.saves' })).reason, 'notAConfigFile');
	assert.equal(expectRefused(fileOf({ kind: undefined })).reason, 'notAConfigFile');
	assert.equal(expectRefused(fileOf({ version: 'one' })).reason, 'notAConfigFile');
	assert.equal(expectRefused(fileOf({ version: 0 })).reason, 'notAConfigFile');
});

test('a file from a newer build says so instead of being read half-way', () => {
	// The one refusal with a remedy the player can act on: update, then retry.
	// Reading the fields we happen to recognise out of a format we do not know
	// is how an import ends up applying three settings out of five.
	assert.equal(expectRefused(fileOf({ version: CONFIG_VERSION + 1 })).reason, 'fromANewerBuild');
});

test('an oversized file is refused before it is parsed', () => {
	const huge = `{"kind":"${CONFIG_KIND}","pad":"${'x'.repeat(MAX_CONFIG_BYTES)}"}`;
	assert.equal(expectRefused(huge).reason, 'tooLarge');
});

/* ------------------------------------------------------- what is accepted */

test('a file this build wrote comes back exactly as it went out', () => {
	const controls = defaultControlsConfig();
	controls.p1.keys.a = 'KeyM';
	controls.p2.pad.start = ['PadButton7'];

	const result = expectOk(serialiseConfig(gatherConfig(fullStorage(), controls, NOW)));

	assert.deepEqual(result.notices, []);
	assert.deepEqual(result.config.controls, controls);
	assert.equal(result.config.language, 'fr');
	assert.equal(result.config.aspect, 'crt');
	assert.equal(result.config.shader, 'xbrz/4xbrz-linear');
	assert.deepEqual(result.config.latency, { 'game-mario': 3, 'game-fighter': 2 });
});

test('a section the file does not carry is left alone rather than defaulted', () => {
	// null means "this file says nothing about it", which is not the same as
	// "this file asks for the default" - applying a default here would silently
	// undo a setting the player never exported.
	const result = expectOk(
		JSON.stringify({ kind: CONFIG_KIND, version: CONFIG_VERSION, language: 'fr' })
	);

	assert.equal(result.config.language, 'fr');
	assert.equal(result.config.controls, null);
	assert.equal(result.config.aspect, null);
	assert.equal(result.config.shader, null);
	assert.equal(result.config.latency, null);
	assert.deepEqual(result.notices, []);
});

test('a value nobody recognises is dropped, and the drop is reported', () => {
	const result = expectOk(
		fileOf({
			language: 'de',
			display: { aspect: 'widescreen', shader: 'xbrz-freescale' },
			latency: { 'game-mario': 999 }
		})
	);

	assert.equal(result.config.language, null);
	assert.equal(result.config.aspect, null);
	assert.equal(result.config.shader, null);
	assert.deepEqual(result.config.latency, {});
	assert.deepEqual(
		[...result.notices].sort(),
		['aspectDropped', 'languageDropped', 'latencyDropped', 'shaderDropped']
	);
});

test('an unlisted shader is dropped rather than fetched from the CDN', () => {
	// `xbrz-freescale` was delisted after its scaling gave framebuffer errors:
	// a black screen with no message. A file may still name it.
	const result = expectOk(fileOf({ display: { aspect: 'crt', shader: 'xbrz-freescale' } }));

	assert.equal(result.config.shader, null);
	assert.equal(result.config.aspect, 'crt', 'one bad field does not poison the other');
	assert.deepEqual(result.notices, ['shaderDropped']);
});

test('a latency table cannot be used to fill up the storage', () => {
	const latency: Record<string, number> = {};
	for (let i = 0; i < MAX_LATENCY_ENTRIES + 50; i++) latency[`game-${i}`] = 3;

	const result = expectOk(fileOf({ latency }));

	assert.equal(Object.keys(result.config.latency ?? {}).length, MAX_LATENCY_ENTRIES);
	assert.ok(result.notices.includes('latencyDropped'));
});

/* ------------------------------------------------------------- the controls */

test('a controls blob that is not a controls config is refused, not defaulted', () => {
	// `normaliseControlsConfig` answers "the defaults" for anything it cannot
	// read. That is right on a database read and wrong here: it would report a
	// successful import and hand back a mapping the player never chose.
	for (const controls of [42, 'nope', { version: 9 }, { p1: {}, p2: {} }, null]) {
		const result = expectOk(fileOf({ controls }));
		assert.equal(result.config.controls, null, `${JSON.stringify(controls)} must be dropped`);
		assert.ok(result.notices.includes('controlsDropped'));
	}
});

test('the controls always come out of the normaliser, never raw', () => {
	// `getUserKeyConfig` hands `config.p1.keys` to the room protocol. An
	// attacker-shaped object must not reach it, and extra fields must not
	// survive the trip.
	const result = expectOk(
		fileOf({
			controls: {
				version: 2,
				p1: { keys: { ...DEFAULT_P1_KEYS, a: 'KeyM' }, pad: {}, evil: 'x' },
				p2: { keys: {}, pad: {} },
				__proto__: { polluted: true }
			}
		})
	);

	const controls = result.config.controls;
	assert.ok(controls);
	assert.deepEqual(controls, normaliseControlsConfig(controls), 'normalising again changes nothing');
	assert.deepEqual(Object.keys(controls).sort(), ['p1', 'p2', 'version']);
	assert.deepEqual(Object.keys(controls.p1).sort(), ['keys', 'pad']);
	assert.equal(controls.p1.keys.a, 'KeyM');
	assert.equal((controls as Record<string, unknown>).polluted, undefined);
});

test('a v1 file is still a file: the bare twelve keys are accepted', () => {
	const result = expectOk(fileOf({ controls: { ...DEFAULT_P1_KEYS, a: 'KeyM' } }));

	assert.equal(result.config.controls?.version, 2);
	assert.equal(result.config.controls?.p1.keys.a, 'KeyM');
});

/* ------------------------------- the controller that is not on this machine */

test('a button bound only to a controller gets its default key back', () => {
	// The trap this whole module was written around. A mapping exported from a
	// machine with a pad names PadButton1 and nothing else for A; imported on a
	// laptop, A does not respond, and the import reported success. A refusal
	// would be better than that; a keyboard binding alongside the pad one is
	// better still, and costs the pad user nothing - both tables are read.
	const controls = defaultControlsConfig();
	controls.p1.keys.a = '';
	controls.p1.pad.a = ['PadButton1'];
	controls.p2.keys.start = '';
	controls.p2.pad.start = ['PadButton9'];

	const result = expectOk(fileOf({ controls }));

	assert.equal(result.config.controls?.p1.keys.a, DEFAULT_P1_KEYS.a);
	assert.deepEqual(result.config.controls?.p1.pad.a, ['PadButton1'], 'the pad binding stays');
	assert.equal(result.config.controls?.p2.keys.start, 'KeyO');
	assert.ok(result.notices.includes('controlsKeyboardRestored'));
});

test('a button deliberately unbound on both tables stays unbound', () => {
	// '' with an empty pad list is the documented way to say "nothing here",
	// and the binding UI has a Tab-to-skip step for exactly it. Restoring a
	// default would resurrect a binding the player removed on purpose.
	const controls = defaultControlsConfig();
	controls.p1.keys.select = '';
	controls.p1.pad.select = [];

	const result = expectOk(fileOf({ controls }));

	assert.equal(result.config.controls?.p1.keys.select, '');
	assert.deepEqual(result.notices, []);
});

test('the restored default never lands on a key another button already holds', () => {
	// The player moved X's default onto B and left A on the pad alone. Handing
	// A its default back would put two buttons on KeyX - a conflict nobody
	// chose, reported by the panel minutes later.
	const controls = defaultControlsConfig();
	controls.p1.keys.a = '';
	controls.p1.pad.a = ['PadButton1'];
	controls.p1.keys.b = DEFAULT_P1_KEYS.a;

	const result = expectOk(fileOf({ controls }));

	assert.equal(result.config.controls?.p1.keys.a, '', 'left unbound rather than made to conflict');
	assert.ok(result.notices.includes('controlsPadOnly'));
	assert.ok(!result.notices.includes('controlsKeyboardRestored'));
});

/* -------------------------------------------------------------- applying it */

test('applying writes exactly the sections the file carried', () => {
	const storage = fakeStorage({
		language: 'en',
		'psnes-shader': 'xbrz/6xbrz-linear',
		'psnes-aspect': 'crt',
		'psnes-latency:game-old': '4'
	});

	applyConfig(storage, expectOk(fileOf({})).config);

	assert.equal(storage.getItem('language'), 'fr');
	assert.equal(storage.getItem('psnes-shader'), 'xbrz/4xbrz-linear');
	assert.equal(storage.getItem('psnes-aspect'), 'crt');
	assert.equal(storage.getItem('psnes-latency:game-mario'), '3');
	assert.equal(
		storage.getItem('psnes-latency:game-old'), null,
		'the imported table replaces the local one rather than merging into it'
	);
});

test('applying a file that carries no display touches no display key', () => {
	const storage = fakeStorage({ 'psnes-shader': 'xbrz/6xbrz-linear', 'psnes-aspect': 'crt' });

	applyConfig(storage, expectOk(
		JSON.stringify({ kind: CONFIG_KIND, version: CONFIG_VERSION, language: 'fr' })
	).config);

	assert.equal(storage.getItem('psnes-shader'), 'xbrz/6xbrz-linear');
	assert.equal(storage.getItem('psnes-aspect'), 'crt');
	assert.equal(storage.getItem('language'), 'fr');
});

test('applying never writes the controls: they go through the server', () => {
	// `writeUserControls` is the only correct write path - it invalidates the
	// five-minute cache the room reads player 1's keys from. Anything here that
	// wrote them locally would leave a room on the old bindings for minutes,
	// and the symptom would surface on a different screen.
	const storage = fakeStorage();

	applyConfig(storage, expectOk(fileOf({})).config);

	for (const key of [...storage.data.keys()]) {
		assert.ok(!key.includes('control'), `${key} looks like a local controls write`);
	}
});

test('a round trip through storage is stable', () => {
	const storage = fullStorage();
	const controls = defaultControlsConfig();
	controls.p1.keys.a = 'KeyM';

	const first = gatherConfig(storage, controls, NOW);
	const target = fakeStorage();
	applyConfig(target, expectOk(serialiseConfig(first)).config);
	const second = gatherConfig(target, controls, NOW);

	assert.deepEqual(second, first);
});
