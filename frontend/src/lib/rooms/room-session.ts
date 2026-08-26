import type { Socket } from 'socket.io-client';
import { onlinePlayers } from '$lib/rooms/online-players';
import { EmulationMode, type Room } from '$lib/types';

/**
 * What the lobby needs to know about a room, derived in one place.
 *
 * A pure function of the room and the viewer, so the page can hold it as a
 * plain reactive value. It is called from a `$:` that names both its inputs -
 * `$: view = deriveRoomView(room, $user?.id)` - because Svelte 4 reads a
 * statement's dependencies from the identifiers written in it, and a call
 * whose arguments hide them would freeze the whole view at mount.
 */
export interface RoomView {
	room: Room | null;
	isCreator: boolean;
	isHost: boolean;
	isSinglePlayer: boolean;
	effectiveMode: EmulationMode | undefined;
	canResume: boolean;
}

export function deriveRoomView(room: Room | null, userId: string | undefined): RoomView {
	/*
	 * Online, not member count.
	 *
	 * A partner who closed their tab is still in `room.players`, so counting
	 * members here would put a single player into netplay: two cores exchanging
	 * inputs with nobody on the other end. The invite panel still counts members
	 * - an away member's seat is theirs - which is why these two disagree.
	 */
	const isSinglePlayer = room ? onlinePlayers(room).length <= 1 : true;

	const effectiveMode = isSinglePlayer ? EmulationMode.SINGLE : room?.emulationMode;

	/*
	 * Whether the mode this room would start in can open on a save at all.
	 *
	 * Only `SoloRoom` and `LockstepRoom` listen for `game:loaded`; `P2PRoom`,
	 * which runs the dual and streaming modes, has no savestate path at all - not
	 * from here and not from its own pause menu. So a staged save in those modes
	 * is not a bug to route around, it is a thing that does not exist, and the
	 * lobby says so rather than starting a fresh game without a word.
	 *
	 * Derived from the effective mode, which collapses to SINGLE while the partner
	 * is away. That makes the notice come and go with the partner, which is
	 * exactly right: with one player it is `SoloRoom` that runs, and it resumes.
	 */
	const canResume =
		effectiveMode === EmulationMode.SINGLE || effectiveMode === EmulationMode.LOCKSTEP;

	return {
		room,
		isCreator: room?.createdBy === userId,
		isHost: room?.hostId === userId,
		isSinglePlayer,
		effectiveMode,
		canResume
	};
}

/**
 * Wires a page to a room's socket events, and hands back the way to unwire it.
 *
 * The listeners are registered together and removed together: a listener left
 * behind after a navigation fires against a dead component, and the symptom
 * only shows up after several room changes, which is what made it hard to find
 * the first time.
 *
 * Five events, not three - `onMount` also rejoins on `connect` (the socket
 * reconnects on its own, but `room:join` does not replay itself) and leaves
 * the game on `game:stopped` (the only path that can reach the *other* player
 * of a netplay room when the match ends). Both are as much a part of the
 * subscription's lifetime as the other three, and both used to be paired with
 * their own `off` in `onDestroy`.
 *
 * Every removal names its own handler, `connect` included: the socket is
 * shared, so a bare `off('connect')` would take the reconnection banner and
 * the netplay slot's own connect listeners down with it.
 */
export function subscribeToRoom(opts: {
	socket: Socket;
	roomId: string;
	onRoom: (room: Room) => void;
	onError: (payload: { message?: string; code?: string; roomId?: string }) => void;
	onStarted: () => void;
	onReconnect: () => void;
	onStopped: () => void;
}): () => void {
	const { socket } = opts;
	socket.on('connect', opts.onReconnect);
	socket.on('room:updated', opts.onRoom);
	socket.on('game:started', opts.onStarted);
	socket.on('game:stopped', opts.onStopped);
	socket.on('error', opts.onError);
	return () => {
		socket.off('connect', opts.onReconnect);
		socket.off('room:updated', opts.onRoom);
		socket.off('game:started', opts.onStarted);
		socket.off('game:stopped', opts.onStopped);
		socket.off('error', opts.onError);
	};
}
