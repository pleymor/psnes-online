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
 * Arme l'expéditeur une fois, et NE LAISSE AUCUN NAVIGATEUR DERRIÈRE.
 *
 * `startLogShipping` ne s'arme que dans un navigateur (`typeof window ===
 * 'undefined'` le garde) et pose deux écouteurs. Il faut donc un décor - mais
 * le laisser en place casse d'autres fichiers de test, et c'est arrivé : douze
 * tests de `solo-engine` et `lockstep-engine` sont tombés en intégration, que
 * la même commande passait ici. `governor.ts:137` teste `typeof document !==
 * 'undefined'` puis appelle `document.removeEventListener` ; un faux document
 * qui n'a qu'`addEventListener` passe la garde et fait exploser l'appel.
 *
 * Les globales sont donc rendues telles qu'elles étaient dès que l'expéditeur
 * est armé - `enabled` est un drapeau de module, il survit très bien à leur
 * disparition. L'ordre des fichiers ne décide plus de rien.
 */
let armed = false;
function armOnce(): void {
  if (armed) return;
  const g = globalThis as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const oldWindow = g.window;
  const oldDocument = g.document;

  const noop = () => {};
  g.window = { addEventListener: noop, removeEventListener: noop };
  g.document = { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' };
  try {
    startLogShipping();
  } finally {
    if (hadWindow) g.window = oldWindow;
    else delete g.window;
    if (hadDocument) g.document = oldDocument;
    else delete g.document;
  }
  armed = true;
}

/**
 * Rend le corps du lot envoyé, en remplissant la file jusqu'au seuil.
 *
 * Le vidage par minuterie prendrait deux secondes ; le seuil le fait tout de
 * suite, et sans horloge simulée dont ce module n'a par ailleurs pas besoin.
 */
async function bodyOfShipped(entryData: unknown): Promise<string> {
  armOnce();

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

test("ce fichier ne laisse aucun faux navigateur derriere lui", () => {
  /*
   * Le test qui manquait, et qui aurait evite une integration rouge.
   *
   * Un decor de navigateur laisse en place voyage jusqu aux autres fichiers :
   * `bun test` partage le processus, et l ordre des fichiers n est pas garanti
   * d une machine a l autre - ici tout passait, en integration douze tests des
   * moteurs tombaient. Une globale posee par un test est une variable partagee
   * entre fichiers, et elle se range comme telle.
   */
  assert.equal(typeof (globalThis as Record<string, unknown>).window, 'undefined');
  assert.equal(typeof (globalThis as Record<string, unknown>).document, 'undefined');
});
