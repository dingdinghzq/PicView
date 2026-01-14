const express = require('express');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
// const LibRaw = require('librawspeed'); // Moved to worker
const sharp = require('sharp');
const cors = require('cors');
const { createMediaPreprocessor } = require('./media-preprocess');

const app = express();
const PORT = process.env.PORT || 3001;
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(__dirname, '../photos');
const CACHE_FOLDER_NAME = '983db650f7f79bc8e87d9a3ba418aefc';
const VIDEO_THUMB_NAME = 'video-thumb.jpg';
const MAX_FULL_IMAGE_DIMENSION = 2560; // cap full-view images for size reduction

const media = createMediaPreprocessor({
  photosDir: PHOTOS_DIR,
  cacheFolderName: CACHE_FOLDER_NAME,
  maxFullImageDimension: MAX_FULL_IMAGE_DIMENSION,
  videoThumbName: VIDEO_THUMB_NAME,
});

app.use(cors());
app.use(express.json());

// Helper to get image files
const isImage = (file) => /\.(jpg|jpeg|png|gif|webp|dng|heic|heif)$/i.test(file);
const isVideo = (file) => /\.(mp4|mov|mkv|webm|avi|rm|rmvb)$/i.test(file);

const videoMime = (file) => {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.rm': return 'application/vnd.rn-realmedia';
    case '.rmvb': return 'application/vnd.rn-realmedia-vbr';
    default: return 'application/octet-stream';
  }
};

// In-memory cache for folders
let folderCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 1000 * 60 * 5; // 5 minutes

async function getFolders() {
  const now = Date.now();
  if (folderCache && (now - lastCacheTime < CACHE_DURATION)) {
    return folderCache;
  }

  // Optimization: use withFileTypes to avoid separate stat calls
  const dirents = await fs.readdir(PHOTOS_DIR, { withFileTypes: true });
  const folders = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  folderCache = folders;
  lastCacheTime = now;
  return folders;
}

// List folders
app.get('/api/folders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    
    const folders = await getFolders();
    
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const results = folders.slice(startIndex, endIndex);
    
    res.json({
      folders: results,
      total: folders.length,
      hasMore: endIndex < folders.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

// List images and subfolders in a folder
app.get('/api/folders/*', async (req, res) => {
  try {
    const folderName = req.params[0];
    const folderPath = path.join(PHOTOS_DIR, folderName);
    
    if (!await fs.pathExists(folderPath)) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const dirents = await fs.readdir(folderPath, { withFileTypes: true });
    const jpgBases = new Set(
      dirents
        .filter(dirent => dirent.isFile() && /\.(jpg|jpeg)$/i.test(dirent.name))
        .map(dirent => path.parse(dirent.name).name.toLowerCase())
    );

    const images = dirents
      .filter(dirent => {
        if (!dirent.isFile() || !isImage(dirent.name)) return false;
        const ext = path.extname(dirent.name).toLowerCase();
        if (ext === '.dng') {
          const base = path.parse(dirent.name).name.toLowerCase();
          if (jpgBases.has(base)) return false;
        }
        return true;
      })
      .map(dirent => dirent.name);

    const videos = dirents
      .filter(dirent => dirent.isFile() && isVideo(dirent.name))
      .map(dirent => dirent.name);
      
    const folders = dirents
      .filter(dirent => dirent.isDirectory() && dirent.name !== CACHE_FOLDER_NAME)
      .map(dirent => dirent.name);

    res.json({ images, videos, folders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list content' });
  }
});

// Helper to find random image recursively
async function findRandomImageRecursive(dirPath) {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const jpgBases = new Set(
      dirents
        .filter(d => d.isFile() && /\.(jpg|jpeg)$/i.test(d.name))
        .map(d => path.parse(d.name).name.toLowerCase())
    );
    
    // Check for images first
    const images = dirents.filter(d => {
      if (!d.isFile() || !isImage(d.name)) return false;
      const ext = path.extname(d.name).toLowerCase();
      if (ext === '.dng') {
        const base = path.parse(d.name).name.toLowerCase();
        if (jpgBases.has(base)) return false; // prefer sibling JPEG over DNG
      }
      return true;
    });
    if (images.length > 0) {
      const randomImage = images[Math.floor(Math.random() * images.length)].name;
      // Return relative path from PHOTOS_DIR
      return path.relative(PHOTOS_DIR, path.join(dirPath, randomImage));
    }

    // Check subfolders
    const folders = dirents.filter(d => d.isDirectory() && d.name !== CACHE_FOLDER_NAME);
    // Shuffle folders
    for (let i = folders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [folders[i], folders[j]] = [folders[j], folders[i]];
    }

    for (const folder of folders) {
      const found = await findRandomImageRecursive(path.join(dirPath, folder.name));
      if (found) return found;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Helper to find random video recursively
async function findRandomVideoRecursive(dirPath) {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });

    const videos = dirents.filter(d => d.isFile() && isVideo(d.name));
    if (videos.length > 0) {
      const randomVideo = videos[Math.floor(Math.random() * videos.length)].name;
      return path.relative(PHOTOS_DIR, path.join(dirPath, randomVideo));
    }

    const folders = dirents.filter(d => d.isDirectory() && d.name !== CACHE_FOLDER_NAME);
    for (let i = folders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [folders[i], folders[j]] = [folders[j], folders[i]];
    }

    for (const folder of folders) {
      const found = await findRandomVideoRecursive(path.join(dirPath, folder.name));
      if (found) return found;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Get random thumbnail for folder (recursive)
app.get('/api/thumbnail/*', async (req, res) => {
  try {
    const folderName = req.params[0];
    const folderPath = path.join(PHOTOS_DIR, folderName);

    const imagePath = await findRandomImageRecursive(folderPath);

    if (imagePath) {
      return res.redirect(`/api/image/${imagePath}?width=300`);
    }

    // Fallback to videos
    const videoPath = await findRandomVideoRecursive(folderPath);
    if (videoPath) {
      // ensure thumbnail exists
      const folderForVideo = path.dirname(videoPath);
      const videoName = path.basename(videoPath);
      const absVideoPath = path.join(PHOTOS_DIR, videoPath);
      const thumb = await media.ensureVideoThumbnail(absVideoPath, folderForVideo, videoName);
      if (thumb && await fs.pathExists(thumb)) {
        return res.sendFile(thumb);
      }
    }

    return res.status(404).send('No media in folder tree');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating thumbnail');
  }
});

// Get a random image from a random folder
app.get('/api/random-image', async (req, res) => {
  try {
    // Use cached folders list
    const folders = await getFolders();

    if (folders.length === 0) {
      return res.status(404).json({ error: 'No folders found' });
    }

    // Try up to 10 times to find a folder with images
    for (let i = 0; i < 10; i++) {
      const randomFolder = folders[Math.floor(Math.random() * folders.length)];
      const folderPath = path.join(PHOTOS_DIR, randomFolder);

      const randomImagePath = await findRandomImageRecursive(folderPath);

      if (randomImagePath) {
        // randomImagePath is relative to PHOTOS_DIR, e.g. "Folder/Sub/Image.jpg"
        // We need to split it into folder and image for the client
        // The client expects { folder: "Folder/Sub", image: "Image.jpg" }

        // Normalize path separators to forward slashes for consistency
        const normalizedPath = randomImagePath.replace(/\\/g, '/');
        const folder = path.dirname(normalizedPath);
        const image = path.basename(normalizedPath);

        return res.json({ folder, image });
      }
    }

    res.status(404).json({ error: 'Could not find any images' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get random image' });
  }
});

// Serve image (with optional resizing and quality reduction)
app.get('/api/image/*', async (req, res) => {
  try {
    const fullPath = req.params[0]; // "Folder/Sub/Image.jpg"
    const { width } = req.query;
    const widthInt = width ? parseInt(width) : null;

    const cachePath = await media.ensureImageVariant(fullPath, widthInt);
    return res.sendFile(cachePath);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error serving image');
  }
});

// Serve video thumbnail (static jpg)
app.get('/api/video-thumbnail/*', async (req, res) => {
  try {
    const fullPath = req.params[0]; // "Folder/Sub/video.mp4"
    const videoPath = path.join(PHOTOS_DIR, fullPath);
    const folderName = path.dirname(fullPath);
    const videoName = path.basename(fullPath);

    if (!await fs.pathExists(videoPath)) {
      return res.status(404).send('Video not found');
    }

    const thumbPath = await media.ensureVideoThumbnail(videoPath, folderName, videoName);
    if (thumbPath && await fs.pathExists(thumbPath)) {
      return res.sendFile(thumbPath);
    }

    // If thumbnail generation failed, return 204
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).send('Error serving video thumbnail');
  }
});

// Serve video with range support
app.get('/api/video/*', async (req, res) => {
  try {
    const fullPath = req.params[0];
    const videoPath = path.join(PHOTOS_DIR, fullPath);
    const folderName = path.dirname(fullPath);
    const videoName = path.basename(fullPath);

    if (!await fs.pathExists(videoPath)) {
      return res.status(404).send('Video not found');
    }

    // Try to use transcoded version for bandwidth savings.
    // If not ready, stream original but kick off background transcode.
    let streamPath = videoPath;
    const cacheDir = path.join(PHOTOS_DIR, folderName, CACHE_FOLDER_NAME);
    const base = path.parse(videoName).name;
    const optimizedPath = path.join(cacheDir, `${base}.h265.mp4`);

    if (await fs.pathExists(optimizedPath)) {
      streamPath = optimizedPath;
    } else {
      // fire-and-forget transcode
      media.ensureVideoTranscode(videoPath, folderName, videoName).catch(() => {});
    }

    const stat = await fs.stat(streamPath);
    const range = req.headers.range;
    const mime = videoMime(streamPath);

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = (end - start) + 1;
      const file = fs.createReadStream(streamPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mime,
      });
      fs.createReadStream(streamPath).pipe(res);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Error serving video');
  }
});

// Rotate image
app.post('/api/rotate', async (req, res) => {
  try {
    const { folderName, imageName } = req.body; 
    // Note: folderName here might be a path now if passed from client
    // But client might pass full path as folderName?
    // Let's assume client passes "Folder/Sub" as folderName and "Image.jpg" as imageName
    
    const imagePath = path.join(PHOTOS_DIR, folderName, imageName);

    if (!await fs.pathExists(imagePath)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picview-'));
    const tempPath = path.join(tempDir, `rotate_${Date.now()}_${path.basename(imageName)}`);

    // Rotate 90 degrees clockwise and preserve metadata
    await sharp(imagePath)
      .rotate(90)
      .withMetadata()
      .toFile(tempPath);

    // Replace original file
    await fs.move(tempPath, imagePath, { overwrite: true });
    await fs.remove(tempDir).catch(() => {});

    // Clear specific cache file for this image
    const localCachePath = path.join(PHOTOS_DIR, folderName, CACHE_FOLDER_NAME, imageName);
    if (await fs.pathExists(localCachePath)) {
      await fs.remove(localCachePath);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to rotate image' });
  }
});

// Serve original file
app.get('/api/original/*', async (req, res) => {
  try {
    const fullPath = req.params[0];
    const imagePath = path.join(PHOTOS_DIR, fullPath);

    if (!await fs.pathExists(imagePath)) {
      return res.status(404).send('File not found');
    }

    res.sendFile(imagePath);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error serving original file');
  }
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../client/dist')));

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
