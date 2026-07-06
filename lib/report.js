'use strict';

const { encodePath } = require('./util');
const { countByStatus } = require('./diffing');

const MARKER = '<!-- nitpix-report -->';

/**
 * Build the PR comment / step summary markdown.
 *
 * urls: { baseline(name), snapshot(name), diff(name) } returning a raw image
 * URL or null (e.g. fork PRs where we couldn't push pending images).
 */
function buildReport({
  results,
  baseRef,
  headSha,
  urls,
  approvedNames,
  unapproved,
  maxImages,
  commandPrefix,
  runUrl,
}) {
  const counts = countByStatus(results);
  const changed = results.filter((r) => r.status === 'changed');
  const added = results.filter((r) => r.status === 'added');
  const missing = results.filter((r) => r.status === 'missing');

  const lines = ['<!-- nitpix-report -->', '## 👁 nitpix visual review', ''];

  const needsReview = unapproved.length > 0;
  const verdict = needsReview
    ? `❌ **${unapproved.length} snapshot${unapproved.length === 1 ? '' : 's'} need${unapproved.length === 1 ? 's' : ''} approval**`
    : counts.changed + counts.added > 0
      ? '✅ all visual changes approved'
      : '✅ no visual changes';
  lines.push(
    `${verdict} — ${counts.changed} changed, ${counts.added} added, ${counts.missing} missing, ${counts.unchanged} unchanged`,
    '',
    `Comparing \`${headSha.slice(0, 7)}\` against \`${baseRef}\` baselines.` + (runUrl ? ` ([run](${runUrl}))` : ''),
    ''
  );

  let imagesUsed = 0;
  const imageBudgetExceeded = () => imagesUsed >= maxImages;

  for (const r of changed) {
    const approved = approvedNames.has(r.name) ? ' — ✅ approved' : '';
    const pct = r.layoutDiff
      ? 'size changed'
      : r.diffPercentage !== undefined
        ? `${r.diffPercentage.toFixed(2)}% diff`
        : 'changed';
    lines.push(`<details><summary>🔄 <code>${escapeHtml(r.name)}</code> (${pct})${approved}</summary>`, '');
    if (urls.baseline && !imageBudgetExceeded()) {
      imagesUsed++;
      const cells = [
        `<img src="${urls.baseline(r.name)}" width="260">`,
        `<img src="${urls.snapshot(r.name)}" width="260">`,
        r.layoutDiff ? '—' : `<img src="${urls.diff(r.name)}" width="260">`,
      ];
      lines.push('| baseline | new | diff |', '| --- | --- | --- |', `| ${cells.join(' | ')} |`);
    } else if (!urls.baseline) {
      lines.push('_images unavailable (no write access to the baseline branch — see the report artifact)_');
    } else {
      lines.push('_image budget exceeded — see the run artifacts for this diff_');
    }
    lines.push('', '</details>', '');
  }

  for (const r of added) {
    const approved = approvedNames.has(r.name) ? ' — ✅ approved' : '';
    lines.push(`<details><summary>🆕 <code>${escapeHtml(r.name)}</code> (new snapshot)${approved}</summary>`, '');
    if (urls.snapshot && !imageBudgetExceeded()) {
      imagesUsed++;
      lines.push(`<img src="${urls.snapshot(r.name)}" width="260">`);
    } else if (!urls.snapshot) {
      lines.push('_image unavailable (no write access to the baseline branch)_');
    } else {
      lines.push('_image budget exceeded — see the run artifacts_');
    }
    lines.push('', '</details>', '');
  }

  if (missing.length) {
    lines.push(
      '<details><summary>👻 missing snapshots (baseline exists but was not captured this run)</summary>',
      '',
      ...missing.map((r) => `- \`${r.name}\``),
      '',
      '</details>',
      ''
    );
  }

  if (needsReview) {
    lines.push(`To approve these changes, comment \`${commandPrefix} approve\` (write access required).`);
  }

  return lines.join('\n');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build url helpers pointing at a pinned commit on the baseline branch. */
function rawUrls({ repo, commitSha, baseRef, pendingDir }) {
  if (!commitSha) return { baseline: null, snapshot: null, diff: null };
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const rawHost = server === 'https://github.com' ? 'https://raw.githubusercontent.com' : `${server}/raw`;
  const base = `${rawHost}/${repo}/${commitSha}`;
  return {
    baseline: (name) => `${base}/baselines/${encodePath(baseRef)}/${encodePath(name)}`,
    snapshot: (name) => `${base}/${pendingDir}/new/${encodePath(name)}`,
    diff: (name) => `${base}/${pendingDir}/diff/${encodePath(name)}`,
  };
}

module.exports = { buildReport, rawUrls, MARKER };
