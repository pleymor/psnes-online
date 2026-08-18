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
RUN bun install --filter=./backend

# Copy prisma schema and generate client (cached until schema changes)
COPY backend/prisma ./prisma
RUN npx prisma generate

# Source code will be mounted as a volume, so we don't copy it here

CMD ["npm", "run", "dev"]
