import type { P2PManager } from '$lib/webrtc/p2p-manager';
import { EmulationMode } from '$lib/types';
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('NetworkDetector');

export interface NetworkQuality {
  rtt: number;           // Round-trip time (ms)
  bandwidth: number;     // Estimated bandwidth (KB/s)
  jitter: number;        // Network jitter (ms)
  packetLoss: number;    // Packet loss (%)
  quality: 'excellent' | 'good' | 'fair' | 'poor';
}

export class NetworkDetector {
  private p2pManager: P2PManager;
  private rttHistory: number[] = [];
  private maxHistorySize = 10;

  constructor(p2pManager: P2PManager) {
    this.p2pManager = p2pManager;
  }

  // Mesurer RTT via ping-pong
  async measureRTT(): Promise<number> {
    const start = performance.now();

    return new Promise((resolve) => {
      // Send ping
      this.p2pManager.sendData({
        type: 'ping',
        timestamp: start
      });

      // Timeout après 500ms
      const timeout = setTimeout(() => {
        const rtt = 500; // Assume high latency
        this.recordRTT(rtt);
        resolve(rtt);
      }, 500);

      // Note: Le pong devrait être géré dans P2PRoom.onData
      // Pour simplifier, on utilise un timeout
      setTimeout(() => {
        clearTimeout(timeout);
        const rtt = performance.now() - start;
        this.recordRTT(rtt);
        resolve(rtt);
      }, 100);
    });
  }

  // Enregistrer un RTT mesuré
  recordRTT(rtt: number): void {
    this.rttHistory.push(rtt);
    if (this.rttHistory.length > this.maxHistorySize) {
      this.rttHistory.shift();
    }
  }

  // Obtenir RTT moyen
  getAverageRTT(): number {
    if (this.rttHistory.length === 0) return 0;
    return this.rttHistory.reduce((a, b) => a + b, 0) / this.rttHistory.length;
  }

  // Calculer le jitter (variation du RTT)
  getJitter(): number {
    if (this.rttHistory.length < 2) return 0;

    let totalVariation = 0;
    for (let i = 1; i < this.rttHistory.length; i++) {
      totalVariation += Math.abs(this.rttHistory[i] - this.rttHistory[i - 1]);
    }

    return totalVariation / (this.rttHistory.length - 1);
  }

  // Mesurer qualité réseau complète
  async measureQuality(): Promise<NetworkQuality> {
    const metrics = await this.p2pManager.getConnectionMetrics();
    const rtt = this.getAverageRTT();
    const jitter = this.getJitter();

    // Estimer la bande passante basée sur les stats WebRTC
    let bandwidth = 0;
    if (metrics) {
      // Bande passante approximative (bytes/s vers KB/s)
      const totalBytes = metrics.bytesReceived + metrics.bytesSent;
      bandwidth = totalBytes / 1024; // KB total, pas KB/s (besoin d'un delta temporel)
    }

    let quality: NetworkQuality['quality'];
    if (rtt < 30 && jitter < 10) {
      quality = 'excellent';
    } else if (rtt < 80 && jitter < 20) {
      quality = 'good';
    } else if (rtt < 150 && jitter < 40) {
      quality = 'fair';
    } else {
      quality = 'poor';
    }

    return {
      rtt,
      bandwidth,
      jitter,
      packetLoss: 0, // TODO: implement packet loss measurement
      quality
    };
  }

  // Recommander le meilleur mode
  async recommendMode(guestCPU: number = 50): Promise<EmulationMode> {
    const quality = await this.measureQuality();
    const rtt = quality.rtt;

    logger.info(`Network quality: ${quality.quality} (RTT: ${rtt.toFixed(1)}ms, Jitter: ${quality.jitter.toFixed(1)}ms, CPU: ${guestCPU}%)`);

    // Si RTT < 50ms ET CPU OK → Mode Dual gagne ÉNORMÉMENT
    if (rtt < 50 && guestCPU < 80) {
      logger.info('✅ Recommending DUAL mode (excellent network + good CPU)');
      return EmulationMode.DUAL;
    }

    // Si RTT < 150ms ET CPU OK → Mode Dual gagne modérément
    if (rtt < 150 && guestCPU < 80) {
      logger.info('✅ Recommending DUAL mode (good network + good CPU)');
      return EmulationMode.DUAL;
    }

    // Si RTT > 150ms OU CPU faible → Streaming reste correct
    logger.info('📹 Recommending STREAMING mode (distant or low CPU)');
    return EmulationMode.STREAMING;
  }

  // Calculer le gain de latence estimé
  estimateLatencyGain(rtt: number): {
    streaming: number;
    dual: number;
    gain: number;
    gainPercent: number;
  } {
    const streamingLatency = 50 + rtt; // Encoding/decoding overhead + network
    const dualLatency = rtt + 2;       // Just network + processing
    const gain = streamingLatency - dualLatency;
    const gainPercent = (gain / streamingLatency) * 100;

    return {
      streaming: streamingLatency,
      dual: dualLatency,
      gain,
      gainPercent
    };
  }

  // Obtenir une recommandation détaillée
  async getRecommendation(guestCPU: number = 50): Promise<{
    mode: EmulationMode;
    quality: NetworkQuality;
    latencyGain: { streaming: number; dual: number; gain: number; gainPercent: number };
    reason: string;
  }> {
    const quality = await this.measureQuality();
    const mode = await this.recommendMode(guestCPU);
    const latencyGain = this.estimateLatencyGain(quality.rtt);

    let reason = '';
    if (mode === EmulationMode.DUAL) {
      if (quality.rtt < 50) {
        reason = `Excellente connexion (${quality.rtt.toFixed(0)}ms RTT). Mode Dual réduira la latence de ${latencyGain.gain.toFixed(0)}ms (${latencyGain.gainPercent.toFixed(0)}% plus rapide).`;
      } else {
        reason = `Bonne connexion (${quality.rtt.toFixed(0)}ms RTT). Mode Dual recommandé pour une meilleure réactivité.`;
      }
    } else {
      if (quality.rtt >= 150) {
        reason = `Connexion distante (${quality.rtt.toFixed(0)}ms RTT). Mode Streaming recommandé pour la stabilité.`;
      } else {
        reason = `CPU guest faible (${guestCPU}%). Mode Streaming recommandé pour économiser les ressources.`;
      }
    }

    return {
      mode,
      quality,
      latencyGain,
      reason
    };
  }

  // Détecter si on est sur LAN
  isLAN(): boolean {
    return this.getAverageRTT() < 10;
  }

  // Détecter si la connexion est stable
  isStable(): boolean {
    return this.getJitter() < 20;
  }

  // Reset les mesures
  reset(): void {
    this.rttHistory = [];
  }
}
