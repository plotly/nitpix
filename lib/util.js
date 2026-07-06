'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Read an action input (mapped to INPUT_* env vars by action.yml). */
function input(name, fallback = '') {
  const key = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  const val = process.env[key];
  return val === undefined || val === '' ? fallback : val;
}

function boolInput(name, fallback = false) {
  const val = input(name, '');
  if (val === '') return fallback;
  return ['true', '1', 'yes'].includes(val.toLowerCase());
}

/** Write a step output (GITHUB_OUTPUT file). */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${value}\n`);
}

/** Append markdown to the job step summary. */
function stepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, markdown + '\n');
}

/** Parsed webhook event payload, or {} when unavailable. */
function eventPayload() {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Recursively list *.png files under dir, as sorted relative paths. */
function listPngs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Encode a snapshot relative path for use in a raw.githubusercontent.com URL. */
function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** Run async tasks with bounded concurrency, preserving order of results. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  // ::warning:: shows up in the Actions UI annotations
  process.stdout.write(`::warning::${msg}\n`);
}

module.exports = {
  input,
  boolInput,
  setOutput,
  stepSummary,
  eventPayload,
  listPngs,
  sha256File,
  copyFile,
  encodePath,
  pool,
  log,
  warn,
};
