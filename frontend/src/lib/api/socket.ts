import { writable } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { DEBUG } from '$lib/config/debug';

export const socket = writable<Socket | null>(null);

export function initializeSocket() {
  // In development, connect directly to backend to avoid Vite proxy issues with binary data
  // In production, use relative path (nginx handles proxy)
  const isDev = import.meta.env.DEV;
  const socketUrl = isDev ? `http://${window.location.hostname}:3000` : '/';

  const socketInstance = io(socketUrl, {
    withCredentials: true,
    transports: ['websocket'], // Force WebSocket for lowest latency
    upgrade: false, // Don't start with polling
    rememberUpgrade: true,
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
  });

  socketInstance.on('connect', () => {
    if (DEBUG) console.log('Socket connected');
  });

  socketInstance.on('disconnect', () => {
    if (DEBUG) console.log('Socket disconnected');
  });

  socketInstance.on('error', (error: any) => {
    console.error('Socket error:', error);
  });

  socket.set(socketInstance);

  return socketInstance;
}
