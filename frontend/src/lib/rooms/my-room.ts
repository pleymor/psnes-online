/**
 * The rooms this client is entitled to see, kept current.
 *
 * The library page used to read `/api/rooms` once in `onMount` and never listen
 * again, which was enough while the only thing it did with a room was offer a
 * link to it. It is not enough for a banner that has to say who is in the group,
 * who is being waited on, and whether a game is running: every one of those
 * changes after the page has loaded.
 *
 * Three events keep it current, and the server already emits all three:
 * `rooms:list` at every connection (so a reconnect re-seeds this for free),
 * `room:update` whenever a room a member or a friend may see changes, and
 * `room:destroyed` when one dies. `friend:roomCreated` is here too, because a
 * friend's brand new room arrives on that event and on no other.
 *
 * The listeners are attached from module scope rather than from a component's
 * `onMount`, deliberately: `rooms:list` is pushed by the server at connection
 * time, and a component subscribing afterwards can be late for it. The HTTP seed
 * covers the opposite race - a socket already connected before this module was
 * ever imported.
 */
import { derived, get, writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';
import { socket } from '$lib/api/socket';
import { user } from '$lib/stores/user';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('MyRoom');

export interface RoomInvitationView {
	id: string;
	toUserId: string;
	toPseudo: string;
	toAvatar?: string;
	/** An ISO string: Socket.IO serialises dates on the way out and never revives them. */
	expiresAt: string;
}

/** One room as `toPublicRoom` describes it. */
export interface RoomView {
	id: string;
	gameId?: string;
	gameTitle?: string;
	gameCoverUrl?: string;
	hostId: string;
	createdBy: string;
	status: 'waiting' | 'playing';
	players: {
		userId: string;
		pseudo: string;
		avatar?: string;
		port: 1 | 2 | null;
		isReady: boolean;
		online: boolean;
	}[];
	/** Only ever present on a room I am a member of: the server strips it otherwise. */
	invitation?: RoomInvitationView;
}

const byId = writable<Map<string, RoomView>>(new Map());

export const activeRooms: Readable<RoomView[]> = derived(byId, (map) => [...map.values()]);

/**
 * The one room I am a member of, or null.
 *
 * One room at a time is a server rule - `leaveCurrentRoom` gives up the previous
 * one on every create and every accept - which is what makes a single value the
 * right shape here rather than a list.
 */
export const myRoom: Readable<RoomView | null> = derived([byId, user], ([map, me]) => {
	if (!me) return null;
	for (const room of map.values()) {
		if (room.players.some((p) => p.userId === me.id)) return room;
	}
	return null;
});

function upsert(room: RoomView | undefined | null) {
	if (!room?.id) return;
	byId.update((map) => {
		const next = new Map(map);
		next.set(room.id, room);
		return next;
	});
}

function forget(roomId: string | undefined) {
	if (!roomId) return;
	byId.update((map) => {
		const next = new Map(map);
		next.delete(roomId);
		return next;
	});
}

async function seed() {
	try {
		const res = await fetch('/api/rooms', { credentials: 'include' });
		if (!res.ok) return;
		const rooms: RoomView[] = await res.json();
		// Merged rather than replacing: `rooms:list` may already have landed while
		// this request was in flight, and it is the fresher of the two.
		for (const room of rooms) if (!get(byId).has(room.id)) upsert(room);
	} catch (error) {
		logger.error('Could not seed the rooms list', error);
	}
}

let attachedTo: Socket | null = null;

function attach(sock: Socket) {
	if (attachedTo === sock) return;
	attachedTo = sock;

	// Replaced wholesale: this is the server's complete answer, already scoped to
	// what this user may see, and it is re-sent on every reconnection.
	sock.on('rooms:list', (rooms: RoomView[]) =>
		byId.set(new Map((rooms ?? []).map((r) => [r.id, r])))
	);
	sock.on('room:update', (room: RoomView) => upsert(room));
	sock.on('room:destroyed', ({ roomId }: { roomId: string }) => forget(roomId));
	sock.on('friend:roomCreated', ({ room }: { room: RoomView }) => upsert(room));

	void seed();
}

if (browser) {
	socket.subscribe((sock) => {
		if (sock) {
			attach(sock);
			return;
		}
		// A logout: the socket is gone and so is any claim to know what rooms exist.
		attachedTo = null;
		byId.set(new Map());
	});
}
