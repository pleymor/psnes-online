# Guide des tests E2E

Ce document explique comment exécuter et écrire des tests end-to-end (E2E) pour le backend PSNES.

## Configuration

### Prérequis

- Docker et Docker Compose installés
- Les tests s'exécutent dans des conteneurs Docker pour garantir un environnement cohérent

## Exécution des tests

### Lancer tous les tests
```bash
cd backend
./test.sh
```

### Lancer un fichier de test spécifique
```bash
./test.sh tests/e2e/auth.e2e.test.ts
```

### Lancer les tests avec options Jest
```bash
./test.sh -- --verbose
./test.sh -- --coverage
./test.sh tests/e2e/rooms.e2e.test.ts -- --watch
```

Le script `test.sh` :
1. Construit une image Docker de test avec toutes les dépendances
2. Démarre Redis de test sur le port 6380
3. Initialise la base de données SQLite de test
4. Exécute les tests dans un conteneur isolé
5. Nettoie automatiquement les ressources

## Structure des tests

```
backend/
  tests/
    setup.ts                      # Configuration globale Jest
    helpers.ts                    # Utilitaires de test réutilisables
    e2e/
      auth.e2e.test.ts           # Tests d'authentification
      rooms.e2e.test.ts          # Tests de gestion des rooms
      friends.e2e.test.ts        # Tests du système d'amitié
      websocket.e2e.test.ts      # Tests WebSocket en temps réel
    fixtures/                     # Données de test (si nécessaire)
```

## Utilitaires disponibles

Le fichier `tests/helpers.ts` fournit plusieurs utilitaires :

### `createTestServer()`
Crée une instance complète du serveur pour les tests.

```typescript
const server = await createTestServer();
// ... exécuter les tests
await closeTestServer(server);
```

### `createTestUser()`
Crée un utilisateur de test dans la base de données.

```typescript
const user = await createTestUser({
  email: 'test@example.com',
  displayName: 'Test User',
  googleId: 'google-id-123',
});
```

### `createAuthenticatedSession()`
Crée une session authentifiée pour les requêtes HTTP.

```typescript
const sessionId = await createAuthenticatedSession(server, user);

// Utiliser dans les requêtes
await request(server.app)
  .get('/api/friends')
  .set('Cookie', [`connect.sid=s:${sessionId}`]);
```

### `createAuthenticatedSocketClient()`
Crée un client WebSocket authentifié.

```typescript
const client = await createAuthenticatedSocketClient(server, user);

client.emit('room:create', { gameId: 'test', gameTitle: 'Test Game' });

const room = await waitForSocketEvent(client, 'room:created');

client.disconnect();
```

### `waitForSocketEvent()`
Attend un événement WebSocket spécifique (avec timeout).

```typescript
const data = await waitForSocketEvent(client, 'room:updated', 5000);
```

### `cleanupDatabase()`
Nettoie la base de données entre les tests.

```typescript
beforeEach(async () => {
  await cleanupDatabase();
});
```

### `createFriendship()`
Crée une relation d'amitié acceptée entre deux utilisateurs.

```typescript
await createFriendship(user1.id, user2.id);
```

## Écrire un nouveau test E2E

### Exemple de structure de test

```typescript
import {
  createTestServer,
  closeTestServer,
  createTestUser,
  cleanupDatabase,
  TestServer,
  TestUser,
} from '../helpers.js';

describe('Mon nouveau test E2E', () => {
  let server: TestServer;
  let user: TestUser;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupDatabase();

    user = await createTestUser({
      email: 'user@test.com',
      displayName: 'Test User',
      googleId: 'google-id-1',
    });
  });

  it('should do something', async () => {
    // Votre test ici
  });
});
```

## Tests de cas d'usage couverts

### 1. Authentification (`auth.e2e.test.ts`)
- ✅ Récupération du mode d'authentification
- ✅ Vérification de l'utilisateur authentifié
- ✅ Déconnexion
- ✅ Connexion en mode dev

### 2. Gestion des rooms (`rooms.e2e.test.ts`)
- ✅ Création de room
- ✅ Création de room avec autoStart
- ✅ Rejoindre une room
- ✅ Limites de capacité (2 joueurs max)
- ✅ Sélection de ports de manette
- ✅ Échange de ports
- ✅ Déselection de ports
- ✅ Quitter une room
- ✅ Destruction de room
- ✅ Transfert d'hôte

### 3. Système d'amitié (`friends.e2e.test.ts`)
- ✅ Liste d'amis
- ✅ Requêtes d'amitié en attente
- ✅ Recherche d'utilisateurs
- ✅ Envoi de requête d'amitié
- ✅ Acceptation de requête
- ✅ Rejet de requête
- ✅ Suppression d'amitié
- ✅ Notifications WebSocket

### 4. Communication WebSocket (`websocket.e2e.test.ts`)
- ✅ Connexion authentifiée
- ✅ Notifications de statut des amis (online/offline)
- ✅ Notifications de création de room aux amis
- ✅ Notifications de changement de statut de room
- ✅ Diffusion des mises à jour de room
- ✅ Flux multijoueur complet

## Bonnes pratiques

1. **Isolation des tests** : Chaque test doit être indépendant. Utilisez `beforeEach` pour nettoyer la base de données.

2. **Nettoyage** : Toujours déconnecter les clients WebSocket à la fin des tests.

3. **Timeouts** : Les tests ont un timeout global de 30 secondes (configuré dans `setup.ts`).

4. **Mocking** : Le logger est mocké pour éviter de polluer la sortie des tests.

5. **Données de test** : Utilisez des données de test distinctes et prévisibles.

## Débogage

### Voir les logs des tests
Commentez le mock du logger dans `tests/setup.ts` :

```typescript
// jest.mock('../src/utils/logger.js', () => ({ ... }));
```

### Exécuter un seul test
```bash
npm test -- -t "nom du test"
```

### Mode debug de Node.js
```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

## Dépannage

### Erreur "Redis connection refused"
Assurez-vous que Redis de test est démarré :
```bash
docker-compose -f docker-compose.test.yml up -d
```

### Erreur "Cannot find module"
Régénérez le client Prisma :
```bash
cd backend
npm run db:generate
```

### Tests qui timeout
- Vérifiez que Redis de test est accessible
- Augmentez le timeout dans la configuration Jest
- Vérifiez que les clients WebSocket sont correctement déconnectés

## CI/CD

Pour intégrer les tests dans un pipeline CI/CD :

```yaml
# Exemple GitHub Actions
- name: Start test Redis
  run: docker-compose -f docker-compose.test.yml up -d

- name: Run tests
  run: |
    cd backend
    npm test

- name: Stop test Redis
  run: docker-compose -f docker-compose.test.yml down
```
