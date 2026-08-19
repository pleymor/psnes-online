##
## Production dependencies installation stage
##
FROM node:20 AS prod-deps

COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
ENV NODE_ENV=build

COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY bun.lock ./
COPY scripts ./scripts

# Bun does not run a workspace member's own lifecycle scripts, and does not
# run the root project's postinstall once --filter narrows the install to
# one workspace -- so better-sqlite3's native binding (see
# scripts/fetch-better-sqlite3-prebuild.sh) has to be built explicitly here,
# it will not happen on its own.
RUN bun install --production --frozen-lockfile --filter=./backend \
    && sh scripts/fetch-better-sqlite3-prebuild.sh


##
## Build stage
## Prisma generation and TypeScript compilation
##
FROM prod-deps AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libpixman-1-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev

# Copy package files and install ALL dependencies (needed for build)
RUN bun install --frozen-lockfile --filter=./backend \
    && sh scripts/fetch-better-sqlite3-prebuild.sh

# Copy source code and prisma schema
COPY backend/prisma ./backend/prisma

# Generate Prisma client
RUN npx prisma generate --schema=backend/prisma/schema.prisma

COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/tsconfig.json

# Build TypeScript to JavaScript
RUN bun run --filter=./backend build


##
## Runtime stage
##
FROM node:20-trixie-slim AS production

ENV NODE_ENV=production
WORKDIR /app

# Install only runtime dependencies for canvas and gosu for privilege dropping
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libpixman-1-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy production dependencies from prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy Prisma schema and runtime dependencies from builder stage
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# The migration entrypoint (dist/db/migrate-cli.js) needs these SQL files at
# runtime; it does not need the two Prisma copies above, but the app code
# started by CMD (dist/index.js) still does -- backend and db-migration share
# this production stage, so those Prisma lines stay load-bearing until the
# app is off Prisma (Task 16). Do not remove them to "clean up" here.
COPY backend/migrations ./migrations

# Copy built application from builder
COPY --from=builder /app/backend/dist ./dist

# Create directories for runtime data (will be mounted as volumes)
RUN mkdir -p roms saves data avatars metadata && \
    chown -R node:node /app

# Copy metadata file into image (not in /data to avoid volume shadowing)
COPY backend/data/snes-metadata.json ./metadata/

# Copy and setup entrypoint script for permission handling
COPY backend/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
