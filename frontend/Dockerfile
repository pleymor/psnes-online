# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Build arguments for Vite environment variables
ARG VITE_API_URL
ARG VITE_WS_URL
ARG VITE_GOOGLE_API_KEY
ARG VITE_GOOGLE_CLIENT_ID

# Set as environment variables for build
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_GOOGLE_API_KEY=$VITE_GOOGLE_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# Copy package files and install all dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm install && \
    npm cache clean --force

# Copy source code and configuration
COPY tsconfig.json ./
COPY svelte.config.js ./
COPY vite.config.ts ./
COPY src ./src
COPY static ./static

# Update PWA configuration for production build
RUN sed -i "s/mode: 'development'/mode: 'production'/" vite.config.ts && \
    sed -i "s/strategies: 'injectManifest'/strategies: 'generateSW'/" vite.config.ts

# Generate SvelteKit types (fixes tsconfig warning)
RUN npx svelte-kit sync

# Build the SvelteKit app
RUN npm run build

# Production stage with nginx
FROM nginx:alpine

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Remove default nginx static files
RUN rm -rf /usr/share/nginx/html/*

# Copy built static assets from builder
# SvelteKit with adapter-static creates static files in build/
COPY --from=builder /app/build /usr/share/nginx/html

# Fix file permissions for nginx to read all files
RUN chmod -R 644 /usr/share/nginx/html/* && \
    find /usr/share/nginx/html -type d -exec chmod 755 {} \;

# Create a healthcheck endpoint
RUN echo 'OK' > /usr/share/nginx/html/health.txt

EXPOSE 80

# Run nginx in foreground
CMD ["nginx", "-g", "daemon off;"]
