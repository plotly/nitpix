'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { log, warn } = require('./util');

const GIT_IDENTITY = [
  '-c', 'user.name=nitpix[bot]',
  '-c', 'user.email=nitpix[bot]@users.noreply.github.com',
];

function git(args, cwd) {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Remote URL for the baseline branch. NITPIX_REMOTE_URL overrides for tests
 * (a local bare repo); otherwise an authenticated https URL for `repo`.
 */
function remoteUrl(repo, token) {
  if (process.env.NITPIX_REMOTE_URL) return process.env.NITPIX_REMOTE_URL;
  const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/^https:\/\//, '');
  return `https://x-access-token:${token}@${server}/${repo}.git`;
}

function branchExists(remote, branch) {
  return git(['ls-remote', '--heads', remote, branch]) !== '';
}

/**
 * Clone the baseline branch (shallow) into dir, creating the orphan branch
 * locally if it doesn't exist on the remote yet.
 */
function checkoutBaseline(remote, branch, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  if (branchExists(remote, branch)) {
    git(['clone', '--depth', '1', '--branch', branch, '--single-branch', remote, dir]);
    return { created: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', branch], dir);
  git(['remote', 'add', 'origin', remote], dir);
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# nitpix baselines\n\nThis orphan branch is managed by [nitpix](https://github.com/plotly/nitpix). Do not edit by hand.\n'
  );
  return { created: true };
}

/**
 * Apply changes and push, retrying with a fresh clone on push races.
 * `applyFn(dir)` must be re-runnable: it re-applies the changes from scratch
 * against whatever the branch currently contains.
 * Returns the pushed commit sha, or the current HEAD sha if nothing changed.
 */
function commitAndPush(remote, branch, dir, applyFn, message, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    applyFn(dir);
    git(['add', '-A'], dir);
    const dirty = git(['status', '--porcelain'], dir) !== '';
    if (dirty) {
      git(['commit', '-m', message], dir);
    } else {
      log('nitpix: baseline branch already up to date, nothing to push');
      try {
        return git(['rev-parse', 'HEAD'], dir);
      } catch {
        return null; // freshly-initialized branch with no commits and no changes
      }
    }
    try {
      git(['push', '-u', 'origin', branch], dir);
      return git(['rev-parse', 'HEAD'], dir);
    } catch (err) {
      if (attempt >= attempts) throw err;
      warn(`nitpix: push to ${branch} rejected (attempt ${attempt}), re-cloning and retrying`);
      checkoutBaseline(remote, branch, dir);
    }
  }
}

module.exports = { remoteUrl, checkoutBaseline, commitAndPush };
