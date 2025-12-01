import { createLogger } from '$lib/utils/logger';

const logger = createLogger('PerformanceMonitor');

export interface PerformanceMetrics {
  // Latence
  inputLatency: number;       // Latence des inputs (ms)
  syncLatency: number;        // Latence de synchronisation (ms)
  networkRTT: number;         // Round-trip time réseau (ms)

  // Synchronisation
  syncChecks: number;         // Nombre de checks de sync effectués
  desyncCount: number;        // Nombre de désynchronisations détectées
  fallbackCount: number;      // Nombre de fallbacks vers streaming
  syncSuccessRate: number;    // Taux de succès des syncs (0-1)

  // Performance
  avgFrameTime: number;       // Temps moyen par frame (ms)
  currentFPS: number;         // FPS actuel
  targetFPS: number;          // FPS cible (60)

  // Inputs
  inputsSent: number;         // Nombre d'inputs envoyés
  inputsReceived: number;     // Nombre d'inputs reçus
  inputsMissing: number;      // Nombre d'inputs manquants
  inputsPredicted: number;    // Nombre d'inputs prédits
  inputMissRate: number;      // Taux de perte d'inputs (0-1)

  // Bande passante
  bytesSent: number;          // Octets envoyés
  bytesReceived: number;      // Octets reçus
  bandwidth: number;          // Bande passante (KB/s)

  // Mode
  mode: string;               // Mode actuel (streaming/dual)
  uptime: number;             // Temps de fonctionnement (secondes)
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics;
  private monitoringInterval: number | null = null;
  private startTime: number;
  private lastLogTime: number = 0;
  private frameTimestamps: number[] = [];
  private readonly frameHistorySize = 60;

  constructor() {
    this.startTime = performance.now();
    this.metrics = this.getInitialMetrics();
  }

  private getInitialMetrics(): PerformanceMetrics {
    return {
      inputLatency: 0,
      syncLatency: 0,
      networkRTT: 0,
      syncChecks: 0,
      desyncCount: 0,
      fallbackCount: 0,
      syncSuccessRate: 1.0,
      avgFrameTime: 0,
      currentFPS: 0,
      targetFPS: 60,
      inputsSent: 0,
      inputsReceived: 0,
      inputsMissing: 0,
      inputsPredicted: 0,
      inputMissRate: 0,
      bytesSent: 0,
      bytesReceived: 0,
      bandwidth: 0,
      mode: 'streaming',
      uptime: 0
    };
  }

  // === Événements de synchronisation ===

  onDesync(): void {
    this.metrics.desyncCount++;
    this.updateSyncSuccessRate();
    logger.warn(`⚠️ Desync #${this.metrics.desyncCount}`);
  }

  onFallback(): void {
    this.metrics.fallbackCount++;
    logger.info(`🔄 Fallback #${this.metrics.fallbackCount}`);
  }

  onSyncCheck(success: boolean): void {
    this.metrics.syncChecks++;
    if (!success) {
      this.onDesync();
    }
    this.updateSyncSuccessRate();
  }

  private updateSyncSuccessRate(): void {
    if (this.metrics.syncChecks === 0) {
      this.metrics.syncSuccessRate = 1.0;
    } else {
      const successCount = this.metrics.syncChecks - this.metrics.desyncCount;
      this.metrics.syncSuccessRate = successCount / this.metrics.syncChecks;
    }
  }

  // === Événements d'inputs ===

  onInputSent(bytes: number = 2): void {
    this.metrics.inputsSent++;
    this.metrics.bytesSent += bytes;
  }

  onInputReceived(bytes: number = 2): void {
    this.metrics.inputsReceived++;
    this.metrics.bytesReceived += bytes;
  }

  onInputMissing(): void {
    this.metrics.inputsMissing++;
    this.updateInputMissRate();
  }

  onInputPredicted(): void {
    this.metrics.inputsPredicted++;
  }

  private updateInputMissRate(): void {
    const totalExpected = this.metrics.inputsReceived + this.metrics.inputsMissing;
    if (totalExpected === 0) {
      this.metrics.inputMissRate = 0;
    } else {
      this.metrics.inputMissRate = this.metrics.inputsMissing / totalExpected;
    }
  }

  // === Performance frames ===

  onFrame(): void {
    const now = performance.now();
    this.frameTimestamps.push(now);

    if (this.frameTimestamps.length > this.frameHistorySize) {
      this.frameTimestamps.shift();
    }

    // Calculer FPS et temps moyen
    if (this.frameTimestamps.length >= 2) {
      const timeSpan = now - this.frameTimestamps[0];
      const frameCount = this.frameTimestamps.length - 1;
      this.metrics.currentFPS = Math.round((frameCount / timeSpan) * 1000);
      this.metrics.avgFrameTime = timeSpan / frameCount;
    }
  }

  // === Setters pour métriques ===

  setMode(mode: string): void {
    if (this.metrics.mode !== mode) {
      logger.info(`📊 Mode changed: ${this.metrics.mode} → ${mode}`);
      this.metrics.mode = mode;
    }
  }

  setRTT(rtt: number): void {
    this.metrics.networkRTT = rtt;
  }

  setInputLatency(latency: number): void {
    this.metrics.inputLatency = latency;
  }

  setSyncLatency(latency: number): void {
    this.metrics.syncLatency = latency;
  }

  setBandwidth(bandwidth: number): void {
    this.metrics.bandwidth = bandwidth;
  }

  // === Monitoring automatique ===

  startMonitoring(intervalMs: number = 10000): void {
    if (this.monitoringInterval) return;

    this.monitoringInterval = window.setInterval(() => {
      this.updateUptime();
      this.logMetrics();
    }, intervalMs);

    logger.info(`✅ Performance monitoring started (every ${intervalMs}ms)`);
  }

  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('⏹️ Performance monitoring stopped');
    }
  }

  private updateUptime(): void {
    this.metrics.uptime = (performance.now() - this.startTime) / 1000;
  }

  private logMetrics(): void {
    const now = performance.now();
    if (now - this.lastLogTime < 9000) return; // Éviter le spam

    this.lastLogTime = now;

    logger.info('📊 Performance Metrics:', {
      mode: this.metrics.mode,
      uptime: `${Math.floor(this.metrics.uptime)}s`,
      fps: `${this.metrics.currentFPS}/${this.metrics.targetFPS}`,
      latency: `${this.metrics.inputLatency.toFixed(1)}ms`,
      rtt: `${this.metrics.networkRTT.toFixed(1)}ms`,
      sync: `${(this.metrics.syncSuccessRate * 100).toFixed(1)}% (${this.metrics.desyncCount} desyncs)`,
      inputs: `${this.metrics.inputsSent} sent, ${this.metrics.inputsReceived} recv, ${this.metrics.inputsMissing} miss`,
      missRate: `${(this.metrics.inputMissRate * 100).toFixed(2)}%`,
      bandwidth: `${(this.metrics.bandwidth / 1024).toFixed(1)} KB/s`
    });
  }

  // === Export des métriques ===

  exportMetrics(): PerformanceMetrics {
    this.updateUptime();
    return { ...this.metrics };
  }

  getMetrics(): Readonly<PerformanceMetrics> {
    this.updateUptime();
    return this.metrics;
  }

  // === Reset ===

  reset(): void {
    const currentMode = this.metrics.mode;
    this.metrics = this.getInitialMetrics();
    this.metrics.mode = currentMode;
    this.frameTimestamps = [];
    this.startTime = performance.now();
    logger.info('🔄 Performance metrics reset');
  }

  // === Statistiques en temps réel ===

  getRealtimeStats(): {
    fps: number;
    latency: number;
    syncRate: number;
    inputMissRate: number;
  } {
    return {
      fps: this.metrics.currentFPS,
      latency: this.metrics.inputLatency,
      syncRate: this.metrics.syncSuccessRate,
      inputMissRate: this.metrics.inputMissRate
    };
  }

  // === Vérifications de santé ===

  isHealthy(): boolean {
    return (
      this.metrics.currentFPS >= 55 &&          // Au moins 55 FPS
      this.metrics.syncSuccessRate >= 0.95 &&   // Au moins 95% de sync
      this.metrics.inputMissRate < 0.05         // Moins de 5% de perte
    );
  }

  getHealthStatus(): 'healthy' | 'warning' | 'critical' {
    if (this.metrics.currentFPS < 30 || this.metrics.syncSuccessRate < 0.8) {
      return 'critical';
    }
    if (this.metrics.currentFPS < 55 || this.metrics.syncSuccessRate < 0.95) {
      return 'warning';
    }
    return 'healthy';
  }
}
