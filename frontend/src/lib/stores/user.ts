import { writable } from 'svelte/store';

export interface User {
  id: string;
  googleId: string;
  email: string;
  displayName: string;
  avatar?: string;
}

export const user = writable<User | null>(null);
