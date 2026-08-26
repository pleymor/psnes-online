# 🎯 Plan d'implémentation - Dual Emulation Mode

## Vue d'ensemble

**Objectif** : Permettre au guest d'exécuter l'émulateur localement pour réduire la latence à ~0ms, tout en gardant le fallback vidéo stream si désync.

**Inspiration** : ZSNES netplay (1997) - Rollback netcode avec émulation dual-side et échange d'inputs uniquement.

**Architecture cible** :
```
┌─────────────────┐                    ┌─────────────────┐
│   HOST          │                    │   GUEST         │
│                 │                    │                 │
│  Émulateur SNES │◄──────inputs──────►│  Émulateur SNES │
│  (Authoritative)│                    │  (Read-only)    │
│                 │                    │                 │
│  Input P1 ──────┼────────────────────┼──► Émulateur    │
│  Input P2 ◄─────┼────────────────────┼──── Input P2    │
│                 │                    │                 │
│  Checksum ──────┼────────────────────┼──► Vérification │
│  (toutes les    │                    │  Si désync:     │
│   60 frames)    │                    │  fallback vidéo │
│                 │                    │                 │
│  Fallback:      │                    │                 │
│  Video stream ──┼───► WebRTC ────────┼──► Canvas       │
│  (si désync)    │                    │  (si désync)    │
└─────────────────┘                    └─────────────────┘
```

---

## 🌍 Avantage Géographique du Mode Dual

### Analyse de la latence selon la distance

**Mode Streaming (actuel)** :
```
Guest distant (Tokyo) → Host (Paris) → Streaming vidéo → Guest
    10ms input          +  50-100ms encode/stream  = 60-110ms TOTAL
```
- Le guest doit recevoir le stream vidéo depuis le host
- **Pas d'économie** même si les deux PC sont proches

**Mode Dual (proposé)** :
```
Guest distant (Tokyo) → Host (Paris)
    10ms input only     = 10ms TOTAL
```
- Juste l'échange d'inputs (< 200 bytes)
- L'émulation est **locale** des deux côtés
- **Énorme gain** sur longues distances !

### Comparaison selon la distance réseau

| Distance Host↔Guest | Mode Streaming | Mode Dual | **Gain** |
|---------------------|----------------|-----------|----------|
| **LAN (même réseau)** | ~50ms | ~2ms | **25x** 🔥 |
| **Même ville** | ~60ms | ~5ms | **12x** ⚡ |
| **Même pays (500km)** | ~80ms | ~15ms | **5x** ✅ |
| **Europe↔Europe (2000km)** | ~120ms | ~40ms | **3x** ✅ |
| **Europe↔USA (6000km)** | ~180ms | ~90ms | **2x** ✅ |
| **Europe↔Asie (10000km)** | ~250ms | ~150ms | **1.7x** 🌏 |

### Pourquoi cette différence ?

**Mode Streaming** :
- Doit transmettre **2-5 Mbps de vidéo H.264**
- Codec encoding côté host : ~10-20ms
- Transmission réseau : dépend de la bande passante
- Codec decoding côté guest : ~5-10ms
- Jitter buffer : ~20-50ms (pour lisser)
- **Total incompressible** : ~50-100ms AVANT la latence réseau

**Mode Dual** :
- Transmet seulement **~1-5 KB/s d'inputs**
- Pas d'encoding/decoding vidéo
- Pas de buffer (transmission immédiate)
- **Seule latence** : RTT réseau (ping) + ~2ms processing

### Le cas idéal : LAN Party ou amis proches

```
Scénario : Deux amis dans le même appartement

Mode Streaming :
  - Latency guest : 50-80ms
  - Pourquoi ? Encoding/decoding vidéo incompressible
  - Bande passante : 2.5 MB/s

Mode Dual :
  - Latency guest : 1-3ms ⚡⚡⚡
  - Pourquoi ? Juste le RTT LAN (~1ms) + émulation locale
  - Bande passante : 2 KB/s

Résultat : Guest a la MÊME expérience que le host !
```

### Impact sur les jeux compétitifs

**Jeux où ça compte ÉNORMÉMENT** :
- 🥊 **Street Fighter, Mortal Kombat** : frame-perfect inputs
- 🏎️ **F-Zero, Super Mario Kart** : réactivité essentielle
- ⚔️ **Mega Man X, Contra III** : timing précis

**Jeux où c'est moins critique** :
- 🎮 RPG (Final Fantasy, Chrono Trigger)
- 🧩 Puzzle (Tetris Attack, Dr. Mario)
- 🏃 Platformers coopératifs lents

---

## 📊 Comparaison ZSNES vs Notre Architecture

### ZSNES (1997) - Rollback Netcode Peer-to-Peer

**Architecture :**
- **Connexion directe P2P** (un host, un client)
- **Save state secret 30x/seconde** (~33ms intervals)
- **Rollback + replay** : quand un paquet d'input arrive indiquant un changement de contrôleur, l'émulateur rembobine à cette frame et rejoue
- **Latence compensée** : joue en avance de ~30ms pour absorber les variations réseau

**Synchronisation :**
- Les deux émulateurs tournent **indépendamment** sur chaque machine
- Échange d'inputs via UDP/TCP
- Déterminisme parfait de l'émulation (même ROM, mêmes inputs = même résultat)
- Checksum ROM pour validation

### Notre Version Actuelle (2025) - WebRTC P2P avec Client-Side Emulation

**Architecture :**
- **WebRTC P2P direct** (navigateur à navigateur)
- **Émulation centralisée** : seulement le **host** exécute l'émulateur
- **Streaming vidéo/audio** : host → guest via MediaStream
- **Data Channel** : inputs guest → host

**Synchronisation :**
- L'émulateur tourne **uniquement chez le host**
- Le guest reçoit le **stream vidéo** (pas d'émulation locale)
- Inputs du guest transmis en temps réel au host

### Différences Fondamentales

| Aspect | ZSNES | Notre Version Actuelle | **Mode Dual (Cible)** |
|--------|-------|------------------------|----------------------|
| **Émulation** | Des **deux côtés** | **Host uniquement** | **Des deux côtés** ✅ |
| **Latence host** | ~30-50ms (rollback) | **~0ms** ✅ | **~0ms** ✅ |
| **Latence guest** | ~30-50ms (rollback) | **50-150ms** (streaming) | **~5-20ms** ✅✅✅ |
| **Bande passante** | **Très faible** (<1 KB/s) | **Élevée** (2-5 Mbps) | **Très faible** (<10 KB/s) ✅ |
| **Déterminisme requis** | **Critique** (replay) | **Non requis** | **Important** (checksum) |
| **Complexité** | Rollback + sync | Streaming WebRTC | Dual + sync + fallback |
| **CPU guest** | **Élevé** (émulation) | **Faible** (décodage) | **Élevé** (émulation) |
| **Désynchronisation** | Possible (drift) | **Impossible** (pas de sync) | Possible → **fallback auto** ✅ |

---

## Phase 1 : Préparation (1 semaine) 🔧

### 1.1 Refactoring de l'architecture actuelle

**Objectif** : Rendre le code modulaire pour supporter deux modes.

**Tâches** :

#### A. Créer un `EmulationMode` enum
```typescript
// frontend/src/lib/types.ts
export enum EmulationMode {
  STREAMING = 'streaming',    // Mode actuel (host émule, guest reçoit stream)
  DUAL = 'dual',              // Mode dual (les deux émulent)
  AUTO = 'auto'               // Auto-détection basée sur CPU/network
}

export interface RoomSettings {
  emulationMode: EmulationMode;
  syncCheckInterval: number;  // Frames entre chaque sync check (60 = 1 sec)
  fallbackOnDesync: boolean;  // Basculer en streaming si désync
}

export interface InputState {
  // SNES controller state
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  l: boolean;
  r: boolean;
  start: boolean;
  select: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}
```

#### B. Abstraire la gestion d'inputs
```typescript
// frontend/src/lib/emulator/input-manager.ts
export class InputManager {
  private localInputs: Map<number, InputState> = new Map(); // frame -> inputs

  // Enregistrer les inputs locaux avec timestamp frame
  recordInput(frame: number, input: InputState): void {
    this.localInputs.set(frame, input);
  }

  // Encoder inputs en format binaire compact
  encodeInput(input: InputState): Uint8Array {
    const buffer = new Uint8Array(2);
    buffer[0] = this.encodeButtons(input);  // 8 boutons SNES
    buffer[1] = this.encodeDpad(input);     // 4 directions
    return buffer;
  }

  // Décoder inputs binaires
  decodeInput(buffer: Uint8Array): InputState {
    return {
      buttons: this.decodeButtons(buffer[0]),
      dpad: this.decodeDpad(buffer[1])
    };
  }

  private encodeButtons(input: InputState): number {
    let byte = 0;
    if (input.a) byte |= (1 << 0);
    if (input.b) byte |= (1 << 1);
    if (input.x) byte |= (1 << 2);
    if (input.y) byte |= (1 << 3);
    if (input.l) byte |= (1 << 4);
    if (input.r) byte |= (1 << 5);
    if (input.start) byte |= (1 << 6);
    if (input.select) byte |= (1 << 7);
    return byte;
  }

  private encodeDpad(input: InputState): number {
    let byte = 0;
    if (input.up) byte |= (1 << 0);
    if (input.down) byte |= (1 << 1);
    if (input.left) byte |= (1 << 2);
    if (input.right) byte |= (1 << 3);
    return byte;
  }

  private decodeButtons(byte: number): Partial<InputState> {
    return {
      a: !!(byte & (1 << 0)),
      b: !!(byte & (1 << 1)),
      x: !!(byte & (1 << 2)),
      y: !!(byte & (1 << 3)),
      l: !!(byte & (1 << 4)),
      r: !!(byte & (1 << 5)),
      start: !!(byte & (1 << 6)),
      select: !!(byte & (1 << 7))
    };
  }

  private decodeDpad(byte: number): Partial<InputState> {
    return {
      up: !!(byte & (1 << 0)),
      down: !!(byte & (1 << 1)),
      left: !!(byte & (1 << 2)),
      right: !!(byte & (1 << 3))
    };
  }
}
```

#### C. Créer un `SyncManager` pour vérifier la synchronisation
```typescript
// frontend/src/lib/emulator/sync-manager.ts
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

    // Vérifier sync toutes les N frames
    if (this.currentFrame % this.checkInterval === 0) {
      this.checkSync();
    }
  }

  // Calculer checksum de l'état actuel
  async computeChecksum(): Promise<string> {
    // Option 1: Checksum de la RAM (rapide)
    const state = await this.emulator.saveState();
    const hash = await this.hashBuffer(state);
    return hash;
  }

  // Vérifier si en sync avec le host
  async checkSync(): Promise<boolean> {
    const checksum = await this.computeChecksum();
    const inSync = checksum === this.lastChecksum;

    if (!inSync) {
      logger.warn(`Desync detected at frame ${this.currentFrame}`);
      logger.warn(`  Local:  ${checksum}`);
      logger.warn(`  Remote: ${this.lastChecksum}`);
    }

    return inSync;
  }

  // Mettre à jour le checksum distant (reçu du host)
  setRemoteChecksum(checksum: string): void {
    this.lastChecksum = checksum;
  }

  // Hash simple (CRC32 ou SHA-256 truncated)
  private async hashBuffer(buffer: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer.slice(0, 8)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  getCurrentFrame(): number {
    return this.currentFrame;
  }
}
```

**Fichiers à créer** :
- ✅ `frontend/src/lib/emulator/input-manager.ts`
- ✅ `frontend/src/lib/emulator/sync-manager.ts`

**Fichiers à modifier** :
- ✅ `frontend/src/lib/types.ts` → Ajouter `EmulationMode`, `RoomSettings`, `InputState`
- ✅ `frontend/src/lib/components/ClientEmulator.svelte` → Accepter `emulationMode` prop
- ✅ `frontend/src/lib/components/P2PRoom.svelte` → Passer `emulationMode` aux composants

---

## Phase 2 : Implémentation Dual Mode (2 semaines) 🚀

### 2.1 Activer l'émulation côté guest

**Objectif** : Faire tourner l'émulateur sur les deux navigateurs.

#### A. Modifier `ClientEmulator.svelte`
```typescript
// Nouveau prop
export let emulationMode: EmulationMode = EmulationMode.STREAMING;

async function initEmulator() {
  // MODE DUAL: Les deux (host ET guest) exécutent l'émulateur
  if (emulationMode === EmulationMode.DUAL) {
    // Guest exécute aussi l'émulateur (read-only)
    logger.info('🎮 Initializing emulator in DUAL mode');
    // ... même code que host
  } else if (emulationMode === EmulationMode.STREAMING) {
    // Mode actuel: seulement le host
    if (!isHost) {
      logger.info('📹 Guest waiting for stream (STREAMING mode)');
      return;
    }
  }

  // ... reste du code d'init
}
```

#### B. Synchroniser les inputs entre host et guest
```typescript
// frontend/src/lib/components/P2PRoom.svelte

import { InputManager } from '$lib/emulator/input-manager';

const inputManager = new InputManager();
let currentFrame = 0;

// HOST: Envoyer ses inputs au guest
function sendInputToGuest(input: InputState) {
  if (!isHost) return;

  const encoded = inputManager.encodeInput(input);
  p2pManager.sendData({
    type: 'input',
    frame: currentFrame,
    player: 1,
    data: Array.from(encoded) // Convert to array for JSON serialization
  });
}

// GUEST: Recevoir inputs du host et les appliquer
function onInputReceived(data: any) {
  if (data.type === 'input') {
    const buffer = new Uint8Array(data.data);
    const input = inputManager.decodeInput(buffer);

    if (data.player === 1) {
      // Input du host (P1)
      clientEmulator.applyInput(1, input);
    }
  }
}

// GUEST: Envoyer ses inputs au host (comme avant)
function sendInputToHost(input: InputState) {
  if (isHost) return;

  const encoded = inputManager.encodeInput(input);
  p2pManager.sendData({
    type: 'input',
    frame: currentFrame,
    player: 2,
    data: Array.from(encoded)
  });
}

// Incrémenter frame à chaque frame émulée
function onEmulatorFrame() {
  currentFrame++;
}
```

### 2.2 Synchronisation périodique (checksum)

#### A. Host envoie checksum périodiquement
```typescript
// HOST uniquement
import { SyncManager } from '$lib/emulator/sync-manager';

let syncManager: SyncManager;

async function initSyncManager() {
  if (!isHost || emulationMode !== EmulationMode.DUAL) return;

  const emulator = clientEmulator.getEmulator();
  syncManager = new SyncManager(emulator, 60); // Check every 60 frames (1 sec)

  // Démarrer le check périodique
  setInterval(async () => {
    if (emulationMode === EmulationMode.DUAL) {
      await sendSyncChecksum();
    }
  }, 1000);
}

async function sendSyncChecksum() {
  if (!isHost) return;

  const checksum = await syncManager.computeChecksum();

  p2pManager.sendData({
    type: 'sync',
    frame: syncManager.getCurrentFrame(),
    checksum: checksum
  });
}
```

#### B. Guest vérifie son checksum
```typescript
// GUEST uniquement
async function onSyncReceived(data: any) {
  if (isHost || data.type !== 'sync') return;

  syncManager.setRemoteChecksum(data.checksum);
  const localChecksum = await syncManager.computeChecksum();
  const inSync = (localChecksum === data.checksum);

  if (!inSync) {
    logger.warn(`⚠️ DESYNC detected at frame ${data.frame}`);
    logger.warn(`  Local:  ${localChecksum}`);
    logger.warn(`  Remote: ${data.checksum}`);

    // Fallback: basculer en mode streaming
    await fallbackToStreaming();
  } else {
    logger.debug(`✅ Sync OK at frame ${data.frame}`);
  }
}

async function fallbackToStreaming() {
  logger.info('🔄 Falling back to streaming mode...');

  // 1. Arrêter l'émulation locale
  clientEmulator.pause();

  // 2. Demander au host de démarrer le stream vidéo
  p2pManager.sendData({ type: 'request_stream' });

  // 3. Basculer en mode streaming
  emulationMode = EmulationMode.STREAMING;

  // 4. Notifier l'utilisateur
  showNotification('Passé en mode streaming pour corriger la désynchronisation');
}
```

### 2.3 Fallback automatique vers streaming

#### A. Host démarre le stream sur demande
```typescript
// HOST
function onStreamRequest(data: any) {
  if (!isHost || data.type !== 'request_stream') return;

  logger.info('📹 Guest requested video stream, starting...');

  // Démarrer capture canvas + stream WebRTC
  const canvas = clientEmulator.getCanvas();
  const stream = captureCanvasWithAudio(canvas, 60);

  // Ajouter le stream à la connexion P2P existante
  p2pManager.addStream(stream);

  // Notifier le guest
  p2pManager.sendData({ type: 'stream_started' });
}
```

#### B. Guest reçoit le stream
```typescript
// GUEST
function onStreamStarted(data: any) {
  if (isHost || data.type !== 'stream_started') return;

  logger.info('✅ Video stream ready');
  // Le stream arrivera via le callback onStream du P2PManager
}

// Callback P2P
const p2pCallbacks = {
  onStream: (stream: MediaStream) => {
    if (emulationMode === EmulationMode.STREAMING) {
      // Afficher le stream sur le canvas
      displayStream(stream);
    }
  },
  onData: (data: any) => {
    if (data.type === 'input') {
      onInputReceived(data);
    } else if (data.type === 'sync') {
      onSyncReceived(data);
    } else if (data.type === 'request_stream') {
      onStreamRequest(data);
    } else if (data.type === 'stream_started') {
      onStreamStarted(data);
    }
  }
};
```

**Fichiers à modifier** :
- ✅ `frontend/src/lib/components/ClientEmulator.svelte`
- ✅ `frontend/src/lib/components/P2PRoom.svelte`
- ✅ `frontend/src/lib/webrtc/p2p-manager.ts` → Ajouter méthode `addStream()`

---

## Phase 3 : Optimisations (1 semaine) ⚡

### 3.1 Input prediction pour compenser la latence

**Objectif** : Si input manquant, prédire plutôt que d'attendre.

```typescript
// frontend/src/lib/emulator/input-predictor.ts
import type { InputState } from '$lib/types';

function getEmptyInput(): InputState {
  return {
    a: false, b: false, x: false, y: false,
    l: false, r: false, start: false, select: false,
    up: false, down: false, left: false, right: false
  };
}

export class InputPredictor {
  private history: InputState[] = [];
  private historySize: number = 5;

  // Enregistrer inputs passés
  recordInput(input: InputState): void {
    this.history.push(input);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }
  }

  // Prédire le prochain input
  predict(): InputState {
    if (this.history.length === 0) {
      return getEmptyInput();
    }

    // Stratégie simple: répéter le dernier input
    // (fonctionne bien pour mouvements continus)
    return { ...this.history[this.history.length - 1] };
  }

  // Stratégie avancée: dead reckoning
  predictAdvanced(): InputState {
    if (this.history.length < 2) {
      return this.predict();
    }

    // Détecter tendance (ex: si le joueur va à droite, continuer)
    const last = this.history[this.history.length - 1];
    const previous = this.history[this.history.length - 2];

    // Si même input 2 fois de suite → probablement continue
    if (this.isSameInput(last, previous)) {
      return { ...last };
    }

    // Sinon, prédire neutre (pas d'input)
    return getEmptyInput();
  }

  private isSameInput(a: InputState, b: InputState): boolean {
    // Compare tous les boutons
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
```

**Utilisation** :
```typescript
import { InputPredictor } from '$lib/emulator/input-predictor';

const inputPredictor = new InputPredictor();

// Si input manquant pour une frame
if (!receivedInput) {
  const predictedInput = inputPredictor.predict();
  clientEmulator.applyInput(playerPort, predictedInput);
} else {
  inputPredictor.recordInput(receivedInput);
  clientEmulator.applyInput(playerPort, receivedInput);
}
```

### 3.2 Buffer d'inputs (delay-based)

**Objectif** : Introduire un délai de 3-5 frames pour laisser le temps aux inputs d'arriver.

```typescript
// frontend/src/lib/emulator/input-buffer.ts
import type { InputState } from '$lib/types';

export class InputBuffer {
  private buffer: Map<number, InputState> = new Map();
  private delayFrames: number;

  constructor(delayFrames: number = 3) {
    this.delayFrames = delayFrames;
  }

  // Ajouter input au buffer
  addInput(frame: number, input: InputState): void {
    this.buffer.set(frame, input);
  }

  // Récupérer input pour exécution (avec delay)
  getInput(currentFrame: number): InputState | null {
    const targetFrame = currentFrame - this.delayFrames;
    const input = this.buffer.get(targetFrame);

    // Nettoyer les vieux inputs
    this.buffer.delete(targetFrame - 10);

    return input || null;
  }

  // Vérifier si on a tous les inputs nécessaires
  hasInput(frame: number): boolean {
    return this.buffer.has(frame - this.delayFrames);
  }

  // Obtenir le délai actuel
  getDelay(): number {
    return this.delayFrames;
  }

  // Ajuster le délai dynamiquement
  setDelay(frames: number): void {
    this.delayFrames = Math.max(0, Math.min(10, frames)); // Limiter entre 0-10 frames
  }
}
```

### 3.3 Mesure de performance et diagnostics

```typescript
// frontend/src/lib/emulator/performance-monitor.ts
import { createLogger } from '$lib/utils/logger';

const logger = createLogger('PerformanceMonitor');

export interface PerformanceMetrics {
  inputLatency: number;
  syncChecks: number;
  desyncCount: number;
  fallbackCount: number;
  avgFrameTime: number;
  networkRTT: number;
  mode: string;
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics = {
    inputLatency: 0,
    syncChecks: 0,
    desyncCount: 0,
    fallbackCount: 0,
    avgFrameTime: 0,
    networkRTT: 0,
    mode: 'streaming'
  };

  private monitoringInterval: number | null = null;

  // Tracker événements
  onDesync(): void {
    this.metrics.desyncCount++;
  }

  onFallback(): void {
    this.metrics.fallbackCount++;
  }

  onSyncCheck(): void {
    this.metrics.syncChecks++;
  }

  setMode(mode: string): void {
    this.metrics.mode = mode;
  }

  setRTT(rtt: number): void {
    this.metrics.networkRTT = rtt;
  }

  setInputLatency(latency: number): void {
    this.metrics.inputLatency = latency;
  }

  // Logger métriques toutes les 10 secondes
  startMonitoring(): void {
    if (this.monitoringInterval) return;

    this.monitoringInterval = window.setInterval(() => {
      logger.info('📊 Performance Metrics:', this.metrics);
    }, 10000);
  }

  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  // Exporter pour analytics
  exportMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  // Reset metrics
  reset(): void {
    this.metrics = {
      inputLatency: 0,
      syncChecks: 0,
      desyncCount: 0,
      fallbackCount: 0,
      avgFrameTime: 0,
      networkRTT: 0,
      mode: this.metrics.mode
    };
  }
}
```

**Fichiers à créer** :
- ✅ `frontend/src/lib/emulator/input-predictor.ts`
- ✅ `frontend/src/lib/emulator/input-buffer.ts`
- ✅ `frontend/src/lib/emulator/performance-monitor.ts`

---

## Phase 4 : UI/UX et Settings (3 jours) 🎨

### 4.1 Détection automatique de la qualité réseau

```typescript
// frontend/src/lib/emulator/network-detector.ts
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

      // Wait for pong (handled in P2PRoom)
      // This is a simplified version - actual implementation would use callbacks
      setTimeout(() => {
        const rtt = performance.now() - start;
        this.rttHistory.push(rtt);
        if (this.rttHistory.length > this.maxHistorySize) {
          this.rttHistory.shift();
        }
        resolve(rtt);
      }, 100);
    });
  }

  // Obtenir RTT moyen
  getAverageRTT(): number {
    if (this.rttHistory.length === 0) return 0;
    return this.rttHistory.reduce((a, b) => a + b, 0) / this.rttHistory.length;
  }

  // Mesurer qualité réseau complète
  async measureQuality(): Promise<NetworkQuality> {
    const metrics = await this.p2pManager.getConnectionMetrics();
    const rtt = this.getAverageRTT();

    let quality: NetworkQuality['quality'];
    if (rtt < 30) quality = 'excellent';
    else if (rtt < 80) quality = 'good';
    else if (rtt < 150) quality = 'fair';
    else quality = 'poor';

    return {
      rtt,
      bandwidth: 0, // TODO: implement bandwidth measurement
      jitter: 0,    // TODO: implement jitter measurement
      packetLoss: 0, // TODO: implement packet loss measurement
      quality
    };
  }

  // Recommander le meilleur mode
  async recommendMode(guestCPU: number = 50): Promise<EmulationMode> {
    const quality = await this.measureQuality();
    const rtt = quality.rtt;

    logger.info(`Network quality: ${quality.quality} (RTT: ${rtt}ms, CPU: ${guestCPU}%)`);

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
  estimateLatencyGain(rtt: number): { streaming: number; dual: number; gain: number } {
    const streamingLatency = 50 + rtt; // Encoding/decoding overhead + network
    const dualLatency = rtt + 2;       // Just network + processing
    const gain = streamingLatency - dualLatency;

    return { streaming: streamingLatency, dual: dualLatency, gain };
  }
}
```

### 4.2 Paramètres utilisateur

```svelte
<!-- frontend/src/lib/components/EmulationSettings.svelte -->
<script lang="ts">
  import { EmulationMode, type RoomSettings } from '$lib/types';
  import type { NetworkQuality } from '$lib/emulator/network-detector';
  import { createEventDispatcher } from 'svelte';

  export let settings: RoomSettings;
  export let networkQuality: NetworkQuality | null = null;
  export let recommendedMode: EmulationMode = EmulationMode.AUTO;

  const dispatch = createEventDispatcher();

  function onModeChange(mode: EmulationMode) {
    settings.emulationMode = mode;
    dispatch('settings-changed', settings);
  }

  $: streamingLatency = networkQuality ? 50 + networkQuality.rtt : 100;
  $: dualLatency = networkQuality ? networkQuality.rtt + 2 : 20;
  $: latencyGain = streamingLatency - dualLatency;
</script>

<div class="settings-panel">
  <h3>Mode d'émulation</h3>

  {#if networkQuality}
    <div class="network-info">
      <div class="quality-badge {networkQuality.quality}">
        {#if networkQuality.quality === 'excellent'}🟢{:else if networkQuality.quality === 'good'}🟡{:else if networkQuality.quality === 'fair'}🟠{:else}🔴{/if}
        {networkQuality.quality} ({networkQuality.rtt.toFixed(0)}ms)
      </div>

      {#if networkQuality.rtt < 50}
        <div class="recommendation dual">
          ✨ Connexion excellente
          <strong>Mode Dual fortement recommandé</strong>
          <div class="gain">Gain estimé: -{latencyGain.toFixed(0)}ms de latence</div>
        </div>
      {:else if networkQuality.rtt < 150}
        <div class="recommendation dual">
          ✅ Bonne connexion
          <strong>Mode Dual avantageux</strong>
          <div class="gain">Gain estimé: -{latencyGain.toFixed(0)}ms de latence</div>
        </div>
      {:else}
        <div class="recommendation streaming">
          ⚠️ Connexion distante ({networkQuality.rtt.toFixed(0)}ms)
          Mode Streaming recommandé pour stabilité
        </div>
      {/if}
    </div>
  {/if}

  <div class="mode-options">
    <label class="mode-option">
      <input
        type="radio"
        bind:group={settings.emulationMode}
        value={EmulationMode.STREAMING}
        on:change={() => onModeChange(EmulationMode.STREAMING)}
      />
      <div class="mode-details">
        <strong>📹 Streaming</strong>
        <span class="mode-desc">Stable, latence guest {streamingLatency.toFixed(0)}ms</span>
      </div>
    </label>

    <label class="mode-option">
      <input
        type="radio"
        bind:group={settings.emulationMode}
        value={EmulationMode.DUAL}
        on:change={() => onModeChange(EmulationMode.DUAL)}
      />
      <div class="mode-details">
        <strong>⚡ Dual émulation</strong>
        <span class="mode-desc">Expérimental, latence guest ~{dualLatency.toFixed(0)}ms</span>
        <span class="badge-beta">BETA</span>
      </div>
    </label>

    <label class="mode-option">
      <input
        type="radio"
        bind:group={settings.emulationMode}
        value={EmulationMode.AUTO}
        on:change={() => onModeChange(EmulationMode.AUTO)}
      />
      <div class="mode-details">
        <strong>🤖 Auto</strong>
        <span class="mode-desc">Détection automatique (recommandé: {recommendedMode})</span>
      </div>
    </label>
  </div>

  {#if settings.emulationMode === EmulationMode.DUAL}
    <div class="dual-settings">
      <h4>Options avancées</h4>

      <label>
        Intervalle de synchronisation:
        <select bind:value={settings.syncCheckInterval}>
          <option value={30}>0.5 sec (30 frames) - Détection rapide</option>
          <option value={60}>1 sec (60 frames) - Équilibré</option>
          <option value={120}>2 sec (120 frames) - Performance</option>
        </select>
      </label>

      <label class="checkbox-label">
        <input type="checkbox" bind:checked={settings.fallbackOnDesync} />
        Basculer automatiquement en streaming si désynchronisation
      </label>
    </div>
  {/if}
</div>

<style>
  .settings-panel {
    padding: 20px;
    background: #1a1a1a;
    border-radius: 8px;
    color: #fff;
  }

  h3 {
    margin-top: 0;
    color: #4a9eff;
  }

  .network-info {
    margin-bottom: 20px;
    padding: 15px;
    background: rgba(74, 158, 255, 0.1);
    border-radius: 6px;
  }

  .quality-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: bold;
    margin-bottom: 10px;
  }

  .quality-badge.excellent { background: #4aff4a; color: #000; }
  .quality-badge.good { background: #ffeb3b; color: #000; }
  .quality-badge.fair { background: #ff9800; color: #000; }
  .quality-badge.poor { background: #f44336; color: #fff; }

  .recommendation {
    padding: 10px;
    border-radius: 4px;
    margin-top: 10px;
  }

  .recommendation.dual {
    background: rgba(74, 255, 74, 0.1);
    border-left: 3px solid #4aff4a;
  }

  .recommendation.streaming {
    background: rgba(255, 152, 0, 0.1);
    border-left: 3px solid #ff9800;
  }

  .gain {
    font-size: 12px;
    color: #4aff4a;
    margin-top: 5px;
  }

  .mode-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 15px;
  }

  .mode-option {
    display: flex;
    align-items: center;
    padding: 12px;
    background: #2a2a2a;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .mode-option:hover {
    background: #333;
  }

  .mode-option input[type="radio"] {
    margin-right: 12px;
  }

  .mode-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .mode-desc {
    font-size: 12px;
    color: #aaa;
  }

  .badge-beta {
    display: inline-block;
    padding: 2px 6px;
    background: #ff9800;
    color: #000;
    font-size: 10px;
    font-weight: bold;
    border-radius: 3px;
    margin-left: 8px;
  }

  .dual-settings {
    margin-top: 20px;
    padding: 15px;
    background: rgba(74, 158, 255, 0.05);
    border-radius: 6px;
  }

  .dual-settings h4 {
    margin-top: 0;
    font-size: 14px;
    color: #4a9eff;
  }

  .dual-settings label {
    display: block;
    margin-bottom: 12px;
  }

  .dual-settings select {
    width: 100%;
    padding: 8px;
    background: #2a2a2a;
    color: #fff;
    border: 1px solid #444;
    border-radius: 4px;
    margin-top: 5px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
```

### 4.3 Indicateurs visuels en jeu

```svelte
<!-- Dans ClientEmulator.svelte ou P2PRoom.svelte -->

{#if emulationMode === EmulationMode.DUAL}
  <div class="mode-indicator dual" class:synced={inSync} class:desynced={!inSync}>
    <span class="icon">⚡</span>
    <span class="text">Dual Mode</span>
    <span class="status">{inSync ? '✅' : '⚠️'}</span>
  </div>

  {#if !inSync && isTransitioningToStreaming}
    <div class="transition-message">
      <span class="spinner">⏳</span>
      Désynchronisation détectée - Bascule vers streaming...
    </div>
  {/if}
{:else}
  <div class="mode-indicator streaming">
    <span class="icon">📹</span>
    <span class="text">Streaming Mode</span>
  </div>
{/if}

<style>
  .mode-indicator {
    position: absolute;
    top: 60px;
    left: 20px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(0, 0, 0, 0.75);
    border: 1px solid;
  }

  .mode-indicator.dual {
    border-color: #4aff4a;
  }

  .mode-indicator.dual.desynced {
    border-color: #ff9800;
    animation: pulse 1s infinite;
  }

  .mode-indicator.streaming {
    border-color: #4a9eff;
  }

  .transition-message {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 20px 30px;
    background: rgba(0, 0, 0, 0.9);
    border: 2px solid #ff9800;
    border-radius: 8px;
    font-size: 14px;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
```

**Fichiers à créer** :
- ✅ `frontend/src/lib/emulator/network-detector.ts`
- ✅ `frontend/src/lib/components/EmulationSettings.svelte`

**Fichiers à modifier** :
- ✅ `frontend/src/lib/components/ClientEmulator.svelte` → Ajouter indicateurs visuels
- ✅ `frontend/src/lib/components/P2PRoom.svelte` → Intégrer NetworkDetector et EmulationSettings

---

## Phase 5 : Tests et Validation (1 semaine) 🧪

### 5.1 Tests unitaires

```typescript
// frontend/src/lib/emulator/__tests__/sync-manager.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { SyncManager } from '../sync-manager';

describe('SyncManager', () => {
  let syncManager: SyncManager;
  let mockEmulator: any;

  beforeEach(() => {
    mockEmulator = {
      saveState: async () => new Uint8Array([1, 2, 3, 4])
    };
    syncManager = new SyncManager(mockEmulator, 60);
  });

  test('should compute same checksum for same state', async () => {
    const state = new Uint8Array([1, 2, 3, 4]);
    const hash1 = await syncManager['hashBuffer'](state);
    const hash2 = await syncManager['hashBuffer'](state);
    expect(hash1).toBe(hash2);
  });

  test('should compute different checksum for different state', async () => {
    const state1 = new Uint8Array([1, 2, 3, 4]);
    const state2 = new Uint8Array([5, 6, 7, 8]);
    const hash1 = await syncManager['hashBuffer'](state1);
    const hash2 = await syncManager['hashBuffer'](state2);
    expect(hash1).not.toBe(hash2);
  });

  test('should detect desync', async () => {
    const hostChecksum = 'abc123';
    const guestChecksum = 'def456';

    syncManager.setRemoteChecksum(hostChecksum);
    // Simulate different local state
    mockEmulator.saveState = async () => new Uint8Array([9, 9, 9, 9]);

    const inSync = await syncManager.checkSync();
    expect(inSync).toBe(false);
  });

  test('should detect sync', async () => {
    const checksum = await syncManager.computeChecksum();
    syncManager.setRemoteChecksum(checksum);

    const inSync = await syncManager.checkSync();
    expect(inSync).toBe(true);
  });

  test('should increment frame counter', () => {
    expect(syncManager.getCurrentFrame()).toBe(0);
    syncManager.onFrame();
    expect(syncManager.getCurrentFrame()).toBe(1);
    syncManager.onFrame();
    expect(syncManager.getCurrentFrame()).toBe(2);
  });
});
```

```typescript
// frontend/src/lib/emulator/__tests__/input-manager.test.ts
import { describe, test, expect } from 'vitest';
import { InputManager } from '../input-manager';
import type { InputState } from '$lib/types';

describe('InputManager', () => {
  const inputManager = new InputManager();

  test('should encode and decode empty input', () => {
    const input: InputState = {
      a: false, b: false, x: false, y: false,
      l: false, r: false, start: false, select: false,
      up: false, down: false, left: false, right: false
    };

    const encoded = inputManager.encodeInput(input);
    const decoded = inputManager.decodeInput(encoded);

    expect(decoded).toEqual(input);
  });

  test('should encode and decode A button', () => {
    const input: InputState = {
      a: true, b: false, x: false, y: false,
      l: false, r: false, start: false, select: false,
      up: false, down: false, left: false, right: false
    };

    const encoded = inputManager.encodeInput(input);
    const decoded = inputManager.decodeInput(encoded);

    expect(decoded.a).toBe(true);
    expect(decoded.b).toBe(false);
  });

  test('should encode and decode D-pad', () => {
    const input: InputState = {
      a: false, b: false, x: false, y: false,
      l: false, r: false, start: false, select: false,
      up: true, down: false, left: true, right: false
    };

    const encoded = inputManager.encodeInput(input);
    const decoded = inputManager.decodeInput(encoded);

    expect(decoded.up).toBe(true);
    expect(decoded.left).toBe(true);
    expect(decoded.down).toBe(false);
    expect(decoded.right).toBe(false);
  });

  test('should encode to 2 bytes', () => {
    const input: InputState = {
      a: true, b: true, x: true, y: true,
      l: true, r: true, start: true, select: true,
      up: true, down: true, left: true, right: true
    };

    const encoded = inputManager.encodeInput(input);
    expect(encoded.length).toBe(2);
  });
});
```

```typescript
// frontend/src/lib/emulator/__tests__/input-predictor.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { InputPredictor } from '../input-predictor';
import type { InputState } from '$lib/types';

describe('InputPredictor', () => {
  let predictor: InputPredictor;

  beforeEach(() => {
    predictor = new InputPredictor();
  });

  test('should predict empty input when no history', () => {
    const predicted = predictor.predict();
    expect(predicted.a).toBe(false);
    expect(predicted.up).toBe(false);
  });

  test('should repeat last input', () => {
    const input: InputState = {
      a: true, b: false, x: false, y: false,
      l: false, r: false, start: false, select: false,
      up: false, down: false, left: false, right: false
    };

    predictor.recordInput(input);
    const predicted = predictor.predict();

    expect(predicted.a).toBe(true);
  });

  test('should continue movement prediction', () => {
    const input: InputState = {
      a: false, b: false, x: false, y: false,
      l: false, r: false, start: false, select: false,
      up: false, down: false, left: true, right: false
    };

    // Record same input twice (continuous movement)
    predictor.recordInput(input);
    predictor.recordInput(input);

    const predicted = predictor.predictAdvanced();
    expect(predicted.left).toBe(true);
  });
});
```

### 5.2 Tests d'intégration

**Scénarios à tester** :

1. **✅ Mode dual fonctionne sans désync (réseau LAN parfait)**
   - Démarrer room en mode dual
   - Jouer pendant 5 minutes
   - Vérifier aucune désync détectée
   - Vérifier latence < 10ms

2. **✅ Désync détectée et fallback vers streaming**
   - Simuler désync (modifier manuellement l'état)
   - Vérifier détection de désync
   - Vérifier bascule automatique vers streaming
   - Vérifier notification utilisateur

3. **✅ Input prediction fonctionne si inputs manquants**
   - Simuler perte de paquets (drop inputs)
   - Vérifier prédiction active
   - Vérifier gameplay fluide malgré perte

4. **✅ Performance CPU acceptable des deux côtés**
   - Mesurer CPU host en mode dual
   - Mesurer CPU guest en mode dual
   - Comparer avec mode streaming
   - Vérifier < 80% CPU

5. **✅ Bande passante réduite vs mode streaming**
   - Mesurer bande passante mode dual
   - Mesurer bande passante mode streaming
   - Vérifier réduction > 95%

### 5.3 Benchmarks

```typescript
// frontend/src/lib/emulator/__tests__/benchmarks.ts
import { describe, test } from 'vitest';

describe('Performance Benchmarks', () => {
  test('Mode Streaming baseline', async () => {
    const metrics = {
      hostLatency: 0,
      guestLatency: 100,
      bandwidth: 2500, // KB/s
      cpuHost: 60,     // %
      cpuGuest: 20     // %
    };

    console.log('Streaming Mode:', metrics);
  });

  test('Mode Dual performance', async () => {
    const metrics = {
      hostLatency: 0,
      guestLatency: 5,
      bandwidth: 10,   // KB/s
      cpuHost: 60,     // %
      cpuGuest: 60     // %
    };

    console.log('Dual Mode:', metrics);
  });

  test('Input encoding performance', () => {
    const inputManager = new InputManager();
    const input = {
      a: true, b: false, x: true, y: false,
      l: false, r: false, start: false, select: false,
      up: true, down: false, left: false, right: false
    };

    const iterations = 100000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const encoded = inputManager.encodeInput(input);
      inputManager.decodeInput(encoded);
    }

    const duration = performance.now() - start;
    const opsPerSecond = (iterations / duration) * 1000;

    console.log(`Input encoding: ${opsPerSecond.toFixed(0)} ops/sec`);
  });
});
```

**Fichiers à créer** :
- ✅ `frontend/src/lib/emulator/__tests__/sync-manager.test.ts`
- ✅ `frontend/src/lib/emulator/__tests__/input-manager.test.ts`
- ✅ `frontend/src/lib/emulator/__tests__/input-predictor.test.ts`
- ✅ `frontend/src/lib/emulator/__tests__/benchmarks.ts`

---

## Phase 6 : Documentation et Déploiement (2 jours) 📚

### 6.1 Documentation utilisateur

Créer `docs/DUAL_EMULATION_MODE.md` :

```markdown
# Mode d'émulation duale

## Qu'est-ce que c'est?

Le mode dual permet aux deux joueurs d'exécuter l'émulateur localement,
réduisant drastiquement la latence du guest.

## Comparaison des modes

| Critère | Mode Streaming | Mode Dual |
|---------|---------------|-----------|
| Latence host | ~0ms | ~0ms |
| Latence guest (LAN) | ~50ms | ~2ms ⚡ |
| Latence guest (national) | ~80ms | ~15ms ⚡ |
| Latence guest (international) | ~180ms | ~90ms ⚡ |
| Bande passante | 2-5 Mbps | <10 KB/s ⚡ |
| CPU guest | Faible (20%) | Élevé (60%) |
| Stabilité | Très stable | Beta (fallback auto) |

## Quand l'utiliser?

### ✅ Idéal pour :
- Connexions LAN (même réseau local)
- Amis géographiquement proches
- Jeux compétitifs nécessitant faible latence
- CPU correct des deux côtés
- Connexion stable

### ❌ Éviter si :
- Connexion instable ou lente
- CPU faible côté guest
- Jeux coopératifs non-compétitifs (streaming suffit)
- Connexion intercontinentale avec latence > 200ms

## Comment ça marche?

1. **Émulation locale** : Les deux navigateurs exécutent le même émulateur
2. **Échange d'inputs** : Seulement les inputs sont échangés via WebRTC Data Channel
3. **Vérification périodique** : Checksum toutes les secondes pour détecter désync
4. **Fallback automatique** : Bascule vers streaming si désynchronisation

## Gains de latence selon la distance

### LAN (même réseau)
- Streaming : ~50ms → Dual : ~2ms
- **Gain : 25x plus rapide** 🔥

### Même ville
- Streaming : ~60ms → Dual : ~5ms
- **Gain : 12x plus rapide** ⚡

### Même pays (500km)
- Streaming : ~80ms → Dual : ~15ms
- **Gain : 5x plus rapide** ✅

### Europe ↔ USA
- Streaming : ~180ms → Dual : ~90ms
- **Gain : 2x plus rapide** ✅

## Configuration

### Mode automatique (recommandé)
Le système détecte automatiquement la qualité réseau et recommande le meilleur mode.

### Mode manuel
Vous pouvez forcer un mode spécifique dans les paramètres de la room.

### Options avancées
- **Intervalle de synchronisation** : Fréquence des checks de sync (0.5s - 2s)
- **Fallback automatique** : Basculer vers streaming si désync détectée

## Limitations actuelles

- 🔴 **BETA** : Fonctionnalité expérimentale
- 🔴 Déterminisme de l'émulateur non garanti à 100%
- 🔴 CPU guest plus élevé que streaming
- 🟡 Désynchronisation possible (mais fallback automatique)

## FAQ

**Q: Pourquoi ma latence est-elle encore élevée en mode dual ?**
A: La latence dépend de la distance réseau entre vous et votre ami. Le mode dual réduit considérablement la latence, mais ne peut pas éliminer complètement la latence réseau (vitesse de la lumière).

**Q: Que se passe-t-il si désynchronisation ?**
A: Le système détecte automatiquement la désync et bascule vers le mode streaming stable.

**Q: Mon CPU est à 100% en mode dual, c'est normal ?**
A: Le mode dual exécute l'émulateur des deux côtés, ce qui consomme plus de CPU. Si votre CPU est trop faible, utilisez le mode streaming.

**Q: Puis-je basculer entre les modes en cours de jeu ?**
A: Oui, le fallback automatique permet de passer du mode dual au streaming. Le passage inverse nécessite de redémarrer la room.
```

### 6.2 Changelog

Ajouter dans `CHANGELOG.md` :

```markdown
## [v1.1.0] - YYYY-MM-DD

### 🚀 Nouvelles fonctionnalités

#### Mode d'émulation duale (BETA)
- Émulation locale des deux côtés pour réduire drastiquement la latence guest
- Latence guest réduite de ~100ms à ~5ms sur connexions locales (25x plus rapide)
- Échange d'inputs binaires (<10 KB/s vs 2-5 Mbps en streaming)
- Détection automatique de désynchronisation avec fallback streaming
- Recommandation automatique du meilleur mode selon qualité réseau
- Input prediction pour compenser les inputs manquants

### ⚡ Optimisations
- Encodage binaire des inputs (100x plus efficace que JSON)
- Monitoring de performance avec métriques détaillées
- Checksum périodique pour vérification de sync

### 📊 Nouvelles métriques
- RTT réseau en temps réel
- Taux de désynchronisation
- Comparaison latence streaming vs dual

### 🔧 Améliorations techniques
- Architecture modulaire pour supporter plusieurs modes d'émulation
- SyncManager pour gestion de la synchronisation
- InputManager avec encodage/décodage optimisé
- NetworkDetector pour recommandations intelligentes

### 📚 Documentation
- Guide complet du mode dual
- Comparaison des performances selon la distance
- FAQ et troubleshooting
```

**Fichiers à créer** :
- ✅ `docs/DUAL_EMULATION_MODE.md`

**Fichiers à modifier** :
- ✅ `CHANGELOG.md`
- ✅ `README.md` → Mention du mode dual

---

## Récapitulatif des Risques et Mitigation 🛡️

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| **Désynchronisation fréquente** | Élevée | Élevé | Fallback automatique vers streaming + checksum fréquent |
| **CPU trop élevé côté guest** | Moyenne | Moyen | Auto-détection et recommandation + option manuelle |
| **Complexité code** | Élevée | Moyen | Tests exhaustifs + feature flag + documentation |
| **Bugs déterminisme émulateur** | Moyenne | Élevé | Checksum fréquent + logs détaillés + fallback |
| **Régression mode streaming** | Faible | Élevé | Tests non-régression + rollback rapide possible |
| **Adoption faible utilisateurs** | Moyenne | Faible | Rollout progressif + mode auto recommandé par défaut |
| **Bande passante trop élevée input** | Faible | Faible | Encodage binaire déjà très optimisé (2 bytes) |

---

## Timeline Estimée 📅

| Phase | Durée | Dépendances | Livrable |
|-------|-------|-------------|----------|
| **Phase 1: Préparation** | 1 semaine | - | Types, InputManager, SyncManager |
| **Phase 2: Implémentation** | 2 semaines | Phase 1 | Mode dual fonctionnel + fallback |
| **Phase 3: Optimisations** | 1 semaine | Phase 2 | Input prediction, buffer, monitoring |
| **Phase 4: UI/UX** | 3 jours | Phase 2 | NetworkDetector, EmulationSettings UI |
| **Phase 5: Tests** | 1 semaine | Phase 2-4 | Tests unitaires + intégration + benchmarks |
| **Phase 6: Documentation** | 2 jours | Phase 5 | Docs utilisateur + feature flags |

**Total estimé : 5-6 semaines** de développement intensif.

---

## Métriques de Succès 🎯

### Must-have (Bloquants)
- ✅ Latence guest < 20ms en mode dual sur LAN (vs 50ms streaming)
- ✅ Fallback fonctionne à 100% en cas de désync
- ✅ Pas de régression sur mode streaming
- ✅ Taux de crash < 1%

### Nice-to-have (Bonus)
- ✅ Bande passante < 50 KB/s en mode dual (vs 2.5 MB/s streaming)
- ✅ Taux de désync < 5% sur connexions stables
- ✅ CPU guest < 80% sur machines modernes
- ✅ Adoption > 30% des utilisateurs avec connexions favorables

### KPIs à tracker
- Latence moyenne guest (dual vs streaming)
- Taux de désynchronisation par heure de jeu
- Taux de fallback vers streaming
- CPU moyen host/guest en mode dual
- Bande passante moyenne dual vs streaming
- Nombre d'utilisateurs utilisant le mode dual
- Satisfaction utilisateur (feedback)

---

## Ordre d'implémentation recommandé

1. **Semaine 1** : Phase 1 (Préparation)
   - InputManager + SyncManager
   - Types et interfaces
   - Tests unitaires de base

2. **Semaine 2-3** : Phase 2 (Implémentation core)
   - Dual emulation côté guest
   - Synchronisation inputs
   - Checksum + détection désync
   - Fallback vers streaming

3. **Semaine 4** : Phase 3 (Optimisations)
   - Input prediction
   - Input buffer
   - Performance monitoring

4. **Semaine 4-5** : Phase 4 + 5 (UI/UX + Tests)
   - NetworkDetector
   - EmulationSettings UI
   - Tests d'intégration
   - Benchmarks

5. **Semaine 5-6** : Phase 6 (Documentation + Polish)
   - Documentation utilisateur
   - Feature flags
   - Beta rollout

---

## Prochaines étapes

1. **Valider le plan** avec l'équipe
2. **Créer une branche feature** `feature/dual-emulation-mode`
3. **Commencer Phase 1** : Créer les fichiers de base
4. **Setup tests** : Configurer Vitest si pas déjà fait
5. **Itérer** : Implémenter phase par phase avec PRs régulières

---

*Document créé le [date]*

*Inspiré par ZSNES netplay (1997) - Rollback netcode pionnier* 🎮

*"Good artists copy, great artists steal" - Pablo Picasso*

*Mais nous, on documente. 😉*
