'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { input, boolInput, setOutput, stepSummary, eventPayload, listPngs, copyFile, log, warn } = require('./util');
const { GitHub } = require('./github');
const { remoteUrl, checkoutBaseline, commitAndPush } = require('./git');
const { compareDirs, countByStatus } = require('./diffing');
const { buildReport, rawUrls, MARKER } = require('./report');

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = input('github-token', process.env.GITHUB_TOKEN || '');
  const branch = input('baseline-branch', 'nitpix');
  const snapshotsDir = path.resolve(input('snapshots-dir', 'nitpix-snapshots'));
  const event = eventPayload();
  const eventName = process.env.GITHUB_EVENT_NAME || '';

  let mode = input('mode', 'auto');
  if (mode === 'auto') {
    if (event.pull_request) {
      mode = 'diff';
    } else if (event.workflow_run) {
      // workflow_run relays the triggering event: PR-triggered test runs get
      // diffed, push-triggered ones promote their branch's baselines.
      mode = event.workflow_run.event === 'push' ? 'promote' : 'diff';
    } else {
      mode = 'promote';
    }
  }

  const gh = new GitHub(token, repo);
  const remote = remoteUrl(repo, token);
  const workDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nitpix-'));
  const baselineRepoDir = path.join(workDir, 'baseline-repo');

  log(`nitpix: mode=${mode} event=${eventName} snapshots=${snapshotsDir}`);
  checkoutBaseline(remote, branch, baselineRepoDir);

  if (mode === 'promote') {
    await promote({ gh, repo, remote, branch, baselineRepoDir, snapshotsDir, event });
  } else {
    await diff({ gh, repo, remote, branch, baselineRepoDir, snapshotsDir, workDir, event });
  }
}

/**
 * Resolve the PR being diffed. Supports:
 *  - pull_request / pull_request_target events (same-repo PRs)
 *  - workflow_run events (the fork/dependabot-safe topology, where an
 *    unprivileged test workflow uploads snapshots and a privileged follow-up
 *    workflow diffs them). `workflow_run.pull_requests` is empty for fork
 *    PRs, so fall back to looking the PR up by head sha.
 */
async function resolveDiffContext(gh, repo, event) {
  if (event.pull_request) {
    const pr = event.pull_request;
    return { prNumber: pr.number, headSha: pr.head.sha, baseRef: pr.base.ref };
  }
  const wr = event.workflow_run;
  if (wr) {
    const headSha = wr.head_sha;
    let pr = (wr.pull_requests || [])[0];
    if (!pr) {
      const candidates = await gh.get(`/repos/${repo}/commits/${headSha}/pulls`);
      pr = (candidates || []).find((p) => p.state === 'open') || (candidates || [])[0];
    }
    if (!pr) {
      throw new Error(`nitpix: no pull request found for workflow_run head ${headSha.slice(0, 7)}`);
    }
    return { prNumber: pr.number, headSha, baseRef: pr.base.ref };
  }
  throw new Error('nitpix: diff mode requires a pull_request or workflow_run event (or set mode/base explicitly)');
}

/**
 * Promote mode (push to a target branch, e.g. dev/master): the snapshots from
 * this run become the new baselines for that branch. Also prunes pending
 * images and approvals belonging to closed PRs.
 */
async function promote({ gh, repo, remote, branch, baselineRepoDir, snapshotsDir, event }) {
  const wr = event && event.workflow_run;
  let targetBranch = input('base', '');
  if (!targetBranch && wr) {
    // Only promote from push runs of this repo's own branches (fork pushes
    // don't trigger base-repo workflows, but belt and braces).
    if (wr.head_repository && wr.head_repository.full_name !== repo) {
      throw new Error(`nitpix: refusing to promote from fork ${wr.head_repository.full_name}`);
    }
    targetBranch = wr.head_branch;
  }
  if (!targetBranch) targetBranch = process.env.GITHUB_REF_NAME || '';
  if (!targetBranch) throw new Error('nitpix: cannot determine target branch for promote mode');

  const snapshots = listPngs(snapshotsDir);
  if (snapshots.length === 0) {
    // Safety valve: an empty snapshot set is almost always a broken test run,
    // and replacing the baselines with nothing would break every open PR.
    warn(`nitpix: no snapshots found in ${snapshotsDir}; refusing to wipe baselines for ${targetBranch}`);
    setOutput('status', 'skipped');
    return;
  }

  let openPrs = null;
  try {
    openPrs = new Set(await gh.listOpenPullNumbers());
  } catch (err) {
    warn(`nitpix: could not list open PRs, skipping pending cleanup (${err.message})`);
  }

  const sha = commitAndPush(
    remote,
    branch,
    baselineRepoDir,
    (dir) => {
      const dest = path.join(dir, 'baselines', targetBranch);
      fs.rmSync(dest, { recursive: true, force: true });
      for (const name of snapshots) copyFile(path.join(snapshotsDir, name), path.join(dest, name));
      if (openPrs) prune(dir, openPrs);
    },
    `nitpix: update ${targetBranch} baselines (${snapshots.length} snapshots) [${(process.env.GITHUB_SHA || '').slice(0, 7)}]`
  );

  log(`nitpix: promoted ${snapshots.length} snapshots to baselines/${targetBranch} @ ${sha}`);
  stepSummary(`### 👁 nitpix\nPromoted **${snapshots.length}** snapshots to \`baselines/${targetBranch}\`.`);
  setOutput('status', 'promoted');
  setOutput('snapshot-count', String(snapshots.length));
}

function prune(dir, openPrs) {
  const pendingRoot = path.join(dir, 'pending');
  if (fs.existsSync(pendingRoot)) {
    for (const entry of fs.readdirSync(pendingRoot)) {
      const match = /^pr-(\d+)$/.exec(entry);
      if (match && !openPrs.has(Number(match[1]))) {
        fs.rmSync(path.join(pendingRoot, entry), { recursive: true, force: true });
      }
    }
  }
  const approvalsRoot = path.join(dir, 'approvals');
  if (fs.existsSync(approvalsRoot)) {
    for (const entry of fs.readdirSync(approvalsRoot)) {
      const match = /^pr-(\d+)\.json$/.exec(entry);
      if (match && !openPrs.has(Number(match[1]))) {
        fs.rmSync(path.join(approvalsRoot, entry), { force: true });
      }
    }
  }
}

/**
 * Diff mode (pull requests): compare snapshots against the base branch
 * baselines, push new/diff images to the baseline branch for the PR comment,
 * post/update the comment, and set the commit status.
 */
async function diff({ gh, repo, remote, branch, baselineRepoDir, snapshotsDir, workDir, event }) {
  const ctx = await resolveDiffContext(gh, repo, event);
  const prNumber = ctx.prNumber;
  const headSha = ctx.headSha;
  const baseRef = input('base', ctx.baseRef);
  const statusContext = input('status-context', 'nitpix/visual');
  const commandPrefix = input('command-prefix', '/nitpix');
  const threshold = parseFloat(input('threshold', '0.1'));
  const antialiasing = boolInput('antialiasing', true);
  const failOnNew = boolInput('fail-on-new', false);
  const failOnMissing = boolInput('fail-on-missing', false);

  const baselineDir = path.join(baselineRepoDir, 'baselines', baseRef);
  const diffDir = path.join(workDir, 'diffs');
  const results = await compareDirs({ baselineDir, snapshotsDir, diffDir, threshold, antialiasing });
  const counts = countByStatus(results);

  // Snapshots needing approval: every change, plus additions if fail-on-new.
  const reviewable = results.filter(
    (r) => r.status === 'changed' || (failOnNew && r.status === 'added')
  );

  // Previously-approved content hashes for this PR survive re-runs/rebases.
  const approvalsFile = path.join(baselineRepoDir, 'approvals', `pr-${prNumber}.json`);
  const approvedHashes = fs.existsSync(approvalsFile)
    ? JSON.parse(fs.readFileSync(approvalsFile, 'utf8')).hashes || {}
    : {};
  const approvedNames = new Set(
    results.filter((r) => r.hash && approvedHashes[r.name] === r.hash).map((r) => r.name)
  );
  const unapproved = reviewable.filter((r) => !approvedNames.has(r.name));
  if (failOnMissing && counts.missing > 0) {
    unapproved.push(...results.filter((r) => r.status === 'missing'));
  }

  // Push pending images (new + diff for changed/added) so the PR comment can
  // embed them via raw.githubusercontent.com URLs pinned to the pushed commit.
  const pendingDir = `pending/pr-${prNumber}/${headSha.slice(0, 12)}`;
  const visual = results.filter((r) => r.status === 'changed' || r.status === 'added');
  const manifest = {
    pr: prNumber,
    headSha,
    base: baseRef,
    results: results.map(({ name, status, hash, diffPercentage }) => ({ name, status, hash, diffPercentage })),
  };

  let pushedSha = null;
  try {
    pushedSha = commitAndPush(
      remote,
      branch,
      baselineRepoDir,
      (dir) => {
        // keep only the current head's pending images for this PR
        fs.rmSync(path.join(dir, 'pending', `pr-${prNumber}`), { recursive: true, force: true });
        for (const r of visual) {
          copyFile(path.join(snapshotsDir, r.name), path.join(dir, pendingDir, 'new', r.name));
          const diffImg = path.join(diffDir, r.name);
          if (r.status === 'changed' && !r.layoutDiff && fs.existsSync(diffImg)) {
            copyFile(diffImg, path.join(dir, pendingDir, 'diff', r.name));
          }
        }
        fs.mkdirSync(path.join(dir, pendingDir), { recursive: true });
        fs.writeFileSync(path.join(dir, pendingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      },
      `nitpix: pending snapshots for #${prNumber} @ ${headSha.slice(0, 7)}`
    );
  } catch (err) {
    // Fork PRs have a read-only token: still diff and report, just without
    // hosted images / comment / status.
    warn(`nitpix: could not push pending images (fork PR or missing permissions?): ${err.message}`);
  }

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const urls = rawUrls({ repo, commitSha: pushedSha, baseRef, pendingDir });
  const body = buildReport({
    results,
    baseRef,
    headSha,
    urls,
    approvedNames,
    unapproved,
    maxImages: parseInt(input('max-comment-images', '20'), 10),
    commandPrefix,
    runUrl,
  });

  stepSummary(body.replace(MARKER, '').trim());

  let commentUrl = null;
  if (boolInput('comment', true)) {
    try {
      const comment = await gh.upsertComment(prNumber, MARKER, body);
      commentUrl = comment && comment.html_url;
    } catch (err) {
      warn(`nitpix: could not post PR comment: ${err.message}`);
    }
  }

  const state = unapproved.length > 0 ? 'failure' : 'success';
  const description =
    unapproved.length > 0
      ? `${unapproved.length} snapshot(s) need approval — comment "${commandPrefix} approve"`
      : `${counts.changed} changed, ${counts.added} added — all approved`;
  try {
    await gh.setStatus(headSha, {
      state,
      context: statusContext,
      description,
      targetUrl: commentUrl || runUrl,
    });
  } catch (err) {
    warn(`nitpix: could not set commit status: ${err.message}`);
  }

  setOutput('status', state === 'success' ? 'passed' : 'needs-approval');
  setOutput('changed-count', String(counts.changed));
  setOutput('added-count', String(counts.added));
  setOutput('missing-count', String(counts.missing));
  setOutput('unapproved-count', String(unapproved.length));

  log(`nitpix: ${description}`);
  if (unapproved.length > 0 && boolInput('fail-on-change', false)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`::error::nitpix failed: ${err.stack || err}\n`);
  process.exitCode = 1;
});
