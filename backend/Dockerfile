FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules and runtime libraries
RUN apk add --no-cache python3 make g++ \
    pkgconf cairo-dev pango-dev pixman-dev \
    libjpeg-turbo-dev giflib-dev librsvg-dev \
    openssl-dev openssl

COPY package*.json ./
RUN npm install

COPY . .

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "dev"]
