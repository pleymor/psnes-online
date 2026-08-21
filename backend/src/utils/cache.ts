/**
 * Simple in-memory cache with TTL for reducing database queries
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class Cache {
  private storage = new Map<string, CacheEntry<any>>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
    // A cache sweep must never be the reason the process stays alive. Without
    // this, any test that transitively imports this module - which is every
    // test of the websocket layer, since the handlers reach it - hangs forever
    // instead of exiting, which is why that layer had no tests at all. In
    // production the HTTP server holds the process open, so the sweep still
    // runs exactly as before.
    this.cleanupInterval.unref();
  }

  get<T>(key: string): T | null {
    const entry = this.storage.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.storage.delete(key);
      return null;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number = 5000): void {
    this.storage.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  delete(key: string): void {
    this.storage.delete(key);
  }

  clear(): void {
    this.storage.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.storage.entries()) {
      if (now > entry.expiresAt) {
        this.storage.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.clear();
  }
}

// Singleton cache instance
export const cache = new Cache();
