/**
 * What comes back when a catalogue cover URL is fetched.
 *
 * Measured on 2026-09-13: 572 of the 3692 entries in libretro-thumbnails'
 * Named_Boxarts are git symlinks, and raw.githubusercontent serves a symlink as
 * its target's *name* -- a 19-byte text/plain body -- under a Content-Type of
 * image/png. Eighteen catalogue entries land on one, Donkey Kong Country and
 * Super Metroid among them, and every one of them has been rendering as a
 * broken image behind the "title only" fallback.
 *
 * So the body decides what it is, never the Content-Type, and a body that names
 * a neighbour is a second fetch rather than a failure.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readCoverBody } from '../src/covers/source.js';

const BOXARTS =
  'https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Super_Nintendo_Entertainment_System/master/Named_Boxarts/';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64)
]);

test('an image body is read as the format its own bytes claim', () => {
  const body = readCoverBody(BOXARTS + 'Anything.png', PNG);

  assert.deepEqual(body, { kind: 'image', mime: 'image/png', bytes: PNG });
});

test('a git symlink body names the neighbour to fetch instead', () => {
  // The exact body raw.githubusercontent returns for ActRaiser (USA) (Arcade).png.
  const body = readCoverBody(
    BOXARTS + encodeURIComponent('ActRaiser (USA) (Arcade).png'),
    Buffer.from('ActRaiser (USA).png', 'utf8')
  );

  assert.deepEqual(body, {
    kind: 'symlink',
    url: BOXARTS + encodeURIComponent('ActRaiser (USA).png')
  });
});

test('a symlink body is followed with its spaces and quotes encoded', () => {
  // Named_Boxarts is full of apostrophes and commas; an unencoded target would
  // be a 404 that looks exactly like a missing cover.
  const body = readCoverBody(
    BOXARTS + 'whatever.png',
    Buffer.from("Diddy's Kong Quest (USA) (En,Fr).png", 'utf8')
  );

  assert.equal(
    body.kind === 'symlink' ? body.url : null,
    BOXARTS + encodeURIComponent("Diddy's Kong Quest (USA) (En,Fr).png")
  );
});

test('a symlink cannot point outside its own directory', () => {
  // The body is bytes from a third party, and it is about to become a URL we
  // fetch. Traversal is refused rather than normalised.
  for (const target of ['../../../etc/passwd', '/etc/passwd', 'sub/dir/x.png']) {
    const body = readCoverBody(BOXARTS + 'whatever.png', Buffer.from(target, 'utf8'));
    assert.equal(body.kind, 'unusable', `${target} must not be followed`);
  }
});

test('an error page is unusable rather than a symlink to follow', () => {
  const body = readCoverBody(BOXARTS + 'missing.png', Buffer.from('404: Not Found', 'utf8'));

  assert.equal(body.kind, 'unusable');
});

test('an empty body is unusable', () => {
  assert.equal(readCoverBody(BOXARTS + 'x.png', Buffer.alloc(0)).kind, 'unusable');
});

test('a body far too long to be a filename is never treated as one', () => {
  // An HTML interstitial can begin with something filename-shaped; length is
  // what keeps a page out of the symlink path.
  const body = readCoverBody(BOXARTS + 'x.png', Buffer.from('a.png'.padEnd(4096, ' '), 'utf8'));

  assert.equal(body.kind, 'unusable');
});
