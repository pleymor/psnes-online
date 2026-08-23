/**
 * Whether a savestate belongs to the game this room is playing.
 *
 * `game:load` checked that the caller owns the save, and nothing else - so a
 * save from a different game could be handed to the emulator, which would take
 * the bytes and produce a machine in a state that never existed. Loading a
 * Zelda save into a Mario room was a request the server accepted.
 *
 * The comparison is on the checksum, not the game id, and that distinction is
 * the whole reason this is a function rather than one line inline: each player
 * has their **own** `Game` row for the same ROM, so the guest resuming their own
 * save in the host's room has a save whose gameId will never match the room's.
 * The CRC32 is what identifies the dump across both rows - `Room.gameCrc32`
 * exists for exactly that, and says so.
 *
 * An unknown checksum on either side is not treated as a mismatch. Rows created
 * before ROMs stayed local carry no CRC32, and refusing them here would break a
 * case that works today to guard against one that cannot be proven.
 */
export function saveSuitsRoom(
  roomCrc32: string | undefined | null,
  saveGameCrc32: string | undefined | null
): boolean {
  if (!roomCrc32 || !saveGameCrc32) return true;
  return roomCrc32 === saveGameCrc32;
}
