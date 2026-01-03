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

# Build LibRaw from source with -fPIC for librawspeed
RUN set -eux; \
		mkdir -p /tmp/libraw && cd /tmp/libraw; \
		curl -L -o libraw.tar.gz https://www.libraw.org/data/LibRaw-0.21.4.tar.gz; \
		tar -xzf libraw.tar.gz; \
		cd LibRaw-0.21.4; \
		CFLAGS="-fPIC" CXXFLAGS="-fPIC" ./configure --disable-examples --disable-samples --disable-openmp; \
		make -j"$(nproc)"; \
		make install; \
		ldconfig; \
		cd /; rm -rf /tmp/libraw

# Prepare LibRaw static library path expected by librawspeed build
RUN set -eux; \
		base="/app/server/node_modules/librawspeed/deps/LibRaw-Source/LibRaw-0.21.4/build/linux-x64/lib"; \
		mkdir -p "$base"; \
		if [ -f /usr/lib/x86_64-linux-gnu/libraw.a ]; then \
			ln -sf /usr/lib/x86_64-linux-gnu/libraw.a "$base/libraw.a"; \
		elif [ -f /usr/lib/x86_64-linux-gnu/libraw_r.a ]; then \
			ln -sf /usr/lib/x86_64-linux-gnu/libraw_r.a "$base/libraw.a"; \
		else \
			echo "LibRaw static library not found" >&2; exit 1; \
		fi

# Install server dependencies
COPY server/package*.json ./server/
WORKDIR /app/server
RUN set -eux; \
		npm config set script-shell /bin/bash; \
		npm install --production --ignore-scripts; \
		cd node_modules/librawspeed; \
		mkdir -p deps/LibRaw-Source/LibRaw-0.21.4/build/linux-x64/lib; \
		if [ -f /usr/local/lib/libraw.a ]; then \
			ln -sf /usr/local/lib/libraw.a deps/LibRaw-Source/LibRaw-0.21.4/build/linux-x64/lib/libraw.a; \
		elif [ -f /usr/local/lib/libraw_r.a ]; then \
			ln -sf /usr/local/lib/libraw_r.a deps/LibRaw-Source/LibRaw-0.21.4/build/linux-x64/lib/libraw.a; \
		elif [ -f /usr/lib/x86_64-linux-gnu/libraw.a ]; then \
			ln -sf /usr/lib/x86_64-linux-gnu/libraw.a deps/LibRaw-Source/LibRaw-0.21.4/build/linux-x64/lib/libraw.a; \
		elif [ -f /usr/lib/x86_64-linux-gnu/libraw_r.a ]; then \
			ln -sf /usr/lib/x86_64-linux-gnu/libraw_r.a deps/LibRaw-Source/LibRaw-0.21.4/build/linux-x64/lib/libraw.a; \
		else \
			echo "LibRaw static library not found" >&2; exit 1; \
		fi; \
		cd /app/server; \
		npm rebuild librawspeed

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
