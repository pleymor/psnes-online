# PSNES Online

Plateforme de jeu rétro SNES multijoueur en ligne. **L'émulation tourne côté
client, dans le navigateur de chaque joueur** — le serveur ne fait jamais tourner
de core SNES : il relaie, signale et persiste.

## 🎮 Fonctionnalités

- **Authentification Google OAuth** - Connexion sécurisée
- **Système d'amis** - Invitations et confirmations sans email
- **Bibliothèque de jeux** - Upload et gestion de ROMs personnelles
- **Rooms multijoueur** - Création et partage de sessions de jeu
- **Configuration manettes** - Personnalisation complète des touches
- **Sélection des ports** - Choix dynamique du port manette (1 ou 2)
- **Sauvegardes individuelles** - Save states liés au joueur et au jeu
- **Menu pause** - Réassignation touches, save/load, arrêt
- **Netplay lockstep** - Mode par défaut : les deux joueurs émulent la même
  machine déterministe, synchronisée à la frame (voir [TECHNICAL.md](TECHNICAL.md))
- **Streaming WebRTC** - Mode alternatif : l'hôte émule et diffuse son image
- **Contrôle vitesse émulation** - Ralenti, accéléré, vitesse illimitée (voir [docs/SPEED_CONTROLS.md](docs/SPEED_CONTROLS.md))

## 🏗️ Architecture

> 📖 **[TECHNICAL.md](TECHNICAL.md) — documentation technique détaillée.**
> Netcode lockstep, protocole binaire, diagrammes de séquence, transport,
> resynchronisations, métriques et déploiement. C'est la référence à lire pour
> travailler sur le multijoueur.
>
> Voir aussi [ARCHITECTURE.md](ARCHITECTURE.md) (vue par mode de room) et
> [LOCKSTEP_NETPLAY.md](LOCKSTEP_NETPLAY.md) (pourquoi le mode lockstep existe).

### Backend
- **Bun/TypeScript** avec Express
- **Socket.io** pour WebSocket temps réel et signaling WebRTC
- **bun:sqlite** pour la base de données
- **Redis** pour sessions et rooms actives
- **Passport.js** pour OAuth Google
- **Multer** pour upload de fichiers

### Frontend
- **SvelteKit** avec TypeScript
- **WebGL** pour le rendu vidéo, avec repli canvas 2D
- **Web Audio API** pour le son
- **Socket.io-client** pour le WebSocket, le relais netplay et la signalisation
- **WebRTC** pour le canal de données direct (netplay) et le streaming vidéo

### Émulation
- **snes9x compilé en WebAssembly** (`core/`, via Emscripten) — exécuté **dans le
  navigateur de chaque joueur**, jamais sur le serveur
- 256x224, PAL 50 Hz ou NTSC 60,0988 Hz selon la ROM
- Quatre modes de room : `lockstep` (défaut), `single`, `streaming`, `dual`
- Contrôle vitesse dynamique en solo (0.5x à illimité)

## 📋 Prérequis

- Bun 1.2+
- Docker & Docker Compose
- Compte Google Cloud (pour OAuth)

## 🚀 Installation

### 1. Cloner et installer

```bash
cd psnes
bun install
```

### 2. Configuration Google OAuth

1. Aller sur [Google Cloud Console](https://console.cloud.google.com/)
2. Créer un nouveau projet
3. Activer "Google+ API"
4. Créer des credentials OAuth 2.0:
   - Type: Web application
   - Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
5. Copier Client ID et Client Secret

### 3. Configuration Backend

```bash
cd backend
cp .env.example .env
```

Éditer `backend/.env`:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL="file:./data/dev.db"

REDIS_HOST=redis
REDIS_PORT=6379

SESSION_SECRET=YOUR_RANDOM_SECRET_HERE

GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

FRONTEND_URL=http://localhost:5173

ROMS_DIR=/app/roms
SAVES_DIR=/app/saves
```

### 4. Lancer avec Docker

```bash
docker compose up
```

Sur WSL, cela peut échouer à cause des autorisations, auquel cas essayez:

```bash
sudo docker compose up
```

L'application sera disponible sur:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000

**Après avoir ajouté/modifié une dépendance** (`package.json` racine, `backend/package.json` ou `frontend/package.json`), un simple redémarrage des conteneurs ne suffit plus : les dépendances sont installées une seule fois, à la construction de l'image, pas à chaque démarrage. Le volume qui les porte n'est pas traité pareil des deux côtés :

- côté **backend**, `node_modules` est un volume **nommé** (`backend-node-modules`) : il
  survit même à `docker compose up --build`, il faut le supprimer explicitement ;
- côté **frontend**, `node_modules` est un volume **anonyme** : par défaut, Compose
  réutilise les données de l'ancien conteneur plutôt que de les régénérer depuis
  l'image reconstruite — il faut forcer son renouvellement.

```bash
docker compose up --build -d --renew-anon-volumes   # reconstruit les images, régénère le volume anonyme du frontend

docker compose rm -sf backend                       # côté backend seulement : le volume nommé doit être supprimé à part
docker volume rm psnes_backend-node-modules
docker compose up -d backend
```

⚠️ Ne pas utiliser `docker compose down -v` pour ça : cette commande supprime **tous**
les volumes nommés du projet, y compris la base SQLite de dev, les saves, les avatars
et les données Redis.

## 🎯 User Journey

1. **Connexion** - Se connecter avec Google
2. **Upload ROM** - Ajouter un jeu à sa bibliothèque
3. **Créer room** - Cliquer sur "Play" pour créer une session
4. **Inviter ami** - L'ami voit le jeu actif et peut rejoindre
5. **Sélection ports** - Choisir manette 1 ou 2
6. **Lancer jeu** - N'importe quel joueur peut démarrer
7. **Jouer** - Chaque joueur émule la partie chez lui ; seules les manettes circulent
8. **Contrôle vitesse** - Tab pour vitesse illimitée, +/- pour ajuster
9. **Menu pause** - Appuyer sur Échap pour options

## 📁 Structure du projet

```
psnes/
├── backend/
│   ├── src/
│   │   ├── api/              # Routes REST
│   │   │   ├── auth.ts       # Google OAuth
│   │   │   ├── friends.ts    # Système d'amis
│   │   │   ├── games.ts      # Bibliothèque ROMs
│   │   │   └── rooms.ts      # Gestion rooms
│   │   ├── auth/
│   │   │   └── passport.ts   # Config Passport
│   │   ├── bootstrap/        # Racine de composition (ordres de démarrage)
│   │   ├── db/               # Repositories SQLite + migrations
│   │   ├── rooms/ saves/     # Domaine rooms et sauvegardes
│   │   ├── websocket/        # znet, rooms, invitations, ROM, présence
│   │   ├── types/
│   │   └── index.ts          # Point d'entrée
│   ├── migrations/
│   │   └── 0001_baseline.sql # Schéma DB (SQL brut)
│   ├── roms/                 # Stockage ROMs
│   ├── saves/                # Stockage saves
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── lib/
│   │   │   ├── components/   # Composants Svelte
│   │   │   ├── stores/       # Stores globaux
│   │   │   └── api/          # API client
│   │   ├── routes/           # Pages SvelteKit
│   │   │   ├── +layout.svelte
│   │   │   ├── +page.svelte  # Login
│   │   │   ├── library/      # Bibliothèque
│   │   │   └── room/[id]/    # Room de jeu
│   │   └── app.html
│   └── package.json
├── core/                     # Core snes9x wasm + suites de tests netcode
│   ├── src/  build.sh        # Compilation Emscripten
│   └── test/                 # Harness sur horloge virtuelle, tests protocole
├── docker-compose.yml
├── TECHNICAL.md              # Documentation technique détaillée
└── README.md
```

Le détail de `frontend/src/lib/znet/` — le moteur lockstep — est dans
[TECHNICAL.md](TECHNICAL.md).

## 🔧 Développement

### Backend

```bash
cd backend
bun install
npm run db:migrate   # Migrations DB
npm run dev          # Mode dev
```

### Frontend

```bash
cd frontend
bun install
npm run dev
npm run check        # svelte-check
npm run build        # ⚠ à lancer avant de déclarer une branche frontend finie
```

### Tests

```bash
npm run test:netplay   # protocole, ordonnanceur, resync, boucle de délai (core factice)
npm run test:core      # déterminisme contre le vrai snes9x wasm
npm run test:ui        # modules d'interface et d'état
npm run test:backend   # API, rooms, sauvegardes, gardes
npm run test:all       # les quatre
npm run test:e2e       # Playwright

npm run core:build     # recompiler le core wasm
npm run measure:splits # mesurer les répartitions de délai d'entrée
```

⚠️ **Ni les tests ni `npm run check` n'invoquent le bundler**, alors que le
déploiement est un `vite build`. Lancer `npm run build --workspace frontend`
avant de considérer une branche frontend terminée.

⚠️ **Un test e2e qui attend une `.game-card` doit d'abord rendre son jeu
résoluble sur cet appareil.** `POST /api/games` n'enregistre qu'une identité, et
la grille n'affiche que ce que *ce navigateur* sait ouvrir : sans
`keepRomOnDevice(page, checksum)` (`e2e/helpers.ts`), la carte n'est jamais
dessinée et le test expire sur « None of your N games are on this device ».

### Tester le mode VR sur un casque

**Le problème à comprendre avant de commencer : WebXR n'existe que dans un
contexte sécurisé.** `localhost` en est un, quel que soit l'absence de TLS. Une
IP de réseau local n'en est pas un — et là, `navigator.xr` vaut simplement
`undefined`, donc `vr/support.ts` ne rapporte aucun casque, le bouton « Passer
en VR » ne s'affiche jamais, et **ça ressemble exactement à un bug du code VR**.

La bonne voie est donc de faire voir l'app au casque *sur* `localhost`, avec
`adb reverse`. Elle n'a besoin d'aucun certificat.

**1. Sur le casque** — Paramètres → Système → Développeur → **Débogage sans
fil**. Le mode développeur doit d'abord être activé pour le compte depuis l'app
mobile Meta Quest.

**2. Appairage**, une seule fois. Le casque affiche un code et un port :

```bash
adb pair <ip-casque>:<port-appairage>
adb connect <ip-casque>:5555
adb devices                 # doit lister le casque
```

**3. Les deux redirections** :

```bash
adb reverse tcp:5173 tcp:5173   # l'app
adb reverse tcp:3000 tcp:3000   # le socket ET l'auth
adb reverse --list
```

**4. Dans le navigateur du casque** : `http://localhost:5173`.

⚠️ **Deux ports, pas un.** `socket.ts` construit son URL de socket avec
`window.location.hostname` en développement (il évite délibérément le proxy
Vite, qui pose des problèmes avec les données binaires). Sans la redirection du
3000, la page se charge et le socket meurt — le bandeau « Connection lost »
apparaît et rien de multijoueur ne fonctionne. Le 3000 sert aussi le callback
Google, donc c'est lui qui rend le **vrai compte** utilisable depuis le casque,
avec sa vraie bibliothèque.

⚠️ **N'essayez pas de servir l'app en HTTPS auto-signé sur l'IP du réseau.**
C'est une impasse, et elle coûte cher à diagnostiquer : il faudrait à la fois du
TLS pour satisfaire WebXR **et** un socket en clair pour `socket.ts`, ce qu'aucun
navigateur n'accepte (contenu mixte). Il faudrait donc mettre le backend en TLS
lui aussi et rediriger le 3000 — deux fois plus de bricolage pour une voie que
`adb reverse` rend inutile. Un certificat accepté « en passant outre » n'est de
plus pas toujours traité comme un contexte sécurisé pour les fonctionnalités
puissantes.

**Sans casque de développeur : le mode d'authentification `dev`.** Google refuse
les adresses IP privées comme URI de redirection autorisée, donc si vous ne
passez pas par `adb reverse`, l'auth Google ne peut pas aboutir depuis le casque.
`AUTH_MODE=dev docker compose up -d backend` ouvre trois utilisateurs de test par
un simple POST, sans aucune redirection. Le prix : un utilisateur de dev ne
possède aucun jeu, donc le pupitre bibliothèque est vide — ce qui exerce le
parcours réel, puisque les ROMs s'ajoutent depuis le navigateur à plat avant
d'entrer en VR.

⚠️ **Après un `bun add`, vérifiez le conteneur et pas seulement l'hôte.**
`/app/node_modules` est un volume anonyme (voir le commentaire dans
`docker-compose.yml`) : un `docker compose up -d` ordinaire reporte l'ancien
contenu, donc une dépendance installée sur l'hôte reste absente du conteneur.
`bun run build` et `bun run check` passent alors sur l'hôte pendant que Vite
échoue dans le conteneur sur `Failed to resolve import`. Le remède est
`docker compose up --build -d --renew-anon-volumes frontend`, et le contrôle utile
est de demander le module au serveur de dev :

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/src/lib/vr/scene.ts
```

### Documentation

| Fichier | Contenu |
|---|---|
| [TECHNICAL.md](TECHNICAL.md) | **Référence technique** : netcode, protocole, diagrammes de séquence |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Vue par mode de room |
| [LOCKSTEP_NETPLAY.md](LOCKSTEP_NETPLAY.md) | Pourquoi le mode lockstep existe |
| [BLOG.md](BLOG.md) | Journal de développement |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Démarrage rapide |
| [docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md) | Configuration OAuth |
| [docs/GITHUB_ACTIONS.md](docs/GITHUB_ACTIONS.md) | CI/CD |
| [docs/SPEED_CONTROLS.md](docs/SPEED_CONTROLS.md) | Contrôles de vitesse |
| [docs/ROM_SYNC_FEATURE.md](docs/ROM_SYNC_FEATURE.md) | Transfert de ROM |
| [docs/P2P_ARCHITECTURE.md](docs/P2P_ARCHITECTURE.md) | Modes WebRTC |

## 🎮 Émulation SNES

Le projet utilise **snes9x compilé en WebAssembly** (`core/`), exécuté dans le
navigateur de chaque joueur. Le serveur ne participe à aucune décision de jeu :
en lockstep il relaie des octets qu'il ne lit pas.

### Contrôles vitesse

| Touche | Action |
|--------|--------|
| `Tab` | Basculer entre vitesse normale (1x) et illimitée (MAX) |
| `+` / `=` | Augmenter la vitesse (0.5x → 1x → 2x → 3x → MAX) |
| `-` | Diminuer la vitesse |

**Vitesses disponibles:**
- **0.5x** - Ralenti (30 FPS)
- **1x** - Normal (60 FPS)
- **2x** - Double vitesse (120 FPS)
- **3x** - Triple vitesse (180 FPS)
- **MAX** - Vitesse illimitée (CPU max)

📖 **Documentation complète**: [docs/SPEED_CONTROLS.md](docs/SPEED_CONTROLS.md)

### Construire le core

Le core snes9x est compilé en WebAssembly depuis `core/` :

```bash
npm run core:build     # ./core/build.sh, via Emscripten
```

Le binaire produit est chargé par le navigateur (`frontend/src/lib/znet/loader.ts`).
`npm run test:core` se saute proprement tant qu'il n'a pas été construit.

## 🌐 Déploiement Production

### Configuration

1. **Domaine**: Configurer DNS pour `snes.pleymor.com`

2. **SSL**: Obtenir certificat Let's Encrypt

```bash
certbot certonly --standalone -d snes.pleymor.com
```

3. **Variables d'env production**:

```env
NODE_ENV=production
FRONTEND_URL=https://snes.pleymor.com
GOOGLE_CALLBACK_URL=https://snes.pleymor.com/auth/google/callback
SESSION_SECRET=<strong-random-secret>
```

4. **Docker Compose production**:

```yaml
# Ajouter proxy nginx pour SSL
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - /etc/letsencrypt:/etc/letsencrypt
```

5. **Optimisations**:
   - Activer compression gzip
   - CDN pour assets statiques
   - Redis persistence (RDB/AOF)
   - Monitoring (Prometheus + Grafana)

## 🔒 Sécurité

- ✅ HTTPS obligatoire en production
- ✅ CORS configuré strictement
- ✅ Helmet.js pour headers sécurisés
- ✅ Session secrets forts
- ✅ Validation des uploads ROM (taille, type)
- ✅ Rate limiting sur API

## 📝 API Documentation

### REST Endpoints

#### Auth
- `GET /auth/google` - Initier OAuth
- `GET /auth/google/callback` - Callback OAuth
- `GET /auth/me` - User actuel
- `GET /auth/mode` - Mode d'authentification du serveur
- `POST /auth/dev/login` - Connexion de développement (`AUTH_MODE=dev`)
- `POST /auth/logout` - Déconnexion

#### Friends
- `GET /api/friends` - Liste amis
- `GET /api/friends/requests` - Demandes en attente
- `POST /api/friends/request` - Envoyer demande
- `POST /api/friends/accept/:id` - Accepter demande
- `DELETE /api/friends/:id` - Supprimer ami

#### Games
- `GET /api/games` - Bibliothèque
- `POST /api/games` - Upload ROM
- `PATCH /api/games/:gameId/checksum` - Mettre à jour le checksum
- `POST /api/games/:gameId/identify` - Identifier le jeu
- `DELETE /api/games/:gameId` - Supprimer jeu
- `GET /api/games/:gameId/saves` - Sauvegardes
- `DELETE /api/games/:gameId/saves/:saveId` - Supprimer une sauvegarde
- `POST /api/games/refresh-metadata` - Rafraîchir les métadonnées

#### Autres
- `GET /api/rooms` - Rooms actives
- `PUT /api/pseudo` - Choisir son pseudo
- `GET /api/user/controls`, `PUT /api/user/controls`, `POST /api/user/controls/reset` - Config manettes
- `GET /api/metadata/search` - Recherche de métadonnées
- `GET /api/covers/:metadataId` - Jaquette
- `GET /api/avatars/:filename` - Avatar
- `POST /api/logs` - Télémétrie client (voir [TECHNICAL.md](TECHNICAL.md#18-télémétrie))

### WebSocket Events

#### Client → Server
- `room:create` - Créer room
- `room:join` - Rejoindre room
- `room:leave` - Quitter room
- `room:selectPort` - Sélectionner port manette
- `room:updateKeyConfig` - Modifier config touches
- `room:toggleReady` - Basculer ready
- `game:start` - Lancer jeu
- `game:input` - Envoyer inputs
- `game:pause` - Pause
- `game:resume` - Reprendre
- `game:stop` - Arrêter
- `game:save` - Sauvegarder
- `game:load` - Charger
- `game:setSpeed` - Changer vitesse émulation
- `lobby:invite` / `lobby:accept` / `lobby:decline` / `lobby:cancel` - Invitations
- `znet:join` / `znet:packet` / `znet:leave` - Session netplay lockstep
- `rom:request` / `rom:chunk` / `rom:unavailable` - Transfert de ROM entre pairs
- `webrtc:signal` - Signalisation WebRTC (vidéo et canal de données)
- `sync:checksum` - Vérification de synchronisation

#### Server → Client
- `room:created` - Room créée
- `room:updated` - Room mise à jour
- `room:destroyed` - Room détruite
- `game:started` - Jeu démarré
- `game:paused` - Jeu en pause
- `game:resumed` - Jeu repris
- `game:stopped` - Jeu arrêté
- `game:speedChanged` - Vitesse émulation changée
- `friends:online` - Amis en ligne
- `lobby:invitation` / `lobby:accepted` / `lobby:declined` / `lobby:cancelled` - Invitations
- `znet:joined` / `znet:peer-joined` / `znet:error` - Sièges netplay
- `rom:request` / `rom:chunk` / `rom:unavailable` - Transfert de ROM
- `room:opened` / `room:update` / `rooms:list` - État des rooms
- `host:left` / `player:left` - Départs

> Il n'y a plus d'événement `game:frame` ni `game:audio` : l'image et le son ne
> transitent pas par le serveur.

## 🐛 Troubleshooting

### Problème: "Failed to connect to WebSocket"
- Vérifier que Redis est démarré
- Vérifier les CORS settings

### Problème: "ROM upload fails"
- Vérifier taille fichier < 10MB
- Vérifier extension (.smc, .sfc, etc.)
- Vérifier permissions dossier `roms/`

### Problème: "Audio crackling"
- Ajuster buffer size dans Web Audio API
- Vérifier latence réseau

## 📊 Performance

### Architecture WebRTC

Le streaming vidéo utilise **WebRTC** pour une latence minimale :

- **Latence réelle** : ~45ms (mesurée)
- **Amélioration** : ~10x plus rapide que l'architecture précédente Socket.IO (~500ms)
- **Technologie** : Peer-to-peer direct avec ICE/STUN pour NAT traversal
- **Qualité** : 60 FPS stable avec audio synchronisé

### Optimisations implémentées

1. **WebRTC DataChannel** : Transmission inputs en temps réel
2. **MediaStream** : Streaming vidéo/audio optimisé
3. **ICE candidates** : Connexion P2P directe quand possible
4. **Audio buffering** : ~100ms buffer pour synchronisation
5. **Frame timing** : Synchronisation précise à 60 FPS

### Benchmarks actuels

- Latence input→display : **~45ms** ✅
- FPS stable : **60 FPS** ✅
- Bande passante : ~2-5 Mbps par room
- Concurrent users : 50+ rooms

## 🤝 Contributing

1. Fork le projet
2. Créer feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push branch (`git push origin feature/AmazingFeature`)
5. Ouvrir Pull Request

## 📄 Licence

Projet privé - Tous droits réservés

## ⚠️ Legal Disclaimer - ROMs and Intellectual Property / Disclaimer Légal - ROMs et Propriété Intellectuelle

### 🇬🇧 English Version

**IMPORTANT - READ BEFORE USE**

This platform provides only a technical emulation infrastructure. The use of video game ROMs is strictly regulated by law:

#### Legal Obligations

1. **Ownership of original games**: You must own an original physical copy of the game whose ROM you upload. Possessing a ROM without the original game is illegal in most jurisdictions.

2. **Personal use only**: ROMs may only be used for strictly personal purposes. Any commercial or public distribution or sharing is prohibited.

3. **Copyright**: SNES games and their ROMs are protected by copyright. Nintendo and game developers retain all rights to their works.

4. **Personal backup**: In some jurisdictions, you have the right to create a backup copy of a game you legally own. Downloading ROMs from the Internet, even for games you own, may be illegal.

#### Responsibilities

- **The user is solely responsible** for the content they upload and its compliance with applicable laws
- The operators of this platform do not provide, host, or distribute any ROMs
- This platform is provided solely for educational purposes and preservation of video game heritage
- By using this platform, you agree to comply with all local, national, and international intellectual property laws

#### Penalties

Copyright infringement may result in civil and criminal prosecution, including substantial fines and imprisonment.

**By using this platform, you acknowledge that you have read, understood, and accepted these terms.**

---

### 🇫🇷 Version Française

**IMPORTANT - À LIRE AVANT UTILISATION**

Cette plateforme fournit uniquement une infrastructure technique d'émulation. L'utilisation de ROMs de jeux vidéo est strictement encadrée par la loi :

#### Obligations légales

1. **Propriété des jeux originaux** : Vous devez posséder une copie physique originale du jeu dont vous uploadez la ROM. La possession d'une ROM sans le jeu original est illégale dans la plupart des juridictions.

2. **Usage personnel uniquement** : Les ROMs ne peuvent être utilisées que dans un cadre strictement personnel. Toute distribution, partage commercial ou public est interdit.

3. **Droits d'auteur** : Les jeux SNES et leurs ROMs sont protégés par le droit d'auteur. Nintendo et les développeurs de jeux détiennent tous les droits sur leurs œuvres.

4. **Backup personnel** : Dans certaines juridictions, vous avez le droit de créer une copie de sauvegarde d'un jeu que vous possédez légalement. Le téléchargement de ROMs depuis Internet, même pour des jeux que vous possédez, peut être illégal.

#### Responsabilités

- **L'utilisateur est seul responsable** du contenu qu'il upload et de sa conformité avec les lois applicables
- Les opérateurs de cette plateforme ne fournissent, n'hébergent et ne distribuent aucune ROM
- Cette plateforme est fournie uniquement à des fins éducatives et de préservation du patrimoine vidéoludique
- En utilisant cette plateforme, vous acceptez de respecter toutes les lois locales, nationales et internationales sur la propriété intellectuelle

#### Sanctions

La violation des droits d'auteur peut entraîner des poursuites civiles et pénales, incluant des amendes substantielles et des peines d'emprisonnement.

**En utilisant cette plateforme, vous reconnaissez avoir lu, compris et accepté ces conditions.**

## 🎯 Roadmap

### v1.0 (Actuel)
- [x] Authentification Google
- [x] Système d'amis
- [x] Upload ROMs
- [x] Rooms multijoueur
- [x] Configuration manettes
- [x] Architecture streaming
- [x] Intégration émulateur réel (snes9x wasm)
- [x] Contrôle vitesse émulation dynamique
- [x] Netplay lockstep déterministe
- [x] Filtres vidéo (CRT, scanlines)
- [x] Support gamepad physique
- [x] Manette virtuelle tactile (stick ou croix)

### v1.1 (Futur)
- [ ] Chat vocal
- [ ] Spectator mode (>2 joueurs)
- [ ] Replay recording
- [ ] Achievements system

### v2.0 (Futur)
- [ ] Support autres consoles (NES, Genesis, N64)
- [ ] Tournois en ligne
- [ ] Classements
- [ ] Cloud saves sync

## 👥 Support

Pour questions ou problèmes:
- GitHub Issues: [psnes/issues](https://github.com/pleymor/psnes/issues)
- Email: support@pleymor.com

---

Fait avec ❤️ par Pleymor
