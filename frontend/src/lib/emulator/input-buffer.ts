import type { InputState } from '$lib/types';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('InputBuffer');

export class InputBuffer {
  private buffer: Map<number, InputState> = new Map();
  private delayFrames: number;
  private minDelay: number = 1;
  private maxDelay: number = 10;

  constructor(delayFrames: number = 3) {
    this.delayFrames = Math.max(this.minDelay, Math.min(this.maxDelay, delayFrames));
  }

  // Ajouter input au buffer
  addInput(frame: number, input: InputState): void {
    this.buffer.set(frame, input);

    // Nettoyer les anciens inputs (garder seulement les 60 dernières frames)
    const oldestFrameToKeep = frame - 60;
    for (const [f] of this.buffer) {
      if (f < oldestFrameToKeep) {
        this.buffer.delete(f);
      }
    }
  }

  // Récupérer input pour exécution (avec delay)
  getInput(currentFrame: number): InputState | null {
    const targetFrame = currentFrame - this.delayFrames;
    const input = this.buffer.get(targetFrame);

    if (!input) {
      logger.debug(`Missing input for frame ${targetFrame} (current: ${currentFrame}, delay: ${this.delayFrames})`);
      return null;
    }

    // Nettoyer les vieux inputs déjà consommés
    this.buffer.delete(targetFrame - 10);

    return input;
  }

  // Vérifier si on a tous les inputs nécessaires
  hasInput(frame: number): boolean {
    const targetFrame = frame - this.delayFrames;
    return this.buffer.has(targetFrame);
  }

  // Obtenir le délai actuel (en frames)
  getDelay(): number {
    return this.delayFrames;
  }

  // Ajuster le délai dynamiquement
  setDelay(frames: number): void {
    const newDelay = Math.max(this.minDelay, Math.min(this.maxDelay, frames));
    if (newDelay !== this.delayFrames) {
      logger.info(`Adjusting input delay: ${this.delayFrames} → ${newDelay} frames`);
      this.delayFrames = newDelay;
    }
  }

  // Ajuster le délai automatiquement selon le taux de perte
  autoAdjustDelay(missRate: number): void {
    // Si taux de perte > 5%, augmenter le buffer
    if (missRate > 0.05 && this.delayFrames < this.maxDelay) {
      this.setDelay(this.delayFrames + 1);
    }
    // Si taux de perte < 1% et buffer > min, réduire
    else if (missRate < 0.01 && this.delayFrames > this.minDelay) {
      this.setDelay(this.delayFrames - 1);
    }
  }

  // Obtenir le nombre d'inputs dans le buffer
  getBufferSize(): number {
    return this.buffer.size;
  }

  // Obtenir le frame le plus ancien dans le buffer
  getOldestFrame(): number | null {
    if (this.buffer.size === 0) return null;
    return Math.min(...this.buffer.keys());
  }

  // Obtenir le frame le plus récent dans le buffer
  getNewestFrame(): number | null {
    if (this.buffer.size === 0) return null;
    return Math.max(...this.buffer.keys());
  }

  // Calculer la latence du buffer (en frames)
  getBufferLatency(): number {
    const oldest = this.getOldestFrame();
    const newest = this.getNewestFrame();
    if (oldest === null || newest === null) return 0;
    return newest - oldest;
  }

  // Vider le buffer
  clear(): void {
    this.buffer.clear();
  }

  // Reset le buffer à un état initial
  reset(): void {
    this.buffer.clear();
    this.delayFrames = 3; // Reset au délai par défaut
  }

  // Obtenir les statistiques du buffer
  getStats(): {
    size: number;
    delay: number;
    latency: number;
    oldest: number | null;
    newest: number | null;
  } {
    return {
      size: this.getBufferSize(),
      delay: this.getDelay(),
      latency: this.getBufferLatency(),
      oldest: this.getOldestFrame(),
      newest: this.getNewestFrame()
    };
  }
}
