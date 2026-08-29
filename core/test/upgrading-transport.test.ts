/**
 * The policy that moves a running session onto the faster path.
 *
 * Kept apart from the WebRTC transport itself so it can be exercised without a
 * browser, an ICE negotiation or a peer: everything interesting here is about
 * *when* to switch, and none of it needs a real data channel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { UpgradingTransport } from '../../frontend/src/lib/znet/upgrading-transport.js';
import type { Transport } from '../../frontend/src/lib/znet/transport.js';
import type { UpgradableTransport } from '../../frontend/src/lib/znet/upgrading-transport.js';

class FakeTransport implements Transport {
	sent: Uint8Array[] = [];
	closed = false;
	handler: ((d: Uint8Array) => void) | null = null;
	get rtt(): number | null {
		return null;
	}
	send(data: Uint8Array): void {
		this.sent.push(data);
	}
	onMessage(h: (d: Uint8Array) => void): void {
		this.handler = h;
	}
	close(): void {
		this.closed = true;
	}
	/** Simulates a packet arriving on this path. */
	deliver(byte: number): void {
		this.handler?.(new Uint8Array([byte]));
	}
}

class FakeFaster extends FakeTransport implements UpgradableTransport {
	open = false;
}

function pair() {
	const slow = new FakeTransport();
	const fast = new FakeFaster();
	return { slow, fast, t: new UpgradingTransport(slow, fast) };
}

test('until the faster path is open, everything goes the slow way', () => {
	const { slow, fast, t } = pair();
	t.send(new Uint8Array([1]));
	assert.equal(slow.sent.length, 1);
	assert.equal(fast.sent.length, 0);
});

test('once the faster path opens, it carries the traffic', () => {
	const { slow, fast, t } = pair();
	t.send(new Uint8Array([1]));
	fast.open = true;
	t.send(new Uint8Array([2]));
	assert.equal(slow.sent.length, 1, 'the early packet still went the slow way');
	assert.equal(fast.sent.length, 1, 'and the later one did not');
});

test('a faster path that drops out hands the traffic back', () => {
	// No coordination with the peer is needed for this, which is the whole
	// reason the switch is safe to make mid-session: both paths stay subscribed
	// at both ends, so either side may change its mind at any moment.
	const { slow, fast, t } = pair();
	fast.open = true;
	t.send(new Uint8Array([1]));
	fast.open = false;
	t.send(new Uint8Array([2]));
	assert.equal(fast.sent.length, 1);
	assert.equal(slow.sent.length, 1, 'the session must not stop when the channel dies');
});

test('packets are accepted from whichever path they arrive on', () => {
	// Both ends switch independently, so a packet sent the fast way can be
	// answered the slow way and the reverse. Anything that listened to only one
	// path would lose a peer that had not switched yet.
	const { slow, fast, t } = pair();
	const seen: number[] = [];
	t.onMessage((d) => seen.push(d[0]));
	slow.deliver(1);
	fast.deliver(2);
	fast.open = true;
	slow.deliver(3);
	fast.deliver(4);
	assert.deepEqual(seen, [1, 2, 3, 4], 'every path stays subscribed the whole time');
});

test('it says which path is carrying the traffic', () => {
  // The badge shows this next to the delay. Without it, a match silently
  // relegated to the relay looks exactly like one that was always going to be
  // slow - which is how a direct channel that stopped opening went unnoticed
  // until someone read a round trip of 50ms where they used to see 20.
  const { fast, t } = pair();

  assert.equal(t.direct, false, 'the session starts on the relay, always');
  fast.open = true;
  assert.equal(t.direct, true, 'and says so the moment it moves over');
  fast.open = false;
  assert.equal(t.direct, false, 'a channel that drops out is not hidden');
});

test('closing closes both paths', () => {
	const { slow, fast, t } = pair();
	t.close();
	assert.ok(slow.closed && fast.closed);
});

test('the session measures the round trip itself', () => {
	const { t } = pair();
	assert.equal(t.rtt, null);
});
