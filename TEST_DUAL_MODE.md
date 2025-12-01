# 🧪 TEST DU MODE DUAL - Guide Pratique

## ✅ Préparation Terminée

J'ai activé le mode DUAL par défaut :
- ✅ Fichier `.env` créé avec `VITE_ENABLE_DUAL_MODE=true`
- ✅ `P2PRoom.svelte` modifié : mode DUAL activé par défaut

---

## 📋 Étapes de Test

### 1. Redémarrer le Serveur

```bash
# Arrêter Docker Compose
docker-compose down

# Redémarrer
docker-compose up -d

# Vérifier les logs
docker-compose logs -f frontend
```

### 2. Ouvrir Deux Navigateurs

**Option A : Même Machine (Test Rapide)**
```
Navigateur 1 (Host) : http://localhost:5173
Navigateur 2 (Guest) : http://localhost:5173 (fenêtre incognito)
```

**Option B : Deux Machines (Test LAN Réel)**
```
Machine 1 (Host) : http://<IP_MACHINE_1>:5173
Machine 2 (Guest) : http://<IP_MACHINE_1>:5173
```

### 3. Créer une Room (Host)

1. Navigateur 1 : Se connecter
2. Aller dans "Games"
3. Choisir un jeu (ex: Super Mario World)
4. Cliquer "Play"
5. **Ouvrir la Console** (F12) pour voir les logs

### 4. Rejoindre la Room (Guest)

1. Navigateur 2 : Se connecter
2. Voir la room dans la liste
3. Cliquer "Join"
4. **Ouvrir la Console** (F12) pour voir les logs

---

## 🔍 Quoi Observer

### Console Host (Navigateur 1)

Logs attendus :
```
🎮 Initializing emulator in DUAL mode (HOST)
✅ Emulator ready
✅ SyncManager initialized (check every 60 frames)
✅ Started sync check interval (every 1000ms)
✅ Started input sending (60 FPS)
📤 Sent sync checksum at frame 60: abc123def456
📤 Sent sync checksum at frame 120: def456abc789
```

### Console Guest (Navigateur 2)

Logs attendus :
```
🎮 Initializing emulator in DUAL mode (GUEST)
✅ Emulator ready
✅ Started input sending (60 FPS)
✅ Sync OK at frame 60
✅ Sync OK at frame 120
```

### Interface Visuelle

**En bas de l'écran**, vous devriez voir :

```
┌─────────────────────────────────────┐
│ ⚡ Dual Mode                        │
│ ✅ Synced                           │
└─────────────────────────────────────┘
```

Badge **VERT** avec "✅ Synced" = **Tout fonctionne !**

---

## ✅ Critères de Succès

### 1. Les Deux Émulateurs Démarrent

- [ ] Host voit le jeu
- [ ] Guest voit le jeu (pas de vidéo stream)
- [ ] Les deux peuvent jouer

### 2. Logs Corrects

- [ ] Host : `Initializing emulator in DUAL mode (HOST)`
- [ ] Guest : `Initializing emulator in DUAL mode (GUEST)`
- [ ] Host : `Started input sending (60 FPS)`
- [ ] Guest : `Started input sending (60 FPS)`
- [ ] Guest : `✅ Sync OK at frame 60`

### 3. Badge UI Visible

- [ ] Badge "⚡ Dual Mode" affiché
- [ ] Status "✅ Synced" (vert)
- [ ] Pas de "⚠️ Desynced"

### 4. Performance

- [ ] Latence guest < 20ms (affiché dans l'indicateur)
- [ ] FPS stable à 60
- [ ] Pas de lag visible

### 5. Bande Passante

Ouvrir DevTools → Network tab :
- [ ] Trafic réseau < 10 KB/s (au lieu de 300-600 KB/s)

---

## ⚠️ Problèmes Potentiels

### Problème 1 : "Guest waiting for stream"

**Symptôme** :
```
Console Guest : 📹 Guest waiting for stream (STREAMING mode)
```

**Cause** : Le mode dual n'est pas activé côté guest

**Solution** :
```bash
# Vérifier que le changement est bien dans le code
grep "EmulationMode.DUAL" frontend/src/lib/components/P2PRoom.svelte

# Doit afficher :
# emulationMode: EmulationMode.DUAL,

# Redémarrer le serveur
docker-compose restart frontend
```

### Problème 2 : Désynchronisation Immédiate

**Symptôme** :
```
Console Guest : ⚠️ DESYNC detected at frame 60
                🔄 Falling back to streaming mode...
```

**Causes possibles** :
- ROMs différentes (très probable)
- Bug de déterminisme émulateur

**Solution** :
1. Vérifier que les deux joueurs chargent **exactement la même ROM**
2. Essayer un autre jeu
3. C'est normal en beta, le fallback fonctionne !

### Problème 3 : Erreur "Cannot compute checksum"

**Symptôme** :
```
Console : Failed to compute checksum: TypeError...
```

**Cause** : L'émulateur n'est pas encore prêt

**Solution** :
- C'est probablement un timing, attendre 2-3 secondes
- Si ça persiste, vérifier les logs d'erreur

### Problème 4 : CPU à 100%

**Symptôme** : Ventilateur à fond, machine qui lag

**Cause** : Les deux émulateurs tournent = 2x plus de CPU

**Solution** :
- C'est normal en mode dual
- Fermer d'autres programmes
- Ou repasser en streaming (changer `DUAL` → `STREAMING`)

---

## 📊 Mesures Attendues

### Latence (visible dans l'UI en bas à gauche)

**Même machine** :
- Host : ~0-2ms
- Guest : ~2-5ms

**Deux machines LAN** :
- Host : ~0-2ms
- Guest : ~2-10ms (selon réseau)

**Comparaison** : En streaming, guest = 50-100ms

### FPS

Les deux côtés : **60 FPS stable**

### Bande Passante

- **Mode Dual** : ~0.5-2 KB/s
- **Mode Streaming** : ~300-600 KB/s

**Gain** : ~300x moins de bande passante !

---

## 🎮 Test Gameplay

### Actions à Tester

1. **Host** appuie sur des touches
   - Guest voit les inputs du host s'appliquer
   - Latence ultra-faible

2. **Guest** appuie sur des touches
   - Host voit les inputs du guest s'appliquer
   - Guest contrôle son personnage avec latence faible

3. **Jouer 2-3 minutes**
   - Vérifier que `✅ Sync OK` continue toutes les 1 sec
   - Pas de crash
   - Pas de désync

### Jeux Recommandés pour Test

**Excellents** :
- Super Mario World (simple, coopératif)
- Street Fighter II Turbo (test latence)
- Super Mario Kart (test performance)

**À éviter pour test initial** :
- Jeux avec beaucoup d'événements aléatoires
- RPGs complexes

---

## 📸 Captures d'Écran Utiles

### 1. Console Logs

Faire un screenshot de :
- Console Host avec les logs `DUAL mode (HOST)`
- Console Guest avec les logs `DUAL mode (GUEST)` et `✅ Sync OK`

### 2. Badge UI

Screenshot du badge "⚡ Dual Mode - ✅ Synced" en bas

### 3. Network Tab

Screenshot du Network tab montrant faible trafic (~1 KB/s)

---

## ✅ Checklist Finale

Avant de confirmer que ça fonctionne :

- [ ] Serveur redémarré
- [ ] Deux navigateurs/machines prêts
- [ ] Room créée (host)
- [ ] Room jointe (guest)
- [ ] Console host : logs DUAL mode HOST
- [ ] Console guest : logs DUAL mode GUEST
- [ ] Badge UI visible "⚡ Dual Mode"
- [ ] Status "✅ Synced"
- [ ] Gameplay fluide (60 FPS)
- [ ] Pas de désync pendant 1-2 min
- [ ] Latence guest < 20ms

---

## 🚀 Une Fois le Test Réussi

Si tout fonctionne bien :

1. **Partager les résultats** :
   - Captures d'écran
   - Latence mesurée
   - Jeu testé
   - Configuration (LAN/WAN)

2. **Tester d'autres scénarios** :
   - Différents jeux
   - Connexion WAN (deux machines différentes)
   - Forcer désync (modifier ROM)

3. **Passer aux tests unitaires** (Phase 5)

---

## ❓ Questions Fréquentes

**Q: Dois-je avoir deux ROMs différentes ?**
R: Non ! Les deux joueurs doivent avoir **exactement la même ROM**. Sinon désync garantie.

**Q: Ça fonctionne avec n'importe quel jeu ?**
R: En théorie oui, mais certains jeux peuvent causer plus de desyncs. On teste.

**Q: Et si désync ?**
R: Le système bascule automatiquement en streaming. Tu verras un overlay "Switching to streaming..."

**Q: Comment revenir en mode streaming ?**
R: Change `EmulationMode.DUAL` → `EmulationMode.STREAMING` dans P2PRoom.svelte ligne 19.

---

**Bon test ! 🎮**

*Si tu rencontres des problèmes, partage les logs console et je t'aide.*
