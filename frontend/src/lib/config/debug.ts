/**
 * Centralized debug configuration
 *
 * Controls verbose logging across the application for development and troubleshooting.
 *
 * Set to `true` to enable detailed performance and diagnostic logs:
 * - WebRTC connection metrics and codec information
 * - Emulator FPS tracking
 * - Input/video latency measurements
 * - Audio capture events
 * - Socket connection events
 *
 * Set to `false` (default) for production to improve performance by:
 * - Eliminating frequent console.log() calls
 * - Reducing string formatting overhead
 * - Minimizing garbage collection pressure
 *
 * Note: console.warn() and console.error() remain active regardless of this setting
 */
export const DEBUG = false;
