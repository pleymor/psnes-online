##
## Production dependencies installation stage
##
FROM node:20 AS prod-deps

WORKDIR /app
ENV NODE_ENV=build

COPY backend/package*.json ./
COPY package-lock.json ./

RUN npm ci --omit=dev --prefer-offline


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
RUN npm ci --prefer-offline

# Copy source code and prisma schema
COPY backend/prisma ./prisma

# Generate Prisma client
RUN npx prisma generate

COPY backend/src ./src
COPY backend/tsconfig.json ./

# Build TypeScript to JavaScript
RUN npm run build


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
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy built application from builder
COPY --from=builder /app/dist ./dist

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
