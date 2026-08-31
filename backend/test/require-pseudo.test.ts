/**
 * The onboarding gate, tested where it actually lives.
 *
 * The modal in the browser is an assertion of the DOM; this middleware is the
 * one that survives curl and a valid session cookie. It is a pure function of
 * req.user, so it needs neither an HTTP server nor a database to pin down.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { requirePseudo } from '../src/middleware/auth.js';

function spyResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(body: unknown) { sent.body = body; return res; }
  };
  return { res, sent };
}

test('no session is refused as unauthenticated, not as ungated', () => {
  const { res, sent } = spyResponse();
  let nexted = 0;

  requirePseudo({ user: undefined } as never, res as never, () => { nexted++; });

  assert.equal(sent.status, 401);
  assert.equal(nexted, 0);
});

test('a session whose pseudonym was assigned rather than chosen is held at 409', () => {
  const { res, sent } = spyResponse();
  let nexted = 0;

  requirePseudo(
    { user: { id: 'u1', pseudo: 'Sprite', discriminator: '0417', pseudoChosenAt: null } } as never,
    res as never,
    () => { nexted++; }
  );

  // 409 rather than 403: the account has every right, it is missing a
  // precondition. The client tells the two apart on the error field.
  assert.equal(sent.status, 409);
  assert.deepEqual(sent.body, { error: 'PSEUDO_REQUIRED' });
  assert.equal(nexted, 0, 'the request must not reach the route');
});

test('a session that has chosen passes through exactly once', () => {
  const { res, sent } = spyResponse();
  let nexted = 0;

  requirePseudo(
    { user: { id: 'u1', pseudo: 'Sprite', discriminator: '0417', pseudoChosenAt: new Date() } } as never,
    res as never,
    () => { nexted++; }
  );

  assert.equal(nexted, 1);
  assert.equal(sent.status, undefined, 'nothing should have been written to the response');
});
