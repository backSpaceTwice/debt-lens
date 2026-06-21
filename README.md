# DebtLens

**A technical-debt scanner for GitHub repositories.** DebtLens traverses a
repo's source, runs a deterministic static-analysis pass to compute real
metrics, then uses the Anthropic API to reason *on top of those signals* — not
raw files — and produce a structured, line-grounded debt report.

The architectural claim: **every finding is grounded in specific line numbers.**
The LLM never invents debt it can't cite to a metric or a line. Out-of-bounds
line refs are dropped before they ever reach the UI.

---

## What it does

- **Repo health dashboard** — an overall 0–100 score plus four category scores
  (Complexity, Test Coverage, Dependencies, Documentation) with color bands.
- **Prioritized debt list** — every finding with a severity badge, category tag,
  file path, and one-line summary; sortable and filterable by category.
- **File drilldown** — full source with the referenced lines highlighted, next
  to the debt item's reasoning and a specific, actionable refactor suggestion.
- **Auto-fix (Step 9)** — for a given debt item, generate a complete rewritten
  file, apply it to an **isolated throwaway branch**, run a **syntax gate**, and
  show a unified diff with a confidence score. It never touches your repo. You
  can then push the fix to a branch on GitHub (compare URL returned) or download
  the fixed file.

---

## How it works

```
GitHub URL
   │
   ▼
github.js          fetch the N most-recently-modified source files
   │               (N is user-chosen, default 30, capped at 50; skips
   │               node_modules, lockfiles, config, binaries)
   ▼
staticAnalysis.js  per-file metrics — loc, functionCount, maxNestingDepth,
   │               todoCount, hasTestFile, docstringRatio, dependencyAge
   ▼
index.js           per-category file selection (each criterion is a metric)
   │
   ▼
llmExtractor.js    Anthropic call per file → debt items, line-ref validated
   │
   ▼
scorer.js          severity formula + repo health + category scores
   │
   ▼
server.js          streams progress + final report to the React frontend (SSE)
```

**Severity formula** (`scorer.js`, weights are tunable):

```
severity = complexity·0.35 + testDebt·0.30 + depDebt·0.20 + docDebt·0.15
```

where `complexity = norm(loc × maxNestingDepth)`, `testDebt = 0|100` by whether
a test file exists, `depDebt = norm(maxDependencyAge)`, and
`docDebt = (1 − docstringRatio)·100`. Overall repo health = `100 − mean(fileScores)`.

---

## Project structure

```
DebtLens/
├── backend/
│   ├── server.js            # Express server — /analyze (SSE) + auto-fix routes
│   ├── index.js             # Pipeline orchestration + CLI driver
│   ├── github.js            # GitHub API traversal (default 30 files, cap 50, in-memory cache)
│   ├── staticAnalysis.js    # Deterministic per-file metrics (no LLM)
│   ├── llmExtractor.js      # Anthropic calls + line-ref validation (4 categories)
│   ├── scorer.js            # Severity formula + repo/category scoring
│   ├── env.js               # Zero-dependency .env loader
│   └── autoFix/
│       ├── fixGenerator.js  # LLM call → full rewritten file (structured output)
│       ├── fixApplier.js    # Scratch git repo + isolated branch + syntax gate
│       ├── diffBuilder.js   # Unified diff via the `diff` package
│       └── githubPush.js    # Push fix to a GitHub branch (or download fallback)
└── frontend/
    └── src/
        ├── App.jsx
        └── components/
            ├── RepoInput.jsx        # URL + file-count input (demo pre-loaded)
            ├── HealthDashboard.jsx  # Overall + 4 category score cards
            ├── DebtList.jsx         # Sortable / filterable debt list
            ├── FileDrilldown.jsx    # Source viewer with line highlighting
            └── AutoFixPanel.jsx     # Diff viewer + apply/discard controls
```

---

## Getting started

### Prerequisites

- **Node.js ≥ 20.6** (the backend uses the built-in `process.loadEnvFile`)
- An **Anthropic API key** (uses `claude-sonnet-4-6`)
- *(Optional)* a **GitHub token** — raises the API rate limit from 60 to 5000
  req/hour, and is required to *push* auto-fixes to a branch

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY (and optionally a token)
npm run server            # starts the API on http://localhost:3001
```

`.env` keys:

| Variable                 | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | Required — LLM extraction and fix generation                   |
| `DEBTLENS_GITHUB_TOKEN`  | Optional — preferred GitHub token (read for analysis, write for Apply) |
| `GITHUB_TOKEN`           | Optional — fallback if `DEBTLENS_GITHUB_TOKEN` is unset        |

> Apply-to-GitHub needs **write** access (`repo` / `public_repo` scope) and only
> works on repos your token can push to (yours or a fork). For repos you don't
> own, Apply falls back to downloading the fixed file.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev               # Vite dev server; proxies /analyze and /api to :3001
```

Open the printed URL, paste a public GitHub repo (pre-loaded with
`expressjs/express`), pick a file count (1–50, defaults to 30), and hit
**Analyze**.

### CLI (no frontend)

The backend doubles as a CLI that prints the full report to the console:

```bash
cd backend
node index.js https://github.com/expressjs/express
# or the shortcuts:
npm run demo            # sindresorhus/slugify
npm run demo:express    # expressjs/express
```

---

## API

| Method   | Route                   | Description                                                                 |
| -------- | ----------------------- | --------------------------------------------------------------------------- |
| `POST`   | `/analyze`              | `{ repoUrl, fileCount }` → SSE stream of `progress` events then a `done` event with the full report |
| `POST`   | `/api/autofix`          | `{ file, debtItem }` → generate + apply (isolated branch) + syntax-check + diff |
| `POST`   | `/api/autofix/push`     | `{ repoPath, branch, owner, repo, fix }` → push to a GitHub branch (or download fallback) |
| `DELETE` | `/api/autofix/discard`  | `{ repoPath, branch }` → tear down the temp branch + scratch repo           |

---

## Auto-fix safety invariants

Auto-fix is built so a bad suggestion can never corrupt your code:

- The original repo is **never cloned or written to** — DebtLens only ever holds
  file *contents*. Each fix goes into a throwaway scratch git repo containing
  just the one file, on a `debtlens/autofix-{timestamp}` branch.
- **No diff is shown unless the syntax check passes** (`node --check`,
  `python -m py_compile`, `go vet`; unchecked languages cap confidence at 70).
- Fixes with `confidence < 65`, a null rewrite, or no overlap with the original
  line refs are **dropped server-side, with the reason shown** to the user.
- **Confidence is always visible.** The temp branch is always deleted on discard.

---

## Key constraints

- **File cap of 50**, with a default of 30 — adjustable in the UI, always
  surfaced and enforced server-side ("most recently modified files" — a
  defensible recency heuristic).
- **Line-ref validation:** any finding referencing an out-of-bounds line is
  dropped and logged — never displayed.
- **Rate limits:** GitHub is 60 req/hour unauthenticated; file contents are
  cached in memory for the session, and a token raises the limit to 5000/hour.

---

## Tech stack

- **Backend:** Node.js + Express, `@anthropic-ai/sdk`, `simple-git`, `diff`
- **Frontend:** React 18 + Vite
- **APIs:** GitHub REST API, Anthropic API (`claude-sonnet-4-6`)
