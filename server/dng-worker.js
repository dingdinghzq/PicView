const LibRaw = require('librawspeed');
const fs = require('fs');

const [,, inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: node dng-worker.js <input> <output>');
  process.exit(1);
}

(async () => {
  let processor;
  try {
    processor = new LibRaw();
    await processor.loadFile(inputPath);
    await processor.processImage();
    
    // Get raw data
    const imageData = await processor.createMemoryImage();
    
    // Write PPM file manually (P6 binary)
    // Header: P6\nwidth height\n255\n
    const header = `P6\n${imageData.width} ${imageData.height}\n255\n`;
    const headerBuffer = Buffer.from(header);
    
    // imageData.data is the raw buffer (RGB)
    // We need to ensure it's RGB. LibRaw usually outputs RGB.
    // If colors is 3, it's RGB.
    
    if (imageData.colors !== 3) {
        throw new Error(`Unsupported color depth: ${imageData.colors}`);
    }

    const fd = fs.openSync(outputPath, 'w');
    fs.writeSync(fd, headerBuffer);
    fs.writeSync(fd, imageData.data);
    fs.closeSync(fd);
    
    await processor.close();
    process.exit(0);
  } catch (err) {
    console.error('Worker error:', err);
    if (processor) {
        try { await processor.close(); } catch (e) {}
    }
    process.exit(1);
  }
})();
