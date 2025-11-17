import { writable } from 'svelte/store';

export interface Game {
  id: string;
  title: string;
  filename: string;
  romPath: string;
  coverUrl?: string;
  uploadedAt: string;
  saves: any[];
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
