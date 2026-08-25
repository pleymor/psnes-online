/**
 * What a click on a game card should do, given the room I am already in.
 *
 * Three answers, and the reason they are gathered here rather than spread
 * through the library page: the button's meaning changes with the state of the
 * group, and a reader of the template would see two of the three branches at
 * most.
 *
 * Takes the room and nothing else. It is always *my* room - the store only ever
 * exposes the one I am a member of - so there is no identity to check here, and
 * no way to pass the wrong room without noticing.
 */

/** The little a decision needs to know about a room. */
export interface GroupRoom {
	id: string;
	status: 'waiting' | 'playing';
	players: { userId: string }[];
}

export type GameClick =
	| { kind: 'launch-solo' }
	| { kind: 'choose-for-group'; roomId: string }
	| { kind: 'blocked'; reason: 'playing' };

export function gameClick(room: GroupRoom | null | undefined): GameClick {
	if (!room) return { kind: 'launch-solo' };

	// The server refuses to change the game of a playing room, so this click has
	// nowhere to go. The banner offers the way back into the game instead.
	if (room.status === 'playing') return { kind: 'blocked', reason: 'playing' };

	// A room with only me in it is not a group. Launching gives it up, which
	// `room:create` does on its own.
	if (room.players.length < 2) return { kind: 'launch-solo' };

	return { kind: 'choose-for-group', roomId: room.id };
}
