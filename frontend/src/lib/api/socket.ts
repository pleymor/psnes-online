import { writable } from 'svelte/store';
import { io, Socket } from 'socket.io-client';

export const socket = writable<Socket | null>(null);

export function initializeSocket() {
  const socketInstance = io('/', {
    withCredentials: true,
    transports: ['websocket', 'polling']
  });

  socketInstance.on('connect', () => {
    console.log('Socket connected');
  });

  socketInstance.on('disconnect', () => {
    console.log('Socket disconnected');
  });

  socketInstance.on('error', (error: any) => {
    console.error('Socket error:', error);
  });

  socket.set(socketInstance);

  return socketInstance;
}
