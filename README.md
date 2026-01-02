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
