const LibRaw = require('librawspeed');
const fs = require('fs');
const path = require('path');

const [,, inputPath, outputPath] = process.argv;

const debugEnabled = process.env.DNG_WORKER_DEBUG === '1' || process.env.DNG_WORKER_DEBUG === 'true';
function log(...args) {
  console.log('[dng-worker]', ...args);
}
function debug(...args) {
  if (debugEnabled) console.log('[dng-worker:debug]', ...args);
}

function hrMs(start) {
  const diff = process.hrtime.bigint() - start;
  return Number(diff / 1000000n);
}

function toPpmPayload(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const colors = imageData.colors;
  const bits = imageData.bits || 8;
  const data = imageData.data;

  if (!data || data.length === 0) {
    throw new Error('createMemoryImage returned empty data');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions: ${width}x${height}`);
  }
  if (![3, 4].includes(colors)) {
    throw new Error(`Unsupported colors: ${colors} (expected 3=RGB or 4=RGBA)`);
  }
  if (bits <= 0 || bits > 16) {
    throw new Error(`Unsupported bit depth: ${bits} (expected 1..16)`);
  }

  const bytesPerSample = bits > 8 ? 2 : 1;
  const expectedLen = width * height * colors * bytesPerSample;
  if (data.length < expectedLen) {
    throw new Error(`Unexpected data length: got ${data.length}, expected >= ${expectedLen}`);
  }

  // PPM maxval: 255 for 8-bit, 65535 for 16-bit.
  const maxval = bits > 8 ? 65535 : 255;

  // Drop alpha if present.
  let rgb;
  if (colors === 3) {
    rgb = Buffer.from(data);
  } else {
    rgb = Buffer.allocUnsafe(width * height * 3 * bytesPerSample);
    const pxCount = width * height;
    for (let i = 0; i < pxCount; i++) {
      const src = i * 4 * bytesPerSample;
      const dst = i * 3 * bytesPerSample;
      // Copy R,G,B; skip A
      data.copy(rgb, dst, src, src + 3 * bytesPerSample);
    }
  }

  // 16-bit PPM requires big-endian samples. Most sources are little-endian on x86.
  if (bytesPerSample === 2) {
    for (let i = 0; i < rgb.length; i += 2) {
      const b0 = rgb[i];
      rgb[i] = rgb[i + 1];
      rgb[i + 1] = b0;
    }
  }

  const header = `P6\n${width} ${height}\n${maxval}\n`;
  return { header: Buffer.from(header), payload: rgb, maxval, bytesPerSample };
}

function toRawPayload(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const colors = imageData.colors;
  const bits = imageData.bits || 8;
  const data = imageData.data;

  if (!data || data.length === 0) {
    throw new Error('createMemoryImage returned empty data');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions: ${width}x${height}`);
  }
  if (![3, 4].includes(colors)) {
    throw new Error(`Unsupported colors: ${colors} (expected 3=RGB or 4=RGBA)`);
  }
  if (bits <= 0 || bits > 16) {
    throw new Error(`Unsupported bit depth: ${bits} (expected 1..16)`);
  }

  const bytesPerSample = bits > 8 ? 2 : 1;
  const expectedLen = width * height * colors * bytesPerSample;
  if (data.length < expectedLen) {
    throw new Error(`Unexpected data length: got ${data.length}, expected >= ${expectedLen}`);
  }

  // Drop alpha if present.
  let rgb;
  if (colors === 3) {
    rgb = Buffer.from(data);
  } else {
    rgb = Buffer.allocUnsafe(width * height * 3 * bytesPerSample);
    const pxCount = width * height;
    for (let i = 0; i < pxCount; i++) {
      const src = i * 4 * bytesPerSample;
      const dst = i * 3 * bytesPerSample;
      data.copy(rgb, dst, src, src + 3 * bytesPerSample);
    }
  }

  return {
    meta: {
      width,
      height,
      channels: 3,
      bits,
      // Sharp expects native-endian for raw; on Linux x64 this is little-endian.
      endian: 'LE',
    },
    payload: rgb,
  };
}

async function safeClose(processor) {
  if (!processor) return;
  try {
    await processor.close();
  } catch (e) {
    debug('close() failed:', e && e.stack ? e.stack : e);
  }
}

if (!inputPath || !outputPath) {
  console.error('Usage: node dng-worker.js <input> <output>');
  process.exit(1);
}

(async () => {
  const started = process.hrtime.bigint();
  let processor;

  try {
    log('node', process.version, 'platform', process.platform, 'arch', process.arch);
    log('input', inputPath);
    log('output', outputPath);
    debug('cwd', process.cwd());
    debug('env.PHOTOS_DIR', process.env.PHOTOS_DIR);

    try {
      const st = fs.statSync(inputPath);
      debug('input stat', { size: st.size, mode: st.mode.toString(8), uid: st.uid, gid: st.gid });
    } catch (e) {
      log('input stat failed:', e && e.message ? e.message : e);
    }

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    processor = new LibRaw();
    try {
      if (typeof processor.version === 'function') {
        debug('libraw version', await processor.version());
      }
    } catch (e) {
      debug('version() failed:', e && e.message ? e.message : e);
    }

    const tLoad = process.hrtime.bigint();
    debug('loadFile start');
    await processor.loadFile(inputPath);
    debug('loadFile ok', hrMs(tLoad) + 'ms');

    try {
      const meta = await processor.getMetadata();
      debug('metadata', meta);
    } catch (e) {
      debug('getMetadata() failed:', e && e.stack ? e.stack : e);
    }

    const tProcess = process.hrtime.bigint();
    debug('processImage start');
    await processor.processImage();
    debug('processImage ok', hrMs(tProcess) + 'ms');

    const tMem = process.hrtime.bigint();
    debug('createMemoryImage start');
    const imageData = await processor.createMemoryImage();
    debug('createMemoryImage ok', hrMs(tMem) + 'ms', {
      width: imageData.width,
      height: imageData.height,
      colors: imageData.colors,
      bits: imageData.bits,
      dataLength: imageData.data ? imageData.data.length : undefined,
    });

    const tWrite = process.hrtime.bigint();
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.raw') {
      debug('write raw start');
      const { meta, payload } = toRawPayload(imageData);
      fs.writeFileSync(outputPath, payload);
      fs.writeFileSync(`${outputPath}.json`, JSON.stringify(meta));
      debug('write raw ok', hrMs(tWrite) + 'ms');
    } else {
      debug('write ppm start');
      const { header: headerBuffer, payload } = toPpmPayload(imageData);
      const fd = fs.openSync(outputPath, 'w');
      try {
        fs.writeSync(fd, headerBuffer);
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      debug('write ppm ok', hrMs(tWrite) + 'ms');
    }

    await safeClose(processor);
    log('success', { elapsedMs: hrMs(started) });
    process.exit(0);
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    console.error('[dng-worker] error:', msg);
    if (processor) {
      try {
        if (typeof processor.getLastError === 'function') {
          const last = processor.getLastError();
          if (last) console.error('[dng-worker] libraw lastError:', last);
        }
      } catch (e) {
        // ignore
      }
    }
    await safeClose(processor);
    process.exit(1);
  }
})();
