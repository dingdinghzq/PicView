# Stage 1: Build the React client
FROM node:18 as client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Setup the Server
FROM node:18-slim
WORKDIR /app

# Install ffmpeg for video thumbnail generation
RUN apt-get update \
	&& apt-get install -y ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

# Install server dependencies
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm install --production

# Copy server source code
COPY server/ ./

# Copy built client assets from Stage 1
COPY --from=client-build /app/client/dist ../client/dist

# Create directories for mount points
RUN mkdir -p /photos /cache

# Environment variables
ENV PORT=3001
ENV PHOTOS_DIR=/photos
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "index.js"]
