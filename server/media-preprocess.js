const fs = require('fs-extra');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');

const runExecFile = promisify(execFile);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableIoError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (code === 'ENOSPC' || code === 'EIO' || code === 'EBUSY' || code === 'EPERM' || code === 'UNKNOWN') {
    return true;
  }

  const message = String(err?.message || err || '').toLowerCase();
  // libvips/sharp sometimes reports a scary ENOSPC-looking message on transient share errors.
  if (message.includes('out of disk space')) return true;
  if (message.includes('output file write error')) return true;
  // Seen on Windows/NAS occasionally; treat as transient as requested.
  if (message.includes('the device does not recognize the command')) return true;

  return false;
}

async function withRetries(fn, opts = {}) {
  const {
    label = 'operation',
    attempts = 3,
    baseDelayMs = 750,
    maxDelayMs = 10_000,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryableIoError(err) || attempt === attempts) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      // eslint-disable-next-line no-console
      console.warn(`${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms:`, err?.message || err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sharpFailOnNone(pipeline) {
  // Older sharp versions don't have `.failOn()`.
  if (pipeline && typeof pipeline.failOn === 'function') {
    return pipeline.failOn('none');
  }
  return pipeline;
}

function sharpOpen(input, options) {
  // Prefer constructor option (covers early decode warnings), then also apply the chain method when available.
  const opts = options ? { ...options } : {};
  if (opts.failOn === undefined) opts.failOn = 'none';
  return sharpFailOnNone(sharp(input, opts));
}

function getDefaultResizeOpts(maxFullImageDimension) {
  return {
    width: maxFullImageDimension,
    height: maxFullImageDimension,
    fit: 'inside',
    withoutEnlargement: true,
  };
}

async function getAutoLevelsParamsFromRaw(rawBuffer, rawOptions) {
  // Approximate Lightroom-style "Auto" by stretching luminance between low/high percentiles.
  // Runs only on cache misses.
  const sample = await sharpOpen(rawBuffer, { raw: rawOptions })
    .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();

  if (!sample || sample.length === 0) return null;

  const hist = new Array(256).fill(0);
  for (let i = 0; i < sample.length; i++) hist[sample[i]]++;

  const total = sample.length;
  const lowTarget = Math.floor(total * 0.01);
  const highTarget = Math.floor(total * 0.99);

  let cum = 0;
  let low = 0;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= lowTarget) {
      low = i;
      break;
    }
  }

  cum = 0;
  let high = 255;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= highTarget) {
      high = i;
      break;
    }
  }

  // Avoid extreme amplification.
  low = Math.max(0, low - 2);
  high = Math.min(255, high + 2);

  if (high <= low + 5) return null;

  // Keep some headroom to reduce highlight clipping.
  const targetLow = 8;
  const targetHigh = 245;
  const scale = (targetHigh - targetLow) / (high - low);
  const offset = targetLow - low * scale;
  return { scale, offset, low, high, targetLow, targetHigh };
}

let heicConvertPromise = null;
async function getHeicConvert() {
  if (!heicConvertPromise) {
    heicConvertPromise = import('heic-convert').then((m) => m.default || m);
  }
  return heicConvertPromise;
}

function createMediaPreprocessor(options) {
  const {
    photosDir,
    cacheDir,
    cacheFolderName,
    maxFullImageDimension,
    videoThumbName,
  } = options;

  if (!photosDir) throw new Error('createMediaPreprocessor: photosDir is required');
  // cacheDir is optional: processed outputs are stored under
  // `${photosDir}/<folder>/${cacheFolderName}/...`
  if (!cacheFolderName) throw new Error('createMediaPreprocessor: cacheFolderName is required');
  if (!maxFullImageDimension) throw new Error('createMediaPreprocessor: maxFullImageDimension is required');

  const VIDEO_THUMB_NAME = videoThumbName || 'video-thumb.jpg';

  const getImageCachePath = (folderName, imageName, variant) => {
    const base = path.parse(imageName).name;
    return path.join(photosDir, folderName, cacheFolderName, `${base}_${variant}.jpg`);
  };

  async function readHeaderBytes(filePath, len) {
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async function isJpegByMagic(filePath) {
    try {
      const b = await readHeaderBytes(filePath, 3);
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    } catch {
      return false;
    }
  }

  async function looksLikeHeif(filePath) {
    // ISO-BMFF: [0..3]=size, [4..7]="ftyp", [8..11]=major_brand
    try {
      const b = await readHeaderBytes(filePath, 12);
      if (b.length < 12) return false;
      if (b.toString('ascii', 4, 8) !== 'ftyp') return false;

      const brand = b.toString('ascii', 8, 12);
      // Common HEIF/HEIC/AVIF brands.
      return brand === 'heic'
        || brand === 'heix'
        || brand === 'hevc'
        || brand === 'hevx'
        || brand === 'heif'
        || brand === 'mif1'
        || brand === 'msf1'
        || brand === 'avif'
        || brand === 'avis';
    } catch {
      return false;
    }
  }

  async function isNonEmptyFile(filePath) {
    try {
      const st = await fs.stat(filePath);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  async function deleteIfZeroByte(filePath) {
    try {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size === 0) {
        await fs.remove(filePath).catch(() => {});
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  async function writeJpegWithRetries(makeSharpPipeline, destPath) {
    await fs.ensureDir(path.dirname(destPath));
    await withRetries(
      async () => {
        const pipeline = typeof makeSharpPipeline === 'function'
          ? makeSharpPipeline()
          : makeSharpPipeline;

        await pipeline.toFile(destPath);
        if (await deleteIfZeroByte(destPath)) {
          throw new Error(`Generated 0-byte output: ${destPath}`);
        }
      },
      { label: `jpeg write ${path.basename(destPath)}`, attempts: 5 }
    );
  }

  async function convertHeicToPngBuffer(sourcePath) {
    // Prefer heic-convert; fall back to ffmpeg for broader codec coverage.
    try {
      const convert = await getHeicConvert();
      const inputBuffer = await fs.readFile(sourcePath);
      const output = await convert({
        buffer: inputBuffer,
        format: 'PNG',
      });
      return Buffer.isBuffer(output) ? output : Buffer.from(output);
    } catch (err) {
      try {
        const { stdout } = await runExecFile('ffmpeg', [
          '-v', 'error',
          '-i', sourcePath,
          '-frames:v', '1',
          '-f', 'image2pipe',
          '-vcodec', 'png',
          'pipe:1',
        ], {
          windowsHide: true,
          encoding: 'buffer',
          maxBuffer: 200 * 1024 * 1024,
        });

        if (stdout && stdout.length > 0) return Buffer.from(stdout);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  // Resolve best source for an image request, handling DNG fallbacks and conversion.
  async function resolveImageSource(folderName, imageName) {
    const ext = path.extname(imageName).toLowerCase();
    const base = path.parse(imageName).name;
    const originalPath = path.join(photosDir, folderName, imageName);

    if (ext === '.heic' || ext === '.heif') {
      // Convert in-memory for the requested variant; don't persist intermediate files.
      return { sourcePath: originalPath, sourceKind: 'heic' };
    }

    if (ext !== '.dng') {
      return { sourcePath: originalPath };
    }

    const jpgCandidate = path.join(photosDir, folderName, `${base}.jpg`);
    if (await fs.pathExists(jpgCandidate)) {
      return { sourcePath: jpgCandidate };
    }

    const jpegCandidate = path.join(photosDir, folderName, `${base}.jpeg`);
    if (await fs.pathExists(jpegCandidate)) {
      return { sourcePath: jpegCandidate };
    }

    const fullCachePath = getImageCachePath(folderName, imageName, 'full');
    if (!await isNonEmptyFile(fullCachePath)) {
      // If an empty/corrupt cache exists, remove it so we reprocess.
      if (await fs.pathExists(fullCachePath)) {
        await fs.remove(fullCachePath).catch(() => {});
      }
      await fs.ensureDir(path.dirname(fullCachePath));

      // Use librawspeed (via worker) for DNG conversion to get full resolution
      try {
        const tempRawPath = fullCachePath + '.raw';

        await withRetries(
          () => runExecFile(process.execPath, [
            path.join(__dirname, 'dng-worker.js'),
            originalPath,
            tempRawPath,
          ]),
          { label: `dng worker ${path.basename(originalPath)}`, attempts: 3 }
        );

        if (!await fs.pathExists(tempRawPath)) {
          throw new Error('Worker failed to produce output');
        }

        const metaPath = `${tempRawPath}.json`;
        if (!await fs.pathExists(metaPath)) {
          throw new Error('Worker failed to produce metadata');
        }

        const meta = await fs.readJson(metaPath);
        const rawBuffer = await fs.readFile(tempRawPath);

        const rawOptions = {
          width: meta.width,
          height: meta.height,
          channels: meta.channels,
        };

        if (meta.bits && meta.bits > 8) {
          rawOptions.depth = 'ushort';
        }

        const auto = await getAutoLevelsParamsFromRaw(rawBuffer, rawOptions);

        let pipeline = sharpOpen(rawBuffer, { raw: rawOptions })
          .rotate()
          .normalize();

        if (auto) {
          pipeline = pipeline.linear(auto.scale, auto.offset);
        }

        if (typeof pipeline.gamma === 'function') {
          pipeline = pipeline.gamma(2.2);
        }

        await writeJpegWithRetries(
          () => pipeline
            .resize(getDefaultResizeOpts(maxFullImageDimension))
            .jpeg({ quality: 75, mozjpeg: true }),
          fullCachePath
        );

        // Guard against rare 0-byte outputs.
        if (!await isNonEmptyFile(fullCachePath)) {
          await fs.remove(fullCachePath).catch(() => {});
          throw new Error(`Generated 0-byte cache: ${fullCachePath}`);
        }

        await fs.remove(tempRawPath);
        await fs.remove(metaPath);
      } catch (err) {
        // Fallback to sharp if worker fails
        await writeJpegWithRetries(
          () => sharpOpen(originalPath)
            .rotate()
            .normalize()
            .gamma(2.2)
            .resize(getDefaultResizeOpts(maxFullImageDimension))
            .jpeg({ quality: 75, mozjpeg: true }),
          fullCachePath
        );

        if (!await isNonEmptyFile(fullCachePath)) {
          await fs.remove(fullCachePath).catch(() => {});
          throw new Error(`Generated 0-byte cache: ${fullCachePath}`);
        }
      }
    }

    return { sourcePath: fullCachePath, sourceKind: 'path' };
  }

  async function ensureImageVariant(fullPath, widthInt) {
    const absOriginal = path.join(photosDir, fullPath);
    const folderName = path.dirname(fullPath);
    const imageName = path.basename(fullPath);

    if (!await fs.pathExists(absOriginal)) {
      throw new Error(`Image not found: ${absOriginal}`);
    }

    // If the original is already a small JPEG, don't generate a resized "full" cache.
    // This keeps disk usage down and avoids unnecessary processing.
    if (!widthInt) {
      const ext = path.extname(imageName).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') {
        try {
          const st = await fs.stat(absOriginal);
          if (st.isFile() && st.size > 0 && st.size < 1_000_000 && await isJpegByMagic(absOriginal)) {
            return absOriginal;
          }
        } catch {
          // ignore
        }
      }
    }

    const resolved = await resolveImageSource(folderName, imageName);
    const sourcePath = resolved.sourcePath;
    let sourceKind = resolved.sourceKind || 'path';

    // Extensions can lie (e.g. .JPG that is actually HEIC). If it looks like HEIF, treat as HEIC.
    if (sourceKind === 'path') {
      if (await looksLikeHeif(sourcePath)) {
        sourceKind = 'heic';
      }
    }

    const variant = widthInt ? `w${widthInt}` : 'full';
    const cachePath = getImageCachePath(folderName, imageName, variant);

    if (await isNonEmptyFile(cachePath)) return cachePath;
    if (await fs.pathExists(cachePath)) {
      await fs.remove(cachePath).catch(() => {});
    }

    const resizeOpts = widthInt
      ? { width: widthInt, withoutEnlargement: true }
      : getDefaultResizeOpts(maxFullImageDimension);

    if (sourceKind === 'heic') {
      try {
        const pngBuffer = await convertHeicToPngBuffer(sourcePath);
        await writeJpegWithRetries(
          () => sharpOpen(pngBuffer)
            .rotate()
            .resize(resizeOpts)
            .jpeg({ quality: 75, mozjpeg: true }),
          cachePath
        );
      } catch (err) {
        // Sometimes files are misnamed .HEIC but are actually JPEGs. Fall back to sharp in that case.
        const msg = String(err?.message || err || '').toLowerCase();
        const notHeic = msg.includes('not a heic') || msg.includes('not a heif') || msg.includes('not a heif/heic');
        if (notHeic || await isJpegByMagic(sourcePath)) {
          await writeJpegWithRetries(
            () => sharpOpen(sourcePath)
              .rotate()
              .resize(resizeOpts)
              .jpeg({ quality: 75, mozjpeg: true }),
            cachePath
          );
        } else {
          throw err;
        }
      }
    } else {
      await writeJpegWithRetries(
        () => sharpOpen(sourcePath)
          .rotate()
          .resize(resizeOpts)
          .jpeg({ quality: 75, mozjpeg: true }),
        cachePath
      );
    }

    if (!await isNonEmptyFile(cachePath)) {
      await fs.remove(cachePath).catch(() => {});
      throw new Error(`Generated 0-byte cache: ${cachePath}`);
    }

    return cachePath;
  }

  async function ensureVideoThumbnail(videoPath, folderName, videoName) {
    const thumbDir = path.join(photosDir, folderName, cacheFolderName);
    const thumbPath = path.join(thumbDir, `${videoName}.jpg`);

    if (await isNonEmptyFile(thumbPath)) return thumbPath;
    if (await deleteIfZeroByte(thumbPath)) {
      // Deleted immediately; regenerate below.
    }

    await fs.ensureDir(thumbDir);

    try {
      await withRetries(
        async () => {
          await runExecFile('ffmpeg', [
            '-y',
            '-ss', '00:00:01',
            '-i', videoPath,
            '-frames:v', '1',
            '-vf', 'scale=300:-1',
            thumbPath,
          ], { windowsHide: true });

          if (await deleteIfZeroByte(thumbPath)) {
            throw new Error(`Generated 0-byte output: ${thumbPath}`);
          }
        },
        { label: `ffmpeg thumbnail ${path.basename(videoName)}`, attempts: 3 }
      );
      return thumbPath;
    } catch (err) {
      console.error('ffmpeg thumbnail failed', err.message || err);
      return null;
    }
  }

  async function getVideoCodec(videoPath) {
    try {
      const { stdout } = await runExecFile('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=nw=1:nk=1',
        videoPath,
      ], { windowsHide: true });

      return String(stdout || '').trim().toLowerCase();
    } catch {
      return null;
    }
  }

  async function ensureVideoTranscode(videoPath, folderName, videoName) {
    const cacheDirForVideo = path.join(photosDir, folderName, cacheFolderName);
    const base = path.parse(videoName).name;
    const outPath = path.join(cacheDirForVideo, `${base}.h265.mp4`);
    const lockPath = path.join(cacheDirForVideo, `${base}.h265.lock`);
    const failPath = path.join(cacheDirForVideo, `${base}.h265.fail.json`);
    const skipPath = path.join(cacheDirForVideo, `${base}.h265.skip.json`);

    if (await isNonEmptyFile(outPath)) return outPath;
    if (await deleteIfZeroByte(outPath)) {
      // Deleted immediately; regenerate below.
    }

    await fs.ensureDir(cacheDirForVideo);

    if (await fs.pathExists(skipPath)) return null;

    // Skip if already HEVC or small enough.
    const minBytes = Number(process.env.PICVIEW_TRANSCODE_MIN_BYTES || 10000000);
    try {
      const st = await fs.stat(videoPath);
      if (minBytes > 0 && st.size <= minBytes) {
        await fs.writeJson(skipPath, { at: Date.now(), reason: 'small', bytes: st.size, minBytes }, { spaces: 0 }).catch(() => {});
        return null;
      }
    } catch {
      // ignore
    }

    const codec = await getVideoCodec(videoPath);
    // ffprobe reports the codec (e.g. "hevc"), not the encoder (e.g. libx265).
    if (codec === 'hevc' || codec === 'h265') {
      await fs.writeJson(skipPath, { at: Date.now(), reason: 'already-hevc', codec }, { spaces: 0 }).catch(() => {});
      return null;
    }

    // If a lock exists, assume a transcode is already running and skip starting another.
    if (await fs.pathExists(lockPath)) return null;

    // If we recently failed, don't keep retrying on every request.
    if (await fs.pathExists(failPath)) {
      try {
        const fail = await fs.readJson(failPath);
        const lastFailAt = typeof fail?.at === 'number' ? fail.at : 0;
        const backoffMs = 10 * 60 * 1000;
        if (Date.now() - lastFailAt < backoffMs) return null;
      } catch {
        // ignore
      }
    }

    // Acquire lock (best-effort).
    try {
      await fs.writeFile(lockPath, JSON.stringify({ at: Date.now(), pid: process.pid }), { flag: 'wx' });
    } catch {
      return null;
    }

    const tempPath = path.join(cacheDirForVideo, `${base}.h265.tmp.${process.pid}.${Date.now()}.mp4`);

    try {
      await withRetries(
        () => runExecFile('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-c:v', 'libx265',
          '-preset', 'medium',
          '-crf', '30',
          '-tag:v', 'hvc1',
          '-c:a', 'aac',
          '-b:a', '128k',
          tempPath,
        ], { windowsHide: true }),
        { label: `ffmpeg transcode ${path.basename(videoName)}`, attempts: 3 }
      );

      if (!await fs.pathExists(tempPath)) {
        throw new Error(`ffmpeg completed but did not create output: ${tempPath}`);
      }

      if (await deleteIfZeroByte(tempPath)) {
        throw new Error(`ffmpeg produced 0-byte output: ${tempPath}`);
      }

      await fs.move(tempPath, outPath, { overwrite: true });

      if (await deleteIfZeroByte(outPath)) {
        throw new Error(`Generated 0-byte output: ${outPath}`);
      }

      await fs.remove(failPath).catch(() => {});
      return outPath;
    } catch (err) {
      const message = err?.message || String(err);
      console.error('ffmpeg transcode failed', message);
      const stderr = err && typeof err.stderr !== 'undefined' ? String(err.stderr) : '';
      if (stderr) {
        console.error('ffmpeg transcode stderr', stderr.slice(0, 2000));
      }
      try {
        await fs.writeJson(failPath, { at: Date.now(), message }, { spaces: 0 });
      } catch {
        // ignore
      }
      return null;
    } finally {
      await fs.remove(lockPath).catch(() => {});
      await fs.remove(tempPath).catch(() => {});
    }
  }

  return {
    VIDEO_THUMB_NAME,
    cacheFolderName,
    getImageCachePath,
    resolveImageSource,
    ensureImageVariant,
    ensureVideoThumbnail,
    ensureVideoTranscode,
  };
}

module.exports = {
  createMediaPreprocessor,
};
