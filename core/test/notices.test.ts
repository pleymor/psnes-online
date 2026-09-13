/**
 * Le centre de notifications : ce qui se pose, ce qui se lit, ce qui s efface.
 *
 * Tout ici est pur ou prend son stockage, pour la raison que `transfer.ts`
 * donne pour les siens : ce depot teste sous Bun, sans navigateur. Les
 * boutons, eux, ont besoin de la socket - ils sont enregistres a l execution
 * et n apparaissent donc pas dans ce fichier.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { NOTICE_SHAPES, shapeOf } from '../../frontend/src/lib/notices/shapes.js';

test('un kind inconnu n a pas de forme', () => {
	assert.equal(shapeOf('rien-de-tel'), null);
});

test('le kind brut rend le message qu on lui a donne', () => {
	const shape = shapeOf('raw');

	assert.ok(shape);
	assert.equal(shape.text({ message: 'Sauvegarde creee' }, 'fr'), 'Sauvegarde creee');
	assert.equal(shape.tone, 'info');
});

test('chaque kind rend un texte non vide dans les deux langues', () => {
	// La garde que `i18n-parity` ne peut pas donner : elle compare les cles
	// des deux locales, pas les kinds qui les utilisent. Un kind ajoute avec
	// une cle oubliee compile et rend une chaine vide a l ecran.
	const params = { message: 'x', name: 'Bob', title: 'Umihara Kawase', count: 2 };

	for (const kind of Object.keys(NOTICE_SHAPES)) {
		for (const lang of ['en', 'fr'] as const) {
			const text = shapeOf(kind)?.text(params, lang) ?? '';
			assert.notEqual(text.trim(), '', `${kind} n a pas de texte en ${lang}`);
		}
	}
});

import { get } from 'svelte/store';
import { createNotices } from '../../frontend/src/lib/notices/store.js';

test('poser une notification la met dans la liste et dans le compte', () => {
	const notices = createNotices();

	notices.post('raw', { message: 'Sauvegarde creee' });

	assert.equal(get(notices.list).length, 1);
	assert.equal(get(notices.count), 1);
});

test('la plus recente vient en dernier', () => {
	const notices = createNotices();

	notices.post('raw', { message: 'un' });
	notices.post('raw', { message: 'deux' });

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['un', 'deux']
	);
});

test('fermer le centre consomme ce qui n a pas de bouton', () => {
	// Et non l ouvrir : videes a l ouverture, elles s effaceraient sous les
	// yeux de qui vient les lire.
	const notices = createNotices();
	notices.post('raw', { message: 'un' });

	notices.openCentre();
	assert.equal(get(notices.list).length, 1, 'la liste doit tenir pendant la lecture');

	notices.closeCentre();
	assert.equal(get(notices.list).length, 0);
});

test('ce qui arrive pendant la lecture s ajoute, puis s en va avec le reste', () => {
	const notices = createNotices();
	notices.openCentre();

	notices.post('raw', { message: 'pendant' });
	assert.equal(get(notices.list).length, 1);

	notices.closeCentre();
	assert.equal(get(notices.list).length, 0);
});

test('une echeance depassee quitte la liste', () => {
	const notices = createNotices();
	notices.post('raw', { message: 'dix minutes' }, { expiresAt: 1_000 });

	notices.sweep(1_001);

	assert.equal(get(notices.list).length, 0);
});

test('retirer par identifiant ne touche pas les autres', () => {
	const notices = createNotices();
	const id = notices.post('raw', { message: 'un' });
	notices.post('raw', { message: 'deux' });

	notices.dismiss(id);

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['deux']
	);
});

test('fermer le centre laisse ce qui porte des boutons', () => {
	// closeCentre() doit à la fois consommer ce qui n'en a pas ET laisser ce qui en a.
	const notices = createNotices({ hasActions: (kind) => kind === 'avec-boutons' });
	notices.post('raw', { message: 'a lire' });
	notices.post('avec-boutons', { message: 'a repondre' });

	notices.openCentre();
	notices.closeCentre();

	assert.deepEqual(
		get(notices.list).map((n) => n.kind),
		['avec-boutons']
	);
});

test('une notification sans echeance survit au sweep', () => {
	// sweep() doit retirer ce qui a passé expiresAt, mais garder ce qui n'en a pas.
	const notices = createNotices();
	notices.post('raw', { message: 'sans echeance' });
	notices.post('raw', { message: 'expiree' }, { expiresAt: 1_000 });

	notices.sweep(1_001);

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['sans echeance']
	);
});

import {
	NOTICES_KEY,
	readNotices,
	writeNotices
} from '../../frontend/src/lib/notices/persist.js';

/** Un stockage de test, sans navigateur. */
function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key)
	};
}

const RAW = { id: 'a', kind: 'raw', params: { message: 'un' }, at: 10 };

test('ce qui est ecrit se relit', () => {
	const storage = fakeStorage();

	writeNotices(storage, [RAW]);

	assert.deepEqual(readNotices(storage, 100), [RAW]);
});

test('une echeance depassee ne ressort pas', () => {
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, expiresAt: 50 }]);

	assert.deepEqual(readNotices(storage, 51), []);
});

test('un kind qui depend d une session vivante ne ressort pas', () => {
	// La socket est morte avec l onglet : la reposer, c est offrir un bouton
	// qui ne peut plus rien declencher.
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, kind: 'share-offer' }]);

	assert.deepEqual(readNotices(storage, 100), []);
});

test('un kind que cette version ne connait plus ne ressort pas', () => {
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, kind: 'ce-kind-a-ete-supprime' }]);

	assert.deepEqual(readNotices(storage, 100), []);
});

test('un stockage illisible rend une liste vide et s efface', () => {
	const storage = fakeStorage({ [NOTICES_KEY]: '{ pas du json' });

	assert.deepEqual(readNotices(storage, 100), []);
	assert.equal(storage.data.has(NOTICES_KEY), false);
});

test('ecrire une liste vide efface l entree', () => {
	const storage = fakeStorage();
	writeNotices(storage, [RAW]);

	writeNotices(storage, []);

	assert.equal(storage.data.has(NOTICES_KEY), false);
});

import {
	actionsOf,
	hasActions,
	registerNoticeActions
} from '../../frontend/src/lib/notices/actions.js';

test('un kind sans boutons enregistres n en a pas', () => {
	assert.equal(hasActions('raw'), false);
	assert.deepEqual(actionsOf('raw'), []);
});

test('des boutons enregistres se retrouvent par leur kind', () => {
	const run = () => {};
	registerNoticeActions('essai', [{ label: 'cancel', run }]);

	assert.equal(hasActions('essai'), true);
	assert.equal(actionsOf('essai').length, 1);
});
