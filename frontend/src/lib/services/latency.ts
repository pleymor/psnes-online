import { LATENCY_HISTORY_SIZE } from '$lib/config/performance';

export interface LatencyMeasurement {
  timestamp: number;
  latency: number;
}

export class LatencyTracker {
  private history: number[] = [];
  private maxHistorySize: number;

  constructor(maxHistorySize: number = LATENCY_HISTORY_SIZE) {
    this.maxHistorySize = maxHistorySize;
  }

  addMeasurement(latency: number): void {
    this.history.push(latency);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  getAverage(): number {
    if (this.history.length === 0) return 0;
    const sum = this.history.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.history.length);
  }

  getMedian(): number {
    if (this.history.length === 0) return 0;
    const sorted = [...this.history].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }

  getMin(): number {
    return this.history.length > 0 ? Math.min(...this.history) : 0;
  }

  getMax(): number {
    return this.history.length > 0 ? Math.max(...this.history) : 0;
  }

  getLast(): number {
    return this.history.length > 0 ? this.history[this.history.length - 1] : 0;
  }

  clear(): void {
    this.history = [];
  }

  getHistory(): number[] {
    return [...this.history];
  }
}

// Factory function for convenience
export function createLatencyTracker(maxHistorySize?: number): LatencyTracker {
  return new LatencyTracker(maxHistorySize);
}
