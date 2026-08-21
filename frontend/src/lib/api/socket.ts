import { get, writable } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { createLogger } from '$lib/utils/logger';
import { linkState } from '$lib/stores/connection';

const logger = createLogger('Socket');

export const socket = writable<Socket | null>(null);

/**
 * Waits for the shared socket to exist.
 *
 * The layout creates it in a reactive block that runs after its own onMount has
 * awaited /auth/me - and a child's onMount runs before its parent's. So any
 * component that registers socket listeners when it mounts sees a null store
 * and, if it gives up there, never hears anything again. That bounced every
 * direct visit to a room URL back to the library, and it would silently swallow
 * the invitations the server pushes at connection time.
 *
 * Resolves null on timeout, which the caller has to handle: there is no socket
 * to listen on.
 */
export function waitForSocket(timeoutMs = 10000): Promise<Socket | null> {
  const existing = get(socket);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = socket.subscribe((value) => {
      if (!value) return;
      clearTimeout(timer);
      // Defer: subscribe fires synchronously, before `unsubscribe` is bound.
      queueMicrotask(() => unsubscribe());
      resolve(value);
    });
  });
}

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

  socketInstance.on('disconnect', (reason: Socket.DisconnectReason) => {
    logger.debug('Socket disconnected', { reason });
    // socket.io does not retry after either side ended the connection on
    // purpose - a deliberate logout or a server-initiated kick - so those two
    // reasons are the only ones where "reconnecting…" would be false.
    const isExplicitDisconnect = reason === 'io client disconnect' || reason === 'io server disconnect';
    linkState.set(isExplicitDisconnect ? 'offline' : 'reconnecting');
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
