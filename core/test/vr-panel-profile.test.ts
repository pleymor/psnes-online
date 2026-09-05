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
  fixedMapRows,
  FIXED_COL_W,
  PROFILE_PANEL_SIZE
} from '../../frontend/src/lib/vr/panels/profile.js';

const LABELS = {
  letters: 'Letters',
  thumb: 'Thumb',
  quit: 'Leave VR',
  resume: 'Back to the game',
  stopGame: 'Stop the game',
  controls: 'Controls',
  // The shipped English, not placeholders: two of the tests below measure
  // these strings, and a short stand-in would pass a width check the real
  // wording could fail.
  gripLeft: 'Left grip',
  gripRight: 'Right grip',
  triggers: 'Triggers',
  sticks: 'Either stick',
  dpad: 'D-pad'
};

function recordingContext() {
  const texts: string[] = [];
  const calls: string[] = [];
  /** Where each string landed. `texts` alone cannot answer "does it fit". */
  const placed: Array<{ text: string; x: number }> = [];
  return {
    texts,
    calls,
    placed,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {}, fillRect() { calls.push('fillRect'); },
    strokeRect() { calls.push('strokeRect'); },
    beginPath() {}, arc() { calls.push('arc'); }, fill() {}, stroke() {},
    fillText(text: string, x: number) { texts.push(text); placed.push({ text, x }); },
    measureText(text: string) { return { width: text.length * 9 }; }
  } as unknown as CanvasRenderingContext2D & {
    texts: string[];
    calls: string[];
    placed: Array<{ text: string; x: number }>;
  };
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

/*
 * The two tests below exist because of a real hardware session, not a
 * hypothesis. The cards draw the four face buttons - the mappings whose letter
 * is printed on the controller, so the ones a player can already guess. START,
 * SELECT, the shoulders and the d-pad were named nowhere in the headset, and
 * START is on the right grip: the session ended with the controls reported
 * dead when they were merely unlabelled.
 */

test('the four unguessable mappings are drawn under either preset', () => {
  // Under both, because no preset moves them - a block that appeared only on
  // one would leave half the players with nothing.
  for (const scheme of ['letters', 'thumb'] as const) {
    const state = { ...IDLE, scheme };
    const ctx = recordingContext();
    drawProfilePanel(ctx, state, layoutProfilePanel(state), { labels: LABELS, hoverId: null });
    const drawn = (ctx as unknown as { texts: string[] }).texts;
    for (const [hardware, snes] of fixedMapRows(LABELS)) {
      assert.ok(
        drawn.includes(`${hardware} \u2192 ${snes}`),
        `${snes} is named nowhere with scheme=${scheme}, and nothing else in the headset names it`
      );
    }
  }
});

test('the mapping rows clear the buttons on the right', () => {
  // Measured where they actually landed rather than against the constant:
  // this catches a long translation, a wrong column width, and the block
  // drifting sideways, which a constant-only check would all miss.
  const state = { ...IDLE, playing: true };
  const quit = layoutProfilePanel(state).find((r) => r.id === 'quit');
  assert.ok(quit, 'no quit region to measure against');

  const ctx = recordingContext();
  drawProfilePanel(ctx, state, layoutProfilePanel(state), { labels: LABELS, hoverId: null });
  const placed = (ctx as unknown as { placed: Array<{ text: string; x: number }> }).placed;

  for (const [hardware, snes] of fixedMapRows(LABELS)) {
    const line = `${hardware} \u2192 ${snes}`;
    const drawn = placed.find((p) => p.text === line);
    assert.ok(drawn, `${line} was not drawn`);
    // The same metric the fixture's own measureText uses.
    const width = line.length * 9;
    assert.ok(
      width <= FIXED_COL_W,
      `"${line}" needs ${width}px in a ${FIXED_COL_W}px column - shorten the wording`
    );
    assert.ok(
      drawn!.x + width <= quit!.x,
      `"${line}" reaches ${drawn!.x + width}px and the buttons start at ${quit!.x}px`
    );
  }
});

/*
 * Leaving the game and leaving VR were the same button, and they are not the
 * same thing.
 *
 * `quit` ends the `XRSession`: the headset drops back to the Quest's own
 * shell. A player who has simply finished a game and wants to pick another
 * one had no way to say so - the launch screen is reachable only when no game
 * holds the curved screen, so the only route from a running game back to the
 * library was out of VR entirely and in again.
 *
 * `stopTogether()` in `VrShell` already does exactly this and has since the
 * lockstep session gained an error path; it was simply unreachable on purpose.
 */

test('stopping the game is offered only while one is running', () => {
  assert.ok(
    !layoutProfilePanel(IDLE).map((r) => r.id).includes('stop'),
    'there is no game to stop from the launch screen'
  );
  assert.ok(
    layoutProfilePanel({ ...IDLE, playing: true }).map((r) => r.id).includes('stop'),
    'a finished game leaves the player no way back to the library'
  );
});

test('stopping the game is a different region from leaving VR', () => {
  // The two used to be one button, and conflating them is the bug: a player
  // who wants another game should not have to take the headset off.
  const regions = layoutProfilePanel({ ...IDLE, playing: true });
  const stop = regions.find((r) => r.id === 'stop');
  const quit = regions.find((r) => r.id === 'quit');
  assert.ok(stop && quit, 'both must exist while a game is running');
  assert.notDeepEqual(
    { x: stop.x, y: stop.y },
    { x: quit.x, y: quit.y },
    'one press cannot mean two things'
  );
});

test('stopping the game says so, in words that are not the ones for leaving VR', () => {
  const ctx = recordingContext();
  const state = { ...IDLE, playing: true };
  drawProfilePanel(ctx, state, layoutProfilePanel(state), {
    labels: LABELS,
    hoverId: null
  });
  const drawn = ctx.texts.join('\n');
  assert.ok(drawn.includes(LABELS.stopGame), 'the button is unlabelled');
  assert.ok(drawn.includes(LABELS.quit), 'leaving VR lost its own label');
});
