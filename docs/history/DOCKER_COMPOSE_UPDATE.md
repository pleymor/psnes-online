# Docker Compose Configuration Update

> **Superseded.** This records a one-off fix made on 2025-11-24, back when the project still ran on Prisma and had a Dual/Streaming emulation toggle. The build-context and Dockerfile shape it describes has since changed further, and step 3 of "Testing the Changes" below (`docker-compose exec backend npx prisma migrate deploy`) no longer works — Prisma is gone; see `docker compose run --rm db-migration` instead. Kept as a historical record, not as instructions to follow.

## Date: 2025-11-24

## Changes Made

### 1. Fixed Docker Build Context

**Problem**: Docker build was failing with "file not found" errors because the build context was set to `./backend` but Dockerfiles referenced paths with `backend/` prefix.

**Solution**: Changed build context to monorepo root (`.`) for both services:

#### Backend Service
```yaml
backend:
  build:
    context: .                      # Changed from ./backend
    dockerfile: backend/dev.Dockerfile
```

#### DB Migration Service
```yaml
db-migration:
  build:
    context: .                      # Changed from ./backend
    dockerfile: backend/Dockerfile
    target: production
```

### 3. Updated Dockerfiles

**backend/dev.Dockerfile**: Updated COPY commands to include `backend/` prefix:
```dockerfile
COPY backend/package*.json ./
COPY backend/prisma ./prisma
```

### 4. Fixed File Permissions

Fixed permissions on `backend/docker-entrypoint.sh`:
```bash
chmod 644 backend/docker-entrypoint.sh
```

## Verification

All services are now running correctly:

```bash
$ docker-compose ps
NAME               IMAGE            STATUS
psnes-backend-1    psnes-backend    Up
psnes-frontend-1   node:20-alpine   Up
psnes-redis-1      redis:7-alpine   Up
```

Environment variables confirmed in container:
```bash
$ docker exec psnes-frontend-1 env | grep VITE
VITE_API_URL=http://localhost:3000
```

## Testing the Changes

To apply these changes:

1. Stop current services:
   ```bash
   docker-compose down
   ```

2. Rebuild and start services:
   ```bash
   docker-compose up -d --build
   ```

3. Run migrations if needed:
   ```bash
   docker-compose exec backend npx prisma migrate deploy
   ```

4. Access the application:
   - Frontend: http://localhost:5173
   - Backend: http://localhost:3000

5. Follow the testing guide in `TEST_DUAL_MODE.md`

## Impact

- Dual emulation mode is available via the toggle in the room lobby
- Default mode is streaming (stable), dual mode is marked as Alpha
