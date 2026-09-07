/**
 * Le diagnostic de la bascule stationnaire → room zone.
 *
 * Symptôme rapporté : à l'entrée, la session est stationnaire une fraction de
 * seconde puis passe en room zone, et il faut sortir de la zone pour se voir
 * proposer de revenir en stationnaire.
 *
 * L'énumération complète de ce que la page demande à WebXR -
 * `isSessionSupported`, `requestSession` sans dictionnaire d'init, et deux
 * `requestReferenceSpace('local')` - ne montre AUCUNE demande de sol ni de
 * limite. Donc soit le runtime provisionne la roomscale de lui-même, soit la
 * bascule n'a rien à voir avec nous. Ce module existe pour trancher avec des
 * données plutôt qu'une quatrième hypothèse.
 *
 * Ce qui se teste ici est la seule partie qui a une logique : ne journaliser
 * que les CHANGEMENTS. Un échantillonnage brut de vingt tics identiques
 * noierait la transition qu'on cherche, et `log-shipper.ts` lotit par cent.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { transitions, PROBE_DELAY_MS, SAMPLE_WINDOW_MS } from '../../frontend/src/lib/vr/boundary-probe.js';

test('un etat stable ne produit qu une seule entree', () => {
  const samples = [0, 100, 200, 300].map((at) => ({ at, state: 'visible' }));
  assert.deepEqual(transitions(samples), [{ at: 0, state: 'visible' }]);
});

test('chaque changement est retenu, avec le moment ou il est vu', () => {
  const samples = [
    { at: 0, state: 'visible-blurred' },
    { at: 100, state: 'visible-blurred' },
    { at: 200, state: 'visible' },
    { at: 300, state: 'visible' },
    { at: 400, state: 'hidden' }
  ];
  assert.deepEqual(transitions(samples), [
    { at: 0, state: 'visible-blurred' },
    { at: 200, state: 'visible' },
    { at: 400, state: 'hidden' }
  ]);
});

test('un aller-retour est deux changements, pas un', () => {
  const samples = [
    { at: 0, state: 'visible' },
    { at: 100, state: 'visible-blurred' },
    { at: 200, state: 'visible' }
  ];
  assert.equal(transitions(samples).length, 3);
});

test('aucun echantillon ne produit aucune entree', () => {
  assert.deepEqual(transitions([]), []);
});

/*
 * La sonde vient APRÈS la fenêtre d'observation, et ce n'est pas un détail.
 *
 * Demander `bounded-floor` est peut-être précisément ce qui provisionne la
 * roomscale. Sonder pendant la fenêtre ferait donc mesurer au diagnostic sa
 * propre conséquence - le pire défaut qu'un instrument puisse avoir.
 */
test('la sonde tombe apres la fin de la fenetre d observation', () => {
  assert.ok(
    PROBE_DELAY_MS > SAMPLE_WINDOW_MS,
    'sonder pendant la fenetre ferait mesurer au diagnostic sa propre consequence'
  );
});

test('la fenetre couvre largement une fraction de seconde', () => {
  // Le symptôme est « une fraction de seconde » : une fenêtre plus courte
  // pourrait finir avant la bascule et ne rien voir.
  assert.ok(SAMPLE_WINDOW_MS >= 2000);
});
