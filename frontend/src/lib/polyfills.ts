// Polyfills for Node.js modules in browser (needed by simple-peer)
import { Buffer } from 'buffer';
import process from 'process';

// Make Buffer and process available globally
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
  (window as any).process = process;
  (window as any).global = window;
}

export {};
