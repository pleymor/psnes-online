#!/bin/bash
set -e

# Install native dependencies for canvas
apt-get update
apt-get install -y \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run the development server
exec npm run dev
