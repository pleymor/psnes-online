/**
 * Which save this client should ask the server for when a room opens on one.
 *
 * Asking is not free. `game:load` refuses a save its caller does not own, and
 * the save a room is staged on always belongs to the room's creator - they are
 * the only member allowed to stage one, and only one of their own. So a guest
 * that asked earned nothing but "Not authorized to load this save", while the
 * resume worked perfectly around it: the server broadcasts the answer to the
 * whole room, and in lockstep only the host applies the bytes - the guest waits
 * to be handed the machine through the netplay protocol, and would discard its
 * own reply even if it were allowed one.
 *
 * Creator rather than host, deliberately. They are the same person in the
 * ordinary case, but `hostId` moves to the remaining player when a host leaves,
 * so a creator who left and was invited back is a non-host who is nonetheless
 * the only member who may ask - while the host is the one who applies. Gating on
 * the host would silently stop resuming in exactly that configuration.
 */
export function resumeSaveToRequest(
	room: { resumeSaveId?: string } | null | undefined,
	amCreator: boolean,
	urlSaveId: string | null
): string | null {
	// The room wins over the URL: it is where both players agree, and it is the
	// later word - the creator may have staged something else from the lobby
	// after arriving on a `?save=` link.
	if (amCreator && room?.resumeSaveId) return room.resumeSaveId;

	// `?save=` is only ever put there by this client, for a game in its own
	// library, so a save named that way is mine whatever seat I hold.
	return urlSaveId ?? null;
}
