/**
 * Les savestates gardés sur l'appareil : ceux pris hors-ligne, et la copie de
 * ceux du serveur, pour qu'une partie hors-ligne retrouve ce qui a été
 * sauvegardé en ligne.
 *
 * Ce qui compte ici ne se voit pas à l'écran tant que le réseau est là : une
 * copie qui manque, et le joueur ne la découvre que dans le train ; une copie
 * que le serveur écrase alors qu'elle n'était pas encore partie, et c'est une
 * sauvegarde perdue. La règle de #71 tient : jamais d'écrasement, une copie
 * divergente devient une sauvegarde de plus.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	createLocalStates,
	memoryLocalStateStorage,
	mirrorPlan,
	visibleStates,
	UNSENT_GRACE_MS,
	type LocalStateMeta,
	type ServerSave
} from '../../frontend/src/lib/saves/local-states.js';

const CRC = 'B19ED489';
const USER = 'user-1';
const bytes = (...values: number[]) => new Uint8Array(values);

function setup(start = 1_000_000) {
	let clock = start;
	let serial = 0;
	const storage = memoryLocalStateStorage();
	const states = createLocalStates({ storage, now: () => clock, newId: () => `local-${++serial}` });
	return { storage, states, tick: (ms = 1000) => (clock += ms), now: () => clock };
}

function server(id: string, updatedAt: number, extra: Partial<ServerSave> = {}): ServerSave {
	return { id, name: `save ${id}`, kind: 'state', screenshot: null, createdAt: updatedAt, updatedAt, syncId: null, ...extra };
}

function meta(id: string, extra: Partial<LocalStateMeta> = {}): LocalStateMeta {
	return {
		id,
		owner: USER,
		checksum: CRC,
		name: `local ${id}`,
		kind: 'state',
		screenshot: null,
		createdAt: 1,
		updatedAt: 1,
		serverId: null,
		serverUpdatedAt: null,
		syncId: null,
		unsent: false,
		supersedes: null,
		...extra
	};
}

const none = new Set<string>();

/* ------------------------------------------------------------ le rapatriement */

test('une sauvegarde du serveur que l\'appareil n\'a pas est téléchargée', () => {
	const plan = mirrorPlan([], [server('s1', 100)], none, 0);
	assert.deepEqual(plan.fetch.map((f) => [f.save.id, f.into]), [['s1', null]]);
});

test('une copie à jour ne se retélécharge pas : seul ce qui a changé part', () => {
	const local = [meta('a', { serverId: 's1', serverUpdatedAt: 100 }), meta('b', { serverId: 's2', serverUpdatedAt: 200 })];
	const plan = mirrorPlan(local, [server('s1', 100), server('s2', 250)], none, 0);
	assert.deepEqual(plan.fetch.map((f) => [f.save.id, f.into]), [['s2', 'b']]);
});

test('supprimée sur le serveur par le joueur : la copie sort aussi', () => {
	const plan = mirrorPlan([meta('a', { serverId: 's1', serverUpdatedAt: 100 })], [], none, 0);
	assert.deepEqual(plan.drop, ['a']);
});

test('une écriture locale pas encore confirmée n\'est jamais remplacée par la copie du serveur', () => {
	// Écrasée hors-ligne, dans la file ; le serveur, lui, a une version plus
	// récente venue d'un autre appareil. Télécharger la sienne ici effacerait
	// la seule copie de la partie de cet appareil.
	const local = [meta('a', { serverId: 's1', serverUpdatedAt: 100, syncId: 'op-1' })];
	const plan = mirrorPlan(local, [server('s1', 300)], new Set(['op-1']), 0);
	assert.deepEqual(plan.fetch, []);
	assert.deepEqual(plan.drop, []);
});

test('ni une écriture en vol par la socket', () => {
	const local = [meta('a', { serverId: 's1', serverUpdatedAt: 100, unsent: true, updatedAt: 0 })];
	const plan = mirrorPlan(local, [], none, 10);
	assert.deepEqual(plan.drop, []);
	assert.deepEqual(plan.queue, []);
});

test('une sauvegarde envoyée par la file se reconnaît à son syncId, sans rien retélécharger', () => {
	const local = [meta('a', { syncId: 'op-1' })];
	const plan = mirrorPlan(local, [server('s9', 400, { syncId: 'op-1' })], none, 0);
	assert.deepEqual(plan.fetch, []);
	assert.deepEqual(plan.adopt, [{ id: 'a', serverId: 's9', serverUpdatedAt: 400, name: 'save s9', kind: 'state' }]);
});

test('un envoi par la socket resté sans réponse part par la file, passé le délai de grâce', () => {
	const stale = meta('a', { unsent: true, updatedAt: 0 });
	const fresh = meta('b', { unsent: true, updatedAt: UNSENT_GRACE_MS });
	const plan = mirrorPlan([stale, fresh], [], none, UNSENT_GRACE_MS + 1);
	assert.deepEqual(plan.queue.map((m) => m.id), ['a']);
});

test('une sauvegarde rapide gardée par le serveur change de nom sans que ses octets bougent', () => {
	const local = [meta('a', { serverId: 's1', serverUpdatedAt: 100, name: '__quick__' })];
	const plan = mirrorPlan(local, [server('s1', 100, { name: '__kept__' })], none, 0);
	assert.deepEqual(plan.fetch, []);
	assert.deepEqual(plan.rename, [{ id: 'a', name: '__kept__', kind: 'state' }]);
});

/* ------------------------------------------------------------ jamais d'écrasement */

test('écrire par-dessus crée une fiche neuve qui remplace l\'ancienne à l\'écran, sans l\'effacer', async () => {
	const { states, storage, tick } = setup();
	const first = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.confirm(first.id, 's1', 100);
	tick();
	const second = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(2), screenshot: null, over: first.id });

	assert.deepEqual((await states.list(USER, CRC)).map((m) => m.id), [second.id]);
	assert.ok(storage.metas.has(first.id), 'l\'ancienne reste, tant que le serveur n\'a pas tranché');
	assert.deepEqual(await states.bytes(first.id), bytes(1));
});

test('le serveur a refusé l\'écriture : l\'ancienne revient telle quelle', async () => {
	const { states } = setup();
	const first = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.confirm(first.id, 's1', 100);
	const second = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(2), screenshot: null, over: first.id });
	await states.refused(second.id);
	const shown = await states.list(USER, CRC);
	assert.deepEqual(shown.map((m) => m.id), [first.id]);
	assert.deepEqual(await states.bytes(first.id), bytes(1));
});

test('l\'écrasement confirmé par la socket retire l\'ancienne copie', async () => {
	const { states, storage } = setup();
	const first = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.confirm(first.id, 's1', 100);
	const second = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(2), screenshot: null, over: first.id });
	await states.confirm(second.id, 's1', 200);
	assert.equal(storage.metas.has(first.id), false);
	assert.deepEqual((await states.list(USER, CRC)).map((m) => [m.id, m.serverId, m.serverUpdatedAt]), [[second.id, 's1', 200]]);
});

test('divergence : écrasée hors-ligne ici, changée ailleurs - le serveur garde les deux, l\'appareil aussi', async () => {
	const { states, storage } = setup();
	// Une sauvegarde copiée du serveur, puis écrasée hors-ligne : la fiche neuve
	// part dans la file avec l'id de celle qu'elle remplace.
	const copied = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.confirm(copied.id, 's1', 100);
	const offline = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(2), screenshot: null, over: copied.id });
	await states.queued(offline.id, 'op-1');

	// Pendant ce temps, un autre appareil a écrasé s1. À la vidange, le serveur
	// voit que `replaces` ne tient plus : il garde s1 (l'autre appareil) et
	// crée s2 avec nos octets.
	const plan = mirrorPlan(
		await states.all(USER, CRC),
		[server('s1', 300), server('s2', 310, { syncId: 'op-1' })],
		none,
		0
	);
	await states.apply(USER, CRC, plan, async (save) => (save.id === 's1' ? bytes(9) : bytes(0)));

	const shown = await states.list(USER, CRC);
	assert.equal(shown.length, 2, 'les deux parties sont là');
	const ours = shown.find((m) => m.id === offline.id)!;
	assert.equal(ours.serverId, 's2');
	assert.deepEqual(await states.bytes(offline.id), bytes(2), 'nos octets, sans avoir été retéléchargés');
	const theirs = shown.find((m) => m.serverId === 's1')!;
	assert.deepEqual(await states.bytes(theirs.id), bytes(9));
	assert.equal(storage.metas.size, 2);
});

test('écrasement hors-ligne accepté tel quel par le serveur : une seule fiche reste', async () => {
	const { states } = setup();
	const copied = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.confirm(copied.id, 's1', 100);
	const offline = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(2), screenshot: null, over: copied.id });
	await states.queued(offline.id, 'op-1');

	const plan = mirrorPlan(await states.all(USER, CRC), [server('s1', 300, { syncId: 'op-1' })], none, 0);
	await states.apply(USER, CRC, plan, async () => {
		throw new Error('nothing should be downloaded');
	});
	const all = await states.all(USER, CRC);
	assert.deepEqual(all.map((m) => [m.id, m.serverId, m.supersedes]), [[offline.id, 's1', null]]);
});

test('sans compte, écrire par-dessus remplace tout de suite : aucun serveur ne tranchera', async () => {
	const { states, storage } = setup();
	const first = await states.write({ owner: null, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	const second = await states.write({ owner: null, checksum: CRC, name: 'A', bytes: bytes(2), screenshot: null, over: first.id });
	assert.equal(storage.metas.has(first.id), false);
	assert.equal(second.unsent, false);
	assert.deepEqual((await states.list(null, CRC)).map((m) => m.id), [second.id]);
});

test('un téléchargement qui échoue laisse la copie d\'avant en place', async () => {
	const { states } = setup();
	const copied = await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.confirm(copied.id, 's1', 100);
	const plan = mirrorPlan(await states.all(USER, CRC), [server('s1', 200)], none, 0);
	const done = await states.apply(USER, CRC, plan, async () => {
		throw new Error('offline');
	});
	assert.deepEqual(done, { fetched: 0, failed: 1 });
	assert.deepEqual(await states.bytes(copied.id), bytes(1));
	assert.equal((await states.get(copied.id))!.serverUpdatedAt, 100, 'réessayé à la prochaine passe');
});

test('chaque compte voit ses sauvegardes, et le joueur sans compte les siennes', async () => {
	const { states } = setup();
	await states.write({ owner: USER, checksum: CRC, name: 'A', bytes: bytes(1), screenshot: null });
	await states.write({ owner: 'user-2', checksum: CRC, name: 'B', bytes: bytes(2), screenshot: null });
	await states.write({ owner: null, checksum: CRC, name: 'C', bytes: bytes(3), screenshot: null });
	assert.deepEqual((await states.list(USER, CRC)).map((m) => m.name), ['A']);
	assert.deepEqual((await states.list(null, CRC)).map((m) => m.name), ['C']);
});

test('la sauvegarde rapide est celle que le menu montre, pas celle qu\'elle remplace', async () => {
	const { states, tick } = setup();
	const q1 = await states.write({ owner: USER, checksum: CRC, name: '__quick__', bytes: bytes(1), screenshot: null });
	tick();
	const q2 = await states.write({ owner: USER, checksum: CRC, name: '__quick__', bytes: bytes(2), screenshot: null, over: q1.id });
	assert.equal((await states.quick(USER, CRC))!.id, q2.id);
});

test('visibleStates : les plus récentes d\'abord, sans celles qui sont remplacées', () => {
	const shown = visibleStates([
		meta('a', { updatedAt: 1 }),
		meta('b', { updatedAt: 3, supersedes: 'a' }),
		meta('c', { updatedAt: 2 })
	]);
	assert.deepEqual(shown.map((m) => m.id), ['b', 'c']);
});
