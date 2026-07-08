'use strict';

const fs = require('fs');
const path = require('path');

const { pool, warn } = require('./util');

/**
 * Load sharp from the runtime-installed prefix (same dir the action installs
 * odiff-bin into) or a regular require (tests). Returns null when
 * unavailable — callers fall back to embedding full-size images.
 */
function loadSharp() {
  try {
    const dir = process.env.NITPIX_ODIFF_DIR;
    if (dir) return require(path.join(dir, 'node_modules', 'sharp'));
    return require('sharp');
  } catch (err) {
    warn(`nitpix: sharp unavailable, comment will embed full-size images (${err.message})`);
    return null;
  }
}

/**
 * Generate thumbnails for the report comment. `jobs` is a list of
 * { src, kind, name }; thumbnails land in outDir/<kind>/<name>.
 * Returns true when thumbnails were generated.
 */
async function makeThumbs(jobs, outDir, width) {
  if (!width || jobs.length === 0) return false;
  const sharp = loadSharp();
  if (!sharp) return false;
  await pool(jobs, 4, async ({ src, kind, name }) => {
    const dest = path.join(outDir, kind, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await sharp(src).resize({ width, withoutEnlargement: true }).png().toFile(dest);
  });
  return true;
}

module.exports = { makeThumbs };
