'use strict';

const fs = require('fs');
const path = require('path');

const { listPngs, sha256File, pool, log } = require('./util');

/**
 * Load odiff-bin. The action installs it with
 * `npm install --prefix $RUNNER_TEMP/nitpix-odiff odiff-bin@<version>` and
 * exports NITPIX_ODIFF_DIR; tests fall back to a regular require.
 */
function loadOdiff() {
  const dir = process.env.NITPIX_ODIFF_DIR;
  if (dir) return require(path.join(dir, 'node_modules', 'odiff-bin'));
  return require('odiff-bin');
}

/**
 * Compare the snapshots in `snapshotsDir` against `baselineDir`.
 * Diff images for changed snapshots are written under `diffDir`.
 *
 * Returns a sorted array of:
 *   { name, status: 'added'|'changed'|'unchanged'|'missing',
 *     hash?, diffPercentage?, layoutDiff? }
 * `missing` = baseline exists but no snapshot was produced this run.
 */
async function compareDirs({ baselineDir, snapshotsDir, diffDir, threshold, antialiasing }) {
  const { compare } = loadOdiff();
  const baselines = new Set(listPngs(baselineDir));
  const snapshots = listPngs(snapshotsDir);
  const results = [];

  for (const name of baselines) {
    if (!snapshots.includes(name)) results.push({ name, status: 'missing' });
  }

  await pool(snapshots, 4, async (name) => {
    const snapPath = path.join(snapshotsDir, name);
    const hash = sha256File(snapPath);
    if (!baselines.has(name)) {
      results.push({ name, status: 'added', hash });
      return;
    }
    const diffPath = path.join(diffDir, name);
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    const result = await compare(path.join(baselineDir, name), snapPath, diffPath, {
      antialiasing,
      threshold,
    });
    if (result.match) {
      results.push({ name, status: 'unchanged', hash });
    } else if (result.reason === 'layout-diff') {
      results.push({ name, status: 'changed', hash, layoutDiff: true });
    } else if (result.reason === 'pixel-diff') {
      results.push({ name, status: 'changed', hash, diffPercentage: result.diffPercentage });
    } else {
      throw new Error(`odiff failed on ${name}: ${JSON.stringify(result)}`);
    }
  });

  results.sort((a, b) => a.name.localeCompare(b.name));
  const counts = countByStatus(results);
  log(`nitpix: compared ${snapshots.length} snapshots -> ${counts.changed} changed, ${counts.added} added, ${counts.missing} missing, ${counts.unchanged} unchanged`);
  return results;
}

function countByStatus(results) {
  const counts = { added: 0, changed: 0, unchanged: 0, missing: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

module.exports = { compareDirs, countByStatus, loadOdiff };
