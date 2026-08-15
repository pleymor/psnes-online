/**
 * Netplay transport over the app's existing socket.io connection.
 *
 * The server relays bytes between the two players without parsing them, which
 * puts it in roughly the role ZSNES gives its netplay server. Going through
 * the server rather than WebRTC costs one extra hop of latency and buys
 * something worth more here: it always connects. The lockstep engine already
 * absorbs latency with its input delay, but it cannot absorb a peer connection
 * that never establishes because both players are behind symmetric NATs.
 */

import type { Transport } from './transport.js';

/** The subset of a socket.io client this transport needs. */
export interface SocketLike {
	emit(event: string, ...args: unknown[]): unknown;
	on(event: string, handler: (...args: never[]) => void): unknown;
	off(event: string, handler?: (...args: never[]) => void): unknown;
}

interface PacketEvent {
	roomId: string;
	payload: ArrayBuffer | Uint8Array;
}

export class SocketTransport implements Transport {
	private handler: ((data: Uint8Array) => void) | null = null;
	private closed = false;
	private listener: (event: PacketEvent) => void;
	private onReconnect: () => void;

	constructor(
		private socket: SocketLike,
		private roomId: string
	) {
		this.listener = (event: PacketEvent) => {
			if (this.closed) return;
			if (event?.roomId !== this.roomId) return;
			const payload = event.payload;
			if (!payload) return;
			this.handler?.(payload instanceof Uint8Array ? payload : new Uint8Array(payload));
		};
		this.socket.on('znet:packet', this.listener as never);

		// The relay drops our player slot when the socket disconnects, so a
		// reconnect has to claim it again. Without this the session survives the
		// blip in every visible way except that no packet ever reaches the peer
		// again, which reads as a freeze rather than a disconnection.
		this.onReconnect = () => {
			if (this.closed) return;
			this.socket.emit('znet:join', { roomId: this.roomId });
		};
		this.socket.on('connect', this.onReconnect as never);
	}

	get rtt(): number | null {
		return null; // The session measures this itself with ping/pong.
	}

	send(data: Uint8Array): void {
		if (this.closed) return;
		// A copy, not a view: socket.io serialises asynchronously and the
		// session reuses its encode buffers.
		const copy = data.slice();
		this.socket.emit('znet:packet', { roomId: this.roomId, payload: copy.buffer });
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.handler = handler;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.off('znet:packet', this.listener as never);
		this.socket.off('connect', this.onReconnect as never);
		this.socket.emit('znet:leave', { roomId: this.roomId });
	}
}
