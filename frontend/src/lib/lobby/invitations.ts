/**
 * The invitations addressed to me.
 *
 * Lifted out of the top bar, which is mounted on two pages out of the whole
 * application - so an invitation arriving anywhere else appeared nowhere at all.
 * Nothing here is new; each rule kept the comment it came with.
 *
 * Module scope, like `my-room.ts` and for the same reason: the server pushes
 * `lobby:invitations` at connection time, and a listener attached from a
 * component's `onMount` can be late for it.
 */
import { get, writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';
import { socket } from '$lib/api/socket';

export interface Invitation {
	id: string;
	roomId: string;
	fromUserId: string;
	fromPseudo: string;
	fromAvatar?: string;
	/** Absent while the room has no game yet, which is now an ordinary state. */
	gameTitle?: string;
	/**
	 * An ISO string, not a Date: Socket.IO serialises dates on the way out and
	 * never revives them, so this is parsed before anything is done with it.
	 */
	expiresAt: string;
}

const list = writable<Invitation[]>([]);
const answeringNow = writable<string | null>(null);
const error = writable<string>('');

export const invitations: Readable<Invitation[]> = list;
/** The invitation whose answer is in flight, so a refusal can be attributed. */
export const answering: Readable<string | null> = answeringNow;
export const invitationError: Readable<string> = error;

export function acceptInvitation(id: string): void {
	error.set('');
	answeringNow.set(id);
	get(socket)?.emit('lobby:accept', { invitationId: id });
}

export function declineInvitation(id: string): void {
	error.set('');
	answeringNow.set(id);
	get(socket)?.emit('lobby:decline', { invitationId: id });
}

function forget(invitationId: string) {
	answeringNow.set(null);
	error.set('');
	list.update((current) => current.filter((i) => i.id !== invitationId));
}

let attachedTo: Socket | null = null;

function attach(sock: Socket) {
	if (attachedTo === sock) return;
	attachedTo = sock;

	// Replaced, not merged: this is the server's whole answer - sent at every
	// connection, already filtered for expiry and for rooms that still exist -
	// and merging would keep resurrecting the ones it left out on purpose.
	sock.on('lobby:invitations', (incoming: Invitation[]) => list.set(incoming ?? []));

	// Keyed by id rather than appended: re-inviting refreshes one row instead of
	// adding another, so the same id arrives again with a later deadline.
	sock.on('lobby:invitation', (invitation: Invitation) =>
		list.update((current) => [...current.filter((i) => i.id !== invitation.id), invitation])
	);

	/*
	 * Accepting no longer navigates.
	 *
	 * The group is formed and both players stay on their library, which is where
	 * the game is chosen now. When there *is* somewhere to go - an invitation into
	 * a room that already has a game - the server says so with `room:opened`, and
	 * the layout is what listens for it.
	 */
	sock.on('lobby:accepted', ({ invitationId }: { invitationId: string }) => forget(invitationId));
	sock.on('lobby:declined', ({ invitationId }: { invitationId: string }) => forget(invitationId));

	/*
	 * The room took its invitation back.
	 *
	 * It leaves without a word: the invitee never asked for anything, so there is
	 * nothing to report to them - but leaving the row would offer an invitation
	 * the server now refuses, and the only thing accepting it could earn them is
	 * an error.
	 */
	sock.on('lobby:invitation-cancelled', ({ invitationId }: { invitationId: string }) =>
		forget(invitationId)
	);

	/*
	 * Only while an answer of ours is in flight.
	 *
	 * `error` is the server's general-purpose channel, so a message meant for some
	 * other feature has no business surfacing in the invitation card. The row is
	 * left in place: a room that filled up can free a seat again while the ten
	 * minutes are still running, and the server leaves that invitation pending for
	 * exactly that reason.
	 */
	sock.on('error', (payload: { message?: string }) => {
		if (!get(answeringNow)) return;
		answeringNow.set(null);
		error.set(payload?.message ?? '');
	});
}

if (browser) {
	socket.subscribe((sock) => {
		if (sock) {
			attach(sock);
			return;
		}
		attachedTo = null;
		list.set([]);
		answeringNow.set(null);
		error.set('');
	});
}
