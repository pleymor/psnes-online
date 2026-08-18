import { writable } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { createLogger } from '$lib/utils/logger';
import { linkState } from '$lib/stores/connection';

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
    // Forever, with a five second ceiling between tries. Ten attempts gave up
    // after well under a minute, which is shorter than a deployment - and
    // once socket.io has given up it never tries again, so the game was over.
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
  });

  socketInstance.on('connect', () => {
    logger.debug('Socket connected');
    linkState.set('connected');
  });

  socketInstance.on('disconnect', () => {
    logger.debug('Socket disconnected');
    linkState.set('reconnecting');
  });

  socketInstance.on('error', (error: any) => {
    logger.error('Socket error:', error);
  });

  socket.set(socketInstance);

  if (isDev) {
    // Dev only: lets a probe script drive the lobby the way a player would,
    // instead of reverse-engineering selectors for every button.
    (window as unknown as Record<string, unknown>).__psnesSocket = socketInstance;
  }

  return socketInstance;
}
