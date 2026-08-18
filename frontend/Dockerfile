# Build stage
FROM node:20-alpine AS builder

COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
COPY --from=oven/bun:1-alpine /usr/local/bin/bunx /usr/local/bin/bunx

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
