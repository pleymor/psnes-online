import { writable } from 'svelte/store';

export interface Game {
  id: string;
  title: string;
  filename: string;
  coverUrl?: string;
  uploadedAt: string;
  saves: any[];
  // Google Drive reference
  driveFileId: string;
  driveFileName: string;
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
