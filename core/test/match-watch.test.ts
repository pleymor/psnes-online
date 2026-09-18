/**
 * Telling who won, from work RAM alone.
 *
 * The whole feature rests on one property that is easy to state and easy to
 * lose: both peers read the same bytes, so both reach the same verdict without
 * exchanging a word. Nothing here may send, receive, or write - a watcher that
 * touched the machine would be a second input path into a lockstep session,
 * which is the one thing the netcode cannot survive.
 *
 * The other half is the trap the issue named: zero health is not the end of a
 * match. The KO animation leaves the value at zero for hundreds of frames, and
 * the menus that follow leave it there for as long as nobody starts a new
 * fight. A byte watcher reports a dozen winners for one knockout; a state
 * machine reports one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchObserver, watcherFor } from '../../frontend/src/lib/games/match-watch.js';
import type { MatchVerdict } from '../../frontend/src/lib/games/match-watch.js';
import { verdictMessage } from '../../frontend/src/lib/rooms/match-report.js';
import { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import type { PsnesCoreModule } from '../../frontend/src/lib/znet/core.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The French PAL dump of Super Butouden 2, the one row the table has. */
const DBZ2 = '8F24F886';

/**
 * Work RAM holding one sample, at the addresses the table names.
 *
 * 128KB, like the real thing: a watcher that reads past its own row would pass
 * against a short buffer and throw against a console.
 */
function ram(p1max: number, p1: number, p2max: number, p2: number): Uint8Array {
  const w = new Uint8Array(128 * 1024);
  const put = (at: number, value: number) => {
    w[at] = value & 0xff;
    w[at + 1] = (value >> 8) & 0xff;
  };
  put(0x0560, p1max);
  put(0x0562, p1);
  put(0x0660, p2max);
  put(0x0662, p2);
  return w;
}

/** Drives an observer over a scripted sequence of samples, one per frame. */
function replay(frames: Uint8Array[], sampleEvery = 1): MatchVerdict[] {
  const verdicts: MatchVerdict[] = [];
  let current = frames[0];
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => current,
    onVerdict: (verdict) => verdicts.push(verdict),
    sampleEvery
  });

  for (let frame = 0; frame < frames.length; frame++) {
    current = frames[frame];
    observer.note(PAD.A, PAD.B);
    observer.observe(frame);
  }
  return verdicts;
}

/* ------------------------------------------- the byte view over the pointer */

const WRAM_BASE = 2048;

/** A module with just enough surface for the work-RAM accessors. */
function fakeModule(size: number): PsnesCoreModule {
  const heap = new Uint8Array(WRAM_BASE + size + 64);
  // Stamped either side of the region so a view off by one byte is visible.
  heap.fill(0xaa, 0, WRAM_BASE);
  heap.fill(0xbb, WRAM_BASE + size);
  for (let i = 0; i < size; i++) heap[WRAM_BASE + i] = i & 0x7f;

  return {
    HEAPU8: heap,
    _pn_init: () => 1,
    _pn_wram: () => WRAM_BASE,
    _pn_wram_size: () => size
  } as unknown as PsnesCoreModule;
}

test('work RAM is a view over the core pointer, not a copy of it', async () => {
  // The whole point of the accessor: `_pn_wram()` and `_pn_wram_size()` have
  // been declared since the sync checksum landed, and only `wramCrc()` was
  // ever wrapped. Sampling health through a 128KB copy twice a second would
  // cost more than the value is worth.
  const core = await PsnesCore.create(async () => fakeModule(128 * 1024));

  const view = core.wram();
  const module = (core as unknown as { module: PsnesCoreModule }).module;
  module.HEAPU8[WRAM_BASE + 0x0560] = 0x42;

  assert.equal(view[0x0560], 0x42, 'a copy would still hold the old byte');
});

test('the view covers work RAM exactly, and nothing either side of it', async () => {
  const core = await PsnesCore.create(async () => fakeModule(128 * 1024));

  const view = core.wram();

  assert.equal(view.length, 128 * 1024);
  assert.equal(view[0], 0, 'the view starts at the pointer, not before it');
  assert.equal(view[view.length - 1], (128 * 1024 - 1) & 0x7f, 'and ends at its last byte');
});

test('a core with no work RAM yields an empty view rather than a wild one', async () => {
  const core = await PsnesCore.create(async () => fakeModule(0));

  assert.equal(core.wram().length, 0);
});

/* ------------------------------------------------------------- the verdict */

test('an unknown checksum has no watcher, rather than a plausible guess', () => {
  // Reading the right address in the wrong ROM gives a number, not an error.
  // The Japanese Super Butouden 2 and this French release are different dumps
  // with different layouts, and only one of them has been measured.
  assert.equal(watcherFor('DEADBEEF'), null);
  assert.equal(watcherFor(''), null);
});

test('the checksum is matched however it is cased', () => {
  // Game.crc32 is stored uppercase, but a URL, a log line or a hand-typed
  // table row is not, and a lookup that only works in one casing is a bug that
  // hides as "the game is not supported".
  assert.notEqual(watcherFor(DBZ2.toLowerCase()), null);
});

test('the watcher reads both ports out of work RAM', () => {
  const watcher = watcherFor(DBZ2)!;

  const sample = watcher.read(ram(400, 312, 400, 88))!;

  assert.deepEqual(sample, {
    p1: { max: 400, current: 312 },
    p2: { max: 400, current: 88 }
  });
});

test('work RAM too short to hold the row yields nothing', () => {
  const watcher = watcherFor(DBZ2)!;

  assert.equal(watcher.read(new Uint8Array(16)), null);
});

test('a knockout names the player still standing', () => {
  const verdicts = replay([ram(400, 400, 400, 400), ram(400, 366, 400, 0)]);

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 1);
  assert.deepEqual(verdicts[0].health, { p1: 366, p2: 0 });
  assert.equal(verdicts[0].frame, 1);
});

test('a knockout on the other side names the other player', () => {
  const verdicts = replay([ram(400, 400, 400, 400), ram(400, 0, 400, 120)]);

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 2);
});

test('one knockout is one verdict, however long the value sits at zero', () => {
  // The measured KO animation holds the loser at zero for around 850 frames,
  // and the menus that follow never write the address again. This is the whole
  // reason the observer is a state machine.
  const frames = [ram(400, 400, 400, 400)];
  for (let i = 0; i < 900; i++) frames.push(ram(400, 366, 400, 0));

  assert.equal(replay(frames).length, 1);
});

test('a second match is decided in its own right', () => {
  // Both healths going back to full is the only signal a new fight has begun -
  // the game writes max and current together when the round starts, from
  // whatever the handicap screen was left on.
  const frames = [
    ram(400, 400, 400, 400),
    ram(400, 366, 400, 0),
    ram(400, 366, 400, 0),
    ram(400, 400, 400, 400),
    ram(400, 0, 400, 210)
  ];

  const verdicts = replay(frames);

  assert.deepEqual(
    verdicts.map((v) => v.winner),
    [1, 2]
  );
});

test('the running score is what a session is worth telling', () => {
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => current,
    onVerdict: () => {},
    sampleEvery: 1
  });
  const frames = [
    ram(400, 400, 400, 400),
    ram(400, 366, 400, 0),
    ram(400, 400, 400, 400),
    ram(400, 0, 400, 210),
    ram(400, 400, 400, 400),
    ram(400, 12, 400, 0)
  ];
  let current = frames[0];

  for (let frame = 0; frame < frames.length; frame++) {
    current = frames[frame];
    observer.note(PAD.A, PAD.B);
    observer.observe(frame);
  }

  assert.deepEqual([...observer.score], [2, 1]);
});

test('a match that never started decides nothing', () => {
  // What the menus look like: the addresses hold whatever the last fight left
  // there, for minutes at a time. Nothing was armed, so nothing is decided.
  const verdicts = replay([ram(400, 366, 400, 0), ram(400, 366, 400, 0)]);

  assert.equal(verdicts.length, 0);
});

test('a double knockout is a draw, not a winner', () => {
  const verdicts = replay([ram(400, 400, 400, 400), ram(400, 0, 400, 0)]);

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 0);
});

test('an unequal handicap still arms, because full is per player', () => {
  // The handicap screen sets each side's VIE independently - 340 against 40
  // was measured - and the game writes current = max for each. Arming on a
  // fixed 400 would leave every handicapped match unreported.
  const verdicts = replay([ram(340, 340, 40, 40), ram(340, 300, 40, 0)]);

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 1);
});

test('implausible work RAM never arms the observer', () => {
  // Before the game has written the row - and in any other game that reaches
  // these addresses - the bytes are arbitrary. Health above anything the
  // handicap screen can produce, or current above max, is not a match.
  const verdicts = replay([
    ram(0xffff, 0xffff, 0xffff, 0xffff),
    ram(0xffff, 0, 0xffff, 0xffff),
    ram(0, 0, 0, 0),
    ram(0, 0, 0, 0)
  ]);

  assert.equal(verdicts.length, 0);
});

test('current health above max is refused as a reading, not clamped', () => {
  const verdicts = replay([ram(400, 401, 400, 400), ram(400, 401, 400, 0)]);

  assert.equal(verdicts.length, 0);
});

test('work RAM is only read on the frames actually sampled', () => {
  // The one loop that must not be slowed. wramCrc() runs per frame in the test
  // harness; a production read on the hot path is a cost paid sixty times a
  // second for a value that changes meaningfully once a match.
  let reads = 0;
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => {
      reads++;
      return ram(400, 400, 400, 400);
    },
    onVerdict: () => {},
    sampleEvery: 30
  });

  for (let frame = 0; frame < 300; frame++) observer.observe(frame);

  assert.equal(reads, 10, 'one read every 30 frames, and not one more');
});

test('the observer never writes to the memory it reads', () => {
  // The rule the renderer had to obey: nothing observed here may feed back
  // into the emulation. Two peers that read the same bytes agree for free;
  // one that writes has forked the machine.
  const w = ram(400, 400, 400, 400);
  const before = Array.from(w);
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => w,
    onVerdict: () => {},
    sampleEvery: 1
  });

  for (let frame = 0; frame < 10; frame++) observer.observe(frame);

  assert.deepEqual(Array.from(w), before);
});

/* -------------------------------------------------- what a player is told */

test('a verdict reads as a winner and a running score', () => {
  const message = verdictMessage('en', { winner: 2, health: { p1: 0, p2: 88 }, frame: 900 }, [1, 3]);

  assert.equal(message, 'Player 2 wins - Score 1 - 3');
});

test('a draw names no winner', () => {
  const message = verdictMessage('fr', { winner: 0, health: { p1: 0, p2: 0 }, frame: 60 }, [2, 2]);

  assert.equal(message, 'Double K.O. - Score 2 - 2');
});

test('the message is translated, not assembled in English and patched', () => {
  const message = verdictMessage('fr', { winner: 1, health: { p1: 44, p2: 0 }, frame: 60 }, [1, 0]);

  assert.equal(message, 'Le joueur 1 gagne - Score 1 - 0');
});

test('match-watch.ts reaches for nothing but the bytes it is handed', () => {
  // A grep, for the same reason solo.test.ts greps solo.ts: the "read-only,
  // off the emulation path" rule is invisible in a passing test suite, and the
  // way it gets broken is someone reaching for the transport to tell the peer.
  const source = readFileSync(
    path.resolve(here, '..', '..', 'frontend', 'src', 'lib', 'games', 'match-watch.ts'),
    'utf8'
  );
  const forbidden = /\bsend\b|transport|socket|fetch\(|localStorage|Date\.now|performance\.now/;
  assert.equal(forbidden.test(source), false, 'a verdict is derived, never exchanged or timed');
});

/* ------------------------------------------------ la garde d'activité */

/** Comme `replay`, mais en poussant un masque de manette par image. */
function replayWithPads(
  frames: Uint8Array[],
  pads: [number, number][],
  sampleEvery = 1
): MatchVerdict[] {
  const verdicts: MatchVerdict[] = [];
  let current = frames[0];
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => current,
    onVerdict: (verdict) => verdicts.push(verdict),
    sampleEvery
  });

  for (let frame = 0; frame < frames.length; frame++) {
    current = frames[frame];
    observer.note(pads[frame][0], pads[frame][1]);
    observer.observe(frame);
  }
  return verdicts;
}

/**
 * Plein, entamé, puis le port 2 à zéro : un KO du port 1 sur trois images.
 *
 * L'image du milieu n'est délibérément PAS à pleine vie. La branche qui arme
 * se reprend à chaque échantillon où les deux barres sont pleines et remet
 * l'activité à zéro : avec deux images pleines d'affilée, il ne resterait
 * qu'une seule image pour prouver quoi que ce soit, et chaque test serait à un
 * appui près de ne plus rien dire.
 */
const KO_OF_P2 = [ram(100, 100, 100, 100), ram(100, 90, 100, 40), ram(100, 80, 100, 0)];

test('un port muet pendant tout le combat ne produit aucun verdict', () => {
  const verdicts = replayWithPads(KO_OF_P2, [[PAD.A, 0], [PAD.B, 0], [PAD.A, 0]]);
  assert.deepEqual(verdicts, []);
});

test('les deux ports actifs produisent le verdict', () => {
  // Les appuis comptés sont ceux d'APRÈS la dernière image de pleine vie.
  const verdicts = replayWithPads(KO_OF_P2, [[0, 0], [0, PAD.B], [PAD.A, 0]]);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 1);
});

test('START et SELECT ne sont pas des appuis de combat', () => {
  const pads: [number, number][] = [
    [PAD.A, PAD.START],
    [PAD.A, PAD.SELECT],
    [PAD.A, PAD.START | PAD.SELECT]
  ];
  assert.deepEqual(replayWithPads(KO_OF_P2, pads), []);
});

test('les gâchettes en sont, elles', () => {
  const verdicts = replayWithPads(KO_OF_P2, [[0, 0], [PAD.L, 0], [0, PAD.R]]);
  assert.equal(verdicts.length, 1);
});

test('un appui avant que le combat s’arme ne compte pas', () => {
  // Le port 2 joue pendant les menus, puis se tait dès que les deux barres
  // sont pleines : c’est le joueur qui repose sa manette avant le round.
  const frames = [ram(100, 40, 100, 90), ...KO_OF_P2];
  const pads: [number, number][] = [[0, PAD.A], [PAD.A, 0], [PAD.B, 0], [PAD.A, 0]];
  assert.deepEqual(replayWithPads(frames, pads), []);
});

test('un appui entre deux échantillons compte quand même', () => {
  // La raison d’être de `note()` : `observe()` ne lit la RAM qu’une image sur
  // 30, et l’unique appui du port 2 tombe sur une image non échantillonnée.
  const frames: Uint8Array[] = [];
  const pads: [number, number][] = [];
  for (let f = 0; f < 61; f++) {
    frames.push(f < 60 ? ram(100, 100, 100, 100) : ram(100, 80, 100, 0));
    pads.push([PAD.A, f === 45 ? PAD.B : 0]);
  }
  const verdicts = replayWithPads(frames, pads, 30);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].winner, 1);
});

test('un combat refusé ne compte pas non plus au score courant', () => {
  const verdicts: MatchVerdict[] = [];
  let wram = ram(100, 100, 100, 100);
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => wram,
    onVerdict: (verdict) => verdicts.push(verdict),
    sampleEvery: 1
  });

  // Armer pour de bon - deux barres pleines - puis un KO que seul le port 1 a
  // joué. Sans l'armement, la machine sortirait sur `!armed` et ce test
  // passerait sans jamais atteindre la garde.
  observer.note(PAD.A, 0);
  observer.observe(0);
  wram = ram(100, 80, 100, 0);
  observer.note(PAD.A, 0);
  observer.observe(1);

  assert.deepEqual(verdicts, []);
  assert.deepEqual([...observer.score], [0, 0]);
  assert.equal(observer.draws, 0);
});

test('un score lu à un verdict ne bouge pas quand le suivant arrive', () => {
  // Épingle le contrat du getter : `score` rend une copie, pas `wins`
  // lui-même. Sans elle, quelqu'un pourrait un jour « simplifier » le getter
  // en rendant le tableau interne tel quel, et ce test serait le seul à s'en
  // apercevoir - un appelant qui garde la valeur d'un premier verdict la
  // verrait changer sous lui au second, sans qu'aucune ligne à cet endroit ne
  // le touche.
  let wram = ram(100, 100, 100, 100);
  const observer = new MatchObserver({
    watcher: watcherFor(DBZ2)!,
    readWram: () => wram,
    onVerdict: () => {},
    sampleEvery: 1
  });

  observer.note(PAD.A, PAD.B);
  observer.observe(0); // arme
  wram = ram(100, 80, 100, 0);
  observer.note(PAD.A, PAD.B);
  observer.observe(1); // KO du port 2 : le port 1 gagne

  const scoreAfterFirstVerdict = observer.score;
  assert.deepEqual([...scoreAfterFirstVerdict], [1, 0]);

  wram = ram(100, 100, 100, 100);
  observer.note(PAD.A, PAD.B);
  observer.observe(2); // arme un second combat
  wram = ram(100, 0, 100, 60);
  observer.note(PAD.A, PAD.B);
  observer.observe(3); // KO du port 1 : le port 2 gagne

  assert.deepEqual([...scoreAfterFirstVerdict], [1, 0]);
  assert.deepEqual([...observer.score], [1, 1]);
});
