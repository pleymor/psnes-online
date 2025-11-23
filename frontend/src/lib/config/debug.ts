/**
 * Centralized debug configuration
 *
 * Controls verbose logging across the application for development and troubleshooting.
 *
 * To enable/disable debug mode dynamically from browser console:
 *   window.setDebug(true)   // Enable debug logs
 *   window.setDebug(false)  // Disable debug logs
 *   window.getDebug()       // Check current state
 *
 * When enabled, shows detailed performance and diagnostic logs:
 * - WebRTC connection metrics and codec information
 * - Emulator FPS tracking
 * - Input/video latency measurements
 * - Audio capture events
 * - Socket connection events
 * - RetroArch emulator output
 *
 * When disabled (default), improves performance by:
 * - Eliminating frequent console.log() calls
 * - Reducing string formatting overhead
 * - Minimizing garbage collection pressure
 *
 * Note: console.warn() and console.error() remain active regardless of this setting
 */

// Use a function to get current debug state (allows dynamic toggling)
const debugState = { enabled: false };

export const DEBUG = () => debugState.enabled;

// Expose global function to toggle debug mode
if (typeof window !== 'undefined') {
  (window as any).setDebug = (enabled: boolean) => {
    debugState.enabled = enabled;
    console.log(`🔧 Debug mode ${enabled ? 'enabled ✅' : 'disabled ❌'}`);
  };

  (window as any).getDebug = () => {
    console.log(`🔧 Debug mode is currently ${debugState.enabled ? 'enabled ✅' : 'disabled ❌'}`);
    return debugState.enabled;
  };

  // Show available debug commands on page load (kept as console.log for user-facing commands)
  console.log('💡 Debug commands available:');
  console.log('  window.setDebug(true)   - Enable debug logs');
  console.log('  window.setDebug(false)  - Disable debug logs');
  console.log('  window.getDebug()       - Check current debug state');
}
