const express = require('express');
const fs = require('fs-extra');
const path = require('path');
// const LibRaw = require('librawspeed'); // Moved to worker
const sharp = require('sharp');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const runExecFile = promisify(execFile);

let heicConvertPromise = null;
async function getHeicConvert() {
  if (!heicConvertPromise) {
    heicConvertPromise = import('heic-convert').then((m) => m.default || m);
  }
  return heicConvertPromise;
}

const app = express();
const PORT = process.env.PORT || 3001;
const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(__dirname, '../photos');
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');
const CACHE_FOLDER_NAME = '983db650f7f79bc8e87d9a3ba418aefc';
const VIDEO_THUMB_NAME = 'video-thumb.jpg';
const MAX_FULL_IMAGE_DIMENSION = 2560; // cap full-view images for size reduction

const getImageCachePath = (folderName, imageName, variant) => {
  const base = path.parse(imageName).name;
  return path.join(PHOTOS_DIR, folderName, CACHE_FOLDER_NAME, `${base}_${variant}.jpg`);
};

app.use(cors());
app.use(express.json());

// Ensure cache directory exists
fs.ensureDirSync(CACHE_DIR);

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

async function ensureVideoThumbnail(videoPath, folderName, videoName) {
  const thumbDir = path.join(PHOTOS_DIR, folderName, CACHE_FOLDER_NAME);
  const thumbPath = path.join(thumbDir, `${videoName}.jpg`);

  if (await fs.pathExists(thumbPath)) return thumbPath;

  await fs.ensureDir(thumbDir);

  // Use ffmpeg to grab frame at 1s
  try {
    await runExecFile('ffmpeg', ['-y', '-ss', '00:00:01', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=300:-1', thumbPath], { windowsHide: true });
    return thumbPath;
  } catch (err) {
    console.error('ffmpeg thumbnail failed', err.message || err);
    // fallback: return null
    return null;
  }
}

async function ensureVideoTranscode(videoPath, folderName, videoName) {
  const cacheDir = path.join(PHOTOS_DIR, folderName, CACHE_FOLDER_NAME);
  const base = path.parse(videoName).name;
  const outPath = path.join(cacheDir, `${base}.h265.mp4`);
  const tempPath = path.join(cacheDir, `${base}.h265.tmp.mp4`);

  if (await fs.pathExists(outPath)) return outPath;
  // If a temp file exists, assume a transcode is already running and skip starting another.
  if (await fs.pathExists(tempPath)) return null;

  await fs.ensureDir(cacheDir);

  try {
    await runExecFile('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-c:v', 'libx265',
      '-preset', 'medium',
      '-crf', '30',
      '-tag:v', 'hvc1',
      '-c:a', 'aac',
      '-b:a', '128k',
      tempPath
    ], { windowsHide: true });
    // only expose finalized file after successful transcode
    await fs.move(tempPath, outPath, { overwrite: true });
    return outPath;
  } catch (err) {
    console.error('ffmpeg transcode failed', err.message || err);
    if (await fs.pathExists(tempPath)) {
      await fs.remove(tempPath).catch(() => {});
    }
    return null;
  }
}

async function convertHeicToJpeg(sourcePath, destPath) {
  await fs.ensureDir(path.dirname(destPath));

  if (await fs.pathExists(destPath)) return;

  const tmpPath = `${destPath}.tmp`;

  // If a temp file exists, assume a conversion is already running.
  if (await fs.pathExists(tmpPath)) {
    const timeoutMs = 60_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fs.pathExists(destPath)) return;
      if (!await fs.pathExists(tmpPath)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  try {
    const convert = await getHeicConvert();
    const inputBuffer = await fs.readFile(sourcePath);
    const output = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.8,
    });

    const outputBuffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
    await fs.writeFile(tmpPath, outputBuffer);
    await fs.move(tmpPath, destPath, { overwrite: true });
  } catch (err) {
    if (await fs.pathExists(tmpPath)) {
      await fs.remove(tmpPath).catch(() => {});
    }
    throw err;
  }
}

// Resolve best source for an image request, handling DNG fallbacks and conversion.
async function resolveImageSource(folderName, imageName) {
  const ext = path.extname(imageName).toLowerCase();
  const base = path.parse(imageName).name;
  const originalPath = path.join(PHOTOS_DIR, folderName, imageName);

  if (ext === '.heic' || ext === '.heif') {
    const fullCachePath = getImageCachePath(folderName, imageName, 'full');
    if (!await fs.pathExists(fullCachePath)) {
      await convertHeicToJpeg(originalPath, fullCachePath);
    }
    return { sourcePath: fullCachePath };
  }

  if (ext !== '.dng') {
    return { sourcePath: originalPath };
  }

  const jpgCandidate = path.join(PHOTOS_DIR, folderName, `${base}.jpg`);
  if (await fs.pathExists(jpgCandidate)) {
    return { sourcePath: jpgCandidate };
  }

  const jpegCandidate = path.join(PHOTOS_DIR, folderName, `${base}.jpeg`);
  if (await fs.pathExists(jpegCandidate)) {
    return { sourcePath: jpegCandidate };
  }

  // No sibling JPEG: convert DNG to cached full-size JPEG using dcraw (sharp often extracts only the preview).
  const fullCachePath = getImageCachePath(folderName, imageName, 'full');
  if (!await fs.pathExists(fullCachePath)) {
    await fs.ensureDir(path.dirname(fullCachePath));
    
    // Use librawspeed (via worker) for DNG conversion to get full resolution
    try {
      console.log('Converting DNG with librawspeed worker:', originalPath);
      
      const tempPpmPath = fullCachePath + '.ppm';
      
      // Run worker process
      await runExecFile(process.execPath, [
        path.join(__dirname, 'dng-worker.js'),
        originalPath,
        tempPpmPath
      ]);
      
      if (!await fs.pathExists(tempPpmPath)) {
        throw new Error('Worker failed to produce output');
      }
      
      // Use sharp to convert PPM to JPEG (rotate, normalize)
      await sharp(tempPpmPath)
        .rotate()
        .normalize()
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(fullCachePath);
        
      // Cleanup temp file
      await fs.remove(tempPpmPath);
        
    } catch (err) {
      console.error('Failed to convert DNG with librawspeed worker, falling back to sharp', err);
      // Fallback to sharp if worker fails
      await sharp(originalPath)
        .rotate()
        .normalize()
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(fullCachePath);
    }
  }

  return { sourcePath: fullCachePath };
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
      const thumb = await ensureVideoThumbnail(absVideoPath, folderForVideo, videoName);
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
    
    const imagePath = path.join(PHOTOS_DIR, fullPath);
    const folderName = path.dirname(fullPath);
    const imageName = path.basename(fullPath);

    if (!await fs.pathExists(imagePath)) {
      return res.status(404).send('Image not found');
    }

    const { sourcePath } = await resolveImageSource(folderName, imageName);

    const widthInt = width ? parseInt(width) : null;
    const variant = widthInt ? `w${widthInt}` : 'full';
    const cachePath = getImageCachePath(folderName, imageName, variant);

    // Return cached optimized image if available
    if (await fs.pathExists(cachePath)) {
      return res.sendFile(cachePath);
    }

    await fs.ensureDir(path.dirname(cachePath));

    // Build resize options
    const resizeOpts = widthInt
      ? { width: widthInt, withoutEnlargement: true }
      : { width: MAX_FULL_IMAGE_DIMENSION, height: MAX_FULL_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true };

    await sharp(sourcePath)
      .rotate()
      .resize(resizeOpts)
      .jpeg({ quality: 75, mozjpeg: true })
      .toFile(cachePath);

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

    const thumbPath = await ensureVideoThumbnail(videoPath, folderName, videoName);
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
      ensureVideoTranscode(videoPath, folderName, videoName).catch(() => {});
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

    // Create a temp path
    const tempPath = path.join(CACHE_DIR, `temp_${Date.now()}_${path.basename(imageName)}`);

    // Rotate 90 degrees clockwise and preserve metadata
    await sharp(imagePath)
      .rotate(90)
      .withMetadata()
      .toFile(tempPath);

    // Replace original file
    await fs.move(tempPath, imagePath, { overwrite: true });

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
