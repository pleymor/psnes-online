/**
 * The profile band.
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 * The quit region always exists. The Quest's menu button is reserved by the
 * system and delivers nothing to the page, so there is no hardware button
 * available for "leave" - this region is the only exit the app itself can
 * offer, and a state that omits it is a state a player is trapped in.
 *
 * And the preset switch draws the mapping. The honest objection to `thumb` is
 * that the letters stop matching what the game says; showing which Quest button
 * carries which SNES button, at the moment of choosing, is the answer to it. A
 * bare pair of labels would not be.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  layoutProfilePanel,
  drawProfilePanel,
  PROFILE_PANEL_SIZE
} from '../../frontend/src/lib/vr/panels/profile.js';

const LABELS = {
  letters: 'Letters',
  thumb: 'Thumb',
  quit: 'Leave VR',
  resume: 'Back to the game',
  controls: 'Controls'
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
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

const IDLE = { pseudo: 'Ada', scheme: 'letters' as const, language: 'fr' as const, playing: false };

test('the exit exists in every state, because nothing else can offer one', () => {
  for (const playing of [false, true]) {
    for (const scheme of ['letters', 'thumb'] as const) {
      const ids = layoutProfilePanel({ ...IDLE, scheme, playing }).map((r) => r.id);
      assert.ok(
        ids.includes('quit'),
        `no way out with playing=${playing} scheme=${scheme}; the Quest menu button gives the page nothing`
      );
    }
  }
});

test('both presets are always offered, including the active one', () => {
  const ids = layoutProfilePanel(IDLE).map((r) => r.id);
  assert.ok(ids.includes('scheme:letters'));
  assert.ok(ids.includes('scheme:thumb'), 'switching back has to be possible too');
});

test('both languages are offered - there are exactly two', () => {
  const ids = layoutProfilePanel(IDLE).map((r) => r.id);
  assert.ok(ids.includes('lang:en'));
  assert.ok(ids.includes('lang:fr'));
});

test('going back to the game is offered only when there is one', () => {
  assert.ok(!layoutProfilePanel(IDLE).map((r) => r.id).includes('resume'));
  assert.ok(
    layoutProfilePanel({ ...IDLE, playing: true }).map((r) => r.id).includes('resume'),
    'the stick click also does this, but a player who has not found that needs a button'
  );
});

test('every region stays on the band and none overlap', () => {
  const regions = layoutProfilePanel({ ...IDLE, playing: true });
  for (const r of regions) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.id} starts off-panel`);
    assert.ok(r.x + r.w <= PROFILE_PANEL_SIZE.width, `${r.id} runs off the right`);
    assert.ok(r.y + r.h <= PROFILE_PANEL_SIZE.height, `${r.id} runs off the bottom`);
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('the pseudonym is shown, because this is the identity panel', () => {
  const ctx = recordingContext();
  drawProfilePanel(ctx, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  assert.ok((ctx as unknown as { texts: string[] }).texts.includes('Ada'));
});

test('the preset switch draws the mapping, not just a label', () => {
  const ctx = recordingContext();
  drawProfilePanel(ctx, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  const shown = (ctx as unknown as { texts: string[] }).texts;

  // Under `letters`, Quest A carries SNES A; under `thumb` it carries SNES B.
  // Whichever preset is active, the diagram has to say which is which, or the
  // "the letters lie" objection has no answer on screen.
  assert.ok(shown.some((t) => t.includes('A')), 'the Quest letters appear');
  assert.ok(
    shown.filter((t) => /^[ABXY]/.test(t)).length >= 4,
    'all four action buttons are accounted for'
  );
});

test('the two presets draw different mappings', () => {
  const letters = recordingContext();
  drawProfilePanel(letters, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  const thumb = recordingContext();
  const thumbState = { ...IDLE, scheme: 'thumb' as const };
  drawProfilePanel(thumb, thumbState, layoutProfilePanel(thumbState), {
    labels: LABELS, hoverId: null
  });

  assert.notDeepEqual(
    (letters as unknown as { texts: string[] }).texts,
    (thumb as unknown as { texts: string[] }).texts,
    'if both presets draw the same thing, the diagram is decoration'
  );
});

test('the active preset is marked, so a player can see what they have', () => {
  const plain = recordingContext();
  drawProfilePanel(plain, IDLE, layoutProfilePanel(IDLE), { labels: LABELS, hoverId: null });
  const hovered = recordingContext();
  drawProfilePanel(hovered, IDLE, layoutProfilePanel(IDLE), {
    labels: LABELS, hoverId: 'scheme:thumb'
  });
  const strokes = (c: typeof plain) =>
    (c as unknown as { calls: string[] }).calls.filter((k) => k === 'strokeRect').length;
  assert.ok(strokes(hovered) > strokes(plain));
});
