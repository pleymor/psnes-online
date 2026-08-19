FROM node:20

COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install native dependencies for canvas (cached as a layer)
RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies (cached until package.json changes).
# The full workspace shape (root + both member manifests) is required: bun.lock
# describes a 3-workspace root, and Bun discards/re-resolves against any context
# that doesn't match that shape, silently floating every version.
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY bun.lock ./
COPY scripts ./scripts

# Bun does not run a workspace member's own lifecycle scripts, and does not
# run the root project's postinstall once --filter narrows the install to
# one workspace -- so better-sqlite3's native binding (see
# scripts/fetch-better-sqlite3-prebuild.sh) has to be built explicitly here.
RUN bun install --frozen-lockfile --filter=./backend \
    && sh scripts/fetch-better-sqlite3-prebuild.sh

# Source code will be mounted as a volume, so we don't copy it here

CMD ["npm", "run", "dev"]
