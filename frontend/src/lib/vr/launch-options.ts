/**
 * What the launch screen shows, decided away from the screen.
 *
 * The same shape as `rooms/game-click.ts`: a pure function over the little a
 * decision needs to know, gathered here rather than spread through a painter
 * where a reader would see two branches out of five. It imports nothing - no
 * `three`, no Svelte, no store - so every rule below is testable under Bun.
 *
 * Three of those rules exist because the alternative was measured and cost a
 * session:
 *
 *   - A dump is found by CRC32. Each player has their own `Game` row for one
 *     cartridge, so a room whose game the friend chose carries THEIR id.
 *   - The save may only be chosen by whoever opened the room. The server
 *     refuses otherwise, with an `error` that nothing in a headset draws.
 *   - A launch that cannot succeed says which of its reasons stopped it,
 *     because a headset has no console and its logs are unreadable from
 *     inside.
 */

/** One save, as the library store already holds it. */
export interface LaunchSave {
	id: string;
	name: string;
	slotNumber: number;
}

/** The little this needs from `stores/games`' `Game`. */
export interface LibraryGame {
	id: string;
	title: string;
	coverUrl?: string;
	crc32?: string | null;
	saves: readonly LaunchSave[];
}

/** The little this needs from a room. */
export interface LaunchRoom {
	id: string;
	/** Who may stage a save. Not the host: the host can change hands. */
	createdBy: string;
	status: 'waiting' | 'playing';
	gameCrc32?: string;
	/** The save the room will start on, staged through `room:choose-save`. */
	resumeSaveId?: string;
	players: {
		userId: string;
		pseudo: string;
		port: 1 | 2 | null;
		isReady: boolean;
		online: boolean;
	}[];
}

export interface FriendState {
	pseudo: string;
	online: boolean;
	port: 1 | 2 | null;
	isReady: boolean;
}

/** Why a launch is refused. Ordered by what the player can do about it. */
export type LaunchBlock = 'rom-missing' | 'already-playing' | 'no-seat';

export interface LaunchOptions {
	game: { title: string; coverUrl?: string; crc32: string };
	/** Empty when nothing has ever been saved for this dump. */
	saves: readonly LaunchSave[];
	/** The save this launch will start on, or null for a fresh game. */
	chosenSaveId: string | null;
	/** False when somebody else opened the room: `room:choose-save` refuses. */
	mayChooseSave: boolean;
	/** null before I have taken a seat, and always in solo. */
	myPort: 1 | 2 | null;
	/** null when there is no group - a room holding only me is not one. */
	friend: FriendState | null;
	/** Whether this device can read the ROM at all. */
	romHere: boolean;
	blocked: LaunchBlock | null;
}

export interface LaunchInput {
	/** The library, as `stores/games` holds it. */
	library: readonly LibraryGame[];
	/** The dump to launch: the one just clicked, or the one the room carries. */
	crc32: string;
	/** null in solo - there is no room until the launch creates one. */
	room: LaunchRoom | null;
	/** My own user id. */
	me: string;
	/** What this device can open, from `resolvableHere`. */
	openable: ReadonlySet<string>;
	/**
	 * A save staged locally, before any room exists to hold it.
	 *
	 * Solo only. Once a room exists its `resumeSaveId` is the truth, because
	 * that is the value both players see and the one the engine resolves.
	 */
	stagedSaveId?: string | null;
}

/** null when the dump is in no library entry: there is nothing to draw. */
export function launchOptions(input: LaunchInput): LaunchOptions | null {
	const entry = input.library.find((game) => game.crc32 === input.crc32);
	if (!entry) return null;

	const room = input.room;
	const mine = room?.players.find((player) => player.userId === input.me) ?? null;
	// A room holding only me is not a group, the same rule `game-click.ts` uses.
	const other = room && room.players.length >= 2
		? room.players.find((player) => player.userId !== input.me) ?? null
		: null;

	const romHere = input.openable.has(input.crc32);

	return {
		game: { title: entry.title, coverUrl: entry.coverUrl, crc32: input.crc32 },
		saves: entry.saves,
		chosenSaveId: room ? room.resumeSaveId ?? null : input.stagedSaveId ?? null,
		// In solo the room does not exist yet, so it will be created by me.
		mayChooseSave: !room || room.createdBy === input.me,
		myPort: mine?.port ?? null,
		friend: other
			? { pseudo: other.pseudo, online: other.online, port: other.port, isReady: other.isReady }
			: null,
		romHere,
		blocked: blockedBy(room, romHere)
	};
}

/**
 * Ordered by what the player can do about it, not by severity.
 *
 * A missing ROM comes first because it is the only one they cannot fix from
 * inside the headset - a seat is two buttons away, and a playing room has the
 * game itself to go back to.
 */
function blockedBy(room: LaunchRoom | null, romHere: boolean): LaunchBlock | null {
	if (!romHere) return 'rom-missing';
	if (!room) return null;
	if (room.status === 'playing') return 'already-playing';

	// Mirrors `game:start`'s own guard: it refuses when no player has both a
	// port and readiness. Offering the button anyway earns an `error` that
	// nothing in an immersive session displays.
	if (room.players.length >= 2 && !room.players.some((p) => p.port !== null && p.isReady)) {
		return 'no-seat';
	}
	return null;
}
