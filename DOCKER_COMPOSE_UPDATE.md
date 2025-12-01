# Docker Compose Configuration Update

## Date: 2025-11-24

## Changes Made

### 1. Environment Variables Added to Frontend Service

Added dual emulation mode environment variables to `docker-compose.yml`:

```yaml
environment:
  - VITE_API_URL=http://localhost:3000
  - BACKEND_URL=http://backend:3000
  - VITE_ENABLE_DUAL_MODE=true
  - VITE_ENABLE_PERF_MONITORING=true
```

### 2. Fixed Docker Build Context

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
VITE_ENABLE_DUAL_MODE=true
VITE_ENABLE_PERF_MONITORING=true
```

## Testing the Changes

To apply these changes and test dual mode:

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

- **Dual emulation mode is now enabled by default** via Docker Compose environment variables
- No need to manually create `frontend/.env` file when running via Docker
- The application will use dual emulation mode for all P2P connections
- Performance monitoring is also enabled by default

## Rollback

To disable dual mode without rebuilding, you can:

1. Comment out the environment variables in `docker-compose.yml`
2. Restart the frontend service: `docker-compose restart frontend`

Or change the values to `false`:
```yaml
- VITE_ENABLE_DUAL_MODE=false
- VITE_ENABLE_PERF_MONITORING=false
```
