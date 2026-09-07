/**
 * Toute région qu'un panneau dessine doit être traitée quelque part.
 *
 * Ce test existe à cause d'un défaut réel, et il aurait suffi à l'attraper. En
 * remplaçant les deux boutons de sauvegarde rapide du bandeau par un seul, le
 * remplacement portait sur une PLAGE de texte, et cette plage a emporté avec
 * elle le gestionnaire de `resume` qui se trouvait entre les deux. Le bouton
 * est resté dessiné, visable, et sans effet - il fallait quitter le jeu et le
 * relancer. Aucun test ne pouvait le voir : les tests de panneau vérifient que
 * la région existe, et le dispatch vit dans un composant Svelte qu'ils
 * n'atteignent pas.
 *
 * Alors il lit les sources, comme `vr-layout.test.ts` lit `layout.ts` pour
 * vérifier qu'il n'importe rien de three. C'est grossier, et c'est exactement
 * proportionné : le mode de défaillance est un bouton mort, silencieux, que
 * seul un joueur découvre.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vr = path.resolve(here, '..', '..', 'frontend', 'src', 'lib', 'vr');
const shell = readFileSync(
  path.resolve(here, '..', '..', 'frontend', 'src', 'lib', 'components', 'VrShell.svelte'),
  'utf8'
);

/*
 * Les huit boutons de la manette sont dessinés comme `bind:<bouton>`, donc
 * leurs noms nus - `a`, `b`, `start`... - ne sont jamais des régions à eux
 * seuls. Les exclure ici plutôt que de compliquer l'extraction.
 */
const PAD_BUTTONS = new Set(['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']);

function produced(): Set<string> {
  const ids = new Set<string>();
  for (const file of readdirSync(path.join(vr, 'panels'))) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(path.join(vr, 'panels', file), 'utf8');
    for (const [, id] of src.matchAll(/id: '([a-z-]+)'/g)) {
      if (!PAD_BUTTONS.has(id)) ids.add(id);
    }
    for (const [, prefix] of src.matchAll(/id: `([a-z-]+):/g)) ids.add(prefix + ':');
  }
  return ids;
}

function handled(): Set<string> {
  const ids = new Set<string>();
  for (const [, id] of shell.matchAll(/id === '([a-z-]+)'/g)) ids.add(id);
  for (const [, prefix] of shell.matchAll(/id\.startsWith\('([a-z-]+):/g)) ids.add(prefix + ':');
  return ids;
}

test('aucune region dessinee n est laissee sans gestionnaire', () => {
  const orphans = [...produced()].filter((id) => !handled().has(id)).sort();
  assert.deepEqual(
    orphans,
    [],
    `region(s) dessinee(s) mais jamais traitee(s) par VrShell : ${orphans.join(', ')}`
  );
});

test('le test lui-meme voit quelque chose, sinon il ne prouve rien', () => {
  // Une extraction cassée rendrait deux ensembles vides et passerait toujours.
  assert.ok(produced().size >= 10, `seulement ${produced().size} regions trouvees`);
  assert.ok(handled().size >= 10, `seulement ${handled().size} gestionnaires trouves`);
  assert.ok(produced().has('quit'), 'la sortie doit figurer parmi les regions produites');
});
