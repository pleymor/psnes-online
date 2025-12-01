import type { WasmEmulator } from '$lib/emulator';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('SyncManager');

export class SyncManager {
  private emulator: WasmEmulator;
  private checkInterval: number;
  private currentFrame: number = 0;
  private lastChecksum: string | null = null;

  constructor(emulator: WasmEmulator, checkInterval: number = 60) {
    this.emulator = emulator;
    this.checkInterval = checkInterval;
  }

  // Appelé chaque frame
  onFrame(): void {
    this.currentFrame++;
  }

  // Vérifier si on doit faire un sync check
  shouldCheckSync(): boolean {
    return this.currentFrame % this.checkInterval === 0 && this.currentFrame > 0;
  }

  // Calculer checksum de l'état actuel
  async computeChecksum(): Promise<string> {
    try {
      // saveState() returns { state: Blob, thumbnail?: Blob }
      const result = await this.emulator.saveState();
      if (!result || !result.state) {
        logger.warn('No state data returned from saveState()');
        return '';
      }

      // Convert Blob to ArrayBuffer
      const stateBlob = result.state;
      const arrayBuffer = await stateBlob.arrayBuffer();
      const hash = await this.hashBuffer(new Uint8Array(arrayBuffer));
      return hash;
    } catch (error) {
      logger.error('Failed to compute checksum:', error);
      return '';
    }
  }

  // Vérifier si en sync avec le host
  async checkSync(): Promise<boolean> {
    if (!this.lastChecksum) {
      logger.warn('No remote checksum to compare with');
      return true; // Assume sync if no remote checksum yet
    }

    const checksum = await this.computeChecksum();
    const inSync = checksum === this.lastChecksum;

    if (!inSync) {
      logger.warn(`Desync detected at frame ${this.currentFrame}`);
      logger.warn(`  Local:  ${checksum}`);
      logger.warn(`  Remote: ${this.lastChecksum}`);
    } else {
      logger.debug(`✅ Sync OK at frame ${this.currentFrame}`);
    }

    return inSync;
  }

  // Mettre à jour le checksum distant (reçu du host)
  setRemoteChecksum(checksum: string): void {
    this.lastChecksum = checksum;
  }

  // Hash simple (SHA-256 truncated)
  private async hashBuffer(buffer: Uint8Array): Promise<string> {
    try {
      // Create a new ArrayBuffer copy to avoid SharedArrayBuffer issues
      const copy = new Uint8Array(buffer.length);
      copy.set(buffer);
      const hashBuffer = await crypto.subtle.digest('SHA-256', copy.buffer);
      // Prendre seulement les 8 premiers octets (64 bits) pour réduire la taille
      return Array.from(new Uint8Array(hashBuffer.slice(0, 8)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (error) {
      logger.error('Failed to hash buffer:', error);
      return '';
    }
  }

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  reset(): void {
    this.currentFrame = 0;
    this.lastChecksum = null;
  }
}
