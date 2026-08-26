/**
 * What this tab was playing, so a reload can put it back.
 *
 * A room of one dies with its player's socket, and a reload closes that socket
 * exactly the way closing the window does - the two only become distinguishable
 * a second later, when the same player comes back. The room is therefore gone
 * before the reloaded page has finished asking for it, and the page arrives
 * knowing only a room id the server has never heard of. It cannot rebuild what
 * it cannot name, and the game is the one thing nobody left can tell it.
 *
 * So the tab remembers, in `sessionStorage` rather than `localStorage`: this is
 * scoped to exactly the lifetime that matters. It survives a reload, it is not
 * shared with the tab next door playing something else, and it goes away with
 * the tab rather than resurrecting a room days later.
 *
 * Only rooms of one are remembered. A room with a partner in it does not die
 * with one window, so there is nothing to rebuild - and rebuilding would put
 * the two players in different rooms while telling neither.
 */

const KEY = 'psnes:room';

export interface RememberedRoom {
	roomId: string;
	gameId: string;
	gameTitle: string;
}

/**
 * The minimum a store has to do. Narrower than `Storage` so a test can pass a
 * plain object, and so the three calls this module makes are visible here.
 */
export interface RoomStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * Every access is wrapped, and none of them are optional politeness.
 *
 * `sessionStorage` is not merely empty in a private window or with site data
 * blocked - reading the property itself throws in some browsers, which would
 * take down whichever room-page statement touched it. A tab that cannot
 * remember is a tab that falls back to today's behaviour, not a broken one.
 */
function safely<T>(run: (store: RoomStore) => T, fallback: T): T {
	try {
		if (typeof sessionStorage === 'undefined') return fallback;
		return run(sessionStorage);
	} catch {
		return fallback;
	}
}

export function rememberRoom(room: RememberedRoom, store?: RoomStore): void {
	const write = (s: RoomStore) => s.setItem(KEY, JSON.stringify(room));
	if (store) {
		try {
			write(store);
		} catch {
			/* see safely() */
		}
		return;
	}
	safely(write, undefined);
}

export function forgetRoom(store?: RoomStore): void {
	const clear = (s: RoomStore) => s.removeItem(KEY);
	if (store) {
		try {
			clear(store);
		} catch {
			/* see safely() */
		}
		return;
	}
	safely(clear, undefined);
}

/**
 * What this tab remembers, but only if it is about the room being asked for.
 *
 * The id has to match. Without that check a stale note would rebuild the wrong
 * game under a hand-typed URL, and "this room no longer exists" - which is the
 * honest answer to a room that never was - would become a room appearing out of
 * nowhere with somebody else's cartridge in it.
 */
export function recallRoom(roomId: string, store?: RoomStore): RememberedRoom | null {
	const read = (s: RoomStore): RememberedRoom | null => {
		const raw = s.getItem(KEY);
		if (!raw) return null;

		// Hand-edited, half-written, or left by an older version of this code.
		// A note we cannot read is a note we do not have.
		const parsed = JSON.parse(raw) as Partial<RememberedRoom> | null;
		if (!parsed?.roomId || !parsed.gameId || typeof parsed.gameTitle !== 'string') return null;
		if (parsed.roomId !== roomId) return null;

		return { roomId: parsed.roomId, gameId: parsed.gameId, gameTitle: parsed.gameTitle };
	};

	if (store) {
		try {
			return read(store);
		} catch {
			return null;
		}
	}
	return safely(read, null);
}
