# 🎮 Test de la POC P2P

## Preuve de concept : Émulation client-side avec WebRTC P2P

Cette POC démontre l'émulation SNES dans le navigateur du host avec streaming P2P vers les guests.

## 🚀 Comment tester

### 1. Démarrer les services

```bash
docker-compose up
```

Services actifs :
- Frontend: http://localhost:5173
- Backend: http://localhost:3000 (signaling uniquement)

### 2. Ouvrir deux navigateurs

**Option A : Deux fenêtres du même navigateur**
```
Fenêtre 1 (Host): http://localhost:5173/p2p-test
Fenêtre 2 (Guest): http://localhost:5173/p2p-test
```

**Option B : Deux appareils différents (meilleur test)**
```
PC 1 (Host): http://localhost:5173/p2p-test
PC 2 (Guest): http://PC1_IP:5173/p2p-test
```

### 3. Configuration

#### Host (Fenêtre 1):
1. Sélectionner **Role: Host**
2. Noter le **Room ID** (ex: `test-room-abc123`)
3. Choisir un **Game**
4. Cliquer **Start as Host**

#### Guest (Fenêtre 2):
1. Sélectionner **Role: Guest**
2. Entrer le **même Room ID** que le host
3. Choisir **le même Game**
4. Cliquer **Join as Guest**

### 4. Vérifier la connexion

**Host** :
- ✅ Devrait voir "👑 HOST" dans le header
- ✅ Devrait voir "✅ Connected (P2P)"
- ✅ Devrait voir le jeu s'exécuter dans un canvas
- ✅ Devrait pouvoir contrôler avec WASD + IJKLOP

**Guest** :
- ✅ Devrait voir "🎮 GUEST" dans le header
- ✅ Devrait voir "✅ Connected (P2P)"
- ✅ Devrait voir une vidéo du jeu (stream du host)
- ✅ Devrait entendre l'audio
- ✅ Devrait pouvoir envoyer des inputs (Player 2)

## 🔍 Debugging

### Ouvrir la console du navigateur (F12)

#### Host logs attendus:
```
📥 Loading ROM... <game-id>
✅ ROM loaded (XXXXX bytes)
🎮 Initializing client-side SNES emulator...
✅ Emulator initialized successfully
🔗 Setting up P2P connection...
📤 Sending WebRTC signal
📥 Received WebRTC signal
✅ P2P connection established!
📹 Capturing canvas stream at 60 FPS
```

#### Guest logs attendus:
```
📥 Loading ROM... <game-id>
✅ ROM loaded (XXXXX bytes)
🔗 Setting up P2P connection...
📥 Received WebRTC signal
📤 Sending WebRTC signal
✅ P2P connection established!
📺 Received stream from host
```

### Backend logs (si besoin):
```bash
docker-compose logs -f backend
```

Attendu:
```
WebRTC signal forwarded between peers
```

## 📊 Mesurer la latence

Ouvrir console navigateur et taper:
```javascript
// Host: mesurer le lag d'émulation
const stats = await window.emulator?.getStats();
console.log('Emulator stats:', stats);

// Guest: mesurer la latence P2P
const rtcStats = await window.p2pManager?.getStats();
for (let stat of rtcStats.values()) {
  if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
    console.log('Latency:', stat.currentRoundTripTime * 1000, 'ms');
  }
}
```

## ⚠️ Problèmes connus

### 1. "Failed to load ROM"
**Cause**: Pas de jeu uploadé
**Solution**: Aller sur http://localhost:5173 et uploader une ROM SNES

### 2. "Connection failed" / "P2P error"
**Cause**: Firewall ou NAT strict
**Solution**:
- Tester sur localhost d'abord (même PC)
- Vérifier que les ports ne sont pas bloqués
- Dans un vrai déploiement, ajouter un serveur TURN

### 3. "Emulator not loading"
**Cause**: Nostalgist failed to initialize
**Solution**: Vérifier la console pour les erreurs WebAssembly

### 4. Video lag / choppy
**Cause**: CPU host trop faible
**Solution**:
- Tester sur un PC plus puissant
- Réduire la résolution/FPS dans Nostalgist

### 5. "Room ID mismatch"
**Cause**: Host et Guest n'utilisent pas le même Room ID
**Solution**: Copier-coller exactement le même Room ID

## 🎯 Points à vérifier

- [ ] **Émulation fonctionne côté host** (canvas affiche le jeu)
- [ ] **WebRTC P2P établi** (status = "Connected")
- [ ] **Stream vidéo reçu côté guest** (video element affiche le jeu)
- [ ] **Audio audible côté guest**
- [ ] **Inputs host fonctionnent** (WASD contrôle le jeu)
- [ ] **Inputs guest envoyés** (touches envoient des data via P2P)
- [ ] **Latence acceptable** (<50ms pour P2P local)
- [ ] **Pas de lag CPU serveur** (backend logs silencieux)

## 📈 Comparaison avec l'ancien système

### Ancien (Server-side):
```
Host → Server (émulation) → Encode → Network → Guest
```
- CPU serveur: 100%
- Latence: 100-120ms
- Scheduler lag: 500-3000ms derrière
- Scalabilité: 1-2 rooms max

### Nouveau (P2P):
```
Host (émulation locale) → WebRTC P2P direct → Guest
```
- CPU serveur: ~5% (signaling only)
- Latence: 15-30ms (P2P direct)
- Pas de scheduler lag (CPU du host)
- Scalabilité: Illimitée

## 🎮 Commandes de test

**Host (Player 1):**
- Move: WASD
- Actions: IJKLOP
- Start: Enter
- Select: Right Shift

**Guest (Player 2):**
- Même mapping (inputs envoyés au host via P2P)

## ✅ Critères de succès

La POC est validée si :

1. ✅ L'émulateur fonctionne dans le navigateur du host
2. ✅ La connexion P2P s'établit entre host et guest
3. ✅ Le guest reçoit le stream vidéo/audio en temps réel
4. ✅ Les inputs du guest sont transmis au host
5. ✅ La latence est < 50ms (mesurable dans les stats WebRTC)
6. ✅ Le CPU serveur reste bas (<10% pendant le jeu)

Si ces 6 points sont OK, la POC est un succès et on peut migrer le système complet ! 🚀

## 🐛 Rapport de bugs

Si quelque chose ne fonctionne pas :

1. Copier les logs console (F12)
2. Copier les logs backend (`docker-compose logs backend`)
3. Noter le navigateur/OS utilisé
4. Décrire ce qui ne fonctionne pas

## 📝 Prochaines étapes

Si la POC fonctionne :

1. **Migrer les rooms existantes** vers le système P2P
2. **Ajouter TURN server** pour NAT traversal (99% success rate)
3. **Optimiser le bitrate** WebRTC pour différentes connexions
4. **Implémenter la migration de host** (si host déconnecte)
5. **Ajouter les save states** côté client
6. **Supprimer l'émulation serveur** (libérer le CPU VPS)

Temps estimé migration complète : **1-2 semaines**
