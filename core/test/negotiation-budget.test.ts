/**
 * How many tries a direct channel gets, and when the count starts over.
 *
 * Kept apart from the WebRTC transport for the same reason as the upgrade
 * policy next door: everything that decides *whether to try again* is about
 * counting, and none of it needs ICE, a browser or a peer.
 *
 * The bug this exists for: the host began negotiating the moment it had joined
 * the relay itself, not when the other player was there. Offers sent into a
 * room with nobody in it are dropped by the server in silence, so a guest that
 * spent longer than the budget locating or downloading its ROM - which the
 * transfer path makes ordinary - cost both players the direct channel for the
 * rest of the match. Measured as 20ms becoming 50ms and never coming back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createNegotiationBudget } from '../../frontend/src/lib/znet/negotiation-budget.js';

test('a fixed number of tries, then it settles', () => {
  const budget = createNegotiationBudget(3);
  for (let i = 0; i < 3; i++) {
    assert.equal(budget.mayAttempt(), true, `try ${i + 1} is allowed`);
    budget.started();
  }
  assert.equal(budget.mayAttempt(), false, 'the fourth is not');
});

test('the peer arriving buys a fresh budget', () => {
  // The heart of it: tries spent before anyone was listening were spent on
  // nobody, so they must not count against the ones that can succeed.
  const budget = createNegotiationBudget(3);
  for (let i = 0; i < 3; i++) budget.started();
  assert.equal(budget.mayAttempt(), false, 'spent, while alone');

  budget.peerArrived();
  assert.equal(budget.mayAttempt(), true, 'and now there is someone to hear the offer');
});

test('a peer that arrives before the budget is spent does not extend it forever', () => {
  // Reset, not increment: a peer flapping in and out must not turn three tries
  // into an unbounded loop of ICE negotiations behind a running match.
  const budget = createNegotiationBudget(3);
  budget.started();
  budget.peerArrived();

  for (let i = 0; i < 3; i++) {
    assert.equal(budget.mayAttempt(), true);
    budget.started();
  }
  assert.equal(budget.mayAttempt(), false, 'still three from the reset, not four');
});

test('a connected channel ends the budget for good', () => {
  // Nothing should keep negotiating behind a channel that is already carrying
  // pads, however often the peer list changes afterwards.
  const budget = createNegotiationBudget(3);
  budget.connected();
  assert.equal(budget.mayAttempt(), false);

  budget.peerArrived();
  assert.equal(budget.mayAttempt(), false, 'not even when someone rejoins');
});

test('a channel that dies is worth negotiating again', () => {
  // Losing the direct channel used to be the end of it: the transport logged
  // the loss and nothing ever tried again, so a session went back to the relay
  // for good. A backend restart mid-match is enough to cause it, which is how
  // this was found - a round trip that doubled at a deployment and stayed.
  const budget = createNegotiationBudget(3);
  budget.started();
  budget.connected();
  assert.equal(budget.mayAttempt(), false, 'nothing to negotiate while it carries packets');

  budget.lost();
  assert.equal(budget.mayAttempt(), true, 'and something to negotiate once it stops');
});

test('a channel that dies gets a whole budget, not the leftovers', () => {
  // The tries spent before it connected were spent on a negotiation that
  // succeeded. Holding them against the next one would leave a session that
  // lost its channel late with nothing to spend.
  const budget = createNegotiationBudget(3);
  for (let i = 0; i < 3; i++) budget.started();
  budget.connected();
  budget.lost();

  for (let i = 0; i < 3; i++) {
    assert.equal(budget.mayAttempt(), true, `try ${i + 1} of a fresh three`);
    budget.started();
  }
  assert.equal(budget.mayAttempt(), false, 'and bounded again, so a flapping link cannot loop');
});
