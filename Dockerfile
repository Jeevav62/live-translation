# Production image for the live-translation server.
FROM node:20-alpine

WORKDIR /app

# Install production deps first for better build-layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# SARVAM_API_KEY (and optional SARVAM_*_RATE_* vars) are provided at runtime
# via the platform's environment settings — never baked into the image.
CMD ["node", "src/server.js"]
