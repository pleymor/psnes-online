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
