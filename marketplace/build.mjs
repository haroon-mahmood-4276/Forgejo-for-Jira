// Renders the Marketplace illustrations.
//
//   node marketplace/build.mjs                 render every image
//   node marketplace/build.mjs logo banner     render only names containing these words
//
// Each scene in scenes.mjs is written to marketplace/svg/<name>.svg (the editable
// source) and then screenshotted by headless Chrome into marketplace/images/<name>.png
// (the file you upload to the Marketplace listing). Chrome is used because it is
// already on most developer machines and renders SVG text and shadows faithfully.
// Set CHROME_PATH if yours is somewhere else.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IMAGES } from './scenes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const svgDir = join(here, 'svg');
const imageDir = join(here, 'images');

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH to a Chrome or Chromium binary.`);
  process.exit(1);
}

mkdirSync(svgDir, { recursive: true });
mkdirSync(imageDir, { recursive: true });

// Any command-line words act as a filter, so one image can be re-rendered quickly.
const filters = process.argv.slice(2);
const selected = IMAGES.filter(
  ({ name }) => filters.length === 0 || filters.some((word) => name.includes(word)),
);

if (selected.length === 0) {
  console.error(`No image name contains: ${filters.join(', ')}`);
  process.exit(1);
}

// A throwaway profile stops Chrome from clashing with a browser that is already open.
const profile = mkdtempSync(join(tmpdir(), 'forgejo-marketplace-'));

try {
  for (const { name, width, height, svg } of selected) {
    const svgPath = join(svgDir, `${name}.svg`);
    const pngPath = join(imageDir, `${name}.png`);
    writeFileSync(svgPath, svg);

    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        // Transparent page background, so rounded corners (the logo) stay transparent.
        '--default-background-color=00000000',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--screenshot=${pngPath}`,
        pathToFileURL(svgPath).href,
      ],
      { stdio: 'pipe', timeout: 60_000 },
    );

    // The Marketplace rejects images that are not exactly the size it asks for,
    // so fail loudly rather than upload a 1px-off screenshot. A PNG stores its
    // width and height as two 32-bit numbers at byte 16 and 20.
    const png = readFileSync(pngPath);
    const actual = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
    if (actual !== `${width}x${height}`) {
      throw new Error(`${name}.png is ${actual}, expected ${width}x${height}`);
    }
    console.log(`ok  ${name}.png  ${actual}`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
