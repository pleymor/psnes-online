# ⚡ Dual Mode - Quick Start Guide

## 🚀 Tester le Mode Dual

#### Option A : Mode Manuel (Recommandé pour Tests)

Dans `frontend/src/lib/components/P2PRoom.svelte`, ligne 18-22 :

```typescript
export let roomSettings: RoomSettings = {
  emulationMode: EmulationMode.DUAL,  // ← Changer à DUAL
  syncCheckInterval: 60,
  fallbackOnDesync: true
};
```

#### Option B : Via l'Interface (Quand UI sera intégrée)

1. Créer une room
2. Ouvrir les paramètres
3. Sélectionner "⚡ Dual émulation"

---

## 🧪 Test Rapide (LAN)

### Setup
- **Host** : PC principal
- **Guest** : Second PC ou VM sur le même réseau

### Étapes

1. **Host** : Créer une room
2. **Guest** : Rejoindre la room
3. **Vérifier les logs** :

```
Console Host :
🎮 Initializing emulator in DUAL mode (HOST)
✅ Started input sending (60 FPS)
✅ Started sync check interval (every 1000ms)
📤 Sent sync checksum at frame 60: abc123

Console Guest :
🎮 Initializing emulator in DUAL mode (GUEST)
✅ Started input sending (60 FPS)
✅ Sync OK at frame 60
```

4. **Jouer** et observer :
   - Latence guest : ~2-5ms (vs ~50ms en streaming)
   - Badge "⚡ Dual Mode - ✅ Synced" en bas
   - Pas de désync pendant 1-2 minutes

---

## 📊 Vérifier Que Ça Marche

### Indicateurs de Succès

✅ **Console logs** :
- `Initializing emulator in DUAL mode`
- `Started input sending (60 FPS)`
- `Sync OK at frame X`

✅ **UI** :
- Badge "⚡ Dual Mode" visible en bas
- Status "✅ Synced" (vert)

✅ **Latence** :
- Guest < 10ms sur LAN
- Guest < 20ms sur connexion locale

✅ **Bande passante** :
- Network tab : ~2 KB/s au lieu de 2-5 Mbps

### Indicateurs de Problème

❌ **Console errors** :
- `Failed to compute checksum`
- `Cannot init SyncManager`

❌ **UI** :
- Badge "⚠️ Desynced" (orange)
- Overlay de transition fréquent

❌ **Latence** :
- Guest > 50ms (pas de gain)

---

## 🐛 Troubleshooting Rapide

### Problème : Désynchronisation immédiate

**Causes** :
- ROMs différentes entre host et guest
- Connexion réseau instable

**Solutions** :
- Vérifier que les deux joueurs ont la **même ROM**
- Augmenter `syncCheckInterval` à 120 frames
- Activer logs détaillés :

```typescript
import { DEBUG } from '$lib/config/debug';
// Dans ClientEmulator ou P2PRoom
if (DEBUG()) {
  console.log('Debug info...');
}
```

### Problème : CPU à 100% sur guest

**Causes** :
- Machine trop faible
- Autres programmes actifs

**Solutions** :
- Fermer programmes inutiles
- Utiliser mode streaming à la place
- Vérifier accélération matérielle navigateur

---

## 📈 Mesurer les Performances

### Latence

Ouvrir DevTools (F12) → Console :

```javascript
// Latence affichée dans l'indicateur en bas à gauche
// Ou dans les logs :
"Input latency: 2.3ms"
"Total latency: 5.1ms"
```

### FPS

```javascript
// Console logs toutes les 2 secondes :
"📊 Emulator FPS: 60"
```

### Sync Rate

```javascript
// Après quelques minutes :
"📊 Performance Metrics: { syncRate: 0.98, desyncCount: 2 }"
```

### Bande Passante

DevTools → Network tab :
- **Streaming** : ~300-600 KB/s constant
- **Dual** : ~0.2-2 KB/s constant

---

## 🎮 Jeux Recommandés pour Tests

### Excellents pour Tests (Frame-Perfect)
1. **Street Fighter II Turbo**
2. **F-Zero**
3. **Mega Man X**
4. **Super Mario Kart**

### Bons pour Tests (Coopératifs)
1. **Super Mario World**
2. **Kirby Super Star**
3. **Contra III**

### Éviter pour Tests Initiaux (RPG Lents)
1. Chrono Trigger
2. Final Fantasy VI
3. Secret of Mana

---

## 🔍 Logs Utiles pour Debug

### Activer Logs Détaillés

Dans browser console :
```javascript
localStorage.setItem('debug', 'true');
location.reload();
```

### Logs à Surveiller

**Host** :
```
✅ SyncManager initialized (check every 60 frames)
✅ Started sync check interval (every 1000ms)
📤 Sent sync checksum at frame 60: abc123def456
```

**Guest** :
```
✅ Sync OK at frame 60
⚠️ DESYNC detected at frame 120
🔄 Falling back to streaming mode...
```

### Désactiver Logs

```javascript
localStorage.removeItem('debug');
location.reload();
```

---

## 📋 Checklist Avant Tests

- [ ] Deux machines sur le même réseau (LAN recommandé)
- [ ] Même ROM chargée des deux côtés
- [ ] DevTools ouvert pour voir les logs
- [ ] Network tab ouvert pour mesurer bande passante

---

## 🎯 Objectifs de Test

### Test 1 : Fonctionnement Basique (5 min)
- [ ] Mode dual démarre correctement
- [ ] Les deux émulateurs s'initialisent
- [ ] Inputs échangés à 60 FPS
- [ ] Sync OK pendant 1 minute

### Test 2 : Performance (10 min)
- [ ] Latence guest < 10ms sur LAN
- [ ] FPS stable à 60
- [ ] Bande passante < 10 KB/s
- [ ] CPU guest < 80%

### Test 3 : Stabilité (30 min)
- [ ] Jouer 30 minutes sans désync
- [ ] Tester différents jeux
- [ ] Vérifier sync rate > 95%

### Test 4 : Fallback (5 min)
- [ ] Forcer désync (modifier ROM)
- [ ] Vérifier transition vers streaming
- [ ] Vérifier notification affichée
- [ ] Continuer à jouer en streaming

---

## 📞 Support & Feedback

### Reporter un Bug

1. Capturer les logs console (Host + Guest)
2. Noter le jeu testé
3. Noter la configuration réseau (LAN/WAN/distance)
4. Créer une issue GitHub avec :
   - Titre : `[Dual Mode] Description du bug`
   - Logs
   - Étapes de reproduction

### Partager des Métriques

Si le mode dual fonctionne bien, partager :
- Latence mesurée (streaming vs dual)
- Distance entre joueurs
- Jeu testé
- Taux de désync (si applicable)

---

## 🚀 Next Steps

Une fois les tests concluants :

1. **Écrire tests unitaires** (Phase 5)
2. **Intégrer EmulationSettings UI** dans l'interface
3. **Tester sur différents jeux**
4. **Mesurer taux de désync réel**
5. **Rollout beta à 10% des utilisateurs**

---

**Bon test ! 🎮**

*Version: 1.0.0-beta*
*Dernière mise à jour: 2025-11-24*
