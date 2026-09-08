/**
 * The friends lectern, which now does something.
 *
 * It used to do nothing on purpose, and most of these tests were about that.
 * The reason it gave has expired: "inviting opens a room and a room leads to
 * lockstep, which this version does not do" was true when it was written and
 * stopped being true when the headset learned to play a two-player game. So
 * the panel gains the one action that was ever really missing, and the two
 * tests that pinned its emptiness are inverted rather than deleted - what they
 * were protecting was a decision, and the decision changed.
 *
 * Nothing here is new machinery. `rooms/actions.ts` already opens the group's
 * room and sends the invitation, and `lobby/invitations.ts` already holds the
 * ones addressed to me, at module scope so they are live inside a session.
 * This panel is a surface over both.
 *
 * What it still has to get right is the ordering, because presence is why the
 * panel exists: the people who are here come first, and the person we have
 * just invited comes before even them - see the test that says why.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  friendRows,
  layoutFriendsPanel,
  drawFriendsPanel,
  friendsVisibleRows,
  FRIENDS_PANEL_SIZE,
  type FriendsState
} from '../../frontend/src/lib/vr/panels/friends.js';

const LABELS = {
  heading: 'Friends',
  online: 'online',
  offline: 'offline',
  nobody: 'No friends yet',
  invite: 'Invite',
  invited: 'Invited',
  cancel: 'Cancel',
  accept: 'Accept',
  decline: 'Decline',
  /** Already interpolated with the inviter's name by the caller. */
  incomingFrom: 'Zoe invites you',
  inGroup: 'in your group'
};

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  return {
    texts,
    calls,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() {}, beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

const FRIENDS = [
  { friend: { id: 'u1', pseudo: 'Ada' } },
  { friend: { id: 'u2', pseudo: 'Bo' } },
  { friend: { id: 'u3', pseudo: 'Cy' } }
];

const CAP = friendsVisibleRows(false);

/** The everyday shape: some friends, nothing pending, nobody asking. */
function state(over: Partial<FriendsState> = {}): FriendsState {
  return {
    rows: friendRows(FRIENDS, new Map([['u1', true]]), new Map(), CAP),
    pending: null,
    incoming: [],
    members: new Set<string>(),
    ...over
  };
}

const ids = (s: FriendsState) => layoutFriendsPanel(s).map((r) => r.id);

test('the people who are here come first', () => {
  const rows = friendRows(FRIENDS, new Map([['u3', true]]), new Map(), CAP);
  assert.deepEqual(rows.map((r) => r.pseudo), ['Cy', 'Ada', 'Bo']);
});

test('offline friends keep their own order behind them', () => {
  const rows = friendRows(FRIENDS, new Map([['u2', true]]), new Map(), CAP);
  assert.deepEqual(rows.map((r) => r.pseudo), ['Bo', 'Ada', 'Cy']);
});

test('an unknown user id is offline, not a crash', () => {
  const rows = friendRows(FRIENDS, new Map(), new Map(), CAP);
  assert.ok(rows.every((r) => !r.online));
});

test('what a friend is playing travels with them', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map([['u1', 'Zelda']]), CAP);
  assert.equal(rows.find((r) => r.id === 'u1')?.playing, 'Zelda');
});

/*
 * The panel is clickable now, and only where pressing means something.
 *
 * Offline friends get no button. The server would take the invitation - it
 * persists one and pushes it only if a socket exists
 * (`invitation-handlers.ts:174`) - but from inside a headset there would be no
 * answer and no feedback, and the ten-minute expiry would very likely run out
 * first. A button whose whole outcome is invisible is the "button that
 * refuses" this panel's old header was right to avoid.
 */
test('an online friend can be invited and an offline one cannot', () => {
  assert.deepEqual(ids(state()), ['invite:u1'], 'only Ada is online');
});

test('nobody at all offers nothing to press', () => {
  const empty = state({ rows: friendRows([], new Map(), new Map(), CAP) });
  assert.deepEqual(ids(empty), []);
});

/*
 * One invitation at a time, and this is the model rather than a preference.
 *
 * `myRoom.invitation` is a single slot (`rooms/my-room.ts:83`), so a second
 * invitation does not queue - it displaces the first, silently, and the player
 * would be left believing two people had been asked. So while one is out, no
 * other row offers Invite at all.
 */
test('a pending invitation takes every other invite button away', () => {
  const pending = state({ pending: { id: 'inv1', toUserId: 'u1' } });
  assert.deepEqual(ids(pending), ['cancel-invite:inv1']);
});

test('the cancel region carries the invitation id it was painted for', () => {
  // Not read fresh from the store at press time: the player is cancelling the
  // invitation they can see, and between the paint and the trigger the store
  // may already hold another.
  const pending = state({ pending: { id: 'inv-77', toUserId: 'u1' } });
  assert.ok(ids(pending).includes('cancel-invite:inv-77'));
});

/*
 * The invited friend is pinned to the top, which is not decoration.
 *
 * The sort is presence-first, so a friend who goes offline right after being
 * invited drops behind everyone who is still here - and on a panel with no
 * scroll, off the bottom of the list entirely. Their row is the only thing
 * carrying the cancel button, so losing it strands the invitation until it
 * expires. Nobody would connect the two.
 */
test('an invited friend stays visible even after going offline', () => {
  const many = Array.from({ length: CAP + 5 }, (_, i) => ({
    friend: { id: `x${i}`, pseudo: `Friend ${i}` }
  }));
  const everyoneElseOnline = new Map(many.slice(1).map((f) => [f.friend.id, true]));

  // x0 is offline and would sort last of all.
  const rows = friendRows(many, everyoneElseOnline, new Map(), CAP, 'x0');
  assert.equal(rows[0]?.id, 'x0', 'the invited friend leads the list');

  const pending = { id: 'inv1', toUserId: 'x0' };
  assert.ok(
    layoutFriendsPanel({ rows, pending, incoming: [], members: new Set() }).some(
      (r) => r.id === 'cancel-invite:inv1'
    ),
    'the invitation would otherwise be impossible to take back'
  );
});

/*
 * An invitation addressed to me.
 *
 * It lands as a band under the header rather than a panel of its own, and it
 * costs the list one row while it is up. That is the honest trade: this panel
 * is where a player already looks for people, and a floating notification is
 * a spatial question this change deliberately does not open.
 */
test('an incoming invitation offers both answers, each carrying its id', () => {
  const asked = state({ incoming: [{ id: 'in-9', fromPseudo: 'Zoe' }] });
  const shown = ids(asked);
  assert.ok(shown.includes('accept:in-9'));
  assert.ok(shown.includes('decline:in-9'));
});

test('an incoming invitation costs the list exactly one row', () => {
  assert.equal(friendsVisibleRows(true), friendsVisibleRows(false) - 1);
});

test('only the first invitation is offered, not a stack of them', () => {
  const asked = state({
    incoming: [
      { id: 'in-1', fromPseudo: 'Zoe' },
      { id: 'in-2', fromPseudo: 'Yan' }
    ]
  });
  const shown = ids(asked);
  assert.ok(shown.includes('accept:in-1'));
  assert.ok(!shown.some((id) => id.endsWith('in-2')), 'there is no room, and no scroll to find it');
});

test('being asked does not stop you asking someone else', () => {
  const both = state({ incoming: [{ id: 'in-9', fromPseudo: 'Zoe' }] });
  assert.ok(ids(both).includes('invite:u1'));
});

/*
 * No region may overlap another, and `panel.ts` says why: `hit()` returns the
 * FIRST match, so an overlap does not look like a bug - the region underneath
 * simply never fires, and only for the presses that land in the shared area.
 * `panels/library.ts` reserved a whole gutter over exactly this.
 */
test('no two regions overlap', () => {
  const busy = state({
    rows: friendRows(FRIENDS, new Map([['u1', true], ['u2', true]]), new Map(), CAP),
    incoming: [{ id: 'in-9', fromPseudo: 'Zoe' }]
  });
  const regions = layoutFriendsPanel(busy);
  assert.ok(regions.length >= 3, 'this case is meant to be crowded');

  for (const a of regions) {
    for (const b of regions) {
      if (a === b) continue;
      const apart =
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('every region stays inside the panel', () => {
  const busy = state({ incoming: [{ id: 'in-9', fromPseudo: 'Zoe' }] });
  for (const r of layoutFriendsPanel(busy)) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off the panel`);
    assert.ok(r.x + r.w <= FRIENDS_PANEL_SIZE.width, `${r.id} runs off the right`);
    assert.ok(r.y + r.h <= FRIENDS_PANEL_SIZE.height, `${r.id} runs off the bottom`);
  }
});

test('a long list is cut to what fits rather than drawn off the panel', () => {
  const many = Array.from({ length: CAP + 10 }, (_, i) => ({
    friend: { id: `u${i}`, pseudo: `Friend ${i}` }
  }));
  const rows = friendRows(many, new Map(), new Map(), CAP);
  assert.equal(rows.length, CAP, 'there is no scroll here, so the list is capped');
});

test('an empty list says so instead of drawing nothing', () => {
  const ctx = recordingContext();
  const empty = state({ rows: friendRows([], new Map(), new Map(), CAP) });
  drawFriendsPanel(ctx, empty, layoutFriendsPanel(empty), LABELS);
  assert.ok(ctx.texts.join(' | ').includes(LABELS.nobody), 'a blank panel reads as one that failed to load');
});

test('the invite button is drawn where it can be aimed at', () => {
  const ctx = recordingContext();
  const s = state();
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  assert.ok(ctx.texts.includes('Ada'));
  assert.ok(ctx.texts.includes(LABELS.invite), 'the action has to be legible, not just clickable');
});

test('a pending invitation says so on the row, and offers the way back', () => {
  const ctx = recordingContext();
  const s = state({ pending: { id: 'inv1', toUserId: 'u1' } });
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  // Exact membership, not a substring of the joined text: "Invited" contains
  // "Invite", so the obvious assertion passes whatever the panel draws.
  assert.ok(ctx.texts.includes(LABELS.invited));
  assert.ok(ctx.texts.includes(LABELS.cancel));
  assert.ok(
    !ctx.texts.includes(LABELS.invite),
    'both at once would say the invitation had not been sent'
  );
});

test('an incoming invitation names who is asking', () => {
  const ctx = recordingContext();
  const s = state({ incoming: [{ id: 'in-9', fromPseudo: 'Zoe' }] });
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  assert.ok(ctx.texts.includes(LABELS.incomingFrom), 'an unattributed invitation is not answerable');
  assert.ok(ctx.texts.includes(LABELS.accept));
  assert.ok(ctx.texts.includes(LABELS.decline));
});

test('a friend in a game shows the game, not just a dot', () => {
  const ctx = recordingContext();
  const s = state({
    rows: friendRows(FRIENDS, new Map([['u1', true]]), new Map([['u1', 'Zelda']]), CAP)
  });
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  assert.ok(ctx.texts.join(' | ').includes('Zelda'));
});


/*
 * Un membre du groupe n'est plus invitable, et c'est un defaut rapporte.
 *
 * « depuis la VR, on peut accepter une invitation. ca marche. mais apres, le
 * panneau des amis affiche toujours le bouton "inviter" sur l'ami qui est
 * pourtant deja dans le groupe. »
 *
 * La cause n'etait pas dans l'acceptation : ce panneau ne connaissait que les
 * invitations - celle qu'on a ENVOYEE (`pending`) et celles qu'on RECOIT
 * (`incoming`) - et rien sur qui est deja dans la room. Accepter ne pouvait
 * donc rien changer a la ligne de l'ami, quelle que soit la qualite du reste.
 *
 * Ce n'est pas qu'un bouton de trop : le presser enverrait une invitation a
 * quelqu'un qui est deja la, et lui poserait une question sur une room qu'il
 * n'a pas quittee.
 */
test('un ami deja dans le groupe n est plus invitable', () => {
  const together = state({ members: new Set(['u1']) });
  const shown = ids(together);

  assert.ok(!shown.includes('invite:u1'), 'le bouton inviter survit a l acceptation');
  // Et les autres gardent le leur : c'est une ligne qui change, pas le panneau.
  assert.ok(!shown.includes('invite:u2'), 'u2 est hors ligne, il n a jamais de bouton');
  const withBo = state({
    rows: friendRows(FRIENDS, new Map([['u1', true], ['u2', true]]), new Map(), CAP),
    members: new Set(['u1'])
  });
  assert.ok(ids(withBo).includes('invite:u2'), 'u2 est en ligne et hors du groupe');
});

test('un membre du groupe le dit, au lieu de dire qu il est en ligne', () => {
  const ctx = recordingContext();
  const together = state({ members: new Set(['u1']) });
  drawFriendsPanel(ctx, together, layoutFriendsPanel(together), LABELS);
  const drawn = ctx.texts.join('\n');

  assert.ok(drawn.includes(LABELS.inGroup), 'rien ne dit qu il est dans le groupe');
  /*
   * Et une seule ligne de statut, la regle que ce module s'applique deja pour
   * « Invite » : deux verites qui se concurrencent valent moins qu'une seule
   * sur laquelle le joueur peut agir. Etre dans le groupe bat « en ligne »,
   * qui n'apprend plus rien.
   */
  assert.ok(!drawn.includes(LABELS.online), 'la presence concurrence l appartenance au groupe');
});

test('etre dans le groupe bat aussi l invitation en attente', () => {
  // Cas atteignable : on invite Ada, elle accepte. Le serveur consomme
  // l'invitation, mais si l'ordre d'arrivee des deux mises a jour laissait
  // `pending` une image de plus, sa ligne ne doit pas proposer de l'annuler.
  const s = state({
    pending: { id: 'inv1', toUserId: 'u1' },
    members: new Set(['u1'])
  });
  assert.ok(!ids(s).includes('cancel-invite:inv1'));
  assert.ok(!ids(s).includes('invite:u1'));

  const ctx = recordingContext();
  drawFriendsPanel(ctx, s, layoutFriendsPanel(s), LABELS);
  const drawn = ctx.texts.join('\n');
  assert.ok(drawn.includes(LABELS.inGroup));
  assert.ok(!drawn.includes(LABELS.invited), 'il est arrive, il n est plus attendu');
});
