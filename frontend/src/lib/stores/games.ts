import { writable } from 'svelte/store';

export interface Game {
  id: string;
  title: string;
  filename: string;
  coverUrl?: string;
  uploadedAt: string;
  saves: any[];
  /**
   * CRC32 of the ROM's contents - the game's identity.
   *
   * The bytes live on the player's machine and never on the server, so this is
   * the only link between a library entry and a file on disk. Null on entries
   * created before local ROMs, which need re-linking once.
   */
  crc32?: string | null;
  /**
   * The catalogue entry this game's dump is linked to, if anyone has said.
   *
   * Resolved server-side from the CRC32, not stored on the game: that is what
   * makes one player's answer reach everyone holding the same dump.
   */
  metadataId?: string | null;
  /** Whether nothing at all is known about this game, so the player can say. */
  needsIdentification?: boolean;
  // Metadata fields
  genre?: string;
  publisher?: string;
  developer?: string;
  releaseDate?: string;
  players?: string;
  region?: string;
  description?: string;
}

export const games = writable<Game[]>([]);
