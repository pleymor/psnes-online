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
