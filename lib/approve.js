'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { input, setOutput, eventPayload, log, warn } = require('./util');
const { GitHub } = require('./github');
const { remoteUrl, checkoutBaseline, commitAndPush } = require('./git');

/**
 * Handles `/nitpix approve` PR comments (issue_comment workflow).
 * Records the content hashes of the PR's changed/added snapshots in
 * approvals/pr-<n>.json on the baseline branch, then flips the commit status
 * to success. Re-runs with identical pixels stay approved (hash match);
 * genuinely new changes go red again.
 */
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = input('github-token', process.env.GITHUB_TOKEN || '');
  const branch = input('baseline-branch', 'nitpix');
  const statusContext = input('status-context', 'nitpix/visual');
  const commandPrefix = input('command-prefix', '/nitpix');

  const event = eventPayload();
  const comment = event.comment;
  const issue = event.issue;
  if (!comment || !issue) throw new Error('nitpix approve: expected an issue_comment event');

  const body = (comment.body || '').trim();
  const match = new RegExp(`^${escapeRegExp(commandPrefix)}\\s+(approve|approved|lgtm)\\b`, 'i').exec(body);
  if (!match) {
    log(`nitpix approve: comment is not a "${commandPrefix} approve" command, nothing to do`);
    setOutput('status', 'ignored');
    return;
  }
  if (!issue.pull_request) {
    log('nitpix approve: comment is not on a pull request, nothing to do');
    setOutput('status', 'ignored');
    return;
  }

  const gh = new GitHub(token, repo);
  const prNumber = issue.number;
  const user = comment.user.login;

  const permission = await gh.userPermission(user);
  if (!['admin', 'write', 'maintain'].includes(permission)) {
    warn(`nitpix approve: @${user} has "${permission}" permission; write access is required`);
    await tryReact(gh, comment.id, '-1');
    setOutput('status', 'denied');
    return;
  }

  const pr = await gh.getPull(prNumber);
  const headSha = pr.head.sha;

  const workDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'nitpix-approve-'));
  const repoDir = path.join(workDir, 'baseline-repo');
  const remote = remoteUrl(repo, token);
  checkoutBaseline(remote, branch, repoDir);

  const manifestFile = path.join(repoDir, 'pending', `pr-${prNumber}`, headSha.slice(0, 12), 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    warn(`nitpix approve: no pending report found for #${prNumber} @ ${headSha.slice(0, 7)}`);
    await tryComment(
      gh,
      prNumber,
      `@${user} there is no nitpix report for the current head (\`${headSha.slice(0, 7)}\`) — ` +
        'the visual tests may still be running, or the PR was updated since the last report. ' +
        'Re-run the visual workflow and try again.'
    );
    setOutput('status', 'stale');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const toApprove = manifest.results.filter((r) => r.status === 'changed' || r.status === 'added');
  if (toApprove.length === 0) {
    log('nitpix approve: nothing to approve');
    await tryReact(gh, comment.id, '+1');
    setOutput('status', 'noop');
    return;
  }

  commitAndPush(
    remote,
    branch,
    repoDir,
    (dir) => {
      const approvalsFile = path.join(dir, 'approvals', `pr-${prNumber}.json`);
      const existing = fs.existsSync(approvalsFile)
        ? JSON.parse(fs.readFileSync(approvalsFile, 'utf8'))
        : { hashes: {} };
      for (const r of toApprove) existing.hashes[r.name] = r.hash;
      existing.headSha = headSha;
      existing.approvedBy = user;
      existing.approvedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(approvalsFile), { recursive: true });
      fs.writeFileSync(approvalsFile, JSON.stringify(existing, null, 2));
    },
    `nitpix: approve #${prNumber} @ ${headSha.slice(0, 7)} by ${user} (${toApprove.length} snapshots)`
  );

  await gh.setStatus(headSha, {
    state: 'success',
    context: statusContext,
    description: `${toApprove.length} snapshot(s) approved by @${user}`,
  });
  await tryReact(gh, comment.id, 'rocket');

  log(`nitpix approve: approved ${toApprove.length} snapshots for #${prNumber} by @${user}`);
  setOutput('status', 'approved');
  setOutput('approved-count', String(toApprove.length));
}

async function tryReact(gh, commentId, content) {
  try {
    await gh.reactToComment(commentId, content);
  } catch (err) {
    warn(`nitpix approve: could not add reaction: ${err.message}`);
  }
}

async function tryComment(gh, prNumber, body) {
  try {
    await gh.createComment(prNumber, body);
  } catch (err) {
    warn(`nitpix approve: could not comment: ${err.message}`);
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((err) => {
  process.stderr.write(`::error::nitpix approve failed: ${err.stack || err}\n`);
  process.exitCode = 1;
});
