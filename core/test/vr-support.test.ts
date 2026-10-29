/**
 * Whether the button exists at all.
 *
 * The issue asked to "detect a Meta Quest user". Sniffing the user agent for
 * `OculusBrowser` would answer a question the browser answers better and would
 * rot on Meta's next release, so the door is the capability:
 * `isSessionSupported('immersive-vr')`. That also says yes on a PC with a
 * tethered headset, which is deliberate - the assumption "two controllers and
 * nothing else" only has to hold *inside* the session. The one exception is a
 * phone or tablet, tested at the end of this file.
 *
 * Every failure is a false, never a throw: `isSessionSupported` rejects with a
 * SecurityError when a permissions policy blocks XR, and a library page that
 * exploded over an absent headset would be a worse bug than a missing button.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { handheld, vrAvailable, type XrCapableNavigator } from '../../frontend/src/lib/vr/support.js';

test('no navigator at all is simply no VR', async () => {
  assert.equal(await vrAvailable(undefined), false);
});

test('a browser without navigator.xr is no VR', async () => {
  assert.equal(await vrAvailable({}), false);
});

test('a headset that answers yes opens the door', async () => {
  const asked: string[] = [];
  const nav = {
    xr: { isSessionSupported: async (mode: string) => { asked.push(mode); return true; } }
  };
  assert.equal(await vrAvailable(nav), true);
  assert.deepEqual(asked, ['immersive-vr'], 'inline-vr is not what this feature is');
});

test('a headset that answers no closes it', async () => {
  const nav = { xr: { isSessionSupported: async () => false } };
  assert.equal(await vrAvailable(nav), false);
});

test('a rejection is a false, not a throw', async () => {
  const nav = {
    xr: { isSessionSupported: async () => { throw new DOMException('blocked', 'SecurityError'); } }
  };
  assert.equal(await vrAvailable(nav), false, 'a permissions policy must not break the library page');
});

/*
 * A phone in a Cardboard viewer answers yes to `immersive-vr` and has no
 * controller to play with, so the button is withheld on phones and tablets
 * whatever the browser says. The headsets that run on Android must not be
 * caught by that, and neither may a desktop.
 */

const QUEST_3 =
  'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.3.0.0 Chrome/126.0.6478.188 VR Safari/537.36';
const QUEST_2_OLD =
  'Mozilla/5.0 (Linux; Android 10; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/23.2.0.4.49 SamsungBrowser/4.0 Chrome/104.0.5112.111 Mobile VR Safari/537.36';
const PICO_4 =
  'Mozilla/5.0 (Linux; Android 10; A8150 Build/QKQ1.200214.002) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.22 Chrome/105.0.5195.68 VR Safari/537.36';
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function navAs(userAgent: string, extra: Partial<XrCapableNavigator> = {}) {
  const asked: string[] = [];
  const nav: XrCapableNavigator = {
    userAgent,
    xr: { isSessionSupported: async (mode: string) => { asked.push(mode); return true; } },
    ...extra
  };
  return { nav, asked };
}

test('a phone that can do Cardboard VR gets no button', async () => {
  const { nav } = navAs(PIXEL);
  assert.equal(await vrAvailable(nav), false);
});

test('the Client Hint alone is enough to call it a phone', async () => {
  const { nav } = navAs('Mozilla/5.0 (X11; Linux x86_64)', { userAgentData: { mobile: true } });
  assert.equal(await vrAvailable(nav), false);
});

test('tablets are handled like phones, an iPad asking for the desktop site included', () => {
  assert.equal(handheld({ userAgent: ANDROID_TABLET }), true);
  assert.equal(handheld({ userAgent: IPHONE }), true);
  assert.equal(handheld({ userAgent: MAC, maxTouchPoints: 5 }), true, 'iPadOS reads as a Mac with touch points');
});

test('a desktop that answers yes keeps its button, as before', async () => {
  for (const ua of [WINDOWS, MAC]) {
    const { nav, asked } = navAs(ua, { userAgentData: { mobile: false }, maxTouchPoints: 0 });
    assert.equal(await vrAvailable(nav), true, ua);
    assert.deepEqual(asked, ['immersive-vr']);
  }
});

test('a desktop with a touch screen is still a desktop', () => {
  assert.equal(handheld({ userAgent: WINDOWS, maxTouchPoints: 10 }), false);
});

test('a Quest keeps its button, whatever its UA says about Android or Mobile', async () => {
  for (const ua of [QUEST_3, QUEST_2_OLD]) {
    const { nav } = navAs(ua, { userAgentData: { mobile: true } });
    assert.equal(await vrAvailable(nav), true, ua);
  }
});

test('a Pico keeps its button too', async () => {
  const { nav } = navAs(PICO_4);
  assert.equal(await vrAvailable(nav), true);
});

test('a phone is not asked about a headset at all', async () => {
  const { nav, asked } = navAs(IPHONE);
  assert.equal(await vrAvailable(nav), false);
  assert.deepEqual(asked, []);
});
