/**
 * Ce qui part vraiment sur le réseau quand on journalise une erreur.
 *
 * Rapporté de la production le 2026-09-12 : deux tentatives de lancement en VR
 * échouent, et la seule ligne qui pourrait dire pourquoi arrive ainsi -
 *
 *     ERROR | VrShell | vr engine failed to start | [{}]
 *
 * `{}` n'est pas une erreur vide : c'est ce que `JSON.stringify` rend d'un
 * `Error`, dont `message`, `name` et `stack` sont des propriétés NON
 * ÉNUMÉRABLES. Le défaut n'appartient donc pas à `VrShell` mais à l'expéditeur,
 * et il vaut pour les quelque cent `logger.error('...', err)` du dépôt : aucun
 * n'a jamais transporté son message.
 *
 * Ces tests s'attachent aux octets envoyés plutôt qu'à une forme interne, parce
 * que c'est la seule chose que le serveur verra - et parce qu'un test qui
 * n'interroge pas `JSON.stringify` ne peut pas voir le défaut qu'on corrige.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { startLogShipping, ship } from '../../frontend/src/lib/utils/log-shipper.js';

/** `MAX_BATCH` dans le module : c'est le seuil qui vide la file sans attendre. */
const MAX_BATCH = 50;

/**
 * Le minimum que `startLogShipping` exige pour s'activer.
 *
 * Il ne s'arme que dans un navigateur (`typeof window === 'undefined'` le
 * garde), et pose deux écouteurs. Rien d'autre n'est touché, donc rien d'autre
 * n'est simulé : un décor plus gros rendrait le test moins lisible sans le
 * rendre plus vrai.
 */
function asABrowser(): void {
  const noop = () => {};
  (globalThis as Record<string, unknown>).window = { addEventListener: noop };
  (globalThis as Record<string, unknown>).document = {
    addEventListener: noop,
    visibilityState: 'visible'
  };
}

/**
 * Rend le corps du lot envoyé, en remplissant la file jusqu'au seuil.
 *
 * Le vidage par minuterie prendrait deux secondes ; le seuil le fait tout de
 * suite, et sans horloge simulée dont ce module n'a par ailleurs pas besoin.
 */
async function bodyOfShipped(entryData: unknown): Promise<string> {
  asABrowser();
  startLogShipping();

  let body = '';
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = init.body;
    return { ok: true };
  }) as unknown as typeof globalThis.fetch;

  try {
    ship({
      timestamp: new Date().toISOString(),
      level: 'error',
      context: 'VrShell',
      message: 'vr engine failed to start',
      data: entryData
    });
    // Le reste du lot, pour atteindre le seuil. Leur contenu est sans intérêt.
    for (let i = 1; i < MAX_BATCH; i++) {
      ship({
        timestamp: new Date().toISOString(),
        level: 'info',
        context: 'filler',
        message: `${i}`
      });
    }
    // `flush` est asynchrone : un tour de boucle suffit à la laisser appeler
    // `fetch`, puisque le corps est construit avant le premier `await`.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = real;
  }

  return body;
}

test("le message d'une erreur survit au voyage - la ligne qui manquait en production", async () => {
  const body = await bodyOfShipped([new Error('WebGL context creation failed')]);

  assert.ok(
    body.includes('WebGL context creation failed'),
    `le message a été perdu en route ; le serveur a reçu : ${body.slice(0, 400)}`
  );
});

test('le nom de la classe part avec, pour distinguer un TypeError d\'un DOMException', async () => {
  const body = await bodyOfShipped([new TypeError('not a function')]);

  assert.ok(body.includes('TypeError'), `le serveur a reçu : ${body.slice(0, 400)}`);
});

test('la pile part avec, puisque le message seul ne dit pas où', async () => {
  const body = await bodyOfShipped([new Error('boom')]);

  assert.ok(body.includes('stack'), `le serveur a reçu : ${body.slice(0, 400)}`);
});

test("la cause d'une erreur part avec elle, sans quoi la vraie panne reste cachée", async () => {
  const inner = new Error('permission denied reading the ROM folder');
  const body = await bodyOfShipped([new Error('vr engine failed to start', { cause: inner })]);

  assert.ok(
    body.includes('permission denied reading the ROM folder'),
    `la cause a été perdue ; le serveur a reçu : ${body.slice(0, 400)}`
  );
});

test("une erreur rangée dans un objet compte autant qu'une erreur nue", async () => {
  // `logger.error('...', { err })` est aussi répandu dans le dépôt que
  // `logger.error('...', err)`, et se perdait exactement pareil.
  const body = await bodyOfShipped([{ phase: 'boot', err: new Error('core wasm missing') }]);

  assert.ok(body.includes('core wasm missing'), `le serveur a reçu : ${body.slice(0, 400)}`);
  assert.ok(body.includes('"phase":"boot"'), `le voisin a été perdu : ${body.slice(0, 400)}`);
});

test('ce qui se sérialisait déjà bien reste intact', async () => {
  // La régression qu'il ne faut pas introduire : les données ordinaires -
  // celles de `vr decor visibility`, par exemple - passaient très bien.
  const body = await bodyOfShipped([{ visible: false, built: true }]);

  assert.ok(body.includes('"visible":false'), `le serveur a reçu : ${body.slice(0, 400)}`);
  assert.ok(body.includes('"built":true'), `le serveur a reçu : ${body.slice(0, 400)}`);
});
