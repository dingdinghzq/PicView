const fs = require('fs-extra');
const path = require('path');

const { createMediaPreprocessor } = require('./media-preprocess');

const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(__dirname, '../photos');
const CACHE_FOLDER_NAME = '983db650f7f79bc8e87d9a3ba418aefc';
const VIDEO_THUMB_NAME = 'video-thumb.jpg';
const MAX_FULL_IMAGE_DIMENSION = 2560;

const isImage = (file) => /\.(jpg|jpeg|png|gif|webp|dng|heic|heif)$/i.test(file);
const isVideo = (file) => /\.(mp4|mov|mkv|webm|avi|rm|rmvb)$/i.test(file);

function parseArgs(argv) {
  const args = {
    concurrency: 2,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--concurrency') {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --concurrency value');
      args.concurrency = Math.floor(v);
      i++;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }

  return args;
}

async function walkMediaFiles(rootDir, cacheFolderName) {
  /** @type {Array<{ absPath: string, relPath: string, kind: 'image'|'video' }>} */
  const items = [];

  async function walkDir(dir) {
    const dirents = await fs.readdir(dir, { withFileTypes: true });

    const jpgBases = new Set(
      dirents
        .filter((d) => d.isFile() && /\.(jpg|jpeg)$/i.test(d.name))
        .map((d) => path.parse(d.name).name.toLowerCase())
    );

    for (const d of dirents) {
      if (d.isDirectory()) {
        if (d.name === cacheFolderName) continue;
        await walkDir(path.join(dir, d.name));
        continue;
      }

      if (!d.isFile()) continue;

      if (isImage(d.name)) {
        const ext = path.extname(d.name).toLowerCase();
        if (ext === '.dng') {
          const base = path.parse(d.name).name.toLowerCase();
          if (jpgBases.has(base)) continue; // prefer sibling JPEG over DNG (same as server listing)
        }

        const absPath = path.join(dir, d.name);
        items.push({
          absPath,
          relPath: path.relative(rootDir, absPath),
          kind: 'image',
        });
        continue;
      }

      if (isVideo(d.name)) {
        const absPath = path.join(dir, d.name);
        items.push({
          absPath,
          relPath: path.relative(rootDir, absPath),
          kind: 'video',
        });
      }
    }
  }

  await walkDir(rootDir);
  return items;
}

async function runPool(items, concurrency, handler) {
  let nextIndex = 0;
  const workers = new Array(concurrency).fill(null).map(async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await handler(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log('Usage: node server/preprocess-offline.js [--concurrency N] [--dry-run]');
    process.exit(0);
  }

  const media = createMediaPreprocessor({
    photosDir: PHOTOS_DIR,
    cacheFolderName: CACHE_FOLDER_NAME,
    maxFullImageDimension: MAX_FULL_IMAGE_DIMENSION,
    videoThumbName: VIDEO_THUMB_NAME,
  });

  const items = await walkMediaFiles(PHOTOS_DIR, CACHE_FOLDER_NAME);

  let ok = 0;
  let failed = 0;

  const startedAt = Date.now();

  await runPool(items, args.concurrency, async (item, idx) => {
    const label = `[${idx + 1}/${items.length}] ${item.kind} ${item.relPath}`;

    try {
      if (args.dryRun) {
        // eslint-disable-next-line no-console
        console.log(`${label} (dry-run)`);
        ok++;
        return;
      }

      if (item.kind === 'image') {
        // Mirror online behavior: generate the commonly requested thumbnail and a full-size cached image.
        await media.ensureImageVariant(item.relPath, 300);
        await media.ensureImageVariant(item.relPath, null);
      } else {
        const folderName = path.dirname(item.relPath);
        const videoName = path.basename(item.relPath);
        await media.ensureVideoThumbnail(item.absPath, folderName, videoName);
        await media.ensureVideoTranscode(item.absPath, folderName, videoName);
      }

      ok++;
      if ((idx + 1) % 50 === 0) {
        const elapsedS = Math.round((Date.now() - startedAt) / 1000);
        // eslint-disable-next-line no-console
        console.log(`Progress: ${idx + 1}/${items.length} (ok=${ok}, failed=${failed}, ${elapsedS}s)`);
      }
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`${label} failed`, err?.message || err);
    }
  });

  const elapsedS = Math.round((Date.now() - startedAt) / 1000);
  // eslint-disable-next-line no-console
  console.log(`Done. ok=${ok}, failed=${failed}, total=${items.length}, ${elapsedS}s`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
