/**
 * Moves a running session onto a faster path without ever depending on it.
 *
 * The relay always connects; a peer-to-peer channel does not. Both facts are
 * load-bearing, so the session starts on the relay and is carried over only if
 * and when the direct channel actually opens - see `socket-transport.ts` for
 * why the relay was chosen in the first place. Nothing here can delay a game
 * starting, and nothing here can stop one that has started.
 *
 * The switch needs no agreement between the peers, which is what makes it safe
 * to make mid-match. Both ends stay subscribed to both paths for the whole
 * session, so a packet sent the fast way can be answered the slow way while the
 * other side is still negotiating. And the protocol above does not care which
 * pipe a packet came down: pads are keyed by absolute frame, state chunks by
 * index, checksums by frame, and a repeat never overwrites a pad already run.
 * A packet arriving twice, or out of order, or from the path that was supposed
 * to have been abandoned, is a case the netcode already handles.
 */

import type { Transport } from './transport.js';

/** A transport that is not always available, and says when it is. */
export interface UpgradableTransport extends Transport {
	/** Whether the faster path can carry a packet right now. */
	readonly open: boolean;
}

export class UpgradingTransport implements Transport {
	constructor(
		private slow: Transport,
		private faster: UpgradableTransport
	) {}

	get rtt(): number | null {
		return null; // The session measures this itself with ping/pong.
	}

	/**
	 * The faster path when it is up, the relay otherwise, decided per packet.
	 *
	 * Per packet rather than once, because a data channel can die at any moment
	 * and a session that kept writing into a dead one would look exactly like
	 * the freeze this whole area has been spending its time on.
	 */
	send(data: Uint8Array): void {
		if (this.faster.open) this.faster.send(data);
		else this.slow.send(data);
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.slow.onMessage(handler);
		this.faster.onMessage(handler);
	}

	close(): void {
		this.slow.close();
		this.faster.close();
	}
}
