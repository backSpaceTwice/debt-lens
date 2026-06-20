# DebtLens — Claude Code Instructions

## Project Overview

DebtLens is a technical debt scanner for GitHub repositories. It traverses source files, runs a static analysis pass to compute measurable metrics, then uses the Anthropic API to reason over those signals and produce a structured debt report.

**Core output:**
- Repo-level health dashboard (4 category scores + overall)
- Prioritized debt list with severity scores and reasoning
- Per-file drilldown with line-level grounding (click a debt item → see the exact lines)

**The key architectural claim:** the LLM reasons on top of real static signals, not raw files. Every finding is grounded in specific line numbers.

---

## Tech Stack

- **Backend:** Node.js (Express) — GitHub API traversal, static analysis, Anthropic API calls
- **Frontend:** React — health dashboard, debt list, file drilldown viewer
- **APIs:** GitHub REST API (public repos via URL, no auth required for MVP), Anthropic API (`claude-sonnet-4-6`)

---

## Project Structure

```
debtlens/
├── backend/
│   ├── index.js              # Express server entry point
│   ├── github.js             # GitHub API file traversal
│   ├── staticAnalysis.js     # Computable metrics (no LLM)
│   ├── contextAssembler.js   # Picks which files to send to LLM
│   ├── llmExtractor.js       # Anthropic API call + schema validation
│   └── scorer.js             # Severity score calculation
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── RepoInput.jsx
│   │   │   ├── HealthDashboard.jsx
│   │   │   ├── DebtList.jsx
│   │   │   └── FileDrilldown.jsx
│   │   └── index.css
│   └── package.json
├── backend/package.json
└── CLAUDE.md
```

---

## Build Priority Order

Build in this exact order. If time runs short, stop at whatever step you're on — every step produces something that works and demonstrates the core claim.

### Step 1 — Backend: GitHub traversal + static analysis (no LLM)
- Accept a public GitHub repo URL, extract `owner/repo`
- Use GitHub REST API to list files, filter out `node_modules`, `.json` config, lockfiles, and binary files
- Cap at the **50 most-recently-modified files** (recency heuristic — defensible, say so in UI)
- For each file, compute these raw metrics:
  - `loc` — lines of code
  - `functionCount` — rough count (regex on `function`, `def`, `=>` etc.)
  - `maxNestingDepth` — count max indentation levels
  - `todoCount` — count `TODO`, `FIXME`, `HACK`, `XXX` comments
  - `hasTestFile` — boolean, does a corresponding test file exist in the repo
  - `dependencyAge` — for `package.json` / `requirements.txt`, days since each dep was last updated (use npm registry or PyPI API)
  - `docstringRatio` — ratio of public functions/classes that have a docstring or JSDoc comment
- Log all metrics to console, no frontend yet
- **Done when:** running `node index.js <github-url>` prints a JSON metrics object for each file

### Step 2 — Backend: LLM extraction for complexity debt only
- Pick the 10 files with highest `loc × maxNestingDepth` score
- For each, send file content + its static metrics to Anthropic API
- Use this schema (enforce strictly in prompt — model must not deviate):

```json
{
  "file": "src/utils/parser.js",
  "debtItems": [
    {
      "id": "d1",
      "category": "complexity",
      "severity": 78,
      "summary": "One-line plain English description",
      "reasoning": "2-3 sentences explaining why this is debt, referencing the specific metric",
      "lineRefs": [42, 43, 44],
      "refactorSuggestion": "Concrete, specific action — not generic advice"
    }
  ]
}
```

- Validate that every `lineRef` is a real line number in the file. If the model hallucinates a line number, log a warning and drop that item.
- **Done when:** the extraction returns valid grounded debt items for at least 3 files

### Step 3 — Backend: expand to all four debt categories

**Complexity debt** (already done in step 2)
- High `loc`, `maxNestingDepth`, or `functionCount`
- Prompt focus: god files, deeply nested conditionals, functions doing too many things

**Test debt**
- `hasTestFile === false` or test-to-code ratio below repo average
- Computable as a direct metric — LLM adds reasoning about *why* this file in particular needs tests

**Dependency debt**
- `dependencyAge > 365 days` for any dependency in `package.json` / `requirements.txt`
- Also flag `todoCount > 0` items that mention version upgrades
- LLM adds context on what the staleness implies

**Documentation debt**
- `docstringRatio < 0.5` for files with `functionCount > 5`
- LLM flags which specific public APIs are undocumented

### Step 4 — Backend: severity scoring

```javascript
function computeSeverityScore(metrics) {
  const complexity = normalize(metrics.loc * metrics.maxNestingDepth, 0, 5000) * 100;
  const testDebt   = metrics.hasTestFile ? 0 : 100;
  const depDebt    = normalize(metrics.maxDependencyAge, 0, 730) * 100;
  const docDebt    = (1 - metrics.docstringRatio) * 100;

  return (
    complexity * 0.35 +
    testDebt   * 0.30 +
    depDebt    * 0.20 +
    docDebt    * 0.15
  );
}
```

- Weights are constants in `scorer.js` — expose them as configurable later (step 7)
- Overall repo health score = `100 - weightedAverage(allFileScores)`
- Per-category score = average of that category's items across all files

### Step 5 — Frontend: health dashboard

- Four category score cards: Complexity, Test Coverage, Dependencies, Documentation
- Each shows a 0–100 score with a color band (green > 70, amber 40–70, red < 40)
- Overall repo health score prominently at top
- Repo metadata: name, language, file count analyzed, last analyzed timestamp
- No drilldown yet — just the numbers

### Step 6 — Frontend: debt list

- Render all debt items sorted by severity descending by default
- Each item shows: severity badge, category tag, file path, one-line summary
- Sortable by severity, category, file
- Filterable by category (checkbox group)
- Clicking an item opens the file drilldown (step 7)

### Step 7 — Frontend: file drilldown + line highlighting

- Show full file source with line numbers
- Lines referenced in `lineRefs` are highlighted (amber background)
- Sidebar shows the debt item: summary, reasoning, refactor suggestion
- This is the primary demo moment — clicking a debt item and seeing the exact lines is what separates this from a generic LLM wrapper

### Step 8 — Polish

- Adjustable severity weight sliders (update scores client-side in real time)
- Loading states with per-step progress ("Fetching files... Running static analysis... Analyzing with AI...")
- Error states for rate limits, private repos, empty repos
- Demo repo pre-loaded (pick a well-known open source repo with known debt before the hackathon)

---

## Cut List (if time runs short)

**Never cut:**
- Line-level grounding (step 2 validation) — this is the entire credibility claim
- Severity score with real formula — judges will ask how it works
- The demo repo being pre-selected and tested

**Safe to cut:**
- GitHub OAuth / private repo support — paste-in URL is sufficient for demo
- Documentation debt category — hardest to make non-generic, drop it last
- Adjustable weight sliders — nice to have, not core
- The repo-picker UI — hardcoding the demo repo URL is fine

---

## Key Constraints

- **50-file cap:** always enforced, always visible in UI ("Analyzing 50 most recently modified files")
- **Line ref validation:** if `lineRef` is out of bounds for the file, drop the debt item and log — never display an ungrounded finding
- **No hallucinated summaries:** prompt must instruct the model to only report debt it can cite to a specific metric or line. If it cannot cite, it must omit.
- **Rate limits:** GitHub API is 60 req/hour unauthenticated. Cache file contents in memory for the session so re-runs don't re-fetch.

---

## Anthropic API Prompt (complexity debt — adapt for other categories)

```
You are a technical debt analyzer. You will receive a source file and its pre-computed static metrics.
Your job is to identify specific complexity debt items grounded in the actual code.

Rules:
- Only report a debt item if you can cite specific line numbers from the file
- Do not give generic advice ("add more comments") — every suggestion must reference the specific function or block
- If you cannot find real complexity debt, return an empty debtItems array
- Respond ONLY with valid JSON matching the schema below. No preamble, no markdown fences.

Schema:
{
  "file": "<filename>",
  "debtItems": [
    {
      "id": "<unique string>",
      "category": "complexity",
      "severity": <0-100 integer>,
      "summary": "<one sentence>",
      "reasoning": "<2-3 sentences referencing specific metrics or patterns>",
      "lineRefs": [<line numbers>],
      "refactorSuggestion": "<specific, actionable>"
    }
  ]
}

File: {{filename}}
Static metrics: {{metrics_json}}
Source:
{{file_content}}
```

---

## Demo Script (for judges)

1. Paste in the pre-selected repo URL → hit Analyze
2. Show the loading steps ticking through (fetching → analyzing → scoring)
3. Land on the health dashboard — overall score, four category cards
4. Scroll to the debt list — sorted by severity, show the top 3 items
5. Click the highest-severity item → file drilldown opens
6. Point out the highlighted lines: "every finding is grounded in specific lines of code, not generated generically"
7. Show the severity formula if a judge asks: "35% complexity, 30% test debt, 20% dependency age, 15% documentation — and you can tune these weights for your team's priorities"
8. If time allows: adjust a weight slider and show the scores update in real time

Total demo: under 3 minutes.
