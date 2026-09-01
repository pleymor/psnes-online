# Build stage
FROM node:20-alpine AS builder

# Version épinglée, et non l'étiquette majeure flottante `oven/bun:1-alpine`.
#
# C'est ce genre d'étiquette qui a cassé les websockets : le backend avait été
# validé contre Bun 1.3.14 en local, et le déploiement tirait ce que `1`
# désignait — 1.4.0, où la montée en websocket échoue. Voir #10.
#
# Ce bun-ci ne sert qu'à construire le frontend, donc une régression s'y verrait
# à la construction plutôt qu'en production. La divergence entre ce qui est
# testé et ce qui tourne reste la même, et la corriger coûte une ligne.
COPY --from=oven/bun:1.3.14-alpine /usr/local/bin/bun /usr/local/bin/bun
COPY --from=oven/bun:1.3.14-alpine /usr/local/bin/bunx /usr/local/bin/bunx

WORKDIR /app

# Build arguments for Vite environment variables
ARG VITE_API_URL
ARG VITE_WS_URL

# Set as environment variables for build
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

# Copy package files and install all dependencies (including devDependencies for build)
COPY package.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY bun.lock ./
RUN bun install --frozen-lockfile --filter=./frontend

# Copy source code and configuration
COPY frontend/tsconfig.json ./frontend/tsconfig.json
COPY frontend/svelte.config.js ./frontend/svelte.config.js
COPY frontend/vite.config.ts ./frontend/vite.config.ts
COPY frontend/src ./frontend/src
COPY frontend/static ./frontend/static

# Update PWA configuration for production build
RUN sed -i "s/mode: 'development'/mode: 'production'/" frontend/vite.config.ts && \
    sed -i "s/strategies: 'injectManifest'/strategies: 'generateSW'/" frontend/vite.config.ts

# Generate SvelteKit types (fixes tsconfig warning)
RUN cd frontend && bunx svelte-kit sync

# Build the SvelteKit app
RUN bun run --filter=./frontend build

# Production stage with nginx
FROM nginx:alpine

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Remove default nginx static files
RUN rm -rf /usr/share/nginx/html/*

# Copy built static assets from builder
# SvelteKit with adapter-static creates static files in build/
COPY --from=builder /app/frontend/build /usr/share/nginx/html

# Fix file permissions for nginx to read all files
RUN chmod -R 644 /usr/share/nginx/html/* && \
    find /usr/share/nginx/html -type d -exec chmod 755 {} \;

# Create a healthcheck endpoint
RUN echo 'OK' > /usr/share/nginx/html/health.txt

EXPOSE 80

# Run nginx in foreground
CMD ["nginx", "-g", "daemon off;"]
