##
## Production dependencies installation stage
##
## Bun is the base image now, not a binary copied into a Node one: nothing in
## this image runs under Node any more. The last thing that needed a real Node
## process was better-sqlite3's prebuild fetch, and better-sqlite3 is gone (the
## backend uses bun:sqlite -- see backend/src/db/sqlite.ts).
##
# Version épinglée, et non `oven/bun:1` flottant.
#
# En 1.4.0, la montée en websocket échoue : engine.io appelle
# `ws.handleUpgrade`, qui abandonne la poignée de main, et `abortHandshake`
# plante alors dans l'implémentation de Bun sur
# `TypeError: undefined is not an object (evaluating 'message')`. Le client
# reçoit un 400 et toute connexion socket échoue - soit, sur cette
# application, le multijoueur entier.
#
# Mesuré : même code, même base, même Redis, même configuration. Connecté sous
# 1.3.14, échec sous 1.4.0. Une étiquette majeure flottante faisait diverger en
# silence ce qui est testé de ce qui est déployé.
FROM oven/bun:1.3.14-debian AS prod-deps

WORKDIR /app
ENV NODE_ENV=build

# The full workspace shape (root + both member manifests) is required: bun.lock
# describes a 3-workspace root, and Bun discards/re-resolves against any context
# that doesn't match that shape, silently floating every version.
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY bun.lock ./

RUN bun install --production --frozen-lockfile --filter=./backend


##
## Build stage
## TypeScript compilation
##
FROM prod-deps AS builder

# Aucune dependance native a compiler.
#
# python3/make/g++ existaient pour better-sqlite3, remplace par bun:sqlite ;
# les bibliotheques cairo/pango/pixman/gif/rsvg pour `canvas`, qui n'a jamais
# ete une dependance de ce depot. Verifie : bun.lock ne tire ni node-gyp ni
# prebuild-install, et les 13 dependances du backend sont toutes en JavaScript.
# Ce bloc coutait une quinzaine de minutes par construction, telechargeait
# ~200 Mo, et a fait echouer un build sur un incident reseau.

# The full install, not --production: the build needs typescript and the
# @types/* packages, @types/bun among them (bun:sqlite has no types without it,
# and tsc refuses the import).
RUN bun install --frozen-lockfile --filter=./backend

COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/tsconfig.json

# Build TypeScript to JavaScript
RUN bun run --filter=./backend build


##
## Runtime stage
##
FROM oven/bun:1.3.14-slim AS production

ENV NODE_ENV=production
WORKDIR /app

# gosu seul : docker-entrypoint.sh fait `exec gosu bun "$@"` pour abandonner
# les privileges. Les bibliotheques d'execution de cairo/pango qui
# l'accompagnaient servaient `canvas`, absent de ce depot.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy production dependencies from prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules

# The migration entrypoint (dist/db/migrate-cli.js) needs these SQL files at
# runtime.
COPY backend/migrations ./migrations

# Copy built application from builder
COPY --from=builder /app/backend/dist ./dist

# Create directories for runtime data (will be mounted as volumes).
# The unprivileged user is `bun` here, where the Node base image called it
# `node`. Both are uid/gid 1000, so an existing data volume keeps working
# untouched -- but the *name* changed, and docker-entrypoint.sh names it.
RUN mkdir -p roms saves data avatars metadata && \
    chown -R bun:bun /app

# Copy metadata file into image (not in /data to avoid volume shadowing)
COPY backend/data/snes-metadata.json ./metadata/

# Copy and setup entrypoint script for permission handling
COPY backend/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "dist/index.js"]
