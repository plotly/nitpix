'use strict';

const fs = require('fs');

/**
 * Minimal GitHub REST client (native fetch, no dependencies).
 *
 * Test hooks:
 *  - NITPIX_STUBS: path to a JSON file mapping "METHOD /path/prefix" to a
 *    canned response; when set, no real HTTP requests are made.
 *  - NITPIX_CALL_LOG: path to a JSONL file where every request is appended
 *    (works in both stubbed and real modes).
 */
class GitHub {
  constructor(token, repo) {
    this.token = token;
    this.repo = repo; // "owner/name"
    this.api = process.env.GITHUB_API_URL || 'https://api.github.com';
    this.stubs = process.env.NITPIX_STUBS
      ? JSON.parse(fs.readFileSync(process.env.NITPIX_STUBS, 'utf8'))
      : null;
  }

  _logCall(method, path, body) {
    const file = process.env.NITPIX_CALL_LOG;
    if (!file) return;
    fs.appendFileSync(file, JSON.stringify({ method, path, body }) + '\n');
  }

  _stubFor(method, path) {
    // Longest matching "METHOD /path/prefix" key wins.
    let best = null;
    for (const key of Object.keys(this.stubs)) {
      const [m, prefix] = key.split(/ (.+)/);
      if (m === method && path.startsWith(prefix)) {
        if (!best || prefix.length > best.prefix.length) best = { prefix, value: this.stubs[key] };
      }
    }
    if (!best) throw new Error(`nitpix test stub missing for: ${method} ${path}`);
    return best.value;
  }

  /** path is relative to the API root, e.g. `/repos/o/r/issues/1/comments`. */
  async request(method, path, body) {
    this._logCall(method, path, body);
    if (this.stubs) return this._stubFor(method, path);

    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'nitpix',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub API ${method} ${path} -> ${res.status}: ${data && data.message}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  get(path) {
    return this.request('GET', path);
  }

  // --- higher-level helpers, all scoped to this.repo ---

  async listOpenPullNumbers() {
    const numbers = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.get(`/repos/${this.repo}/pulls?state=open&per_page=100&page=${page}`);
      numbers.push(...batch.map((p) => p.number));
      if (batch.length < 100) break;
    }
    return numbers;
  }

  getPull(number) {
    return this.get(`/repos/${this.repo}/pulls/${number}`);
  }

  async userPermission(username) {
    const data = await this.get(`/repos/${this.repo}/collaborators/${encodeURIComponent(username)}/permission`);
    return data.permission; // admin | write | read | none
  }

  /** Create or update the single nitpix comment (identified by marker) on a PR. */
  async upsertComment(prNumber, marker, body) {
    let existing = null;
    for (let page = 1; page <= 10 && !existing; page++) {
      const batch = await this.get(`/repos/${this.repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
      existing = batch.find((c) => c.body && c.body.includes(marker)) || null;
      if (batch.length < 100) break;
    }
    if (existing) {
      return this.request('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
    }
    return this.request('POST', `/repos/${this.repo}/issues/${prNumber}/comments`, { body });
  }

  createComment(prNumber, body) {
    return this.request('POST', `/repos/${this.repo}/issues/${prNumber}/comments`, { body });
  }

  setStatus(sha, { state, context, description, targetUrl }) {
    return this.request('POST', `/repos/${this.repo}/statuses/${sha}`, {
      state,
      context,
      description: description && description.slice(0, 140),
      target_url: targetUrl,
    });
  }

  reactToComment(commentId, content) {
    return this.request('POST', `/repos/${this.repo}/issues/comments/${commentId}/reactions`, { content });
  }
}

module.exports = { GitHub };
