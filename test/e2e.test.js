'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { solid } = require('./png');

const ROOT = path.join(__dirname, '..');
const HEAD_SHA = 'a'.repeat(40);

// --- shared fixture: a bare "origin" repo and a fake GitHub API ------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitpix-test-'));
const originDir = path.join(tmp, 'origin.git');
const snapshotsDir = path.join(tmp, 'snapshots');
const stubsFile = path.join(tmp, 'stubs.json');
const callLog = path.join(tmp, 'calls.jsonl');

execFileSync('git', ['init', '--bare', originDir], { stdio: 'ignore' });

const STUBS = {
  'GET /repos/plotly/dash/pulls?state=open': [],
  'GET /repos/plotly/dash/pulls/42': { number: 42, head: { sha: HEAD_SHA }, base: { ref: 'dev' } },
  'GET /repos/plotly/dash/issues/42/comments?': [],
  'POST /repos/plotly/dash/issues/42/comments': { id: 1, html_url: 'https://example.com/comment' },
  'POST /repos/plotly/dash/statuses/': {},
  'POST /repos/plotly/dash/issues/comments/5/reactions': {},
  'GET /repos/plotly/dash/collaborators/alice/permission': { permission: 'write' },
  'GET /repos/plotly/dash/collaborators/mallory/permission': { permission: 'read' },
  // fork PRs: workflow_run.pull_requests is empty, PR is looked up by head sha
  [`GET /repos/plotly/dash/commits/${HEAD_SHA}/pulls`]: [
    { number: 42, state: 'open', head: { sha: HEAD_SHA }, base: { ref: 'dev' } },
  ],
};
fs.writeFileSync(stubsFile, JSON.stringify(STUBS));

function writeSnapshots(images) {
  fs.rmSync(snapshotsDir, { recursive: true, force: true });
  for (const [name, buf] of Object.entries(images)) {
    const file = path.join(snapshotsDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
}

/** Run lib/<script> with a fabricated Actions environment. */
function run(script, { eventName, event, inputs = {}, env = {} }) {
  const eventFile = path.join(tmp, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify(event));
  const outputFile = path.join(tmp, 'output.txt');
  const summaryFile = path.join(tmp, 'summary.md');
  fs.writeFileSync(outputFile, '');
  fs.writeFileSync(summaryFile, '');
  fs.writeFileSync(callLog, '');

  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_REPOSITORY: 'plotly/dash',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_SHA: 'f'.repeat(40),
    RUNNER_TEMP: tmp,
    NITPIX_REMOTE_URL: `file://${originDir}`,
    NITPIX_STUBS: stubsFile,
    NITPIX_CALL_LOG: callLog,
    INPUT_GITHUB_TOKEN: 'test-token',
    INPUT_SNAPSHOTS_DIR: snapshotsDir,
    ...Object.fromEntries(
      Object.entries(inputs).map(([k, v]) => [`INPUT_${k.replace(/-/g, '_').toUpperCase()}`, v])
    ),
    ...env,
  };

  const stdout = execFileSync(process.execPath, [path.join(ROOT, 'lib', script)], {
    env: childEnv,
    encoding: 'utf8',
  });
  const outputs = Object.fromEntries(
    fs
      .readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/).slice(0, 2))
  );
  const calls = fs
    .readFileSync(callLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  return { stdout, outputs, calls, summary: fs.readFileSync(summaryFile, 'utf8') };
}

/** Files (relative paths) currently on the baseline branch at origin. */
function baselineBranchFiles() {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'nitpix'], {
    cwd: originDir,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).sort();
}

function baselineBranchFile(relPath) {
  return execFileSync('git', ['show', `nitpix:${relPath}`], { cwd: originDir });
}

const RED = solid(80, 60, [200, 30, 30]);
const RED2 = solid(80, 60, [30, 160, 30]); // clearly different from RED
const BLUE = solid(80, 60, [30, 30, 200]);
const GREEN = solid(80, 60, [30, 200, 30]);
const YELLOW = solid(80, 60, [220, 220, 30]);

// --- the scenario, in order ------------------------------------------------

test('promote: push to dev seeds the baselines on the orphan branch', () => {
  writeSnapshots({ 'a.png': RED, 'b.png': BLUE, 'sub/c.png': GREEN });
  const { outputs } = run('main.js', {
    eventName: 'push',
    event: {},
    env: { GITHUB_REF_NAME: 'dev' },
  });
  assert.equal(outputs.status, 'promoted');
  assert.equal(outputs['snapshot-count'], '3');
  const files = baselineBranchFiles();
  assert.ok(files.includes('baselines/dev/a.png'));
  assert.ok(files.includes('baselines/dev/b.png'));
  assert.ok(files.includes('baselines/dev/sub/c.png'));
});

test('promote: refuses to wipe baselines when no snapshots were produced', () => {
  writeSnapshots({});
  const { outputs } = run('main.js', {
    eventName: 'push',
    event: {},
    env: { GITHUB_REF_NAME: 'dev' },
  });
  assert.equal(outputs.status, 'skipped');
  assert.ok(baselineBranchFiles().includes('baselines/dev/a.png'));
});

const PR_EVENT = {
  pull_request: { number: 42, head: { sha: HEAD_SHA }, base: { ref: 'dev' } },
};

test('diff: PR with a changed, an added and a missing snapshot goes red', () => {
  // a changed, b unchanged, sub/c missing, d added
  writeSnapshots({ 'a.png': RED2, 'b.png': BLUE, 'd.png': YELLOW });
  const { outputs, calls, summary } = run('main.js', {
    eventName: 'pull_request',
    event: PR_EVENT,
  });

  assert.equal(outputs.status, 'needs-approval');
  assert.equal(outputs['changed-count'], '1');
  assert.equal(outputs['added-count'], '1');
  assert.equal(outputs['missing-count'], '1');
  assert.equal(outputs['unapproved-count'], '1'); // only the change; fail-on-new defaults off

  // pending images + manifest pushed to the baseline branch
  const pending = `pending/pr-42/${HEAD_SHA.slice(0, 12)}`;
  const files = baselineBranchFiles();
  assert.ok(files.includes(`${pending}/new/a.png`));
  assert.ok(files.includes(`${pending}/diff/a.png`));
  assert.ok(files.includes(`${pending}/new/d.png`));
  assert.ok(files.includes(`${pending}/manifest.json`));

  // commit status failure was posted for the head sha
  const status = calls.find((c) => c.method === 'POST' && c.path.includes('/statuses/'));
  assert.ok(status.path.endsWith(`/statuses/${HEAD_SHA}`));
  assert.equal(status.body.state, 'failure');
  assert.equal(status.body.context, 'nitpix/visual');

  // comment posted with the report
  const comment = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/42/comments'));
  assert.ok(comment.body.body.includes('nitpix-report'));
  assert.ok(comment.body.body.includes('a.png'));
  assert.ok(summary.includes('a.png'));
});

test('approve: write-access comment records hashes and flips status green', () => {
  const { outputs, calls } = run('approve.js', {
    eventName: 'issue_comment',
    event: {
      comment: { id: 5, body: '/nitpix approve', user: { login: 'alice' } },
      issue: { number: 42, pull_request: {} },
    },
  });
  assert.equal(outputs.status, 'approved');
  assert.equal(outputs['approved-count'], '2'); // changed a.png + added d.png

  const approvals = JSON.parse(baselineBranchFile('approvals/pr-42.json').toString());
  assert.equal(approvals.approvedBy, 'alice');
  assert.ok(approvals.hashes['a.png']);
  assert.ok(approvals.hashes['d.png']);

  const status = calls.find((c) => c.method === 'POST' && c.path.includes('/statuses/'));
  assert.equal(status.body.state, 'success');
  const reaction = calls.find((c) => c.path.includes('/reactions'));
  assert.equal(reaction.body.content, 'rocket');
});

test('approve: read-only user is denied', () => {
  const { outputs, calls } = run('approve.js', {
    eventName: 'issue_comment',
    event: {
      comment: { id: 5, body: '/nitpix approve', user: { login: 'mallory' } },
      issue: { number: 42, pull_request: {} },
    },
  });
  assert.equal(outputs.status, 'denied');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.includes('/statuses/')));
});

test('diff: re-run with identical pixels stays approved (hash match)', () => {
  writeSnapshots({ 'a.png': RED2, 'b.png': BLUE, 'd.png': YELLOW });
  const { outputs, calls } = run('main.js', {
    eventName: 'pull_request',
    event: PR_EVENT,
  });
  assert.equal(outputs.status, 'passed');
  assert.equal(outputs['unapproved-count'], '0');
  const status = calls.find((c) => c.method === 'POST' && c.path.includes('/statuses/'));
  assert.equal(status.body.state, 'success');
});

test('diff: pushing NEW pixels after approval goes red again', () => {
  writeSnapshots({ 'a.png': GREEN, 'b.png': BLUE, 'd.png': YELLOW });
  const { outputs } = run('main.js', {
    eventName: 'pull_request',
    event: PR_EVENT,
  });
  assert.equal(outputs.status, 'needs-approval');
  assert.equal(outputs['unapproved-count'], '1');
});

test('diff via workflow_run: fork PR is resolved by head sha and fully reported', () => {
  // Same PR state as the previous test (a.png diverged again after approval),
  // but delivered through the fork/dependabot-safe workflow_run topology
  // where pull_requests[] is empty in the payload.
  writeSnapshots({ 'a.png': GREEN, 'b.png': BLUE, 'd.png': YELLOW });
  const { outputs, calls } = run('main.js', {
    eventName: 'workflow_run',
    event: {
      workflow_run: {
        id: 12345,
        event: 'pull_request',
        head_sha: HEAD_SHA,
        head_branch: 'feature',
        pull_requests: [],
      },
    },
  });
  assert.equal(outputs.status, 'needs-approval');
  assert.equal(outputs['unapproved-count'], '1');
  // PR was looked up via the commits/<sha>/pulls API
  assert.ok(calls.some((c) => c.path === `/repos/plotly/dash/commits/${HEAD_SHA}/pulls`));
  // status + comment posted against PR #42's head as usual
  const status = calls.find((c) => c.method === 'POST' && c.path.includes('/statuses/'));
  assert.ok(status.path.endsWith(`/statuses/${HEAD_SHA}`));
  assert.equal(status.body.state, 'failure');
});

test('promote via workflow_run: push-triggered test run updates its branch baselines', () => {
  writeSnapshots({ 'a.png': RED, 'b.png': BLUE });
  const { outputs } = run('main.js', {
    eventName: 'workflow_run',
    event: {
      workflow_run: {
        id: 12346,
        event: 'push',
        head_sha: 'b'.repeat(40),
        head_branch: 'master',
        head_repository: { full_name: 'plotly/dash' },
        pull_requests: [],
      },
    },
  });
  assert.equal(outputs.status, 'promoted');
  assert.ok(baselineBranchFiles().includes('baselines/master/a.png'));
});

test('promote: merge to dev updates baselines and prunes closed-PR data', () => {
  // PR #42 is no longer in the open list (stub returns [])
  writeSnapshots({ 'a.png': RED2, 'b.png': BLUE, 'd.png': YELLOW });
  const { outputs } = run('main.js', {
    eventName: 'push',
    event: {},
    env: { GITHUB_REF_NAME: 'dev' },
  });
  assert.equal(outputs.status, 'promoted');
  const files = baselineBranchFiles();
  assert.ok(files.includes('baselines/dev/d.png'));
  assert.ok(!files.includes('baselines/dev/sub/c.png'), 'removed snapshot should drop from baselines');
  assert.ok(!files.some((f) => f.startsWith('pending/pr-42/')), 'closed PR pending data pruned');
  assert.ok(!files.includes('approvals/pr-42.json'), 'closed PR approvals pruned');
  // and the promoted baseline actually has the new pixels
  assert.deepEqual(baselineBranchFile('baselines/dev/a.png'), RED2);
});
