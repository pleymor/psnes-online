# Architecture technique — PSNES Online

> Ce document décrit le produit **par mode de room**. Pour le détail du netcode
> lockstep — protocole octet par octet, diagrammes de séquence, boucle de frame,
> resynchronisations, transport et métriques — voir
> [TECHNICAL.md](TECHNICAL.md).

## Vue d'ensemble

PSNES Online est une plateforme de jeu rétro SNES multijoueur avec **émulation
côté client dans tous les modes**. Le serveur ne fait jamais tourner de core
SNES : il s'occupe de la signalisation (WebSocket, WebRTC), du relais
d'entrées, et de la persistance (comptes, jeux, sauvegardes). Chaque joueur
exécute sa propre instance de l'émulateur dans son navigateur.

Une room démarre dans l'un de quatre modes, choisi à la création
(`room:create`, `backend/src/websocket/room-handlers.ts:54`) et non modifiable
en cours de partie (changer de mode démonterait une session en cours) :

| Mode | Composant | Logique | Coût |
|---|---|---|---|
| `lockstep` (défaut) | `LockstepRoom.svelte` | `frontend/src/lib/znet/` | D frames de latence d'entrée, blocage franc si le réseau hoquette |
| `single` | `SoloRoom.svelte` | `frontend/src/lib/znet/solo.ts` | — |
| `streaming` | `P2PRoom.svelte` | `frontend/src/lib/multiplayer/streaming-mode.ts`, `frontend/src/lib/webrtc/` | l'invité subit la latence d'encodage vidéo, pas de savestate partagé |
| `dual` (alpha) | `P2PRoom.svelte` | `frontend/src/lib/multiplayer/dual-mode.ts`, `frontend/src/lib/netplay/` | peut diverger silencieusement |

`lockstep` est le défaut (`emulationMode: payload.emulationMode ?? 'lockstep'`,
`backend/src/websocket/room-handlers.ts:109`) et le seul mode activement
développé. Un lecteur de cette documentation doit partir de ce mode-là, pas du
streaming P2P — historiquement le premier écrit, et le seul que cette
documentation décrivait avant cette révision.

`single` est le mode solo : un seul joueur, pas de réseau, la même machine à
états lockstep tournant sans pair distant (`znet/solo.ts`).

`streaming` et `dual` reposent tous deux sur `P2PRoom.svelte` et une connexion
WebRTC directe entre les deux navigateurs (`frontend/src/lib/webrtc/p2p-manager.ts`) ;
ce qu'ils en font diffère complètement, voir plus bas.

## Le chemin lockstep, en bref

Le principe (ZSNES-style, pas de rollback) : les deux pairs font tourner le
même core déterministe depuis le même savestate. L'entrée locale lue à la
frame F est programmée pour la frame F+D (« délai d'entrée »), la fenêtre
laissée au paquet pour traverser le réseau. Une frame n'avance pas tant que
les manettes des deux joueurs pour cette frame ne sont pas arrivées : si un
paquet est en retard, l'émulateur attend, exactement comme ZSNES. Un checksum
est échangé périodiquement ; s'il diverge, l'hôte renvoie un savestate complet
et les deux côtés redémarrent dessus.

Le prix : D frames de latence d'entrée et un blocage franc à chaque hoquet
réseau — le compromis assumé pour ne jamais produire la classe de bug
« correct localement, faux à distance ».

**Ce document ne détaille pas plus loin le netcode** : voir
[`LOCKSTEP_NETPLAY.md`](LOCKSTEP_NETPLAY.md), qui reste la référence sur le
sujet (pourquoi ce mode existe plutôt qu'un quatrième correctif au mode
`dual`, le core wasm dédié dans `core/`, le protocole de synchronisation).

Ce que cette passe de refactoring a découpé hors de
`frontend/src/lib/znet/session.ts` (1517 → 1161 lignes), qui ne porte plus que
la machine à états, le transport et l'epoch :
- `pad-timeline.ts` — ce qui a été échantillonné et ce qui est arrivé
- `link-metrics.ts` — ce que fait le lien (RTT, gigue, retards)
- `delay-control.ts` — si le délai d'entrée D doit bouger

Le reste de `znet/` (`core.ts`, `governor.ts`, `protocol.ts`, `output.ts`,
`webgl-renderer.ts`, `input.ts`, `devices.ts`, …) est le moteur lockstep
complet : encodage/compression du protocole, rendu WebGL, gestion des
manettes. `LockstepRoom.svelte` est le composant Svelte qui l'orchestre côté
UI.

## Le mode streaming (WebRTC)

C'était, jusqu'à cette révision, la seule architecture que ce document
décrivait. Elle reste exacte pour ce mode précis — elle a seulement cessé
d'être une description du produit entier.

**Rôles :**
- **Host :** exécute l'émulateur, capture le flux vidéo/audio du canvas,
  l'envoie par WebRTC.
- **Guest :** reçoit le flux WebRTC, l'affiche dans un `<video>`, envoie ses
  entrées par DataChannel.
- **Serveur :** signalisation WebRTC uniquement (pas d'émulation, pas de
  streaming côté serveur).

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT 1 (HOST)                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  SNES Emulator (WasmEmulator / Snes9x WASM)          │   │
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

### Établissement de la connexion P2P

```
1. Host crée une room (via WebSocket classique)
   Client → Socket.io: room:create { gameId, gameTitle, emulationMode: 'streaming' }
   Server → Client: room:created { room }
   Server → Friends: friend:roomCreated

2. Host lance l'émulateur local
   Browser → WasmEmulator → Snes9x WASM
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

### Boucle de jeu (60 FPS)

**Côté HOST :**
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

**Côté GUEST :**
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

### Latence

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

Optimisations appliquées : encodage H.264 matériel (GPU), `playoutDelayHint =
0` pour un buffer vidéo minimal, `jitterBufferTarget = 0` pour l'audio
(`frontend/src/lib/webrtc/p2p-manager.ts`), P2P direct sans relais TURN quand
possible, DataChannel pour les entrées (<5ms).

C'est ce coût — l'invité subit la latence d'encodage vidéo et il n'existe pas
de savestate partagé entre les deux pairs — qui a motivé le mode `lockstep`
plutôt qu'un correctif de plus sur ce chemin.

## Le mode dual (alpha)

`dual` fait tourner deux instances RetroArch indépendantes
(`frontend/src/lib/netplay/`), synchronisées par échange d'entrées plutôt que
par un flux vidéo — chaque joueur voit sa propre émulation locale au lieu de
recevoir l'image de l'hôte. `simple-sync-manager.ts` porte la synchronisation
courante ; `rollback-manager.ts`, `frame-controller.ts`, `input-buffer.ts` et
`state-buffer.ts` portent les briques d'un netcode par prédiction/rollback.

C'est un mode alpha : il peut diverger silencieusement, pour des raisons
structurelles documentées dans `LOCKSTEP_NETPLAY.md` (RetroArch ne peut pas
avancer d'exactement une frame sur commande, les entrées sont injectées via
des événements clavier simulés dont le timing n'est pas garanti, les réglages
par joueur ne sont pas comparés, et le core snes9x seed sa RAM de travail
depuis l'horloge murale). C'est exactement ce que le mode `lockstep` a été
écrit pour éliminer.

## Le serveur

Le serveur ne fait tourner aucun core SNES. Son rôle : authentifier, servir
l'API REST, signaler et relayer par WebSocket, persister.

**Amorçage (`backend/src/`) :**
- `index.ts` (73 lignes) — assemble la séquence de démarrage : garde
  d'environnement, connexion Redis, construction de l'app, restauration des
  rooms depuis Redis, ouverture du port, arrêt propre.
- `bootstrap/env-guard.ts` — refuse de démarrer en production si une variable
  d'environnement obligatoire manque.
- `bootstrap/app.ts` — construit l'application Express : session, CORS,
  Helmet, compression, routeurs, gestion d'erreurs.
- `bootstrap/jobs.ts` — restaure les rooms actives depuis Redis au démarrage,
  balaie les rooms orphelines, tâches de fond périodiques.
- `bootstrap/shutdown.ts` — installe les handlers `SIGTERM`/`SIGINT` pour un
  arrêt propre (fermeture HTTP, Redis, sauvegarde de l'état des rooms).

**API REST (`backend/src/api/`) :** `auth.ts`, `games.ts`, `friends.ts`,
`rooms.ts`, `user.ts`, `avatars.ts`, `metadata.ts`, `covers.ts`, `logs.ts`,
`pseudo.ts`, `entry-input.ts` — un routeur Express par domaine, montés dans
`bootstrap/app.ts`.

**WebSocket (`backend/src/websocket/`) :** sept groupes de handlers,
enregistrés par `index.ts` à chaque connexion authentifiée
(`registerRoomHandlers`, `registerInvitationHandlers`, `registerGameHandlers`,
`registerP2PHandlers`, `registerSyncHandlers`, `registerZnetHandlers`,
`registerRomTransferHandlers`) :
- `room-handlers.ts` (689 lignes, réduit de 1054) — cycle de vie de la room :
  création (mode d'émulation par défaut : `lockstep`), rejoindre/quitter,
  choix de port, config touches, ready, mode de latence.
- `invitation-handlers.ts` (381 lignes) — extrait de `room-handlers.ts` lors
  de cette passe : invitations et acceptation.
- `game-handlers.ts` — sélection du jeu, démarrage de partie.
- `p2p-handlers.ts` — signalisation WebRTC (offer/answer/ICE) pour les modes
  `streaming` et `dual`.
- `sync-handlers.ts` — synchronisation d'état pour le mode `dual`.
- `znet-handlers.ts` — relais des paquets d'entrée pour le mode `lockstep`.
- `rom-transfer.ts` — transfert de ROM hôte → invité.
- `presence.ts`, `guards.ts`, `room-view.ts`, `room-snapshot.ts` — support
  partagé (présence en ligne, garde-fous d'accès, vues publiques de room,
  snapshot pour la restauration).

**Persistance :**
- **SQLite** (`backend/src/db/`) — comptes (`User`), amitiés (`Friendship`),
  bibliothèque de jeux (`Game`), sauvegardes (`Save`, avec le blob et une
  capture d'écran).
- **Redis** — sessions (TTL 7 jours), état des rooms actives (`room:{roomId}`),
  statut de présence (`user:{userId}:status`). C'est aussi la source dont
  `bootstrap/jobs.ts` restaure les rooms au redémarrage.

## La VR : une présentation, pas un cinquième mode

Le casque ne change rien à l'émulation. `VrShell.svelte` pilote les mêmes
`createSoloEngine` et `createLockstepEngine` que `SoloRoom` et `LockstepRoom`,
sur le même core wasm, et lancer un jeu à deux depuis la VR ouvre une room
ordinaire que l'ami peut rejoindre à plat. Le tableau des quatre modes plus
haut reste donc la bonne grille de lecture : la VR est une surface de sortie et
d'entrée par-dessus, pas une cinquième ligne.

Elle est montée une seule fois, dans `+layout.svelte`, au-dessus du `<slot />`
— seul endroit présent quoi que fasse le joueur, et qu'une navigation ne
démonte pas.

**Le chemin d'entrée.** `support.ts` pose au navigateur la seule question
honnête (`isSessionSupported`, jamais le user-agent). `prepare.ts` existe pour
une loi empirique établie sur un vrai Quest 3 : **lire le dossier de ROMs
depuis une session immersive ne marche jamais**, la permission accordée sur la
page plate répondant « non accordée » une fois dans le casque. Les jeux sont
donc rapatriés avant que le casque ne prenne la main, et `door.ts` demande la
permission à la porte plutôt qu'au point d'usage — la boîte de dialogue native
est dessinée par le navigateur, sur la page, c'est-à-dire exactement ce que le
casque a remplacé. `xr-session.ts` ne demande que l'espace `local`, garanti par
la spécification, et garantit qu'on ne sort qu'une fois.

**La scène.** `scene.ts` détient le renderer et une seule politique : la boucle
XR pompe le gouverneur puis rend. Elle ne décide jamais qu'une frame existe —
c'est `FrameGovernor` qui le fait, à travers `frame-pump.ts`, et c'est ce qui
tient l'émulateur à 60,0988 Hz sur un casque à 72 ou 90. `layout.ts` et
`anchor.ts` concentrent toutes les distances et la position de la scène dans
des modules qui n'importent pas three, donc testables sous Bun et réglables
d'un seul fichier. `framebuffer-scale.ts` réclame la résolution native plutôt
que celle que le runtime recommande avec un œil sur son propre budget.

**Les panneaux.** Une session immersive n'a pas de DOM à réutiliser : un
panneau est un canvas peint à la main plus une liste de rectangles
(`panel.ts`, `panel-mesh.ts`). La mise en page est une fonction pure rendant
des `Region[]`, donc testée sous Bun ; seuls les appels de dessin ne le sont
pas. `panels/chrome.ts` porte l'habillage Super Mario World commun. Les menus
d'options vivent sur une tablette flottante qui change de contenu plutôt que
d'empiler des écrans. **Des crans, jamais de curseurs** : le pointeur est un
laser tenu à bout de bras, viser un bouton est franc là où faire glisser une
poignée ne l'est pas, et les bouts d'une échelle butent au lieu de boucler.

**Les entrées.** `pad.ts` traduit deux manettes Touch en un masque SNES 12
bits — les Touch parlent `xr-standard`, pas `standard`, et les axes n'ont pas
le même sens. `bt-pad.ts` ajoute une manette Bluetooth **en plus** et non à la
place. `pointer.ts` tient la détection de front sans laquelle une gâchette
maintenue lancerait un jeu soixante-douze fois par seconde.

### Le relief des calques

Une frame SNES arrive plate, mais elle n'a pas été composée à plat : en
dessinant, le PPU décide pour chaque pixel quel calque et quelle priorité l'ont
emporté, et garde la réponse dans `GFX.ZBuffer`. Le core expose ce plan en
lecture seule (`core/src/gfx_depth.cpp`, `pn_depth()`), et l'écran VR s'en sert
pour séparer les calques dans l'espace : dix plans plats, un par couple
(calque, priorité), chacun ne montrant que les pixels qu'il a gagnés.

Quatre choses sont à savoir avant de toucher à ce chemin, chacune ayant d'abord
produit une réponse plausible et fausse :

- **Il faut lire les deux tampons de profondeur.** Beaucoup de jeux dessinent
  l'essentiel de leurs calques sur le *sub-screen* et les ramènent par color
  math ; `GFX.ZBuffer` seul rend un plan uniformément plat.
- **libretro décale la frame de sept lignes** dans `GFX.Screen` (overscan).
  `pn_depth()` retrouve le décalage depuis le pointeur qu'on lui passe.
- **Un octet de priorité ne nomme pas un calque sans le mode BG** : en mode 1,
  BG1 vaut 47/43 ; en mode 3, 43 est BG2. D'où `pn_depth_bg_mode()` et
  `vr/layer-map.ts`.
- **La distance appartient au couple, pas au calque.** Un calque peut être à
  deux endroits : dans Super Mario All-Stars les nuages et la barre d'état sont
  tous deux BG3, à deux priorités que le matériel compose aux deux extrémités
  de l'ordre.

Le réglage est retenu par jeu, sur l'appareil, sous la clé CRC32 de la ROM
(`vr/relief-preset.ts`). Il part **éteint** : le relief est un goût, pas une
correction, et une pression sur l'intensité donne le diorama entier,
correctement proportionné.

Ce qui n'est pas fait : les trous. Un calque n'est dessiné que là où il a gagné
le pixel, donc ce qui est devant lui y laisse un trou, et rien dans la frame ne
dit ce qu'il y avait derrière. Reboucher à 60 Hz n'est pas résolu. `tools/vr-relief/`
garde la sonde qui a servi à établir tout ceci, avec le détail des trois
approches pesées.

## Frontend : au-delà des modes

**`frontend/src/lib/rooms/`** — logique partagée entre les composants de
room, extraite lors de cette passe :
- `room-session.ts` — cycle de vie de session commun.
- `sram.ts` — persistance de la SRAM de la cartouche.
- `input-sources.ts` — sources d'entrée (clavier, tactile, manette).
- `renderer-surface.ts` — surface de rendu partagée.
- `fullscreen.ts`, `chrome-autohide.ts` — plein écran et masquage de l'UI du
  navigateur.
- `actions.ts`, `game-click.ts`, `my-room.ts`, `online-players.ts`,
  `remembered-room.ts`, `resume-save.ts` — préexistants à cette passe.

**`frontend/src/lib/emulator/`** — le wrapper WasmEmulator (Snes9x WASM,
forké de Nostalgist.js) commun à tous les modes, et `input-manager.ts` pour la
capture d'entrée bas niveau.

**`frontend/src/lib/components/`** — les composants de room
(`LockstepRoom.svelte`, `SoloRoom.svelte`, `P2PRoom.svelte`,
`ClientEmulator.svelte`, `DualClientEmulator.svelte`) et les composants d'UI
partagés (menus, contrôles, listes d'amis, cartes de jeu).

**`scripts/svelte-frozen-props.mjs`** — lint créé lors de cette passe : une
déclaration de fonction appelée depuis un bloc réactif `$:` ou un template
Svelte 4 se compile en initialisation à usage unique plutôt qu'en dépendance
réactive. Le bug est invisible à la lecture ; ce script le détecte
statiquement.

## Carte des répertoires

```
psnes/
├── ARCHITECTURE.md          # ce document
├── LOCKSTEP_NETPLAY.md      # référence netcode lockstep
├── README.md
├── core/                    # core wasm dédié au mode lockstep (snes9x + libretro frontend maison)
│   ├── src/psnes_core.c
│   └── src/gfx_depth.cpp    # la seule fenêtre ouverte sur les internes de snes9x (lecture seule)
├── docs/
│   ├── history/             # instantanés de travaux terminés (voir docs/history/README.md)
│   ├── QUICKSTART.md
│   ├── GOOGLE_OAUTH_SETUP.md
│   ├── GITHUB_ACTIONS.md
│   ├── ROM_SYNC_FEATURE.md
│   ├── SPEED_CONTROLS.md
│   └── P2P_ARCHITECTURE.md  # détail du mode streaming
├── backend/src/
│   ├── index.ts              # 73 lignes — assemble le démarrage
│   ├── bootstrap/             # env-guard, app, jobs, shutdown
│   ├── api/                   # un routeur Express par domaine
│   ├── websocket/             # sept groupes de handlers socket.io
│   ├── auth/                  # Passport / OAuth Google
│   ├── db/                    # SQLite + Redis
│   ├── rooms/                 # état des rooms en mémoire
│   ├── saves/                 # gestion des sauvegardes
│   ├── services/               # métadonnées, recherche catalogue, amis, config utilisateur
│   ├── utils/                   # logger, cache, avatar, pseudo, …
│   ├── middleware/
│   └── types/
├── frontend/src/
│   ├── routes/                 # pages SvelteKit
│   └── lib/
│       ├── components/          # LockstepRoom, SoloRoom, P2PRoom, ClientEmulator, …
│       ├── znet/                 # moteur lockstep (session, transport, rendu WebGL)
│       ├── rooms/                 # logique de room partagée entre modes
│       ├── multiplayer/            # streaming-mode.ts, dual-mode.ts
│       ├── netplay/                 # sync manager, rollback, buffers (mode dual)
│       ├── webrtc/                   # p2p-manager.ts (signalisation + DataChannel)
│       ├── emulator/                  # wrapper WasmEmulator, input-manager
│       ├── vr/                          # session immersive : scène, écran, panneaux, manettes
│       │   └── panels/                    # un panneau = un canvas peint + des Region[]
│       └── api/, stores/, services/, config/, controls/, saves/, lobby/, games/, roms/, i18n/, utils/
├── e2e/                       # tests Playwright (dont probe-lockstep.mjs)
├── tools/vr-relief/           # sonde du relief des calques (bun run vr:relief)
└── scripts/                   # svelte-frozen-props.mjs, net-probe.sh, …
```

---

**Dernière mise à jour :** 2026-09-11
