# Résumé des optimisations de latence vidéo (Session 2)

## Problème identifié
Décalage visuel de **~500ms** entre host et guest, malgré des latences réseau affichées très faibles (< 10ms).

## Causes identifiées

1. **Jitter buffer WebRTC** : 200-400ms de buffer par défaut
2. **Buffering vidéo navigateur** : Accumulation de frames dans le buffer HTML5
3. **Mesure de latence incorrecte** : Utilisation de `Date.now()` au lieu de `performance.now()`
4. **Délai initial de 3s** : Attente arbitraire avant capture du canvas
5. **Dérive progressive** : Pas de correction automatique du lag vidéo

---

## Solutions implémentées

### ✅ Solution 1 : Réduction du jitter buffer WebRTC
**Fichier** : `frontend/src/lib/webrtc/p2p-manager.ts`

#### Modifications RTCPeerConnection (lignes 72-81)
```typescript
config: {
  // CRITICAL: Reduce buffering for ultra-low latency (LAN optimized)
  rtcpMuxPolicy: 'require',           // Multiplex RTP and RTCP
  bundlePolicy: 'max-bundle',         // Bundle all media streams
  audioJitterBufferMaxPackets: 1,     // Keep only 1 packet in buffer
  audioJitterBufferFastAccelerate: true, // Quickly adapt to network changes
}
```

**Gain estimé** : -150 à -250ms

#### Optimisation SDP H.264 (lignes 314-334)
Ajout de paramètres bas niveau dans le codec H.264 :
- `x-google-min-bitrate=2000`
- `x-google-start-bitrate=2500`
- `level-asymmetry-allowed=1`

**Gain estimé** : -50 à -100ms

#### Optimisation côté récepteur (lignes 414-477)
Nouvelle méthode `optimizeVideoReceiving()` :
```typescript
videoReceiver.playoutDelayHint = 0.0;  // Request 0ms playout delay
videoReceiver.jitterBufferTarget = 0;  // Minimal jitter buffer
```

**Gain estimé** : -100 à -200ms

---

### ✅ Solution 2 : Optimisation de l'élément `<video>`
**Fichier** : `frontend/src/routes/room/[id]/+page.svelte`

#### Désactivation de tous les buffers (lignes 93-138)
```typescript
guestVideoElement.preload = 'none';
guestVideoElement.disablePictureInPicture = true;
guestVideoElement.disableRemotePlayback = true;
guestVideoElement.playsInline = true;
```

**Gain estimé** : -50 à -150ms

#### Flush initial du buffer (lignes 145-171)
Après 500ms, skip au bord "live" du stream pour éviter le lag initial :
```typescript
if (lag > 0.1) {
  guestVideoElement.currentTime = bufferedEnd - 0.05;
}
```

**Gain estimé** : Élimine le lag initial (jusqu'à -500ms au premier lancement)

#### Monitoring continu (lignes 173-193)
Toutes les 2 secondes, détecte et corrige toute dérive > 200ms :
```typescript
if (lag > 0.2) {
  guestVideoElement.currentTime = bufferedEnd - 0.05;
}
```

**Gain estimé** : Prévient l'accumulation de lag au fil du temps

---

### ✅ Solution 3 : Mesure précise de latence
**Fichier** : `frontend/src/routes/room/[id]/+page.svelte`

#### Utilisation de `performance.now()` (lignes 247-248, 288)
```typescript
// AVANT (incorrect)
const now = Date.now();  // Précision ±1-15ms

// APRÈS (correct)
const now = performance.now();  // Précision ±0.001ms
```

#### Augmentation fréquence (ligne 291)
```typescript
// AVANT : Toutes les 250ms
setInterval(() => { ... }, 250);

// APRÈS : Toutes les 100ms (meilleure précision)
setInterval(() => { ... }, 100);
```

**Gain** : Affichage précis de la vraie latence

---

### ✅ Solution 4 : Suppression du délai de 3s
**Fichier** : `frontend/src/routes/room/[id]/+page.svelte`

#### Attente adaptative (lignes 314-329)
```typescript
// AVANT : Délai fixe de 3000ms
await new Promise(resolve => setTimeout(resolve, 3000));

// APRÈS : Polling jusqu'à ce que le canvas soit prêt
while ((!canvas || canvas.width === 0 || canvas.height === 0) && attempts < maxAttempts) {
  await new Promise(resolve => setTimeout(resolve, 50));
  canvas = emulatorComponent?.getCanvas();
  attempts++;
}
```

**Gain** : Démarrage plus rapide (généralement < 500ms au lieu de 3000ms)

---

## Résultats attendus

### Avant optimisations
- **Latence affichée** : 0.20ms (incorrecte)
- **Latence visuelle réelle** : ~500ms
- **Lag au premier lancement** : Très important

### Après optimisations
- **Latence affichée** : Valeur précise (attendue : 20-80ms)
- **Latence visuelle réelle** : ~50-150ms (réduction de 70-85%)
- **Lag au premier lancement** : Minimisé (< 100ms)

---

## Comment tester

1. **Activer le mode DEBUG** :
   ```javascript
   // Dans la console navigateur (guest ET host)
   window.DEBUG = true;
   localStorage.setItem('DEBUG', 'true');
   ```

2. **Logs à surveiller côté Guest** :
   ```
   ✅ Video element optimized for ultra-low latency
   🎬 Optimizing video receiver for minimal latency...
   ✅ Set playoutDelayHint to 0ms (minimal buffering)
   ✅ Set jitterBufferTarget to 0ms
   📹 [GUEST] Video latency: XX.XXms
   ```

3. **Logs à surveiller côté Host** :
   ```
   🎮 Canvas ready after XXXms (X attempts)
   ✅ Added low-latency params to H.264 fmtp line
   📹 Started sending frame timestamps (100ms interval)
   ```

4. **Indicateur de latence** :
   - Visible en bas à gauche côté guest
   - Devrait afficher des valeurs réalistes (20-80ms en LAN)

5. **Test visuel** :
   - Comparer côte à côte l'écran du host et du guest
   - Décalage devrait être quasi imperceptible (< 100ms)

---

## Fichiers modifiés

1. **frontend/src/lib/webrtc/p2p-manager.ts**
   - Configuration RTCPeerConnection
   - Optimisation SDP H.264
   - Nouvelle méthode `optimizeVideoReceiving()`

2. **frontend/src/routes/room/[id]/+page.svelte**
   - Optimisation élément `<video>`
   - Flush buffer initial
   - Monitoring continu
   - Mesure précise avec `performance.now()`
   - Attente adaptative du canvas

---

## Notes techniques

### Compatibilité navigateurs
- **Chrome/Edge** : Support complet (playoutDelayHint, jitterBufferTarget)
- **Firefox** : Support partiel (certaines optimisations ignorées)
- **Safari** : Support minimal (optimisations de base uniquement)

### Limites physiques
- **Latence minimale théorique** : ~33ms (2 frames @ 60fps : capture + decode)
- **Latence réseau LAN** : ~1-5ms (négligeable)
- **Latence encodage/décodage H.264** : ~10-20ms (avec GPU)

**Total théorique minimum** : ~45-60ms

### Optimisations futures possibles
1. Réduire la résolution canvas (512x448 → 256x224)
2. Utiliser AV1 codec (si supporté par GPU)
3. Implémenter WebCodecs API pour contrôle total de l'encodage
4. Utiliser WebTransport au lieu de WebRTC (Chrome 97+)

---

## Troubleshooting

### La latence affichée est toujours < 1ms
→ Le backend n'a pas redémarré, `performance.now()` n'est pas encore utilisé

### Le lag initial persiste
→ Vérifier que le monitoring buffer est actif (chercher "Auto-correcting" dans les logs)

### Latence > 200ms malgré optimisations
→ Vérifier la connexion P2P (devrait être "Direct P2P" ou "P2P (STUN)")
→ Si "Relayed", la connexion passe par un serveur TURN (ajouter TURN server local)

### Video saccadée
→ L'optimisation est peut-être trop agressive
→ Augmenter le seuil de correction de 0.2s à 0.3s (ligne 184)
