# Stage 1: Build the React client
FROM node:22 as client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Setup the Server
FROM node:22-slim
WORKDIR /app

# Install ffmpeg and build tools for native modules (librawspeed/sharp)
RUN apt-get update \
	&& apt-get install -y \
		ffmpeg \
		python3 \
		build-essential \
		pkg-config \
		curl \
		libraw-dev \
		libjpeg-dev \
		zlib1g-dev \
		libtiff-dev \
		liblcms2-dev \
	&& rm -rf /var/lib/apt/lists/*

# Provide expected libraw.h include path for librawspeed build
RUN [ -f /usr/include/libraw.h ] || ln -s /usr/include/libraw/libraw.h /usr/include/libraw.h
# Symlink additional LibRaw headers expected at root include path
RUN set -eux; \
		for hdr in /usr/include/libraw/*; do \
			base=$(basename "$hdr"); \
			if [ ! -e "/usr/include/${base}" ]; then \
				ln -s "$hdr" "/usr/include/${base}"; \
			fi; \
		done



# Install server dependencies
COPY server/package*.json ./server/
WORKDIR /app/server
RUN set -eux; \
	npm config set script-shell /bin/bash; \
	cd node_modules/librawspeed || true; \
	cd /app/server; \
	npm install --production --ignore-scripts; \
	cd node_modules/librawspeed; \
	# Link against system libraw.so (PIC) to avoid -fPIC issues with Debian's static libraw.a
	node -e "const fs=require('fs');const p='binding.gyp';const j=JSON.parse(fs.readFileSync(p,'utf8'));const cond=j.targets[0].conditions;const linux=cond.find(c=>c[0]===\"OS=='linux'\");if(!linux)throw new Error('linux condition not found');const cfg=linux[1];cfg.libraries=['-lraw','-ljpeg','-lz','-ltiff','-llcms2'];fs.writeFileSync(p,JSON.stringify(j,null,2));"; \
	cd /app/server; \
	npm rebuild librawspeed --build-from-source || true; \
	cd node_modules/librawspeed; \
	npx --yes node-gyp rebuild; \
	# Some librawspeed versions expect libraw_addon.node; others produce raw_addon.node.
	if [ -f build/Release/raw_addon.node ] && [ ! -f build/Release/libraw_addon.node ]; then \
		cp -f build/Release/raw_addon.node build/Release/libraw_addon.node; \
	fi; \
	if [ -f build/Release/libraw_addon.node ] && [ ! -f build/Release/raw_addon.node ]; then \
		cp -f build/Release/libraw_addon.node build/Release/raw_addon.node; \
	fi; \
	cd /app/server; \
	node -e "require('librawspeed')"; \
	test -f node_modules/librawspeed/build/Release/raw_addon.node || test -f node_modules/librawspeed/build/Release/libraw_addon.node

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
