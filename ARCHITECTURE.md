# Architecture Technique - PSNES Online

## Vue d'ensemble

PSNES Online est une plateforme de jeu rétro multijoueur avec émulation côté serveur et streaming temps réel vers les clients.

## Principe de fonctionnement

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT 1                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │  Canvas API │  │ Web Audio API │  │   Input      │       │
│  │   (Vidéo)   │  │    (Audio)    │  │  Handler     │       │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                  │               │
│         └─────────────────┴──────────────────┘               │
│                           │                                  │
│                    WebSocket (Socket.io)                     │
└───────────────────────────┼──────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        SERVER                                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              WebSocket Manager                       │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐     │   │
│  │  │   Room 1   │  │   Room 2   │  │   Room N   │     │   │
│  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘     │   │
│  └────────┼───────────────┼───────────────┼────────────┘   │
│           │               │               │                 │
│  ┌────────▼───────────────▼───────────────▼────────────┐   │
│  │           Emulator Manager                          │   │
│  │  ┌──────────────────────────────────────────────┐   │   │
│  │  │  SNES Emulator Instance (libretro/snes9x)    │   │   │
│  │  │                                               │   │   │
│  │  │  Input P1 ──┐                                │   │   │
│  │  │             ├──► Emulation ──► Video Frame   │   │   │
│  │  │  Input P2 ──┘              └──► Audio Frame  │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐         │
│  │   Express    │  │   Redis   │  │   SQLite     │         │
│  │  (REST API)  │  │ (Sessions)│  │ (Persistent) │         │
│  └──────────────┘  └───────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT 2                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │  Canvas API │  │ Web Audio API │  │   Input      │       │
│  │   (Vidéo)   │  │    (Audio)    │  │  Handler     │       │
│  └─────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Flux de données

### 1. Création d'une room

```
Client → WebSocket: room:create { gameId, gameTitle }
Server → Room Manager: Create new room
Server → Emulator Manager: Initialize emulator instance
Server → Client: room:created { room }
Server → All Friends: friend:roomCreated
```

### 2. Gameplay loop (60 FPS)

```
Every 16.67ms (60Hz):
  ┌─ Emulator reads inputs from both players
  │  └─ Process controller state for ports 1 & 2
  │
  ├─ Run emulation for 1 frame (~89,341 CPU cycles @ 3.58MHz)
  │  └─ Execute CPU, PPU, APU, DMA operations
  │
  ├─ Generate video frame (256x224 pixels, RGBA)
  │  └─ Emit via WebSocket → game:frame
  │
  └─ Generate audio samples (~735 samples @ 32kHz)
     └─ Emit via WebSocket → game:audio

Client receives frame → Canvas putImageData()
Client receives audio → AudioContext playback
Client sends inputs → WebSocket: game:input
```

### 3. Latence et synchronisation

**Pipeline de latence:**

```
Input détecté (client)
  ↓ ~10ms (network latency)
Server reçoit input
  ↓ 0-16ms (wait next frame)
Emulator traite input
  ↓ 16.67ms (1 frame @ 60Hz)
Frame générée
  ↓ ~10ms (network latency)
Client reçoit frame
  ↓ ~5ms (rendering)
Display mis à jour

Total: ~40-60ms (acceptable pour jeu rétro)
```

**Optimisations:**
- Input prediction côté client (optionnel)
- Frame buffering adaptatif
- Compression vidéo (H.264 via WebRTC)

## Architecture des données

### Base de données SQLite (Persistante)

```sql
User
  - id (PK)
  - googleId (unique)
  - email
  - displayName
  - avatar

Friendship
  - id (PK)
  - initiatorId (FK → User)
  - receiverId (FK → User)
  - status (pending|accepted|rejected)

Game
  - id (PK)
  - userId (FK → User)
  - title
  - romPath
  - uploadedAt

Save
  - id (PK)
  - gameId (FK → Game)
  - slotNumber (1-10)
  - name
  - data (BLOB)
  - screenshot
  - createdAt
```

### Redis (Volatile - Sessions & Rooms)

```
session:{sessionId} → User session data (TTL: 7 days)

room:{roomId} → {
  gameId,
  gameTitle,
  hostId,
  players: [{
    userId,
    displayName,
    avatar,
    port: 1|2|null,
    isReady: boolean,
    keyConfig
  }],
  status: 'waiting'|'playing'|'paused'
}

user:{userId}:status → 'online'|'offline'|'in-game'
```

## WebSocket Events API

### Room Management

**Client → Server:**
- `room:create` → Créer nouvelle room
- `room:join` → Rejoindre room existante
- `room:leave` → Quitter room
- `room:selectPort` → Choisir port manette (1 ou 2)
- `room:updateKeyConfig` → Modifier config touches
- `room:toggleReady` → Toggle état ready

**Server → Client:**
- `room:created` → Room créée avec succès
- `room:updated` → État room modifié
- `room:destroyed` → Room fermée

### Game Control

**Client → Server:**
- `game:start` → Lancer émulation
- `game:input` → Envoyer état manette
- `game:pause` → Mettre en pause
- `game:resume` → Reprendre
- `game:stop` → Arrêter et retour lobby
- `game:save` → Créer save state
- `game:load` → Charger save state

**Server → Client:**
- `game:started` → Émulation démarrée
- `game:frame` → Frame vidéo (ArrayBuffer)
- `game:audio` → Échantillons audio (Float32Array)
- `game:paused` → Jeu en pause
- `game:resumed` → Jeu repris
- `game:stopped` → Jeu arrêté

### Friends & Presence

**Server → Client:**
- `friends:online` → Liste amis en ligne
- `friend:statusChanged` → Ami online/offline
- `friend:roomCreated` → Ami a créé une room

## Format des données streaming

### Video Frame

```typescript
interface VideoFrame {
  width: 256,        // SNES: 256px ou 512px (hi-res)
  height: 224,       // SNES: 224px ou 448px (interlaced)
  data: ArrayBuffer  // RGBA pixels (width * height * 4 bytes)
}
```

**Taille:** 256×224×4 = 229 KB par frame
**Bande passante:** 229 KB × 60 FPS = ~13.7 MB/s

**Optimisations possibles:**
- Compression H.264: ~1-2 Mbps
- Delta encoding: ~30% réduction
- WebRTC: gestion automatique bande passante

### Audio Frame

```typescript
interface AudioFrame {
  sampleRate: 32000,     // SNES: 32kHz
  channels: 2,           // Stereo
  data: Float32Array     // Samples interleaved L/R
}
```

**Échantillons par frame:** 32000 Hz ÷ 60 FPS = ~533 samples
**Taille:** 533 × 2 channels × 4 bytes = ~4.3 KB par frame
**Bande passante:** ~258 KB/s

### Game Input

```typescript
interface GameInput {
  port: 1 | 2,
  buttons: {
    up: boolean,
    down: boolean,
    left: boolean,
    right: boolean,
    a: boolean,
    b: boolean,
    x: boolean,
    y: boolean,
    l: boolean,
    r: boolean,
    start: boolean,
    select: boolean
  }
}
```

**Taille:** ~50 bytes par input
**Fréquence:** Variable (seulement lors changements)
**Bande passante:** Négligeable (~3 KB/s max)

## Scalabilité

### Ressources par room active

- **CPU:** ~5-10% (émulation SNES)
- **RAM:** ~50-100 MB (émulateur + ROM + buffers)
- **Réseau sortant:** ~3-5 Mbps (2 clients × 1.5-2.5 Mbps)

### Capacité serveur (estimations)

**Serveur modeste (4 cores, 8GB RAM):**
- Rooms simultanées: 10-20
- Joueurs concurrent: 20-40

**Serveur dédié (8 cores, 16GB RAM):**
- Rooms simultanées: 50-100
- Joueurs concurrent: 100-200

**Scaling horizontal:**
- Load balancer (nginx)
- Multiple instances backend
- Redis cluster pour sessions partagées
- Sticky sessions pour WebSocket

## Sécurité

### Authentification
- OAuth 2.0 Google (pas de passwords stockés)
- Session cookies HttpOnly + Secure
- CSRF protection via same-site cookies

### Uploads
- Validation type fichier (whitelist extensions)
- Limite taille: 10 MB
- Scan antivirus optionnel
- Stockage isolé par utilisateur

### WebSocket
- Authentication via session cookie
- Rate limiting sur events
- Validation inputs (sanitization)
- Rooms access control

### Production
- HTTPS obligatoire (Let's Encrypt)
- Helmet.js headers sécurisés
- CORS strict
- Secrets rotation régulière

## Monitoring & Observabilité

### Métriques clés

**Performance:**
- Latence moyenne input→display
- FPS moyen par room
- Décrochages audio/vidéo

**Business:**
- Utilisateurs actifs (DAU/MAU)
- Rooms créées/jour
- Jeux uploadés
- Durée sessions moyenne

**Infrastructure:**
- CPU/RAM par room
- Bande passante utilisée
- Erreurs WebSocket
- Latence Redis/SQLite

### Stack recommandée

- **Prometheus:** Collecte métriques
- **Grafana:** Dashboards
- **Loki:** Logs centralisés
- **Alertmanager:** Alertes (CPU > 80%, etc.)

## Améliorations futures

### Court terme
1. Intégration émulateur réel (snes9x-wasm)
2. Compression vidéo H.264
3. Audio buffering adaptatif
4. Input prediction

### Moyen terme
5. WebRTC peer-to-peer (réduction latence)
6. Filtres vidéo (CRT, scanlines)
7. Support gamepad physique
8. Spectator mode (>2 joueurs)

### Long terme
9. Multi-console (NES, Genesis, N64)
10. Cloud saves sync
11. Replay recording
12. Tournois & classements

---

**Dernière mise à jour:** 2025-11-16
