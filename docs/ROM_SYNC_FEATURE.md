# 🔐 ROM Synchronization Feature - Mode Dual

## Problématique

En mode dual émulation, les deux joueurs exécutent l'émulateur localement. Pour garantir un comportement déterministe et éviter les désynchronisations, **les deux joueurs doivent exécuter exactement la même ROM**.

## Solution Implémentée

### Architecture

```
┌─────────────────┐                    ┌─────────────────┐
│   HOST          │                    │   GUEST         │
│                 │                    │                 │
│ 1. Load ROM     │                    │ 1. Wait...      │
│    from server  │                    │                 │
│                 │                    │                 │
│ 2. Compute      │                    │                 │
│    SHA-256 hash │                    │                 │
│                 │                    │                 │
│ 3. Send ROM ────┼──► P2P (chunks) ──►│ 2. Receive ROM  │
│    in 16KB      │     16KB chunks    │    chunks       │
│    chunks       │                    │                 │
│                 │                    │ 3. Assemble ROM │
│                 │                    │                 │
│                 │                    │ 4. Verify hash  │
│                 │◄───── ACK ─────────│                 │
│                 │                    │                 │
│ 4. Both start   │                    │ 5. Both start   │
│    emulation    │                    │    emulation    │
└─────────────────┘                    └─────────────────┘
```

### Flux Détaillé

#### 1. Host (Chargement Initial)
```typescript
// Host charge la ROM depuis le serveur
romData = await fetch('/api/games/${gameId}/download');

// Calcul du hash SHA-256
romHash = await computeROMHash(romData);
```

#### 2. Guest (Attente)
```typescript
// En mode dual, le guest N'APPELLE PAS le serveur
// Il attend de recevoir la ROM du host
logger.info('⏳ DUAL mode: Guest waiting to receive ROM from host...');
```

#### 3. Host (Envoi par Chunks)
```typescript
// Découpage en chunks de 16 KB
const CHUNK_SIZE = 16384;
const totalChunks = Math.ceil(romData.byteLength / CHUNK_SIZE);

for (let i = 0; i < totalChunks; i++) {
  const chunk = romArray.slice(start, end);

  p2pManager.sendData({
    type: 'rom_data',
    chunkIndex: i,
    totalChunks,
    data: Array.from(chunk),
    hash: i === totalChunks - 1 ? romHash : null // Hash dans le dernier chunk
  });

  await delay(50ms); // Pour éviter de saturer le canal
}
```

**Pourquoi par chunks ?**
- Les data channels WebRTC ont une taille maximale (~256 KB)
- Évite de bloquer le canal pendant l'envoi
- Permet un suivi de progression

#### 4. Guest (Réception & Assemblage)
```typescript
// Stocker chaque chunk
romChunks.set(chunkIndex, new Uint8Array(chunkData));

// Quand tous reçus, assembler
if (romChunks.size === totalChunks) {
  const assembledROM = assemblage_des_chunks();

  // Vérifier le hash
  const receivedHash = await computeROMHash(assembledROM);
  if (receivedHash !== hash) {
    error = 'ROM verification failed - hash mismatch';
    return;
  }

  // ROM prête !
  romData = assembledROM.buffer;

  // Envoyer ACK au host
  p2pManager.sendData({ type: 'rom_ack' });
}
```

#### 5. Démarrage Synchronisé
Une fois que le guest a la ROM et que le hash est vérifié, les deux émulateurs démarrent avec **exactement la même ROM**.

---

## Avantages

### ✅ Garantie de Déterminisme
- Hash SHA-256 garantit que c'est **exactement la même ROM**
- Impossible d'avoir des desyncs dues à des ROMs différentes
- Pas besoin de vérifier manuellement que les ROMs sont identiques

### ✅ Simplicité pour l'Utilisateur
- Le guest n'a rien à faire
- Pas besoin de télécharger la ROM séparément
- Tout est automatique

### ✅ Sécurité
- Pas besoin d'exposer les ROMs publiquement
- Le serveur envoie la ROM seulement au host authentifié
- Le guest reçoit la ROM via P2P sécurisé

### ✅ Performance
- Chunks de 16 KB : rapide et ne sature pas le canal
- Total ~512 KB pour une ROM SNES moyenne = ~32 chunks = ~2 secondes
- Délai de 50ms entre chunks = négligeable

---

## Gestion d'Erreurs

### Erreur 1 : Hash Mismatch
```
⚠️ ROM hash mismatch! Expected: abc123, Got: def456
```

**Cause** : Corruption durant le transfert (très rare avec WebRTC)

**Action** : Afficher erreur, ne pas démarrer l'émulateur

### Erreur 2 : Chunk Manquant
```
Error: Missing ROM chunk 15
```

**Cause** : Perte de paquet P2P (très rare)

**Action** : Afficher erreur, demander reconnexion

### Erreur 3 : Timeout
Si aucun chunk reçu après 30 secondes → timeout

**Action** : Fallback vers mode streaming

---

## Logs Attendus

### Console Host
```
📥 Loading ROM... game-123
✅ ROM loaded (524288 bytes)
🔐 ROM hash: a1b2c3d4e5f6...
✅ P2P connected!
📤 Sending ROM to guest...
✅ ROM sent to guest (32 chunks, 524288 bytes)
✅ Guest confirmed ROM received
```

### Console Guest
```
⏳ DUAL mode: Guest waiting to receive ROM from host...
✅ P2P connected!
📥 Received ROM chunk 1/32
📥 Received ROM chunk 2/32
...
📥 Received ROM chunk 32/32
✅ All ROM chunks received, assembling...
✅ ROM hash verified: a1b2c3d4e5f6...
✅ ROM ready (524288 bytes)
```

---

## Métriques

### Taille Typique ROM SNES
- **Petite** : 256 KB = 16 chunks = ~1 seconde
- **Moyenne** : 512 KB = 32 chunks = ~2 secondes
- **Grande** : 1-2 MB = 64-128 chunks = ~4-7 secondes

### Bande Passante
- 16 KB chunk × 20 chunks/sec = ~320 KB/s durant le transfert
- Pic temporaire, puis retour à <1 KB/s en mode dual

---

## Comparaison Modes

### Mode STREAMING (Actuel - Sans Changement)
```
Host:  Load ROM from server → Start emulator → Stream video
Guest: Receive video stream (pas besoin de ROM)
```

### Mode DUAL (Nouveau)
```
Host:  Load ROM from server → Send ROM to guest → Both start emulators
Guest: Receive ROM from host → Verify hash → Both start emulators
```

---

## Configuration

Aucune configuration utilisateur nécessaire !

Le système détecte automatiquement :
- Si mode DUAL → Guest attend la ROM du host
- Si mode STREAMING → Guest reçoit juste le stream vidéo

---

## Limitations & Futures Améliorations

### Limitations Actuelles
- ROM envoyée en entier (pas de delta/patch si ROM similaire)
- Pas de reprise en cas d'interruption (recommence depuis le début)
- Pas de compression (chunks envoyés bruts)

### Améliorations Futures Possibles
- **Compression** : Compresser les chunks (gzip) → réduction ~30-50%
- **Cache** : Si même ROM déjà reçue récemment, ne pas re-télécharger
- **Delta encoding** : Si ROMs très similaires (versions différentes)
- **Progression UI** : Barre de progression pour l'utilisateur

---

## Sécurité

### Hash SHA-256
- Impossible de forger une ROM avec le même hash
- Garantit l'intégrité des données
- Détecte toute corruption

### P2P Sécurisé
- WebRTC utilise DTLS (équivalent TLS)
- Données chiffrées en transit
- Pas d'interception possible

---

## Impact sur le Code

### Fichiers Modifiés
- `frontend/src/lib/components/P2PRoom.svelte` (+~120 lignes)

### Nouvelles Fonctions
- `computeROMHash()` : Calcul SHA-256
- `sendROMToGuest()` : Envoi par chunks
- `handleROMReceived()` : Réception et assemblage

### Nouveaux Messages P2P
- `rom_data` : Chunk de ROM
- `rom_ack` : Acknowledgement guest

---

## Tests

### Test 1 : Transfert Basique
- [ ] Host charge ROM
- [ ] Guest reçoit tous les chunks
- [ ] Hash vérifié
- [ ] Émulateurs démarrent

### Test 2 : Grande ROM (2 MB)
- [ ] Transfert complet en <10 secondes
- [ ] Pas de saturation du canal
- [ ] Hash OK

### Test 3 : Hash Mismatch (Test Négatif)
- [ ] Modifier un chunk manuellement
- [ ] Vérifier erreur affichée
- [ ] Émulateur ne démarre pas

---

**Version** : 1.0.0
**Date** : 2025-11-24
**Impact** : Critique pour mode dual, aucun impact sur mode streaming
