/**
 * The lockstep pads over a direct data channel, when one can be had.
 *
 * Worth having for one measured reason: the relay sits in Germany and a pad
 * crosses it once each way, so the in-game round trip reads about twice the
 * PC-to-VPS one - 62ms where a direct path would be about 31. Every frame of
 * that is input delay both players feel on every button press.
 *
 * It is emphatically not a fix for stability. Measured over five clean minutes,
 * the relay's delivery is already almost perfect: a median gap of 1.25 frames
 * between arrivals, a p90 of 29ms against the 40ms the automatic floor buffers,
 * and not one delivery in 649 samples that carried more than a single frame.
 * What hurts a session is competing traffic on the uplink, which no transport
 * can help with. This buys latency, nothing else.
 *
 * `P2PManager` is deliberately not reused. It exists to carry video: it munges
 * the SDP to prefer H.264, negotiates audio and video directions, and tunes an
 * audio jitter buffer. None of that belongs on a connection that will only ever
 * carry 22-byte pad packets, and all of it is extra ways for the negotiation to
 * fail.
 */

import '$lib/polyfills';
import SimplePeer from 'simple-peer';
import { createLogger } from '$lib/utils/logger';
import { createNegotiationBudget, type NegotiationBudget } from './negotiation-budget.js';
import type { UpgradableTransport } from './upgrading-transport.js';

const logger = createLogger('ZnetWebRTC');

/** The subset of a socket.io client the signalling needs. */
export interface SignalSocket {
	emit(event: string, ...args: unknown[]): unknown;
	on(event: string, handler: (...args: never[]) => void): unknown;
	off(event: string, handler?: (...args: never[]) => void): unknown;
}

/**
 * How long one negotiation gets before it is torn down and retried.
 *
 * A guest that has not yet joined the socket.io room never receives the offer -
 * the server drops room events with no recipient, silently - and simple-peer
 * has no way to know its offer went nowhere. Rebuilding the peer sends a fresh
 * one, which is the only repair available for a message nobody heard.
 */
const ATTEMPT_MS = 5_000;

/**
 * Attempts before settling for the relay.
 *
 * Counted from the moment the other player is actually in the room - see
 * `negotiation-budget.ts`. Counting from our own arrival is what let a guest
 * still fetching its ROM cost both players the direct channel for the whole
 * match.
 */
const MAX_ATTEMPTS = 3;

export class ZnetWebRtcTransport implements UpgradableTransport {
	private peer: SimplePeer.Instance | null = null;
	private handler: ((data: Uint8Array) => void) | null = null;
	private listener: (event: { signal?: unknown }) => void;
	private onPeerJoined: () => void;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private budget: NegotiationBudget = createNegotiationBudget(MAX_ATTEMPTS);
	private connected = false;
	private disposed = false;

	constructor(
		private socket: SignalSocket,
		private roomId: string,
		private isHost: boolean
	) {
		this.listener = (event) => {
			// The video modes share this signalling channel. Nothing else runs it
			// during a lockstep match today, but an offer meant for a camera fed
			// to this peer would break a negotiation that had every chance of
			// succeeding, and the guard costs one field.
			const wrapped = event?.signal as { znet?: unknown } | undefined;
			if (!wrapped?.znet || this.disposed) return;
			try {
				this.peer?.signal(wrapped.znet as SimplePeer.SignalData);
			} catch (err) {
				logger.debug('rejected a signal for a negotiation that had moved on', err);
			}
		};
		this.socket.on('webrtc:signal', this.listener as never);

		/*
		 * The other player reaching the netplay room is the first moment an offer
		 * can land anywhere. Before it, the server drops room events with no
		 * recipient and simple-peer never learns that nobody heard.
		 *
		 * Only the host acts: it is the initiator, so it is the one whose offers
		 * were going nowhere. A guest has nothing to resend.
		 */
		this.onPeerJoined = () => {
			if (this.disposed || this.connected) return;
			this.budget.peerArrived();
			if (!this.isHost) return;
			logger.info('the other player is here; trying for a direct channel again');
			this.attempt();
		};
		this.socket.on('znet:peer-joined', this.onPeerJoined as never);

		if (!SimplePeer.WEBRTC_SUPPORT) {
			logger.info('no WebRTC here; the session stays on the relay');
			return;
		}
		this.attempt();
	}

	/** Whether the direct path can carry a packet right now. */
	get open(): boolean {
		return this.connected && !this.disposed;
	}

	get rtt(): number | null {
		return null; // The session measures this itself with ping/pong.
	}

	send(data: Uint8Array): void {
		if (!this.open || !this.peer) return;
		try {
			this.peer.send(data);
		} catch (err) {
			// A channel that has died between `open` and here. Give up on it and
			// let the caller fall back rather than throwing into the frame loop.
			logger.debug('the direct channel refused a packet; back to the relay', err);
			this.connected = false;
		}
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.handler = handler;
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.connected = false;
		if (this.timer) clearTimeout(this.timer);
		this.socket.off('webrtc:signal', this.listener as never);
		this.socket.off('znet:peer-joined', this.onPeerJoined as never);
		this.teardown();
	}

	private teardown(): void {
		try {
			this.peer?.destroy();
		} catch {
			// Destroying a peer that never connected throws in some browsers.
		}
		this.peer = null;
	}

	private attempt(): void {
		if (this.disposed || this.connected) return;
		if (!this.budget.mayAttempt()) return;
		this.budget.started();
		if (this.timer) clearTimeout(this.timer);
		this.teardown();

		const peer = new SimplePeer({
			initiator: this.isHost,
			trickle: true,
			channelName: 'znet',
			/*
			 * Unordered, but still reliable.
			 *
			 * Unordered is the whole point: on the relay's TCP stream one lost
			 * segment holds up every pad behind it until it is retransmitted,
			 * which is exactly the stall a lockstep session cannot absorb. SCTP
			 * without ordering delivers what arrives, when it arrives.
			 *
			 * Reliable, though, because the same pipe carries the savestate. The
			 * protocol above is happy to lose a pad - packets repeat the last six
			 * frames for that reason - but a dropped state chunk costs a whole
			 * reship. Nothing above depends on order: pads carry an absolute
			 * frame, chunks an index, checksums a frame.
			 */
			channelConfig: { ordered: false },
			config: {
				iceServers: [
					{ urls: 'stun:stun.l.google.com:19302' },
					{ urls: 'stun:stun1.l.google.com:19302' }
				]
			}
		});
		this.peer = peer;

		peer.on('signal', (data) => {
			if (this.disposed) return;
			this.socket.emit('webrtc:signal', { roomId: this.roomId, signal: { znet: data } });
		});

		peer.on('connect', () => {
			if (this.disposed) return;
			this.connected = true;
			this.budget.connected();
			if (this.timer) clearTimeout(this.timer);
			logger.info('direct channel open; the pads leave the relay');
		});

		peer.on('data', (chunk: Uint8Array | ArrayBuffer) => {
			if (this.disposed) return;
			this.handler?.(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
		});

		const lost = () => {
			if (this.disposed || !this.connected) return;
			this.connected = false;
			logger.info('direct channel gone; the session carries on over the relay');
		};
		peer.on('close', lost);
		peer.on('error', (err) => {
			// Never fatal. A negotiation that fails costs latency, not the match.
			logger.debug('direct channel negotiation failed', err);
			lost();
		});

		this.timer = setTimeout(() => {
			if (this.disposed || this.connected) return;
			if (!this.budget.mayAttempt()) {
				// Not the end of it any more: the budget starts over if the other
				// player turns up later, which is what `znet:peer-joined` is for.
				logger.info(`no direct channel after ${MAX_ATTEMPTS} tries; staying on the relay`);
				this.teardown();
				return;
			}
			this.attempt();
		}, ATTEMPT_MS);
	}
}
