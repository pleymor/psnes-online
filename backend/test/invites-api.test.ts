/**
 * Ce que le propriétaire d'un quota voit de ses places.
 *
 * `toInviteView` est testée seule parce que c'est elle qui décide de ce qui
 * sort du serveur -- la même raison qui a fait écrire `toSelf` à la main dans
 * api/auth.ts plutôt que de sérialiser la ligne.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { toInviteView } from '../src/api/invites.js';
import type { SignupInvite } from '../src/db/signup-invites.js';

const invite: SignupInvite = {
  id: 'inv-1', code: 'abcdefghijklmnopqrstuv', inviterId: 'alice',
  inviteeId: null, grantedByCli: false,
  createdAt: new Date(1_700_000_000_000), usedAt: null, revokedAt: null
};

test('la vue porte le lien complet, prêt à copier', () => {
  const view = toInviteView(invite, null, 'https://psnes.example');
  assert.equal(view.url, 'https://psnes.example/?invite=abcdefghijklmnopqrstuv');
});

test('la vue ne laisse pas sortir l\'identifiant de l\'inviteur ni celui du filleul', () => {
  const used = { ...invite, usedAt: new Date(1_700_000_001_000), inviteeId: 'bob-uuid' };
  const view = toInviteView(used, 'Sprite#0417', 'https://psnes.example');

  assert.deepEqual(Object.keys(view).sort(), ['code', 'id', 'inviteePseudo', 'url', 'usedAt']);
  assert.equal(view.inviteePseudo, 'Sprite#0417');
  assert.equal(JSON.stringify(view).includes('bob-uuid'), false);
});
