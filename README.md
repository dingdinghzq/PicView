# PicView

A high-performance photo viewer website.

## Setup

1.  **Install Dependencies**:
    ```bash
    cd server
    npm install
    cd ../client
    npm install
    ```

2.  **Start Server**:
    ```bash
    cd server
    node index.js
    ```
    The server runs on `http://localhost:3001`.

3.  **Start Client**:
    ```bash
    cd client
    npm run dev
    ```
    The client runs on `http://localhost:3000`.

## Adding Photos

Place your photo folders in the `photos` directory.
Structure:
```
photos/
  Vacation/
    img1.jpg
    img2.jpg
  Wedding/
    photo1.jpg
    ...
```

## Features

-   **Folder Navigation**: Browse photos by folder.
-   **Thumbnails**: Random thumbnails for folders.
-   **Optimization**: Server-side image resizing and caching for fast loading.
-   **Image Viewer**:
    -   Pan and Zoom support.
    -   Keyboard navigation (Arrow keys).
  -   Progressive loading (blur preview).

## RAW and HEIC Support

-   DNG/RAW: processed with `librawspeed` (LibRaw) via a worker process for full-resolution output.
-   HEIC/HEIF: handled with `heic-convert`.
-   Baseline runtime: Node.js 22 (Dockerfile uses `node:22-slim`).

## Docker

-   Build image: `docker build -t picview:latest .`
-   Save image: `docker save -o picview2.tar picview:latest`
-   Load elsewhere: `docker load -i picview2.tar`
-   Run: `docker run --rm -p 3001:3001 -v /host/photos:/photos -v /host/cache:/cache -e PHOTOS_DIR=/photos picview:latest`

## Environment

-   `PHOTOS_DIR` (default `/photos`)
-   `PORT` (default `3001`)
-   Cache output is written under each folder: `<folder>/983db650f7f79bc8e87d9a3ba418aefc/`
-   `PICVIEW_TRANSCODE_MIN_BYTES` (optional): skip video transcode when file size is <= this many bytes

## Offline Preprocessing

Pre-generate the same cached variants as the online API:

-   `npm run preprocess` (or `node server/preprocess-offline.js`)
-   Flags: `--concurrency N`, `--dry-run`

## Build Notes

-   The Docker image compiles LibRaw 0.21.4 with `-fPIC` and links `librawspeed` against it; image includes ffmpeg and standard image codecs.
-   Client is built during the Docker multi-stage build and copied into the server image.
