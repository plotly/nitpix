'use strict';

const { encodePath } = require('./util');
const { countByStatus } = require('./diffing');

const MARKER = '<!-- nitpix-report -->';

/**
 * Build the PR comment / step summary markdown.
 *
 * urls: { baseline(name), snapshot(name), diff(name), thumb(kind, name) }
 * returning a raw image URL, or null helpers when images couldn't be pushed
 * (e.g. fork PRs without the workflow_run topology). thumb() returns null
 * when thumbnails are disabled — full images are embedded instead.
 *
 * Comment-weight strategy (GitHub loads every <img> in a comment at once,
 * even inside closed <details>, and `width=` doesn't reduce the download):
 * - inline images are small thumbnails hyperlinked to the full-size files
 * - snapshots are ordered by severity and only `maxImages` inline images are
 *   embedded (changed rows cost 3, added rows cost 1); the rest degrade to
 *   plain baseline/new/diff links
 * - with `inlineImages: false` the whole report is links-only; main.js posts
 *   that version first so notification emails never embed images, then
 *   immediately edits in the full version (GitHub only emails on creation)
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
  inlineImages = true,
}) {
  const counts = countByStatus(results);
  const bySeverity = (a, b) =>
    (b.layoutDiff ? 100 : b.diffPercentage || 0) - (a.layoutDiff ? 100 : a.diffPercentage || 0);
  const changed = results.filter((r) => r.status === 'changed').sort(bySeverity);
  const added = results.filter((r) => r.status === 'added');
  const missing = results.filter((r) => r.status === 'missing');

  const lines = [MARKER, '## 👁 nitpix visual review', ''];

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
  const canEmbed = (cost) => inlineImages && urls.baseline && imagesUsed + cost <= maxImages;

  // thumbnail-if-available <img> wrapped in a link to the full image
  const img = (kind, name) => {
    const full = urls[kind](name);
    const thumb = urls.thumb && urls.thumb(kind, name);
    return `<a href="${full}"><img src="${thumb || full}" width="260"></a>`;
  };
  const linkRow = (r) => {
    if (!urls.baseline) return '_images unavailable (no write access to the baseline branch)_';
    const parts = [`[new](${urls.snapshot(r.name)})`];
    if (r.status === 'changed') {
      parts.unshift(`[baseline](${urls.baseline(r.name)})`);
      if (!r.layoutDiff) parts.push(`[diff](${urls.diff(r.name)})`);
    }
    return parts.join(' · ');
  };

  for (const r of changed) {
    const approved = approvedNames.has(r.name) ? ' — ✅ approved' : '';
    const pct = r.layoutDiff
      ? 'size changed'
      : r.diffPercentage !== undefined
        ? `${r.diffPercentage.toFixed(2)}% diff`
        : 'changed';
    lines.push(`<details><summary>🔄 <code>${escapeHtml(r.name)}</code> (${pct})${approved}</summary>`, '');
    if (canEmbed(3)) {
      imagesUsed += 3;
      const cells = [img('baseline', r.name), img('snapshot', r.name), r.layoutDiff ? '—' : img('diff', r.name)];
      lines.push('| baseline | new | diff |', '| --- | --- | --- |', `| ${cells.join(' | ')} |`);
    } else {
      lines.push(linkRow(r));
    }
    lines.push('', '</details>', '');
  }

  for (const r of added) {
    const approved = approvedNames.has(r.name) ? ' — ✅ approved' : '';
    lines.push(`<details><summary>🆕 <code>${escapeHtml(r.name)}</code> (new snapshot)${approved}</summary>`, '');
    if (canEmbed(1)) {
      imagesUsed += 1;
      lines.push(img('snapshot', r.name));
    } else {
      lines.push(linkRow(r));
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

  if (inlineImages && urls.baseline && imagesUsed >= maxImages && changed.length + added.length > 0) {
    lines.push(`_Inline image budget (${maxImages}) reached — remaining snapshots are linked above._`, '');
  }

  if (needsReview) {
    lines.push(`To approve these changes, comment \`${commandPrefix} approve\` (write access required).`);
  }

  return lines.join('\n');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build url helpers pointing at a pinned commit on the baseline branch.
 * `hasThumbs` controls whether thumb() resolves into pending/<...>/thumb/.
 */
function rawUrls({ repo, commitSha, baseRef, pendingDir, hasThumbs = false }) {
  if (!commitSha) return { baseline: null, snapshot: null, diff: null, thumb: null };
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const rawHost = server === 'https://github.com' ? 'https://raw.githubusercontent.com' : `${server}/raw`;
  const base = `${rawHost}/${repo}/${commitSha}`;
  return {
    baseline: (name) => `${base}/baselines/${encodePath(baseRef)}/${encodePath(name)}`,
    snapshot: (name) => `${base}/${pendingDir}/new/${encodePath(name)}`,
    diff: (name) => `${base}/${pendingDir}/diff/${encodePath(name)}`,
    thumb: hasThumbs
      ? (kind, name) => `${base}/${pendingDir}/thumb/${kind}/${encodePath(name)}`
      : null,
  };
}

module.exports = { buildReport, rawUrls, MARKER };
