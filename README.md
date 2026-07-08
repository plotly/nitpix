# nitpix 👁

GitHub-Actions-native visual diffing — a self-hosted Percy replacement.

Your tests capture screenshot PNGs into a directory; nitpix does everything
else **inside GitHub** — no external service, no tokens to buy:

- diffs snapshots against baselines with [odiff](https://github.com/dmtrKovalenko/odiff)
  (anti-aliasing aware, fast native binary)
- stores baselines on an **orphan git branch** in your repo (`nitpix` by default)
- posts a single, continuously-updated **PR comment** with baseline / new / diff
  images, served from `raw.githubusercontent.com`
- manages a **commit status** (`nitpix/visual`) you can make a required check
- approval is a PR comment — `/nitpix approve` — and flips the status green
  **without re-running your test matrix**
- merging to the target branch **auto-promotes** that run's snapshots to the
  new baselines (Percy-style auto-accept on the base branch)

Because the contract is just *"a directory of PNGs"*, it works for any stack:
Python + Selenium (dash), Node + Playwright, plotly.js image tests, etc.

## How it works

```
test workflow (unprivileged —      nitpix workflow (workflow_run —
works for forks & dependabot)      base-repo context, full token)
┌──────────────────────┐    ┌────────────────────────────────────┐
│ tests write PNGs to  │    │ plotly/nitpix@v1                   │
│ ./nitpix-snapshots   │───▶│  PR run:   diff vs baselines/,     │
│                      │    │            push imgs, comment,     │
│ plotly/nitpix/upload │    │            set nitpix/visual       │
│ (per shard)          │    │  push run: promote snapshots to    │
└──────────────────────┘    │            baselines/<branch>/     │
                            └────────────────────────────────────┘
                                       ▲
                     "/nitpix approve" comment (plotly/nitpix/approve)
                     records approved snapshot hashes → status green
```

Everything lives on the orphan baseline branch:

```
nitpix (orphan branch)
├── baselines/<target-branch>/**.png     # updated only by pushes to that branch
├── pending/pr-<n>/<sha12>/              # images for the PR comment (latest head only)
│   ├── new/**.png
│   ├── diff/**.png
│   └── manifest.json
└── approvals/pr-<n>.json                # approved content hashes
```

Approvals are keyed by **content hash**, so rebases and re-runs that produce
identical pixels stay approved; genuinely new pixels go red again. Pending
images and approvals for closed PRs are pruned automatically on promote runs.

## Setup

### 1. Capture snapshots in your tests

Write PNGs into a directory (default `nitpix-snapshots`). For a Selenium suite
like dash's, a drop-in replacement for `percy_snapshot` is ~20 lines:

```python
# e.g. dash/testing/nitpix.py
import os
import re

SNAPSHOT_DIR = os.getenv("NITPIX_SNAPSHOT_DIR", "nitpix-snapshots")


def nitpix_snapshot(driver, name, widths=(1280,), min_height=1024):
    """Drop-in replacement for percy_snapshot: saves one PNG per width."""
    safe = re.sub(r"[^\w.@-]+", "_", name)
    original = driver.get_window_size()
    try:
        for width in widths:
            driver.set_window_size(width, max(original["height"], min_height))
            path = os.path.join(SNAPSHOT_DIR, f"{safe}@{width}.png")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            driver.save_screenshot(path)
    finally:
        driver.set_window_size(original["width"], original["height"])
```

> Unlike Percy, `widths` resizes the real browser window, so JS-driven layout
> responds too (Percy only re-applied CSS). Pin the browser version in CI —
> determinism comes from the environment, not from a rendering service.

### 2. Upload from each test shard

```yaml
- name: Upload visual snapshots
  if: always()
  uses: plotly/nitpix/upload@v1
  with:
    name: integration-${{ matrix.test-group }}   # any unique shard id
    path: nitpix-snapshots
```

### 3. Diff + report (replaces `percy build:finalize`)

**Recommended: a separate `workflow_run` workflow.** This is what makes nitpix
work for **fork PRs and dependabot** — the cases where Percy silently skipped.
`pull_request` runs from forks (and dependabot, which GitHub treats the same
way) get a read-only token and no secrets, so they can never comment or set a
status. The fix: the test workflow only *uploads* snapshots (needs no
permissions), and a follow-up workflow — which always runs in the base repo
with a full-privilege token — downloads them, diffs, comments, and sets the
status. nitpix never checks out or executes PR code in this workflow, which is
what makes the pattern safe.

`.github/workflows/nitpix.yml`:

```yaml
name: nitpix
on:
  workflow_run:
    workflows: [Tests]          # your test workflow's `name:`
    types: [completed]

permissions:
  contents: write        # push to the baseline branch
  pull-requests: write   # the report comment
  statuses: write        # the nitpix/visual check

jobs:
  visual-review:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: plotly/nitpix@v1
        # defaults shown:
        # with:
        #   artifact-pattern: nitpix-snapshots-*
        #   baseline-branch: nitpix
        #   threshold: '0.1'
```

The action reads the `workflow_run` payload: test runs triggered by a PR
(same-repo, fork, or dependabot) are **diffed** — the PR is resolved by head
sha when the payload omits it, as it does for forks — and test runs triggered
by a `push` to a branch **promote** that branch's baselines. So make sure the
test workflow runs on both:

```yaml
# in your test workflow
on:
  push:
    branches: [dev, master]   # baseline-promoting branches
  pull_request:
```

Finally, make `nitpix/visual` a required status check in branch protection.

<details><summary>Alternative: single-workflow setup (same-repo PRs only)</summary>

If you never take fork or dependabot PRs, you can skip the second workflow and
append a job to the test workflow itself:

```yaml
nitpix:
  runs-on: ubuntu-latest
  needs: [test-integration, test-table]   # all snapshot-producing jobs
  permissions:
    contents: write
    pull-requests: write
    statuses: write
  steps:
    - uses: plotly/nitpix@v1
```

</details>

### 4. The approve command

`.github/workflows/nitpix-approve.yml`:

```yaml
name: nitpix approve
on:
  issue_comment:
    types: [created]

jobs:
  approve:
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/nitpix')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      statuses: write
    steps:
      - uses: plotly/nitpix/approve@v1
```

Only users with **write** access can approve; others get a 👎 reaction.

## Inputs (main action)

| input | default | |
| --- | --- | --- |
| `snapshots-dir` | `nitpix-snapshots` | where the PNGs are |
| `artifact-pattern` | `nitpix-snapshots-*` | shard artifacts to merge; `''` = snapshots captured in this job |
| `mode` | `auto` | `diff` on PR events, `promote` otherwise |
| `base` | PR base / pushed branch | which branch's baselines to use |
| `baseline-branch` | `nitpix` | the orphan storage branch |
| `threshold` | `0.1` | odiff per-pixel color threshold (0–1) |
| `antialiasing` | `true` | ignore anti-aliased pixels |
| `fail-on-new` | `false` | new snapshots need approval too |
| `fail-on-missing` | `false` | baselines not captured this run fail the check |
| `fail-on-change` | `false` | also fail the step (the commit status is the primary signal) |
| `comment` / `max-comment-images` | `true` / `30` | PR comment behavior; the budget counts inline images (changed = 3, new = 1), worst diffs first, the rest degrade to links |
| `thumbnail-width` | `360` | inline images are thumbnails linking to the full files; `0` embeds full-size |
| `status-context` | `nitpix/visual` | the check name |
| `github-token` | `github.token` | needs contents/PR/statuses write |

Outputs: `status`, `changed-count`, `added-count`, `missing-count`,
`unapproved-count`.

### Comment weight

GitHub loads every inline image in a comment at once (even inside closed
`<details>`, and `width=` doesn't shrink the download), and notification
emails carry the comment body as created. nitpix keeps reports light three
ways:

- inline images are **thumbnails** (`thumbnail-width`, default 360px)
  hyperlinked to the full-size files;
- a total **image budget** (`max-comment-images`) is spent on the worst
  diffs first; snapshots beyond it render as `baseline · new · diff` links;
- the comment is **created links-only and immediately edited** to the full
  version — GitHub only emails on creation, so emails never embed images.

## Notes & limitations

- **Fork PRs & dependabot**: fully supported via the `workflow_run` topology
  above. If you instead run nitpix directly in a `pull_request` job, fork and
  dependabot runs degrade gracefully (diff results in the step summary, no
  comment/status) — but a required `nitpix/visual` check would then block
  those PRs, so use `workflow_run` if you take them.
- **Review the images, not just the diff**: snapshot artifacts from fork PRs
  are attacker-supplied bytes. nitpix only ever copies them as `.png` files
  onto the baseline branch and never executes anything from them, but the
  human approving should look at what they're approving.
- **Public repos only** for inline comment images —
  `raw.githubusercontent.com` doesn't serve private-repo content to browsers
  without auth. (Private-repo support would need an artifact-based HTML
  report; planned.)
- **Empty runs are safe**: promote mode refuses to replace baselines with an
  empty snapshot set, so a broken test run can't wipe your baselines.
- **Branch growth**: the orphan branch accumulates history. It carries no
  code, so you can periodically squash it (`git checkout --orphan` + force
  push) without affecting anything else.
- Concurrent shard/PR pushes to the baseline branch are handled with a
  re-clone-and-retry loop; writers touch disjoint paths.

## Development

```bash
npm install
npm test        # end-to-end tests against a local bare repo + stubbed API
```

No runtime npm dependencies — the actions run plain Node 20 scripts; odiff is
installed at action runtime, pinned via the `odiff-version` input.
