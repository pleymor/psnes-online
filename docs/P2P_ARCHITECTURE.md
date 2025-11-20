# Architecture P2P pour Émulation Client-Side

## Vue d'ensemble

L'émulation s'exécute dans le navigateur du **host** (créateur de la room), et les **guests** reçoivent le stream vidéo/audio via **WebRTC P2P direct**.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SERVEUR (VPS)                            │
│  - Authentification (Google OAuth)                               │
│  - Base de données (rooms, users, games)                         │
│  - WebRTC Signaling (Socket.IO)                                  │
│  - STUN/TURN fallback (si NAT strict)                           │
│  CPU Usage: ~5% (vs 100% actuellement)                          │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ WebSocket (Signaling only)
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼──────────┐    ┌────────▼─────────┐
│   HOST (P1)      │    │   GUEST (P2)     │
│                  │    │                  │
│ ┌──────────────┐ │    │                  │
│ │  Émulateur   │ │    │  ┌────────────┐ │
│ │  SNES        │ │    │  │   Video    │ │
│ │  WebAssembly │ │    │  │   Canvas   │ │
│ │              │ │    │  └────────────┘ │
│ │  - Input P1  │ │    │  ┌────────────┐ │
│ │  - Input P2  │ │    │  │   Audio    │ │
│ │  - Run @60Hz │ │    │  │   Context  │ │
│ └──────────────┘ │    │  └────────────┘ │
│        │         │    │         ▲        │
│        │ Render  │    │         │        │
│        ▼         │    │         │        │
│  ┌──────────┐   │    │         │        │
│  │  Canvas  │   │    │         │        │
│  └──────────┘   │    │         │        │
│        │         │    │         │        │
│        │         │◄───┼─────────┼────────┤
│        └─────────┼────┼─────────┘        │
│    Video/Audio   │    │   WebRTC P2P     │
│    Stream        │    │   (Direct)       │
│                  │    │                  │
│     Input P1     │    │    Input P2      │
│                  │◄───┼──────────────────┤
│                  │    │  Data Channel    │
└──────────────────┘    └──────────────────┘
```

## Flux de données

### 1. Création de Room (Host)

```javascript
// Host crée une room
1. Host: POST /api/rooms/create { gameId }
2. Server: Create room in DB, return roomId
3. Host: Load ROM + Initialize Emulator (WebAssembly)
4. Host: Create RTCPeerConnection + offer
5. Host: Socket.emit('room:ready', { roomId, offer })
6. Server: Store offer, broadcast to friends
```

### 2. Connexion Guest

```javascript
// Guest rejoint la room
1. Guest: POST /api/rooms/{roomId}/join
2. Server: Validate + return room info
3. Guest: Create RTCPeerConnection
4. Guest: Socket.emit('room:join', { roomId })
5. Server: Send host's offer to guest
6. Guest: Create answer + send to host via signaling
7. Host receives answer → ICE negotiation
8. ✅ Direct P2P connection established
```

### 3. Gameplay (P2P Direct - NO SERVER)

```javascript
// Communication P2P directe (latence minimale)

HOST:
  ┌─> Read input P1 (keyboard/gamepad)
  │
  ├─> Receive input P2 via WebRTC Data Channel ◄─┐
  │                                               │
  ├─> Run emulator frame (60 Hz)                 │
  │                                               │
  ├─> Render to canvas                           │
  │                                               │
  └─> Stream video/audio via WebRTC ────────────►│
                                                  │
GUEST:                                            │
  ┌─> Receive video/audio stream ◄───────────────┘
  │
  ├─> Render to canvas + play audio
  │
  ├─> Read input P2 (keyboard/gamepad)
  │
  └─> Send input P2 via WebRTC Data Channel ─────┐
                                                  │
                          (retour vers HOST) ◄────┘
```

## Technologies

### Frontend

```json
{
  "dependencies": {
    "nostalgist": "^0.8.0",           // Émulateur SNES WebAssembly
    "simple-peer": "^9.11.1",         // WebRTC P2P (facile à utiliser)
    "socket.io-client": "^4.7.2"      // Signaling uniquement
  }
}
```

**Alternative émulateurs** :
- `nostalgist` : Wrapper facile, multi-consoles
- `snes9x-emscripten` : Plus de contrôle
- `emulatorjs` : Interface complète

### Backend (simplifié)

```json
{
  "dependencies": {
    "socket.io": "^4.7.2",           // Signaling WebRTC
    "express": "^4.18.2",            // API REST
    "prisma": "^5.0.0"               // Database (inchangé)
  },
  "removed": {
    "snes9x-next": "DELETED",        // Plus d'émulation serveur
    "canvas": "DELETED",             // Plus de rendering serveur
    "node-libretro": "DELETED"       // Plus besoin
  }
}
```

## Latence - Comparaison

### Architecture actuelle (Server-side)

```
Input P2 → Server → Emulation → Encode → Network → Client
  10ms      50ms      10ms       20ms      30ms     = 120ms
                     (CPU lag!)
```

### Architecture P2P (Client-side)

```
Input P2 → WebRTC → Host Emulation → Already rendered
  1ms       15ms         0ms            = 16ms !!!
```

**Gain de latence : 7x plus rapide !**

## Gestion des cas limites

### 1. Host déconnecte

```javascript
// Guest détecte la déconnexion
peer.on('close', () => {
  // Option A: Migrer émulation vers un autre client
  // Option B: Arrêter la session
  showMessage('Host disconnected - Game ended');
});
```

### 2. NAT Traversal

```javascript
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },      // STUN gratuit
    {
      urls: 'turn:turn.psnes.example.com:3478',    // TURN fallback
      username: 'user',
      credential: 'pass'
    }
  ]
};
```

**Taux de succès P2P** :
- STUN seul : ~80% (NAT symétrique = fail)
- STUN + TURN : ~99% (TURN relay en dernier recours)

### 3. Host avec CPU faible

```javascript
// Détection performance
const fps = measureFPS();
if (fps < 50) {
  // Option 1: Baisser résolution
  emulator.setResolution(256, 224); // Native SNES

  // Option 2: Limiter bitrate WebRTC
  sender.setParameters({
    encodings: [{ maxBitrate: 500000 }] // 500 kbps
  });

  // Option 3: Proposer à un autre joueur d'être host
  showMessage('Your device is slow. Transfer host?');
}
```

## Plan de migration

### Phase 1 : Preuve de concept (2-3 jours)

```bash
# Créer branche
git checkout -b feature/client-side-emulation

# Nouveau composant
frontend/src/lib/components/ClientEmulator.svelte

# Test 1-vs-1 local
npm run dev
```

**Objectifs** :
- ✅ Charger ROM dans navigateur
- ✅ Émulateur fonctionne
- ✅ WebRTC P2P établi
- ✅ Stream vidéo/audio

### Phase 2 : Intégration (3-5 jours)

- Modifier room system (host vs guest)
- Adapter UI (host voit "You are hosting")
- Signaling via Socket.IO existant
- Tests multi-devices

### Phase 3 : Production (1-2 jours)

- TURN server setup (coturn)
- Optimisation bitrate
- Fallback vers server-side si échec P2P
- Monitoring

## Estimation effort total

**Temps** : 1-2 semaines
**Complexité** : Moyenne
**ROI** : Énorme (résout tous les problèmes)

## Avantages vs Inconvénients

### ✅ Avantages

1. **Zero lag serveur** - Plus de `⚠️  SCHEDULER: Resetting timing`
2. **Latence minimale** - P2P direct = 15ms au lieu de 120ms
3. **Scalabilité infinie** - VPS 3€/mois suffit
4. **Économie** - 17€/mois économisés
5. **Meilleure UX** - Host a 0ms de latence
6. **Plus de rooms** - Pas limité par CPU serveur

### ⚠️ Inconvénients

1. **Dépendance au host** - Si host lag, guest lag
2. **NAT Traversal** - Besoin TURN server (~80% réussite sans)
3. **Complexité code** - WebRTC + émulation = plus de code
4. **Mobile limité** - Émulation gourmande sur téléphone
5. **ROM upload** - Host doit upload ROM (vs serveur stocke)

## Conclusion

**Cette architecture est LA solution optimale !**

- Résout le problème CPU VPS immédiatement
- Latence divisée par 7
- Coût divisé par 5
- Expérience utilisateur supérieure

**Je recommande fortement de migrer vers ce système.**
