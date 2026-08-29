/**
 * How many tries a direct channel gets, and when the count starts over.
 *
 * Kept apart from the WebRTC transport for the same reason as the upgrade
 * policy in `upgrading-transport.ts`: everything here is counting, and none of
 * it needs ICE, a browser or a peer - so it can be exercised in a test, which
 * the transport itself cannot be.
 *
 * The rule that matters is `peerArrived`. The host starts negotiating as soon
 * as it has joined the relay itself, and an offer sent into a room the other
 * player has not reached yet is dropped by the server in silence - simple-peer
 * has no way to know nobody heard it. Spending the whole budget that way is
 * ordinary rather than rare: the guest first has to obtain the ROM, which can
 * mean a multi-megabyte transfer from the host, or a human finding a file. Both
 * outrun three five-second tries easily, and the match then ran on the relay
 * from beginning to end - 20ms of round trip becoming 50ms, with nothing left
 * that would ever try again.
 *
 * So tries spent while alone do not count: they were spent on nobody.
 */
export interface NegotiationBudget {
	/** Whether another negotiation may be started now. */
	mayAttempt(): boolean;
	/** Records that one has been started. */
	started(): void;
	/** The other player is here. Whatever was spent before this was wasted. */
	peerArrived(): void;
	/** A channel is carrying packets; there is nothing left to negotiate. */
	connected(): void;
	/** It has stopped carrying them, so there is again. */
	lost(): void;
}

export function createNegotiationBudget(maxAttempts: number): NegotiationBudget {
	let attempts = 0;
	let settled = false;

	return {
		mayAttempt: () => !settled && attempts < maxAttempts,
		started: () => {
			attempts++;
		},
		peerArrived: () => {
			// Reset rather than extend: a peer flapping in and out would otherwise
			// turn a bounded retry into an unbounded loop of ICE negotiations
			// running behind a match that is playing perfectly well on the relay.
			if (!settled) attempts = 0;
		},
		connected: () => {
			settled = true;
		},
		lost: () => {
			// A whole budget, not the leftovers. The tries spent before it
			// connected paid for a negotiation that worked; holding them against
			// the next one would leave a session that loses its channel late with
			// nothing to spend.
			//
			// Still bounded, so a link that connects and dies in a loop costs
			// three negotiations per cycle rather than an endless stream of them.
			// Worth paying: a channel that manages to connect at all is one worth
			// having back, and the alternative was never having it again.
			settled = false;
			attempts = 0;
		}
	};
}
