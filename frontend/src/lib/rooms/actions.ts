/**
 * The gestures of a group, in one place.
 *
 * Inviting is reachable from two screens now - the friends drawer and the
 * library's banner - and the friends list and the room screen have already
 * drifted apart once by each holding its own copy of a lobby action. One
 * implementation, several callers.
 */
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { socket } from '$lib/api/socket';
import { myRoom } from '$lib/rooms/my-room';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('GroupActions');

/**
 * Opens a room and answers with its id, or null if the server never said.
 *
 * The id is the thing every caller here needs next - to invite into it, or to
 * navigate to it - and `room:created` is the only place it comes from. A refusal
 * arrives on the `error` channel and is reported by whoever listens to it, so
 * the timeout only has to stop this promise from hanging for ever.
 */
function createRoom(payload: {
	gameId?: string;
	gameTitle?: string;
	autoStart?: boolean;
}): Promise<string | null> {
	const sock = get(socket);
	if (!sock) return Promise.resolve(null);

	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), 5000);
		sock.once('room:created', (room: { id: string }) => {
			clearTimeout(timer);
			resolve(room?.id ?? null);
		});
		sock.emit('room:create', payload);
	});
}

/**
 * Invites a friend, opening the group's room first if there is not one yet.
 *
 * The room created here *is* the group: an empty room, which "a lobby before the
 * game" made an ordinary state. It is not hidden - the banner appears in the
 * same gesture and names it.
 */
export async function inviteToGroup(friendId: string): Promise<void> {
	const sock = get(socket);
	if (!sock) return;

	const existing = get(myRoom);
	if (existing) {
		sock.emit('lobby:invite', { roomId: existing.id, friendId });
		return;
	}

	const roomId = await createRoom({});
	if (!roomId) {
		logger.error('The group room was never created, so nobody was invited');
		return;
	}

	sock.emit('lobby:invite', { roomId, friendId });
}

/** Takes the group's invitation back. Either member may. */
export function cancelGroupInvitation(invitationId: string): void {
	get(socket)?.emit('lobby:cancel', { invitationId });
}

/** Gives up the seat for real, which is what dissolves a group of two. */
export function leaveGroup(roomId: string): void {
	get(socket)?.emit('room:leave', { roomId });
}

/**
 * Opens the group's room on a game.
 *
 * Nothing navigates here: `room:opened` comes back from the server and carries
 * *both* players, which is the whole point. The save, when there is one, is
 * staged through the server too - in lockstep both machines boot from the same
 * state, so it cannot be a local variable.
 */
export function chooseGameForGroup(
	roomId: string,
	game: { id: string; title: string },
	saveId?: string
): void {
	const sock = get(socket);
	if (!sock) return;

	sock.emit('room:choose-game', { roomId, gameId: game.id, gameTitle: game.title });
	// After the game and never before: choosing a game unstages whatever save was
	// staged for the previous one.
	if (saveId) sock.emit('room:choose-save', { roomId, saveId });
}

/**
 * Starts a game on my own, with no lobby in between.
 *
 * `autoStart` is the room protocol's own door for this: the room is born
 * playing, and the room page is handed `game:started` in reply to its
 * `room:join` - the same path a reconnection takes. It also gives up whatever
 * room I was in, which is what makes a leftover one-player room a non-case.
 */
export async function launchSolo(
	game: { id: string; title: string },
	saveId?: string
): Promise<void> {
	const roomId = await createRoom({ gameId: game.id, gameTitle: game.title, autoStart: true });
	if (!roomId) {
		logger.error('The room was never created, so there was nowhere to go');
		return;
	}

	// In the URL rather than in a store, like the `?from=invitation` the library
	// already sets: it survives a reload, and it is visible when something goes
	// wrong.
	const query = saveId ? `?save=${encodeURIComponent(saveId)}` : '';
	await goto(`/room/${roomId}${query}`);
}
