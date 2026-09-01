FROM node:20

# Épinglé pour la même raison que frontend/Dockerfile : `oven/bun:1` flotte.
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy package files and install dependencies (cached until package.json changes).
# The full workspace shape (root + both member manifests) is required: bun.lock
# describes a 3-workspace root, and Bun discards/re-resolves against any context
# that doesn't match that shape, silently floating every version.
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY bun.lock ./
RUN bun install --frozen-lockfile --filter=./frontend

# Source code will be mounted as a volume, so we don't copy it here

CMD ["npm", "run", "dev", "--", "--host"]
