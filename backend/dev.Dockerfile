FROM node:20

WORKDIR /app

# Install native dependencies for canvas (cached as a layer)
RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies (cached until package.json changes)
COPY package*.json ./
RUN npm install

# Copy prisma schema and generate client (cached until schema changes)
COPY prisma ./prisma
RUN npx prisma generate

# Source code will be mounted as a volume, so we don't copy it here

CMD ["npm", "run", "dev"]
