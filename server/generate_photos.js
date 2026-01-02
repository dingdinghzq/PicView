const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');

const PHOTOS_DIR = path.join(__dirname, '../photos');

async function generate() {
  await fs.ensureDir(PHOTOS_DIR);

  const folders = ['Nature', 'City', 'Space'];
  
  for (const folder of folders) {
    const folderPath = path.join(PHOTOS_DIR, folder);
    await fs.ensureDir(folderPath);
    console.log(`Created ${folder}`);

    for (let i = 1; i <= 5; i++) {
      const fileName = `img${i}.jpg`;
      const filePath = path.join(folderPath, fileName);
      
      // Create a random color image
      const r = Math.floor(Math.random() * 255);
      const g = Math.floor(Math.random() * 255);
      const b = Math.floor(Math.random() * 255);

      await sharp({
        create: {
          width: 1920,
          height: 1080,
          channels: 3,
          background: { r, g, b }
        }
      })
      .jpeg()
      .toFile(filePath);
      
      console.log(`  Created ${fileName}`);
    }
  }
}

generate().catch(console.error);
