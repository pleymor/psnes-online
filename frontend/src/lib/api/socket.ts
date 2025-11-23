import { writable } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('Socket');

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
    logger.debug('Socket connected');
  });

  socketInstance.on('disconnect', () => {
    logger.debug('Socket disconnected');
  });

  socketInstance.on('error', (error: any) => {
    logger.error('Socket error:', error);
  });

  socket.set(socketInstance);

  return socketInstance;
}
