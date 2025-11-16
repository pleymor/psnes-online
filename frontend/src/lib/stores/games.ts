import { writable } from 'svelte/store';

export interface Game {
  id: string;
  title: string;
  filename: string;
  romPath: string;
  coverUrl?: string;
  uploadedAt: string;
  saves: any[];
}

export const games = writable<Game[]>([]);
