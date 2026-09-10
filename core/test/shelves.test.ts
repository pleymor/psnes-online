/**
 * Où tombent les étagères sous la grille.
 *
 * Le mode de panne que ces tests existent pour arrêter est visuel et muet :
 * une planche mal comptée ou mal placée traverse une jaquette, et rien ne
 * le signale - ni le typage, ni un test de rendu, ni la suite e2e, qui
 * clique des cartes sans regarder ce qu'il y a derrière.
 *
 * Le compte de colonnes est la moitié fragile : c'est l'arithmétique de
 * `repeat(auto-fill, ...)` réécrite en TypeScript, donc deux implémentations
 * de la même règle, qui peuvent diverger d'une piste sans prévenir.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { columnsThatFit, rowBottoms } from '../../frontend/src/lib/games/shelves.js';

const CARD = 376;
const GAP = 28;

test('une largeur inconnue ne donne aucune colonne', () => {
	// Avant la première mesure la grille fait zéro pixel : poser des étagères
	// sur cette supposition les ferait sauter à la mesure suivante.
	assert.equal(columnsThatFit(0, CARD, GAP), 0);
	assert.equal(columnsThatFit(-10, CARD, GAP), 0);
	assert.equal(columnsThatFit(Number.NaN, CARD, GAP), 0);
});

test('la dernière piste ne se perd pas d un cheveu', () => {
	// Trois pistes et deux gouttières font exactement 1184 : à cette largeur
	// il en tient trois, pas deux. Une division sans la gouttière ajoutée en
	// aurait rendu deux.
	assert.equal(columnsThatFit(3 * CARD + 2 * GAP, CARD, GAP), 3);
	assert.equal(columnsThatFit(3 * CARD + 2 * GAP - 1, CARD, GAP), 2);
	assert.equal(columnsThatFit(3 * CARD + 2 * GAP + 1, CARD, GAP), 3);
});

test('la largeur réelle de la bibliothèque tient trois jaquettes', () => {
	// 1280 de fenêtre moins 2 x 32 de marge : la mesure prise à l écran.
	assert.equal(columnsThatFit(1216, CARD, GAP), 3);
});

test('une grille plus étroite qu une carte en garde une', () => {
	// Ce que fait `auto-fill` : la carte déborde plutôt que de disparaître.
	assert.equal(columnsThatFit(200, CARD, GAP), 1);
});

test('une bibliothèque vide n a pas d étagère', () => {
	assert.deepEqual(rowBottoms({ count: 0, columns: 3, rowHeight: 263, rowGap: 56 }), []);
});

test('une largeur non mesurée n a pas d étagère non plus', () => {
	assert.deepEqual(rowBottoms({ count: 8, columns: 0, rowHeight: 263, rowGap: 56 }), []);
});

test('chaque rangée a sa planche, la dernière comprise', () => {
	// Sept jeux sur trois colonnes font trois rangées, dont une incomplète -
	// et celle-là a une étagère comme les autres, sans quoi ses jeux
	// resteraient en l air.
	const tops = rowBottoms({ count: 7, columns: 3, rowHeight: 263, rowGap: 56 });
	assert.equal(tops.length, 3);
});

test('les planches sont espacées du pas d une rangée', () => {
	const tops = rowBottoms({ count: 6, columns: 3, rowHeight: 263, rowGap: 56 });
	assert.deepEqual(tops, [263, 582]);
	assert.equal(tops[1] - tops[0], 263 + 56);
});

test('une seule rangée donne une seule planche, au bas de la rangée', () => {
	assert.deepEqual(rowBottoms({ count: 2, columns: 3, rowHeight: 263, rowGap: 56 }), [263]);
});
