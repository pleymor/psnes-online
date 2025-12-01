# Plan d'implémentation : Rollback Netcode pour le Mode Dual

## Contexte

Le mode dual actuel souffre de deux problèmes majeurs :
1. **Désynchronisations** : Les deux émulateurs dérivent l'un de l'autre au fil du temps
2. **RNG différent** : Les jeux avec éléments aléatoires produisent des résultats différents

### Pourquoi ça arrive ?

Actuellement, chaque émulateur :
- Tourne indépendamment à ~60 FPS
- Reçoit les inputs distants avec un délai réseau variable
- N'a pas d'état initial garanti identique
- N'a aucun mécanisme de correction

---

## Solution : Rollback Netcode (style GGPO/RetroArch)

### Principe

```
┌─────────────────────────────────────────────────────────────────┐
│  Frame N : Prédire l'input distant (répéter le dernier connu)   │
│  Frame N+k : Recevoir le vrai input de la frame N               │
│  Si prédiction incorrecte :                                     │
│    1. Charger le savestate de la frame N                        │
│    2. Rejouer les frames N → N+k avec les vrais inputs          │
│    3. L'état est maintenant synchronisé                         │
└─────────────────────────────────────────────────────────────────┘
```

### Avantages
- **Pas de lag perceptible** : On prédit et on corrige invisiblement
- **Tolérant à la latence** : Fonctionne même avec 100ms+ de latence
- **Déterministe** : Même inputs = même résultat garanti

---

## Architecture proposée

### Nouveaux composants

```
frontend/src/lib/netplay/
├── rollback-manager.ts      # Gestionnaire principal du rollback
├── state-buffer.ts          # Ring buffer des savestates
├── input-buffer.ts          # Buffer des inputs avec prédiction
├── frame-sync.ts            # Synchronisation des compteurs de frame
└── types.ts                 # Types partagés
```

### Diagramme de flux

```
                    HOST                                    GUEST
                      │                                        │
    ┌─────────────────┴─────────────────┐    ┌────────────────┴────────────────┐
    │         INITIALISATION            │    │         INITIALISATION          │
    │  1. Charger ROM                   │    │  1. Charger ROM                 │
    │  2. Créer savestate initial ──────┼───►│  2. Charger savestate initial   │
    │  3. Attendre ACK ◄────────────────┼────┤  3. Envoyer ACK                 │
    │  4. Démarrer frame 0              │    │  4. Démarrer frame 0            │
    └─────────────────┬─────────────────┘    └────────────────┬────────────────┘
                      │                                        │
    ╔═════════════════╧═════════════════╗    ╔════════════════╧════════════════╗
    ║         BOUCLE DE JEU             ║    ║         BOUCLE DE JEU           ║
    ║                                   ║    ║                                 ║
    ║  Pour chaque frame N :            ║    ║  Pour chaque frame N :          ║
    ║  ┌─────────────────────────────┐  ║    ║  ┌───────────────────────────┐  ║
    ║  │ 1. Sauvegarder état (ring)  │  ║    ║  │ 1. Sauvegarder état       │  ║
    ║  │ 2. Lire input local P1      │  ║    ║  │ 2. Lire input local P2    │  ║
    ║  │ 3. Prédire input P2         │  ║    ║  │ 3. Prédire input P1       │  ║
    ║  │ 4. Exécuter frame           │  ║    ║  │ 4. Exécuter frame         │  ║
    ║  │ 5. Envoyer input P1 ────────┼──╫───►│  │ 5. Envoyer input P2       │  ║
    ║  │                             │◄─╫────┼──┤                           │  ║
    ║  └─────────────────────────────┘  ║    ║  └───────────────────────────┘  ║
    ║                                   ║    ║                                 ║
    ║  Si mauvaise prédiction :         ║    ║  Si mauvaise prédiction :       ║
    ║  ┌─────────────────────────────┐  ║    ║  ┌───────────────────────────┐  ║
    ║  │ 1. Charger savestate N      │  ║    ║  │ 1. Charger savestate N    │  ║
    ║  │ 2. Rejouer N → current      │  ║    ║  │ 2. Rejouer N → current    │  ║
    ║  │    avec vrais inputs        │  ║    ║  │    avec vrais inputs      │  ║
    ║  └─────────────────────────────┘  ║    ║  └───────────────────────────┘  ║
    ╚═══════════════════════════════════╝    ╚═════════════════════════════════╝
```

---

## Plan d'implémentation détaillé

### Phase 1 : Infrastructure de base

#### 1.1 Types et interfaces (`types.ts`)

```typescript
interface FrameState {
  frame: number;
  state: Blob;              // Savestate complet
  localInput: InputState;   // Input local confirmé
  remoteInput: InputState;  // Input distant (confirmé ou prédit)
  remoteConfirmed: boolean; // true si input distant reçu
}

interface NetplayConfig {
  inputDelayFrames: number;     // Délai d'input local (0-3 frames)
  maxRollbackFrames: number;    // Max frames à rollback (7-10)
  syncCheckInterval: number;    // Interval vérification sync (60 frames)
}

interface InputMessage {
  type: 'input';
  frame: number;
  player: 1 | 2;
  input: number[];  // Encoded InputState
}

interface SyncMessage {
  type: 'sync_check';
  frame: number;
  checksum: string;
}

interface InitialStateMessage {
  type: 'initial_state';
  state: ArrayBuffer;
  frame: 0;
}
```

#### 1.2 Ring Buffer de savestates (`state-buffer.ts`)

```typescript
class StateBuffer {
  private buffer: Map<number, Blob>;
  private maxSize: number;

  constructor(maxSize: number = 10);

  // Sauvegarder l'état d'une frame
  async saveState(frame: number, emulator: WasmEmulator): Promise<void>;

  // Récupérer l'état d'une frame
  getState(frame: number): Blob | null;

  // Nettoyer les vieux états
  private cleanup(currentFrame: number): void;

  // Trouver la frame la plus ancienne disponible
  getOldestFrame(): number;
}
```

#### 1.3 Buffer d'inputs avec prédiction (`input-buffer.ts`)

```typescript
class InputBuffer {
  private localInputs: Map<number, InputState>;
  private remoteInputs: Map<number, InputState>;
  private lastConfirmedRemoteFrame: number;
  private lastRemoteInput: InputState;

  constructor();

  // Ajouter un input local
  setLocalInput(frame: number, input: InputState): void;

  // Recevoir un input distant
  setRemoteInput(frame: number, input: InputState): void;

  // Obtenir l'input pour une frame (avec prédiction si nécessaire)
  getInput(frame: number, player: 1 | 2, isLocal: boolean): InputState;

  // Vérifier si on doit rollback
  needsRollback(currentFrame: number): { needed: boolean; rollbackTo: number };

  // Prédire l'input distant (répéter le dernier connu)
  private predictRemoteInput(): InputState;

  // Marquer les frames comme confirmées
  confirmFrame(frame: number): void;
}
```

### Phase 2 : Gestionnaire de rollback

#### 2.1 RollbackManager (`rollback-manager.ts`)

```typescript
class RollbackManager {
  private emulator: WasmEmulator;
  private stateBuffer: StateBuffer;
  private inputBuffer: InputBuffer;
  private currentFrame: number = 0;
  private config: NetplayConfig;
  private isHost: boolean;
  private onSendInput: (msg: InputMessage) => void;

  constructor(
    emulator: WasmEmulator,
    config: NetplayConfig,
    isHost: boolean,
    onSendInput: (msg: InputMessage) => void
  );

  // === INITIALISATION ===

  // Host : créer et envoyer l'état initial
  async createInitialState(): Promise<ArrayBuffer>;

  // Guest : charger l'état initial reçu
  async loadInitialState(state: ArrayBuffer): Promise<void>;

  // === BOUCLE DE JEU ===

  // Appelé chaque frame AVANT l'exécution
  async preFrame(): Promise<void> {
    // 1. Sauvegarder l'état actuel
    await this.stateBuffer.saveState(this.currentFrame, this.emulator);

    // 2. Vérifier si rollback nécessaire
    const rollback = this.inputBuffer.needsRollback(this.currentFrame);
    if (rollback.needed) {
      await this.performRollback(rollback.rollbackTo);
    }
  }

  // Obtenir les inputs pour la frame courante
  getInputs(): { p1: InputState; p2: InputState } {
    const localPlayer = this.isHost ? 1 : 2;
    const remotePlayer = this.isHost ? 2 : 1;

    return {
      p1: this.inputBuffer.getInput(this.currentFrame, 1, localPlayer === 1),
      p2: this.inputBuffer.getInput(this.currentFrame, 2, localPlayer === 2)
    };
  }

  // Appelé chaque frame APRÈS l'exécution
  postFrame(localInput: InputState): void {
    // 1. Stocker l'input local
    this.inputBuffer.setLocalInput(this.currentFrame, localInput);

    // 2. Envoyer l'input au pair
    this.onSendInput({
      type: 'input',
      frame: this.currentFrame,
      player: this.isHost ? 1 : 2,
      input: encodeInput(localInput)
    });

    // 3. Incrémenter le compteur
    this.currentFrame++;
  }

  // Recevoir un input distant
  onRemoteInput(msg: InputMessage): void {
    this.inputBuffer.setRemoteInput(msg.frame, decodeInput(msg.input));
  }

  // === ROLLBACK ===

  private async performRollback(toFrame: number): Promise<void> {
    console.log(`🔄 Rollback frame ${this.currentFrame} → ${toFrame}`);

    // 1. Charger l'état de la frame cible
    const state = this.stateBuffer.getState(toFrame);
    if (!state) {
      console.error(`No state for frame ${toFrame}!`);
      return;
    }
    await this.emulator.loadState(state);

    // 2. Rejouer les frames jusqu'à maintenant
    const targetFrame = this.currentFrame;
    this.currentFrame = toFrame;

    while (this.currentFrame < targetFrame) {
      const inputs = this.getInputs();
      // Appliquer les inputs et avancer d'une frame
      this.applyInputs(inputs);
      await this.emulator.runFrame(); // Note: API à vérifier
      this.currentFrame++;
    }
  }

  // === SYNC CHECK ===

  async performSyncCheck(): Promise<string> {
    const state = await this.emulator.saveState();
    return await hashState(state.state);
  }
}
```

### Phase 3 : Intégration avec WasmEmulator

#### 3.1 Hooks d'émulation

WasmEmulator (forked from Nostalgist.js) utilise RetroArch compilé en WASM. Il faut vérifier :

1. **`saveState()` / `loadState()`** : Déjà disponibles et fonctionnels
2. **Exécution frame-par-frame** : Besoin de contrôler l'avancement

```typescript
// Vérifier si on peut contrôler l'exécution frame par frame
// Option 1: Pause/resume avec callback
emulator.pause();
// ... set inputs ...
emulator.resume();  // Run one frame?

// Option 2: Hook dans la boucle principale
// Potentiellement via retroarchConfig ou hooks Emscripten
```

#### 3.2 Modifications de ClientEmulator.svelte

```typescript
// Nouveau flow d'initialisation
async function initDualMode() {
  // 1. Créer l'émulateur
  emulator = await WasmEmulator.snes({ ... });

  // 2. Créer le RollbackManager
  rollbackManager = new RollbackManager(
    emulator,
    { inputDelayFrames: 0, maxRollbackFrames: 8, syncCheckInterval: 60 },
    isHost,
    (msg) => dualModeHandler.sendInput(msg)
  );

  // 3. Sync initial
  if (isHost) {
    const initialState = await rollbackManager.createInitialState();
    dualModeHandler.sendInitialState(initialState);
  } else {
    const initialState = await dualModeHandler.waitForInitialState();
    await rollbackManager.loadInitialState(initialState);
  }

  // 4. Démarrer la boucle de jeu avec rollback
  startGameLoopWithRollback();
}

function startGameLoopWithRollback() {
  // Hook dans la boucle d'émulation
  // Cette partie dépend de l'API WasmEmulator/RetroArch
}
```

### Phase 4 : Protocole réseau amélioré

#### 4.1 Nouveaux messages P2P

```typescript
// Dans dual-mode.ts, ajouter ces types de messages :

type NetplayMessage =
  | { type: 'initial_state'; state: ArrayBuffer }
  | { type: 'initial_state_ack' }
  | { type: 'input'; frame: number; player: 1 | 2; input: number[] }
  | { type: 'sync_check'; frame: number; checksum: string }
  | { type: 'sync_result'; frame: number; match: boolean };
```

#### 4.2 Séquence de démarrage

```
HOST                                    GUEST
  │                                        │
  ├─── ROM chargée ────────────────────────┤
  │                                        │
  ├─── Créer émulateur ────────────────────┤
  │                                        │
  ├─── Avancer 1 frame (init) ─────────────┤
  │                                        │
  ├─── saveState() ────────────────────────┤
  │                                        │
  ├─── initial_state ─────────────────────►│
  │                                        ├─── loadState()
  │◄──────────────────── initial_state_ack ┤
  │                                        │
  ├─── game:go ───────────────────────────►│
  │                                        │
  ╔════════ BOUCLE SYNCHRONISÉE ═══════════╗
```

### Phase 5 : Optimisations

#### 5.1 Compression des savestates

Les savestates SNES font ~150KB. Pour le ring buffer :
- 10 frames = 1.5MB de mémoire
- Compression LZ4/zstd peut réduire à ~30-50KB

```typescript
// Optionnel : compression
import { compress, decompress } from 'lz4js';

async saveState(frame: number, emulator: WasmEmulator) {
  const { state } = await emulator.saveState();
  const buffer = await state.arrayBuffer();
  const compressed = compress(new Uint8Array(buffer));
  this.buffer.set(frame, compressed);
}
```

#### 5.2 Input delay (optionnel)

Ajouter un délai d'input local réduit les rollbacks :

```typescript
// Avec inputDelayFrames = 2 :
// Frame N : On lit l'input
// Frame N+2 : L'input est appliqué
// Cela donne 2 frames de marge pour recevoir l'input distant
```

#### 5.3 Spectateur mode

Les spectateurs peuvent recevoir un flux d'inputs confirmés avec délai.

---

## Risques et challenges

### 1. API WasmEmulator limitée

**Problème** : WasmEmulator ne fournit peut-être pas de contrôle frame-par-frame.

**Solutions possibles** :
- Utiliser `pause()`/`resume()` avec timing précis
- Modifier WasmEmulator pour ajouter `runSingleFrame()`
- Utiliser les hooks Emscripten directement

### 2. Performance des savestates

**Problème** : `saveState()` peut être lent (10-50ms).

**Solutions** :
- Ne sauvegarder que toutes les N frames
- Utiliser des savestates delta (différentiel)
- Profiler et optimiser

### 3. Latence réseau variable

**Problème** : Le jitter réseau cause des rollbacks fréquents.

**Solutions** :
- Buffer d'inputs adaptatif
- Input delay dynamique basé sur la latence mesurée

### 4. Déterminisme du core snes9x

**Problème** : Le core doit être 100% déterministe.

**Vérification** :
- snes9x-wasm est normalement déterministe
- Tester avec des sessions enregistrées

---

## Estimation de complexité

| Composant | Complexité | Dépendances |
|-----------|------------|-------------|
| `types.ts` | Faible | Aucune |
| `state-buffer.ts` | Faible | WasmEmulator API |
| `input-buffer.ts` | Moyenne | Logique de prédiction |
| `rollback-manager.ts` | Haute | Tout ci-dessus |
| Intégration ClientEmulator | Haute | WasmEmulator API frame control |
| Protocole réseau | Moyenne | P2P existant |
| Tests et debug | Haute | Tout |

---

## Étapes de test

1. **Test unitaire** : StateBuffer et InputBuffer isolés
2. **Test local** : Deux onglets, même machine
3. **Test LAN** : Deux machines, même réseau
4. **Test WAN** : Deux machines, internet (latence réelle)
5. **Test stress** : Jeux avec beaucoup de RNG (RPGs, puzzles)

---

## Ressources

- [RetroArch Netplay README](https://github.com/libretro/RetroArch/blob/master/network/netplay/README)
- [GGPO Documentation](https://www.ggpo.net/)
- [Nostalgist.js API](https://nostalgist.js.org/) (original library, now forked as WasmEmulator)
- [Rollback Netcode Explained (Infil)](https://ki.infil.net/w02-netcode.html)

---

## Prochaines étapes

1. [ ] Vérifier l'API WasmEmulator pour le contrôle frame-par-frame
2. [ ] Implémenter `StateBuffer` et `InputBuffer`
3. [ ] Implémenter `RollbackManager` (version basique)
4. [ ] Modifier la séquence d'initialisation dual mode
5. [ ] Ajouter les nouveaux messages P2P
6. [ ] Intégrer dans `ClientEmulator.svelte`
7. [ ] Tester en local (deux onglets)
8. [ ] Optimiser (compression, input delay)
9. [ ] Tester en conditions réelles
