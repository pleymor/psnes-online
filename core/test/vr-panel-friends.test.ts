/**
 * The friends lectern.
 *
 * It does nothing on purpose, and the tests are mostly about that: no region is
 * clickable, because every action a friends list normally offers is unavailable
 * in here. Inviting opens a room and a room leads to lockstep, which this
 * version does not do; adding a friend needs a pseudonym typed, and there is no
 * keyboard in an immersive session. A panel full of buttons that refuse would
 * be worse than a panel with none.
 *
 * What it does have to get right is the ordering. Presence is the only reason
 * this panel exists, so the people who are here come first - a friends list
 * that buries the two online friends under forty offline ones has thrown away
 * its whole value.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  friendRows,
  layoutFriendsPanel,
  drawFriendsPanel,
  FRIENDS_PANEL_SIZE,
  FRIENDS_VISIBLE_ROWS
} from '../../frontend/src/lib/vr/panels/friends.js';

const LABELS = {
  heading: 'Friends',
  online: 'online',
  offline: 'offline',
  nobody: 'No friends yet',
  readOnly: 'Invitations are not available in VR yet'
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

test('the people who are here come first', () => {
  const online = new Map([['u1', false], ['u2', true], ['u3', false]]);
  const rows = friendRows(FRIENDS, online, new Map());
  assert.deepEqual(rows.map((r) => r.pseudo), ['Bo', 'Ada', 'Cy']);
  assert.equal(rows[0].online, true);
});

test('offline friends keep their own order behind them', () => {
  const rows = friendRows(FRIENDS, new Map(), new Map());
  assert.deepEqual(rows.map((r) => r.pseudo), ['Ada', 'Bo', 'Cy'], 'a stable sort, not a shuffle');
});

test('an unknown user id is offline, not a crash', () => {
  const rows = friendRows(FRIENDS, new Map([['nobody', true]]), new Map());
  assert.equal(rows.every((r) => !r.online), true);
});

test('what a friend is playing travels with them', () => {
  const rows = friendRows(
    FRIENDS,
    new Map([['u1', true]]),
    new Map([['u1', 'Super Metroid']])
  );
  assert.equal(rows[0].playing, 'Super Metroid');
  assert.equal(rows[1].playing, null);
});

test('nothing on this panel is clickable', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map());
  assert.deepEqual(
    layoutFriendsPanel(rows),
    [],
    'every action a friends list offers is unavailable in here; buttons that refuse are worse than none'
  );
});

test('a long list is cut to what fits rather than drawn off the panel', () => {
  const many = Array.from({ length: FRIENDS_VISIBLE_ROWS + 10 }, (_, i) => ({
    friend: { id: `u${i}`, pseudo: `Friend ${i}` }
  }));
  const rows = friendRows(many, new Map(), new Map());
  assert.equal(rows.length, FRIENDS_VISIBLE_ROWS, 'there is no scroll here, so the list is capped');
});

test('an empty list says so instead of drawing nothing', () => {
  const ctx = recordingContext();
  drawFriendsPanel(ctx, [], [], LABELS);
  const shown = (ctx as unknown as { texts: string[] }).texts.join(' | ');
  assert.ok(shown.includes(LABELS.nobody), 'a blank panel reads as a panel that failed to load');
});

test('the panel admits it is read-only', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map());
  const ctx = recordingContext();
  drawFriendsPanel(ctx, rows, [], LABELS);
  const shown = (ctx as unknown as { texts: string[] }).texts.join(' | ');
  assert.ok(shown.includes('Ada'));
  assert.ok(
    shown.includes(LABELS.readOnly),
    'a player who cannot find the invite button deserves to be told there is not one'
  );
});

test('a friend in a game shows the game, not just a dot', () => {
  const rows = friendRows(FRIENDS, new Map([['u1', true]]), new Map([['u1', 'Zelda']]));
  const ctx = recordingContext();
  drawFriendsPanel(ctx, rows, [], LABELS);
  assert.ok((ctx as unknown as { texts: string[] }).texts.join(' | ').includes('Zelda'));
});
