/**
 * La voix sur le lutrin des amis, et le badge du poignet.
 *
 * Deux promesses de la fonctionnalité se tiennent ici, parce que three ne
 * tourne pas sous Bun et que le casque ne rapporte pas un bouton absent :
 * « couper son micro est toujours atteignable » - le bouton de l'en-tête existe
 * dès que la voix existe, bandeau d'invitation ou pas - et « un micro refusé
 * dit comment l'autoriser ». Le badge, lui, ne doit jamais montrer ouvert ce
 * qui ne part pas.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  friendRows,
  layoutFriendsPanel,
  drawFriendsPanel,
  friendsVisibleRows,
  FRIENDS_PANEL_SIZE,
  type FriendsState,
  type FriendsVoice
} from '../../frontend/src/lib/vr/panels/friends.js';
import { badgeTone, badgeCrossed } from '../../frontend/src/lib/vr/voice/badge-look.js';

const VOICE_LABELS = {
  muteMic: 'Couper mon micro',
  unmuteMic: 'Ouvrir mon micro',
  denied: 'Micro refusé : autorisez-le',
  retry: 'Réessayer',
  mutePeer: 'Couper',
  unmutePeer: 'Rétablir'
};

const LABELS = {
  heading: 'Amis',
  online: 'en ligne',
  offline: 'hors ligne',
  nobody: 'Personne',
  invite: 'Inviter',
  invited: 'Invité',
  cancel: 'Annuler',
  accept: 'Accepter',
  decline: 'Refuser',
  incomingFrom: 'Zoé vous invite',
  inGroup: 'dans le groupe',
  inVr: 'en VR',
  voice: VOICE_LABELS
};

function recordingContext() {
  const texts: string[] = [];
  return {
    texts,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() {},
    strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & { texts: string[] };
}

const FRIENDS = [
  { friend: { id: 'u1', pseudo: 'Ada' } },
  { friend: { id: 'u2', pseudo: 'Bo' } },
  { friend: { id: 'u3', pseudo: 'Cy' } }
];

function voice(over: Partial<FriendsVoice> = {}): FriendsVoice {
  return {
    mic: 'live',
    peers: new Set(['u1']),
    speaking: new Set(),
    mutedPeers: new Set(),
    ...over
  };
}

function state(over: Partial<FriendsState> = {}): FriendsState {
  const denied = over.voice?.mic === 'denied';
  return {
    rows: friendRows(
      FRIENDS, new Map([['u1', true], ['u2', true]]), new Set(['u1']), new Map(),
      friendsVisibleRows(!!over.incoming?.length, denied)
    ),
    pending: null,
    incoming: [],
    members: new Set<string>(),
    voice: voice(),
    ...over
  };
}

const ids = (s: FriendsState) => layoutFriendsPanel(s).map((r) => r.id);

test('hors VR, le lutrin reste celui qu\'il était : aucun bouton de voix', () => {
  const regions = ids(state({ voice: null }));
  assert.ok(!regions.some((id) => id.startsWith('voice')), regions.join(', '));
});

test('le micro se coupe depuis l\'en-tête, avant même qu\'un ami soit là', () => {
  assert.ok(ids(state({ voice: voice({ mic: 'idle', peers: new Set() }) })).includes('voice:mute'));
  assert.ok(ids(state()).includes('voice:mute'));
  assert.ok(ids(state({ voice: voice({ mic: 'muted' }) })).includes('voice:mute'));
});

test('le bouton du micro reste à sa place quand une invitation arrive', () => {
  const quiet = layoutFriendsPanel(state()).find((r) => r.id === 'voice:mute');
  const asked = layoutFriendsPanel(state({ incoming: [{ id: 'in-1', fromPseudo: 'Zoé' }] }))
    .find((r) => r.id === 'voice:mute');
  assert.deepEqual(asked, quiet);
});

test('le bouton dit l\'action, pas l\'état', () => {
  const live = recordingContext();
  const s = state();
  drawFriendsPanel(live, s, layoutFriendsPanel(s), LABELS);
  assert.ok(live.texts.includes(VOICE_LABELS.muteMic));

  const muted = recordingContext();
  const m = state({ voice: voice({ mic: 'muted' }) });
  drawFriendsPanel(muted, m, layoutFriendsPanel(m), LABELS);
  assert.ok(muted.texts.includes(VOICE_LABELS.unmuteMic));
});

test('un micro refusé dit comment l\'autoriser, offre de réessayer, et coûte une ligne', () => {
  const s = state({ voice: voice({ mic: 'denied' }) });
  const regions = ids(s);
  assert.ok(regions.includes('voice:retry'));
  assert.ok(!regions.includes('voice:mute'), 'rien à couper quand rien ne part');

  const ctx = recordingContext();
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  assert.ok(ctx.texts.includes(VOICE_LABELS.denied));
  assert.ok(ctx.texts.includes(VOICE_LABELS.retry));

  assert.equal(friendsVisibleRows(false, true), friendsVisibleRows(false) - 1);
  assert.equal(friendsVisibleRows(true, true), friendsVisibleRows(false) - 2);
});

test('seuls les amis en conversation ont un bouton pour les couper, et il porte leur id', () => {
  const regions = ids(state({ voice: voice({ peers: new Set(['u1']) }) }));
  assert.ok(regions.includes('voice-peer:u1'));
  assert.ok(!regions.includes('voice-peer:u2'), 'en ligne mais pas en conversation');
  // Couper n'enlève pas « Inviter » : la voix ne prend pas la place de la partie à deux.
  assert.ok(regions.includes('invite:u1'));
});

test('un ami coupé chez moi le montre, et le bouton propose de le rétablir', () => {
  const ctx = recordingContext();
  const s = state({ voice: voice({ mutedPeers: new Set(['u1']) }) });
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  assert.ok(ctx.texts.includes(VOICE_LABELS.unmutePeer));
  assert.ok(!ctx.texts.includes(VOICE_LABELS.mutePeer));
});

test('aucune région de voix n\'en chevauche une autre, même bandeaux levés', () => {
  const busy = state({
    incoming: [{ id: 'in-1', fromPseudo: 'Zoé' }],
    voice: voice({ mic: 'denied', peers: new Set(['u1', 'u2']) })
  });
  const regions = layoutFriendsPanel(busy);
  for (const a of regions) {
    assert.ok(a.x >= 0 && a.y >= 0, `${a.id} sort du panneau`);
    assert.ok(a.x + a.w <= FRIENDS_PANEL_SIZE.width, `${a.id} déborde à droite`);
    assert.ok(a.y + a.h <= FRIENDS_PANEL_SIZE.height, `${a.id} déborde en bas`);
    for (const b of regions) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} chevauche ${b.id}`);
    }
  }
});

test('le badge ne montre jamais ouvert ce qui ne part pas', () => {
  assert.equal(badgeTone('muted', true), 'muted');
  assert.equal(badgeTone('denied', true), 'denied');
  assert.ok(badgeCrossed(badgeTone('muted', false)));
  assert.ok(badgeCrossed(badgeTone('denied', false)));
  assert.ok(!badgeCrossed(badgeTone('live', false)));
});

test('le badge s\'allume quand je parle, et seulement micro ouvert', () => {
  assert.equal(badgeTone('live', true), 'speaking');
  assert.equal(badgeTone('live', false), 'live');
  assert.equal(badgeTone('idle', true), 'ready');
  assert.equal(badgeTone('asking', false), 'asking');
});
