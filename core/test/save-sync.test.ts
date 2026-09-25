/**
 * Hors-ligne d'abord (#71) : la file des sauvegardes, et la SRAM locale
 * d'abord, sur une fausse horloge et un faux transport.
 *
 * Le faux serveur n'invente pas sa règle : il applique celle du vrai,
 * `backend/src/saves/sync-plan.ts`, et ne remplace que la base de données par
 * deux champs. Ce que ces tests prouvent de la fusion est donc ce que la
 * production fera ; ce qu'ils prouvent en plus, c'est la plomberie autour -
 * et d'abord le cas que le ticket nomme : l'envoi émis pendant une coupure,
 * dont personne n'a accusé réception.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	backoff,
	bytesHash,
	enqueue,
	failureOf,
	localNeedsUpload,
	openDecision,
	shouldDrain,
	sramAck,
	summarize,
	syncLineKey,
	type SyncOp
} from '../../frontend/src/lib/saves/sync-rules.js';
import {
	createOutbox,
	memoryOutboxStorage,
	type OutboxTransport,
	type TransportAnswer
} from '../../frontend/src/lib/saves/outbox.js';
import { openSram, persistSram, type SramSyncDeps } from '../../frontend/src/lib/saves/sram-sync.js';
import {
	createLocalSaveStore,
	memoryDeviceSaves,
	memorySaveFolder,
	type LocalSaveStore
} from '../../frontend/src/lib/saves/local-store.js';
import { planSramSync, planStateSync, KEPT_SRAM_NAME } from '../../backend/src/saves/sync-plan.js';

const CRC = 'B19ED489';
const ME = 'user-me';
const bytes = (...values: number[]) => new Uint8Array(values);

/* ------------------------------------------------------ un faux serveur */

interface FakeSave {
	id: string;
	name: string;
	kind: 'state' | 'sram';
	bytes: Uint8Array;
	slotNumber: number;
	updatedAt: number;
	syncId: string;
}

/** La règle du vrai serveur, sur deux champs au lieu d'une base. */
function fakeServer(clock: { now: number }) {
	const state = {
		sram: null as { bytes: Uint8Array; updatedAt: number } | null,
		saves: [] as FakeSave[],
		/** Pour simuler une coupure : écrit, puis ne répond pas. */
		dropAnswers: 0,
		down: false,
		status: 200,
		reason: undefined as string | undefined,
		received: 0
	};
	let serial = 0;
	const slot = () => state.saves.reduce((h, s) => Math.max(h, s.slotNumber), 0) + 1;

	function handle(op: SyncOp): TransportAnswer {
		if (state.status !== 200) return { status: state.status, body: { reason: state.reason } };
		const already = state.saves.find((s) => s.syncId === op.id);
		if (op.kind === 'sram') {
			if (already) {
				return { status: 200, body: { outcome: 'duplicate', updatedAt: state.sram?.updatedAt ?? 0, sram: state.sram?.bytes ?? null, kept: null } };
			}
			const plan = planSramSync(state.sram, { bytes: op.bytes, base: op.base ?? null, savedAt: op.savedAt }, clock.now);
			if (plan.kind === 'same') return { status: 200, body: { outcome: 'same', updatedAt: plan.updatedAt, sram: null, kept: null } };
			if (plan.kind === 'write' || plan.kind === 'fast-forward') {
				state.sram = { bytes: op.bytes, updatedAt: plan.updatedAt };
				return { status: 200, body: { outcome: plan.kind, updatedAt: plan.updatedAt, sram: null, kept: null } };
			}
			const loser = plan.kind === 'incoming-wins' ? state.sram!.bytes : op.bytes;
			const kept: FakeSave = {
				id: `kept-${serial++}`, name: KEPT_SRAM_NAME, kind: 'sram', bytes: loser,
				slotNumber: slot(), updatedAt: plan.keep.savedAt, syncId: op.id
			};
			state.saves.push(kept);
			if (plan.kind === 'incoming-wins') state.sram = { bytes: op.bytes, updatedAt: plan.updatedAt };
			return {
				status: 200,
				body: {
					outcome: plan.kind,
					updatedAt: plan.updatedAt,
					sram: plan.kind === 'stored-wins' ? state.sram!.bytes : null,
					kept: { id: kept.id, savedAt: kept.updatedAt }
				}
			};
		}
		if (already) return { status: 200, body: { outcome: 'duplicate', saveId: already.id } };
		const plan = planStateSync(state.saves, { name: op.name!, savedAt: op.savedAt, replaces: op.replaces }, clock.now);
		const id = `save-${serial++}`;
		if (plan.kind === 'overwrite') {
			const target = state.saves.find((s) => s.id === plan.id)!;
			Object.assign(target, { bytes: op.bytes, updatedAt: plan.savedAt, syncId: op.id });
			return { status: 200, body: { outcome: plan.kind, saveId: plan.id } };
		}
		if (plan.kind === 'take-quick') state.saves.find((s) => s.id === plan.renameId)!.name = '__kept__';
		const name = plan.kind === 'create' ? plan.name : plan.kind === 'take-quick' ? '__quick__' : '__kept__';
		state.saves.push({ id, name, kind: 'state', bytes: op.bytes, slotNumber: plan.slotNumber, updatedAt: plan.savedAt, syncId: op.id });
		return { status: 200, body: { outcome: plan.kind, saveId: id } };
	}

	const transport: OutboxTransport = {
		async send(op) {
			state.received++;
			if (state.down) throw new TypeError('Failed to fetch');
			const answer = handle(op);
			if (state.dropAnswers > 0) {
				state.dropAnswers--;
				throw new TypeError('Network connection lost');
			}
			return answer;
		}
	};
	return { state, transport };
}

let ids = 0;
function device(server: ReturnType<typeof fakeServer>, clock: { now: number }) {
	const storage = memoryOutboxStorage();
	const outbox = createOutbox({
		storage,
		transport: server.transport,
		now: () => clock.now,
		newId: () => `op-${ids++}`
	});
	const folder = memorySaveFolder({ supported: false, now: () => clock.now });
	const deviceSaves = memoryDeviceSaves();
	const store = createLocalSaveStore({ folder, device: deviceSaves, now: () => clock.now });
	let online = true;
	const deps: SramSyncDeps = {
		store,
		outbox,
		reachable: () => online,
		now: () => clock.now,
		timeoutMs: 1000,
		async fetchServer() {
			if (server.state.down) throw new Error('offline');
			if (server.state.status !== 200) throw new Error(`answered ${server.state.status}`);
			return { bytes: server.state.sram?.bytes ?? null, updatedAt: server.state.sram?.updatedAt ?? null };
		}
	};
	return {
		storage,
		outbox,
		store,
		deps,
		deviceSaves,
		setOnline(value: boolean) {
			online = value;
		}
	};
}

const ctx = { checksum: CRC, userId: ME };

/* ------------------------------------------------------------ les règles */

test('une copie locale jamais synchronisée pour ce compte part, même sans rien de neuf', () => {
	assert.equal(localNeedsUpload({ bytes: bytes(1) }, null), true);
	assert.equal(localNeedsUpload({ bytes: bytes(1) }, { base: 5, hash: bytesHash(bytes(1)) }), false);
	assert.equal(
		localNeedsUpload({ bytes: bytes(2) }, { base: 5, hash: bytesHash(bytes(1)) }),
		true,
		'un .srm changé par RetroArch dans le dossier est une écriture comme une autre'
	);
	assert.equal(localNeedsUpload(null, null), false);
});

test('au lancement, le serveur qui a avancé est suivi ; le même contenu ne réécrit rien', () => {
	assert.equal(openDecision({ bytes: bytes(1) }, { bytes: bytes(1), updatedAt: 9 }).kind, 'in-step');
	assert.equal(openDecision({ bytes: bytes(1) }, { bytes: bytes(2), updatedAt: 9 }).kind, 'adopt');
	assert.equal(openDecision(null, { bytes: null, updatedAt: null }).kind, 'keep-local');
});

test('deux SRAM en attente pour la même cartouche n\'en font qu\'une, qui garde la base de la première', () => {
	const op = (id: string, b: Uint8Array, base: number | null): SyncOp => ({
		id, userId: ME, checksum: CRC, kind: 'sram', bytes: b, savedAt: 1, base,
		attempts: 0, notBefore: 0, lastError: null, rev: 0, lane: id
	});
	const queue = enqueue(enqueue([], op('a', bytes(1), 100)), op('b', bytes(2), 999));
	assert.equal(queue.length, 1);
	assert.equal(queue[0].id, 'b', 'le syncId est celui du nouveau contenu');
	assert.equal(queue[0].lane, 'a', 'la voie reste, pour retrouver ce qu\'un accusé accuse');
	assert.equal(queue[0].base, 100, 'la dernière version du serveur que l\'appareil a vue');
	assert.deepEqual([...queue[0].bytes], [2]);
});

test('les savestates ne fusionnent pas, sauf la sauvegarde rapide prise hors-ligne', () => {
	const state = (id: string, name: string): SyncOp => ({
		id, userId: ME, checksum: CRC, kind: 'state', bytes: bytes(1), savedAt: 1, name,
		attempts: 0, notBefore: 0, lastError: null, rev: 0, lane: id
	});
	assert.equal(enqueue(enqueue([], state('a', 'x')), state('b', 'x')).length, 2);
	assert.equal(enqueue(enqueue([], state('a', '__quick__')), state('b', '__quick__')).length, 1);
});

test('le recul après échec est borné, et une réponse se range dans la bonne raison', () => {
	assert.equal(backoff(1, 'unreachable'), 5000);
	assert.equal(backoff(30, 'unreachable'), 600_000);
	assert.equal(failureOf({ threw: true }), 'unreachable');
	assert.equal(failureOf({ status: 401 }), 'session');
	assert.equal(failureOf({ status: 404, reason: 'not-in-library' }), 'not-in-library');
	assert.equal(failureOf({ status: 503 }), 'unreachable');
	assert.equal(failureOf({ status: 500 }), 'server');
	assert.equal(failureOf({ status: 409 }), 'refused');
});

test('la file ne se vide que sur connected, jamais sur la seule présence du réseau', () => {
	assert.equal(shouldDrain('connected', true), true);
	assert.equal(shouldDrain('reconnecting', true), false);
	assert.equal(shouldDrain('unreachable', true), false);
	assert.equal(shouldDrain('connected', false), false, 'sans session, rien ne part');
});

test('un accusé où le serveur a gardé la sienne ne devient pas la base de la partie en cours', () => {
	const ack = sramAck(bytes(1), { outcome: 'stored-wins', updatedAt: 50, sram: bytes(2), kept: { id: 'k' } });
	assert.equal(ack.adopt, false);
	const won = sramAck(bytes(1), { outcome: 'fast-forward', updatedAt: 50, sram: null, kept: null });
	assert.deepEqual(won, { adopt: true, record: { base: 50, hash: bytesHash(bytes(1)) } });
});

test('ce que le joueur lit : un compteur, et un échec jamais tu', () => {
	const failing: SyncOp = {
		id: 'a', userId: ME, checksum: CRC, kind: 'sram', bytes: bytes(1), savedAt: 1,
		attempts: 1, notBefore: 0, lastError: { reason: 'server', at: 5 }, rev: 0, lane: 'a'
	};
	assert.equal(syncLineKey(summarize([])), 'syncAllSent');
	assert.equal(syncLineKey(summarize([{ ...failing, lastError: null }])), 'syncPending');
	assert.equal(syncLineKey(summarize([failing])), 'syncFailedServer');
	assert.equal(summarize([failing, { ...failing, id: 'b' }]).pending, 2);
	assert.equal(summarize([{ ...failing, lastError: { reason: 'not-in-library', at: 1 } }]).stuck, true);
});

/* --------------------------------------------------------------- la file */

test('un envoi pendant une coupure reste dans la file, et part au retour', async () => {
	const clock = { now: 1_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	server.state.down = true;

	await d.outbox.add({ userId: ME, checksum: CRC, kind: 'sram', bytes: bytes(7), savedAt: clock.now, base: null });
	const failed = await d.outbox.drain(ME);
	assert.equal(failed.failed[0].reason, 'unreachable');
	const [waiting] = await d.outbox.pending(ME);
	assert.equal(waiting.attempts, 1);
	assert.equal(waiting.lastError?.reason, 'unreachable');

	server.state.down = false;
	// Pas avant la fin du recul, sans `force`.
	assert.equal((await d.outbox.drain(ME)).sent.length, 0);
	clock.now += 5000;
	const sent = await d.outbox.drain(ME);
	assert.equal(sent.sent.length, 1);
	assert.equal((await d.outbox.pending(ME)).length, 0);
	assert.deepEqual([...server.state.sram!.bytes], [7]);
	assert.deepEqual(await d.outbox.record(ME, CRC), { base: 1_000_000, hash: bytesHash(bytes(7)) });
});

test('le cas du ticket : écrit par le serveur, accusé perdu - le renvoi ne double rien', async () => {
	const clock = { now: 2_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);

	await d.outbox.add({ userId: ME, checksum: CRC, kind: 'state', bytes: bytes(9), savedAt: clock.now, name: 'Soir' });
	server.state.dropAnswers = 1;
	await d.outbox.drain(ME);
	assert.equal(server.state.saves.length, 1, 'le serveur l\'a écrite');
	assert.equal((await d.outbox.pending(ME)).length, 1, 'mais sans accusé, la file la garde');

	const again = await d.outbox.drain(ME, { force: true });
	assert.equal(again.sent.length, 1);
	assert.equal(server.state.saves.length, 1, 'le même syncId est reconnu : aucune seconde copie');
	assert.equal((await d.outbox.pending(ME)).length, 0);
});

test('une écriture qui en remplace une autre pendant l\'envoi n\'est pas retirée par l\'accusé de l\'ancienne', async () => {
	const clock = { now: 3_000_000 };
	const server = fakeServer(clock);
	const storage = memoryOutboxStorage();
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const outbox = createOutbox({
		storage,
		now: () => clock.now,
		newId: () => `op-${ids++}`,
		// Un verrou qui ne sérialise pas : c'est la page et le worker, ou la
		// minuterie qui écrit pendant qu'une vidange attend le réseau.
		lock: (run) => run(),
		transport: {
			async send(op) {
				await gate;
				return server.transport.send(op);
			}
		}
	});
	await outbox.add({ userId: ME, checksum: CRC, kind: 'sram', bytes: bytes(1), savedAt: clock.now, base: null });
	const draining = outbox.drain(ME);
	await new Promise((r) => setTimeout(r, 0));
	await outbox.add({ userId: ME, checksum: CRC, kind: 'sram', bytes: bytes(2), savedAt: clock.now + 1, base: null });
	release();
	await draining;

	const [left] = await outbox.pending(ME);
	assert.ok(left, 'la seconde écriture attend toujours');
	assert.deepEqual([...left.bytes], [2]);
	assert.equal(left.base, server.state.sram!.updatedAt, 'elle descend de ce que la première vient de poser');
	await outbox.drain(ME, { force: true });
	assert.deepEqual([...server.state.sram!.bytes], [2]);
	assert.equal(server.state.saves.length, 0, 'une suite, pas un conflit');
});

test('une session expirée arrête la vidange ; un jeu hors bibliothèque ne bloque pas les autres', async () => {
	const clock = { now: 4_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	await d.outbox.add({ userId: ME, checksum: CRC, kind: 'state', bytes: bytes(1), savedAt: 1, name: 'a' });
	await d.outbox.add({ userId: ME, checksum: 'AAAAAAAA', kind: 'state', bytes: bytes(2), savedAt: 2, name: 'b' });

	server.state.status = 401;
	const expired = await d.outbox.drain(ME);
	assert.equal(server.state.received, 1, 'le reste aurait été refusé de même');
	assert.equal(expired.failed[0].reason, 'session');

	server.state.status = 404;
	server.state.reason = 'not-in-library';
	const report = await d.outbox.drain(ME, { force: true });
	assert.equal(report.failed.length, 2);
	assert.equal((await d.outbox.pending(ME)).length, 2, 'refusées, mais gardées : rien n\'est jeté');
	assert.equal(summarize(await d.outbox.pending(ME)).stuck, true);
});

test('la file d\'un autre compte sur le même navigateur ne part pas sous cette session', async () => {
	const clock = { now: 5_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	await d.outbox.add({ userId: 'someone-else', checksum: CRC, kind: 'sram', bytes: bytes(3), savedAt: 1, base: null });
	assert.equal((await d.outbox.drain(ME, { force: true })).sent.length, 0);
	assert.equal(server.state.received, 0);
	assert.equal((await d.outbox.pending('someone-else')).length, 1);
});

/* ------------------------------------------------- la SRAM locale d'abord */

test('le local illisible est le seul échec qui interdit d\'écrire', async () => {
	const clock = { now: 6_000_000 };
	const d = device(fakeServer(clock), clock);
	const broken: LocalSaveStore = {
		...d.store,
		read: async () => {
			throw new Error('disk gone');
		}
	};
	assert.deepEqual(await openSram({ ...d.deps, store: broken }, ctx), { ok: false });
});

test('le serveur injoignable n\'empêche plus rien : on joue sur le local, et il attend dans la file', async () => {
	const clock = { now: 7_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	await d.store.write(CRC, 'sram', bytes(4, 2));
	server.state.down = true;

	const opened = await openSram(d.deps, ctx);
	assert.equal(opened.ok, true);
	assert.deepEqual([...(opened as { bytes: Uint8Array }).bytes], [4, 2]);
	assert.equal((opened as { synced: boolean }).synced, false);
	assert.equal((await d.outbox.pending(ME)).length, 1, 'jamais synchronisée pour ce compte : elle part');
});

test('« pas de réponse » n\'est jamais « le serveur n\'a rien » : un 500 laisse le local intact', async () => {
	const clock = { now: 8_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	await d.store.write(CRC, 'sram', bytes(1, 1));
	await d.outbox.setRecord(ME, CRC, { base: 10, hash: bytesHash(bytes(1, 1)) });
	server.state.status = 500;

	const opened = await openSram(d.deps, ctx);
	assert.deepEqual([...(opened as { bytes: Uint8Array }).bytes], [1, 1]);
	assert.deepEqual([...(await d.store.read(CRC, 'sram'))!.bytes], [1, 1]);
});

test('sans compte, rien ne part : le mode de #70, inchangé', async () => {
	const clock = { now: 9_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	await persistSram({ ...d.deps, outbox: null }, { checksum: CRC, userId: null }, bytes(5));
	assert.equal(server.state.received, 0);
	assert.deepEqual([...(await d.store.read(CRC, 'sram'))!.bytes], [5]);
});

test('la minuterie qui réécrit les mêmes octets ne gonfle pas le compteur', async () => {
	const clock = { now: 10_000_000 };
	const server = fakeServer(clock);
	const d = device(server, clock);
	d.setOnline(false);
	await persistSram(d.deps, ctx, bytes(1));
	await persistSram(d.deps, ctx, bytes(1));
	await persistSram(d.deps, ctx, bytes(2));
	await persistSram(d.deps, ctx, bytes(2));
	assert.equal((await d.outbox.pending(ME)).length, 1);
});

test('deux appareils, un compte, hors-ligne tous les deux : la plus récente devient la SRAM, l\'autre est gardée, rien n\'est perdu', async () => {
	const clock = { now: 20_000_000 };
	const server = fakeServer(clock);
	const a = device(server, clock);
	const b = device(server, clock);

	// Une première partie sur A, en ligne : tout le monde part de là.
	await a.store.write(CRC, 'sram', bytes(0));
	await openSram(a.deps, ctx);
	await b.store.write(CRC, 'sram', bytes(0));
	await openSram(b.deps, ctx);
	assert.deepEqual([...server.state.sram!.bytes], [0]);

	// Le réseau coupé sur les deux, une partie avancée de chaque côté.
	a.setOnline(false);
	b.setOnline(false);
	server.state.down = true;
	clock.now += 60_000;
	await persistSram(a.deps, ctx, bytes(0xa)); // A joue d'abord
	clock.now += 60_000;
	await persistSram(b.deps, ctx, bytes(0xb)); // B joue plus tard

	// Le réseau rendu : A revient le premier, B ensuite.
	server.state.down = false;
	a.setOnline(true);
	b.setOnline(true);
	clock.now += 60_000;
	await a.outbox.drain(ME, { force: true });
	await b.outbox.drain(ME, { force: true });

	assert.deepEqual([...server.state.sram!.bytes], [0xb], 'la plus récente, B, est la SRAM');
	const kept = server.state.saves.filter((s) => s.kind === 'sram');
	assert.equal(kept.length, 1);
	assert.deepEqual([...kept[0].bytes], [0xa], 'la partie de A est gardée, datée');
	assert.equal(kept[0].updatedAt, 20_060_000, 'datée de quand A l\'a jouée');

	// A relance le jeu : il suit le serveur, et sa propre partie est là-bas.
	const reopened = await openSram(a.deps, ctx);
	assert.deepEqual([...(reopened as { bytes: Uint8Array }).bytes], [0xb]);
	assert.deepEqual([...(await a.store.read(CRC, 'sram'))!.bytes], [0xb]);

	const everything = [server.state.sram!.bytes, ...server.state.saves.map((s) => s.bytes)].map((x) => x[0]);
	assert.deepEqual(everything.sort(), [0xa, 0xb], 'les deux parties existent quelque part');
});

test('le même cas, B revenant le premier avec la partie la plus ancienne : la plus récente gagne quand même', async () => {
	const clock = { now: 30_000_000 };
	const server = fakeServer(clock);
	const a = device(server, clock);
	const b = device(server, clock);
	await a.store.write(CRC, 'sram', bytes(0));
	await openSram(a.deps, ctx);
	await b.store.write(CRC, 'sram', bytes(0));
	await openSram(b.deps, ctx);

	a.setOnline(false);
	b.setOnline(false);
	server.state.down = true;
	clock.now += 60_000;
	await persistSram(b.deps, ctx, bytes(0xb)); // B joue d'abord
	clock.now += 60_000;
	await persistSram(a.deps, ctx, bytes(0xa)); // A joue plus tard

	server.state.down = false;
	clock.now += 60_000;
	await b.outbox.drain(ME, { force: true }); // B, plus ancienne, revient la première
	await a.outbox.drain(ME, { force: true });

	assert.deepEqual([...server.state.sram!.bytes], [0xa]);
	assert.deepEqual(server.state.saves.map((s) => [s.kind, s.bytes[0]]), [['sram', 0xb]]);
});

test('la partie qui continue après un conflit perdu ne fait pas sauter la gagnante', async () => {
	const clock = { now: 40_000_000 };
	const server = fakeServer(clock);
	const a = device(server, clock);
	await a.store.write(CRC, 'sram', bytes(0));
	await openSram(a.deps, ctx);

	// Un autre appareil a écrit depuis, plus tard que ce que A va envoyer.
	server.state.sram = { bytes: bytes(0xc), updatedAt: clock.now + 500_000 };
	clock.now += 100_000;
	await persistSram(a.deps, ctx, bytes(0xa));
	await a.outbox.drain(ME, { force: true });
	assert.deepEqual([...server.state.sram.bytes], [0xc], 'plus récente, elle reste');

	// A continue de jouer sur sa lignée : l'écriture suivante ne doit pas
	// passer pour une suite de la gagnante qu'elle n'a jamais chargée.
	clock.now += 600_000;
	await persistSram(a.deps, ctx, bytes(0xa, 1));
	await a.outbox.drain(ME, { force: true });
	const all = [server.state.sram!.bytes, ...server.state.saves.map((s) => s.bytes)].map((x) => [...x].join(','));
	assert.ok(all.includes('12'), 'la gagnante d\'avant est gardée, pas écrasée');
	assert.ok(all.includes('10,1'));
});
