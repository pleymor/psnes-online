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
- **Streaming WebRTC** - Latence ultra-faible ~45ms via WebRTC peer-to-peer
- **Contrôle vitesse émulation** - Ralenti, accéléré, vitesse illimitée (voir [docs/SPEED_CONTROLS.md](docs/SPEED_CONTROLS.md))

## 🏗️ Architecture

### Backend
- **Node.js/TypeScript** avec Express
- **Socket.io** pour WebSocket temps réel et signaling WebRTC
- **Prisma** + SQLite pour la base de données
- **Redis** pour sessions et rooms actives
- **Passport.js** pour OAuth Google
- **Multer** pour upload de fichiers

### Frontend
- **SvelteKit** avec TypeScript
- **WebRTC** pour streaming vidéo/audio basse latence (~45ms)
- **Canvas API** pour rendu vidéo
- **Web Audio API** pour le son
- **Socket.io-client** pour WebSocket et signaling

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
