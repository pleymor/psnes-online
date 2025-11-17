# PSNES Online

Plateforme de jeu rétro SNES multijoueur en ligne avec émulation côté serveur.

## 🎮 Fonctionnalités

- **Authentification Google OAuth** - Connexion sécurisée
- **Système d'amis** - Invitations et confirmations sans email
- **Bibliothèque de jeux** - Upload et gestion de ROMs personnelles
- **Rooms multijoueur** - Création et partage de sessions de jeu
- **Configuration manettes** - Personnalisation complète des touches
- **Sélection des ports** - Choix dynamique du port manette (1 ou 2)
- **Sauvegardes individuelles** - Save states liés au joueur et au jeu
- **Menu pause** - Réassignation touches, save/load, arrêt
- **Streaming temps réel** - Vidéo et audio synchronisés
- **Contrôle vitesse émulation** - Ralenti, accéléré, vitesse illimitée (voir [docs/SPEED_CONTROLS.md](docs/SPEED_CONTROLS.md))

## 🏗️ Architecture

### Backend
- **Node.js/TypeScript** avec Express
- **Socket.io** pour WebSocket temps réel
- **Prisma** + SQLite pour la base de données
- **Redis** pour sessions et rooms actives
- **Passport.js** pour OAuth Google
- **Multer** pour upload de fichiers

### Frontend
- **SvelteKit** avec TypeScript
- **Canvas API** pour rendu vidéo
- **Web Audio API** pour le son
- **Socket.io-client** pour WebSocket

### Émulation
- **snes9x-next** (libretro core) - Émulation SNES réelle
- Streaming vidéo (256x224 @ 60 FPS)
- Audio PCM temps réel
- Contrôle vitesse dynamique (0.5x à illimité)

## 📋 Prérequis

- Node.js 20+
- Docker & Docker Compose
- Compte Google Cloud (pour OAuth)

## 🚀 Installation

### 1. Cloner et installer

```bash
cd psnes
npm install
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

## 🎯 User Journey

1. **Connexion** - Se connecter avec Google
2. **Upload ROM** - Ajouter un jeu à sa bibliothèque
3. **Créer room** - Cliquer sur "Play" pour créer une session
4. **Inviter ami** - L'ami voit le jeu actif et peut rejoindre
5. **Sélection ports** - Choisir manette 1 ou 2
6. **Lancer jeu** - N'importe quel joueur peut démarrer
7. **Jouer** - Le jeu tourne sur le serveur, streaming vers les clients
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
│   │   ├── emulator/
│   │   │   └── manager.ts    # Gestion émulateur
│   │   ├── models/           # Models Prisma
│   │   ├── websocket/
│   │   │   └── index.ts      # Socket.io handlers
│   │   ├── types/
│   │   │   └── index.ts      # Types TypeScript
│   │   └── index.ts          # Point d'entrée
│   ├── prisma/
│   │   └── schema.prisma     # Schéma DB
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
├── docker-compose.yml
└── README.md
```

## 🔧 Développement

### Backend

```bash
cd backend
npm install
npm run db:generate  # Générer Prisma client
npm run db:migrate   # Migrations DB
npm run dev          # Mode dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## 🎮 Émulation SNES

Le projet utilise **snes9x-next**, un core libretro compilé en WebAssembly pour une émulation SNES réelle côté serveur.

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

### Configuration avancée (Legacy)

**⚠️ Note**: Les instructions ci-dessous sont pour référence historique. L'émulateur est déjà intégré.

### Option 1: snes9x-emscripten (Recommandé)

```bash
# Installer snes9x compilé en WebAssembly
npm install snes9x-emscripten
```

Modifier `backend/src/emulator/manager.ts`:

```typescript
import Snes9x from 'snes9x-emscripten';

async startEmulator(roomId: string, gameId: string) {
  const emulator = await Snes9x.create();
  await emulator.loadROM(romPath);

  // Frame loop
  emulator.onFrame((videoData, audioData) => {
    this.emit(`frame:${roomId}`, videoData);
    this.emit(`audio:${roomId}`, audioData);
  });
}
```

### Option 2: libretro native (Avancé)

Utiliser `node-ffi` ou `napi` pour bindings vers libretro native:

```bash
# Installer libretro core
apt-get install libretro-snes9x
```

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
- `POST /auth/logout` - Déconnexion

#### Friends
- `GET /api/friends` - Liste amis
- `GET /api/friends/requests` - Demandes en attente
- `POST /api/friends/request` - Envoyer demande
- `POST /api/friends/accept/:id` - Accepter demande
- `DELETE /api/friends/:id` - Supprimer ami

#### Games
- `GET /api/games` - Bibliothèque
- `POST /api/games/upload` - Upload ROM
- `DELETE /api/games/:id` - Supprimer jeu
- `GET /api/games/:id/saves` - Sauvegardes

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

#### Server → Client
- `room:created` - Room créée
- `room:updated` - Room mise à jour
- `room:destroyed` - Room détruite
- `game:started` - Jeu démarré
- `game:frame` - Frame vidéo
- `game:audio` - Frame audio
- `game:paused` - Jeu en pause
- `game:resumed` - Jeu repris
- `game:stopped` - Jeu arrêté
- `game:speedChanged` - Vitesse émulation changée
- `friends:online` - Amis en ligne

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

### Optimisations latence

1. **Réduire taille frames**: Utiliser compression (H.264)
2. **WebRTC**: Pour p2p si possible
3. **Frame skip**: Adapter aux conditions réseau
4. **Audio buffering**: ~100ms buffer
5. **Delta encoding**: N'envoyer que pixels changés

### Benchmarks cibles

- Latence input→display: < 100ms
- FPS stable: 60 FPS
- Bande passante: ~2-5 Mbps par room
- Concurrent users: 50+ rooms

## 🤝 Contributing

1. Fork le projet
2. Créer feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push branch (`git push origin feature/AmazingFeature`)
5. Ouvrir Pull Request

## 📄 Licence

Projet privé - Tous droits réservés

**Note légale**: L'upload de ROMs est de la responsabilité de l'utilisateur. Assurez-vous de posséder les droits légaux pour les jeux que vous uploadez.

## 🎯 Roadmap

### v1.0 (Actuel)
- [x] Authentification Google
- [x] Système d'amis
- [x] Upload ROMs
- [x] Rooms multijoueur
- [x] Configuration manettes
- [x] Architecture streaming
- [x] Intégration émulateur réel (snes9x-next)
- [x] Contrôle vitesse émulation dynamique

### v1.1 (Futur)
- [ ] Filtres vidéo (CRT, scanlines)
- [ ] Support gamepad physique
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
