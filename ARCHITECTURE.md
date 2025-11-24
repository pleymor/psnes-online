# Architecture Technique - PSNES Online

## Vue d'ensemble

PSNES Online est une plateforme de jeu rétro multijoueur avec **émulation côté client** et **synchronisation P2P (peer-to-peer)** via WebRTC. Chaque joueur exécute sa propre instance de l'émulateur, le serveur ne servant que de signalisation pour établir les connexions directes entre clients.

## Principe de fonctionnement

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT 1 (HOST)                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  SNES Emulator (Nostalgist.js / Snes9x WASM)         │   │
│  │  ┌─────────────┐  ┌─────────────┐                    │   │
│  │  │   Video     │  │   Audio     │                    │   │
│  │  │   Output    │  │   Output    │                    │   │
│  │  └──────┬──────┘  └──────┬──────┘                    │   │
│  │         │                │                           │   │
│  │  ┌──────▼────────────────▼──────┐                    │   │
│  │  │   Canvas + AudioContext      │                    │   │
│  │  └──────┬───────────────────────┘                    │   │
│  │         │                                            │   │
│  │  ┌──────▼───────────────┐                            │   │
│  │  │  MediaStream Capture │ (canvas.captureStream)     │   │
│  │  └──────┬───────────────┘                            │   │
│  └─────────┼────────────────────────────────────────────┘   │
│            │                                                │
│            │ WebRTC (SimplePeer)                            │
│            │ - Video/Audio stream (H.264 @ 60fps)           │
│            │ - Data Channel (inputs P2)                     │
│            │                                                │
└────────────┼────────────────────────────────────────────────┘
             │
             │ Direct P2P Connection (LAN/WAN)
             │ ICE/STUN: stun.l.google.com
             │
┌────────────▼────────────────────────────────────────────┐
│                      CLIENT 2 (GUEST)                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  WebRTC Receiver                                 │   │
│  │  ┌───────────────┐  ┌───────────────┐            │   │
│  │  │  Video decode │  │  Audio decode │            │   │
│  │  │   (H.264)     │  │   (Opus)      │            │   │
│  │  └───────┬───────┘  └───────┬───────┘            │   │
│  │          │                  │                    │   │
│  │  ┌───────▼──────────────────▼─────┐              │   │
│  │  │   <video> element              │              │   │
│  │  └────────────────────────────────┘              │   │
│  │                                                  │   │
│  │  ┌─────────────────────────────────┐             │   │
│  │  │   Data Channel (send inputs)    │             │   │
│  │  └─────────────────────────────────┘             │   │
│  └──────────────────────────────────────────────────┘   │
│            ▲                                            │
│            │ Keyboard inputs → DataChannel → Host       │
└────────────┼────────────────────────────────────────────┘
             │
             │
┌────────────▼────────────────────────────────────────┐
│ SERVER  (Signaling only via Socket.io)              │
│                                                     │
│  WebSocket Manager:                                 │
│  - webrtc:signal (SDP offer/answer)                 │
│  - p2p:join / p2p:joined                            │
│  - Room coordination                                │
│                                                     │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │   Express    │  │   Redis   │  │   SQLite     │  │
│  │  (REST API)  │  │ (Sessions)│  │ (Persistent) │  │
│  └──────────────┘  └───────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Rôles:**
- **Host (Client 1):** Exécute l'émulateur, capture le flux vidéo/audio, envoie via WebRTC
- **Guest (Client 2):** Reçoit le flux WebRTC, affiche via `<video>`, envoie ses inputs via DataChannel
- **Serveur:** Signalisation WebRTC uniquement (pas d'émulation, pas de streaming)

## Flux de données

### 1. Initialisation P2P et connexion WebRTC

```
1. Host crée une room (via WebSocket classique)
   Client → Socket.io: room:create { gameId, gameTitle }
   Server → Client: room:created { room }
   Server → Friends: friend:roomCreated

2. Host lance l'émulateur local
   Browser → Nostalgist.js → Snes9x WASM
   Emulator → Canvas rendering (256x224)
   Emulator → Web Audio API

3. Guest rejoint la room
   Client → Socket.io: room:join { roomId }
   Server → Host: room:updated (guest joined)

4. Établissement P2P (WebRTC signaling)
   Guest → Server: p2p:join { roomId }
   Server → Host: p2p:peer-joined

   Host → P2PManager: initConnection(localStream)
     ├─ Capture canvas: canvas.captureStream(60fps)
     ├─ Create SimplePeer (initiator: true)
     └─ Generate SDP offer

   Host → Server: webrtc:signal { offer }
   Server → Guest: webrtc:signal { offer }

   Guest → P2PManager: initConnection()
     ├─ Create SimplePeer (initiator: false)
     └─ Generate SDP answer

   Guest → Server: webrtc:signal { answer }
   Server → Host: webrtc:signal { answer }

   → ICE candidate exchange (STUN)
   → P2P connection established ✅
```

### 2. Gameplay loop P2P (60 FPS)

**Côté HOST:**
```
Every 16.67ms (60Hz):
  ┌─ Emulator (Snes9x WASM) runs 1 frame
  │  ├─ Process local input (Player 1)
  │  ├─ Process remote input received via DataChannel (Player 2)
  │  └─ Execute ~89,341 CPU cycles @ 3.58MHz
  │
  ├─ Generate video frame (256x224 RGBA)
  │  └─ Canvas rendering → canvas.captureStream()
  │      └─ WebRTC encodes H.264 @ 60fps
  │
  ├─ Generate audio samples (~533 samples @ 32kHz)
  │  └─ Web Audio API → MediaStream
  │
  └─ WebRTC sends to Guest
     ├─ Video track: H.264 encoded (~1-5 Mbps)
     ├─ Audio track: Opus encoded (~128 kbps)
     └─ Data channel: Input ACKs

Local display: Canvas → Screen (0ms)
```

**Côté GUEST:**
```
Every frame:
  ┌─ Receive WebRTC stream
  │  ├─ Video: H.264 decode → <video> element
  │  └─ Audio: Opus decode → AudioContext
  │
  ├─ User input detected (keyboard)
  │  └─ Send via DataChannel → Host
  │     { type: 'input', button: 'A', pressed: true, timestamp }
  │
  └─ Receive ACK from Host
     └─ Measure latency (RTT)

Display: <video> element renders stream
```

### 3. Latence et synchronisation P2P

**Pipeline de latence (Guest):**

```
Input détecté (Guest)
  ↓ ~1-5ms (DataChannel → Host, direct P2P)
Host reçoit input
  ↓ 0-16ms (wait next emulation frame)
Emulator traite input
  ↓ 16.67ms (1 frame @ 60Hz)
Frame encodée (H.264 hardware)
  ↓ ~5-10ms (encoding + network)
Guest reçoit frame
  ↓ ~5-15ms (H.264 decode + display)
Display mis à jour

Total: ~30-60ms (optimal en LAN: 30-40ms)
```

**Latence mesurée (code P2PRoom.svelte:100-122):**
- **Input latency:** RTT Guest → Host → Guest (~10-20ms LAN)
- **Total latency:** Input RTT + video encoding/decoding (~33ms estimate)

**Optimisations appliquées:**
- H.264 hardware encoding (GPU acceleration)
- `playoutDelayHint = 0` pour buffer minimal (p2p-manager.ts:432)
- `jitterBufferTarget = 0` pour audio (p2p-manager.ts:444)
- Direct P2P (pas de relay TURN si possible)
- Canvas capture @ 60fps natif
- DataChannel pour inputs (ultra-rapide, <5ms)

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

### WebRTC P2P Events

**Client → Server (Signaling):**
- `p2p:join` → Rejoindre room P2P
- `webrtc:signal` → Transmettre SDP offer/answer/ICE candidates

**Server → Client (Signaling):**
- `p2p:joined` → Confirmation join P2P
- `p2p:peer-joined` → Notification nouveau peer
- `webrtc:signal` → Relayer signal WebRTC

**Host → Guest (WebRTC DataChannel):**
- `{ type: 'input_ack', inputId, timestamp }` → ACK input reçu

**Guest → Host (WebRTC DataChannel):**
- `{ type: 'input', button, pressed, timestamp, inputId }` → Envoyer input P2

### Friends & Presence

**Server → Client:**
- `friends:online` → Liste amis en ligne
- `friend:statusChanged` → Ami online/offline
- `friend:roomCreated` → Ami a créé une room

## Format des données WebRTC

### MediaStream (Host → Guest via WebRTC)

**Video Track:**
- Codec: H.264 (hardware accelerated)
- Résolution: 256×224 (native SNES) ou 512×448 (upscaled)
- Framerate: 60 FPS
- Bitrate: 1-5 Mbps (adaptatif selon réseau)
- Source: `canvas.captureStream(60)`

**Audio Track:**
- Codec: Opus
- Sample rate: 32 kHz (SNES native)
- Channels: 2 (stereo)
- Bitrate: ~128 kbps
- Source: Web Audio API → MediaStream

**Bande passante totale (par connexion):** ~1.5-5 Mbps

### DataChannel Messages (Guest → Host)

**Input message:**
```typescript
{
  type: 'input',
  button: 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'start' | 'select' |
          'up' | 'down' | 'left' | 'right',
  pressed: boolean,
  timestamp: number,  // performance.now()
  inputId: string     // unique ID pour tracking latence
}
```

**Input ACK (Host → Guest):**
```typescript
{
  type: 'input_ack',
  inputId: string,
  timestamp: number  // original timestamp for RTT calculation
}
```

**Taille:** ~100 bytes par message
**Fréquence:** Variable (seulement lors changements)
**Bande passante:** Négligeable (<5 KB/s)
**Latence:** <5ms (direct P2P)

## Scalabilité

### Architecture P2P : Avantages majeurs

**Charge serveur minimale:**
- Le serveur ne fait **QUE de la signalisation WebRTC** (SDP/ICE)
- **Pas d'émulation** côté serveur
- **Pas de streaming** vidéo/audio
- Charge CPU/RAM négligeable par room (~1-2% CPU par connexion active)

**Ressources par room active (serveur):**
- **CPU:** <1% (signalisation WebSocket uniquement)
- **RAM:** ~5-10 MB (state de la room + sessions)
- **Réseau sortant:** Négligeable (~10-50 KB/s pour signaling)

### Capacité serveur (estimations P2P)

**Serveur modeste (2 cores, 4GB RAM):**
- Rooms simultanées: 500-1000
- Joueurs concurrent: 1000-2000

**Serveur dédié (4 cores, 8GB RAM):**
- Rooms simultanées: 2000-5000
- Joueurs concurrent: 4000-10000

**Limites:**
- Limite principale: Connexions WebSocket concurrentes
- RAM pour sessions/rooms (SQLite + Redis)
- Bande passante pour signaling (très faible)

**Scaling horizontal:**
- Load balancer (nginx)
- Multiple instances backend
- Redis cluster pour sessions partagées
- Sticky sessions pour WebSocket (signaling)
- Pas besoin de synchronisation d'état émulateur (clients autonomes)

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

### ✅ Déjà implémenté
1. ~~Intégration émulateur réel (snes9x-wasm)~~ → **Fait** (Nostalgist.js)
2. ~~Compression vidéo H.264~~ → **Fait** (WebRTC hardware encoding)
3. ~~WebRTC peer-to-peer~~ → **Fait** (architecture P2P complète)

### Court terme
1. Améliorer stabilité WebRTC (reconnexion auto)
2. Optimiser input buffering (réduire latency <30ms)
3. Support multi-room simultané par utilisateur
4. Metrics temps réel (latence, FPS, qualité connexion)

### Moyen terme
5. Filtres vidéo (CRT, scanlines, upscaling)
6. Support gamepad physique (Gamepad API)
7. Spectator mode (>2 joueurs, broadcast stream)
8. Save states synchronisés (host/guest)
9. Chat vocal intégré (WebRTC audio bidirectionnel)

### Long terme
10. Multi-console (NES, Genesis, Game Boy, N64)
11. Cloud saves sync automatique
12. Replay recording & partage
13. Tournois & classements
14. Support mobile (touch controls)
15. Netplay rollback pour latence WAN élevée

---

**Dernière mise à jour:** 2025-11-24
