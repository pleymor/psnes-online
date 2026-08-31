##
## Development image.
##
## Bun is the base, not a binary copied into a Node one: the dev server is
## `bun --watch src/index.ts`, and nothing here runs under Node. Note that this
## image therefore has no `npm` -- docker-compose.yml drives it with `bun run`.
##
FROM oven/bun:1.3.14-debian

WORKDIR /app

# Aucune dependance native ici non plus, et ce dev.Dockerfile n'utilise pas
# gosu : il lance `bun run dev` directement. Rien a installer.

# Copy package files and install dependencies (cached until package.json changes).
# The full workspace shape (root + both member manifests) is required: bun.lock
# describes a 3-workspace root, and Bun discards/re-resolves against any context
# that doesn't match that shape, silently floating every version.
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY bun.lock ./

RUN bun install --frozen-lockfile --filter=./backend

# Source code will be mounted as a volume, so we don't copy it here

CMD ["bun", "run", "dev"]
