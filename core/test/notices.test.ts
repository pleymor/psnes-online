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
