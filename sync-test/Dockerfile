FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy test files
COPY . .

# Copy frontend source (needed for $lib alias)
COPY ../frontend ../frontend

# Run the test
CMD ["node", "test-sync.js", "--verbose"]
