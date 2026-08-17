import { User } from '../types/index.js';

/**
 * Who is connected, and on which socket.
 *
 * Small enough to have lived inline in the connection handler, which is where
 * it went wrong: a client that reconnects registers its new socket at once,
 * while the server may not declare the old one dead until its ping timeout -
 * up to twenty seconds later. Handling that disconnect unconditionally tore
 * down the *new* connection's entry, so the user disappeared from the map and
 * every targeted emit after that went nowhere: new rooms never reached the
 * other player until they reloaded, and they showed as offline to friends.
 *
 * Every mutation is therefore keyed on the socket that owns it.
 */
export class Presence {
  private byUser = new Map<string, string>();
  private bySocket = new Map<string, User>();

  register(user: User, socketId: string): void {
    this.byUser.set(user.id, socketId);
    this.bySocket.set(socketId, user);
  }

  /**
   * Removes a socket.
   *
   * Returns whether it was the user's current one - false means a newer
   * connection has taken over and the caller should not treat this as the user
   * going away.
   */
  unregister(userId: string, socketId: string): boolean {
    this.bySocket.delete(socketId);
    if (this.byUser.get(userId) !== socketId) return false;
    this.byUser.delete(userId);
    return true;
  }

  socketFor(userId: string): string | undefined {
    return this.byUser.get(userId);
  }

  userFor(socketId: string): User | undefined {
    return this.bySocket.get(socketId);
  }

  /** True when this socket is the one the user is currently reachable on. */
  isCurrent(userId: string, socketId: string): boolean {
    return this.byUser.get(userId) === socketId;
  }

  get onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }
}
