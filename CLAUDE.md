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

- **Backend:** Node.js (Express) — GitHub API traversal, static analysis, Anthropic API calls, auto-fix orchestration
- **Frontend:** React — health dashboard, debt list, file drilldown viewer, auto-fix diff viewer
- **APIs:** GitHub REST API (public repos via URL, no auth required for MVP), Anthropic API (`claude-sonnet-4-6`)
- **Auto-fix:** `simple-git` (Node.js git bindings) — branch creation, file patching, syntax verification, PR diff generation

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
│   ├── scorer.js             # Severity score calculation
│   └── autoFix/
│       ├── fixGenerator.js   # LLM call to generate the actual code fix
│       ├── fixApplier.js     # Writes fix to temp branch, runs syntax check
│       ├── diffBuilder.js    # Builds unified diff for UI display
│       └── prBuilder.js      # Assembles PR description with reasoning
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── RepoInput.jsx
│   │   │   ├── HealthDashboard.jsx
│   │   │   ├── DebtList.jsx
│   │   │   ├── FileDrilldown.jsx
│   │   │   └── AutoFixPanel.jsx  # Diff viewer + accept/discard controls
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

### Step 9 — Auto-fix (only start if Steps 1–7 are solid and 3+ hours remain)

**Do not start this step until the AI suggestion quality has been manually reviewed and is specific enough to act on. Generic suggestions produce embarrassing auto-fixes. See "AI Quality Touchup" section below.**

The auto-fix loop is: generate fix → apply to temp branch → syntax check → show diff → accept or discard. It never touches `main`. Every fix is on a throwaway branch the user explicitly merges or discards.

#### 9a — Backend: fix generation (`fixGenerator.js`)

For a given debt item, make a second Anthropic API call with the full file source, the debt item JSON, and the refactor suggestion. Ask for the complete rewritten file — not a patch, not a snippet, the full file. This avoids patch-application edge cases and is simpler to validate.

Use this schema (enforce strictly — no deviations):

```json
{
  "file": "src/utils/parser.js",
  "fixSummary": "One sentence describing what changed and why",
  "confidence": 85,
  "changedLineRefs": [42, 43, 44, 45],
  "rewrittenContent": "<full file content as a string>",
  "verificationSteps": ["Function still exported", "No new dependencies introduced"]
}
```

Rules enforced in prompt:
- `confidence` must be honest — if the fix requires understanding business logic the model doesn't have, confidence should be low (< 60) and the fix should be declined server-side
- `changedLineRefs` must be a subset of the original `lineRefs` from the debt item — if they don't overlap, drop the fix
- `rewrittenContent` must be the complete file, not a fragment
- If the model cannot produce a confident, complete fix it must return `"rewrittenContent": null` — never a partial file

Drop any fix where `confidence < 65` or `rewrittenContent` is null. Log the reason.

#### 9b — Backend: fix application (`fixApplier.js`)

```javascript
// Never touch the working directory or main branch
// Use simple-git to operate on a cloned temp copy

async function applyFix(repoPath, fix) {
  const git = simpleGit(repoPath);
  const branch = `debtlens/autofix-${Date.now()}`;

  await git.checkoutLocalBranch(branch);
  await fs.writeFile(path.join(repoPath, fix.file), fix.rewrittenContent);

  // Syntax check before anything else
  const syntaxOk = await runSyntaxCheck(fix.file, repoPath);
  if (!syntaxOk) {
    await git.checkout('main');
    await git.deleteLocalBranch(branch, true);
    return { success: false, reason: 'syntax check failed' };
  }

  await git.add(fix.file);
  await git.commit(`fix(debtlens): ${fix.fixSummary}`);

  return { success: true, branch, commitHash: await git.revparse('HEAD') };
}
```

Syntax check per language:
- `.js` / `.ts` — `node --check <file>` (zero dependencies)
- `.py` — `python -m py_compile <file>`
- `.go` — `go vet <file>`
- Anything else — skip syntax check, set `confidence` ceiling to 70 regardless of model output

If syntax check fails: delete the branch, return failure reason to UI, do not show a diff.

#### 9c — Backend: diff builder (`diffBuilder.js`)

After a successful syntax check, build a unified diff between the original file content and the rewritten content. Use the `diff` npm package — do not shell out to `git diff` as it's harder to parse for the UI.

```javascript
import { createTwoFilesPatch } from 'diff';

function buildDiff(originalContent, rewrittenContent, filename) {
  return createTwoFilesPatch(
    `a/${filename}`, `b/${filename}`,
    originalContent, rewrittenContent,
    'original', 'debtlens-fix'
  );
}
```

Return the unified diff string to the frontend alongside the fix metadata.

#### 9d — Frontend: AutoFixPanel component

- Triggered from the FileDrilldown sidebar — "Auto-fix this" button next to each debt item
- Shows a loading state while fix generates and applies ("Generating fix... Checking syntax... Building diff...")
- Renders the unified diff with additions in green, removals in red (use `react-diff-viewer` or hand-roll with line parsing — it's ~30 lines)
- Two buttons: **Apply fix** (opens a new GitHub PR tab or copies the branch name) and **Discard** (calls backend to delete the temp branch)
- Confidence score visible: "85% confident — review before merging"
- If fix was dropped server-side (low confidence or syntax fail): show the reason plainly — "Couldn't auto-fix: this change requires understanding business context. Review the suggestion manually."

#### 9e — The safety invariants (never violate these)

```
NEVER write to the original cloned repo's main branch
NEVER apply a fix without a passing syntax check
NEVER show a diff for a fix that failed syntax check
NEVER hide the confidence score from the user
ALWAYS delete the temp branch on discard
ALWAYS show what changed — no silent file mutations
```

---

## Cut List (if time runs short)

**Never cut:**
- Line-level grounding (step 2 validation) — this is the entire credibility claim
- Severity score with real formula — judges will ask how it works
- The demo repo being pre-selected and tested
- Step 9 safety invariants — if auto-fix ships, the branch isolation and syntax check are non-negotiable

**Safe to cut:**
- GitHub OAuth / private repo support — paste-in URL is sufficient for demo
- Documentation debt category — hardest to make non-generic, drop it last
- Adjustable weight sliders — nice to have, not core
- The repo-picker UI — hardcoding the demo repo URL is fine
- Step 9 entirely — DebtLens is a complete product without it; only build auto-fix if Steps 1–7 are solid and polished

---

## Key Constraints

- **50-file cap:** always enforced, always visible in UI ("Analyzing 50 most recently modified files")
- **Line ref validation:** if `lineRef` is out of bounds for the file, drop the debt item and log — never display an ungrounded finding
- **No hallucinated summaries:** prompt must instruct the model to only report debt it can cite to a specific metric or line. If it cannot cite, it must omit.
- **Rate limits:** GitHub API is 60 req/hour unauthenticated. Cache file contents in memory for the session so re-runs don't re-fetch.
- **Auto-fix branch isolation:** fixes always go to a `debtlens/autofix-{timestamp}` branch, never main. Temp branch is deleted on discard.
- **Auto-fix confidence floor:** drop any fix with `confidence < 65`. Show the reason to the user — never silently drop.
- **Auto-fix syntax gate:** no diff is shown to the user unless the syntax check passes. A failed syntax check deletes the branch immediately.

---

## AI Quality Touchup (do this before Step 9)

Run the full pipeline against the demo repo and read every `reasoning` and `refactorSuggestion` field out loud. Apply this test to each:

**Bad reasoning:** "This function is too long and should be broken up into smaller functions."
**Good reasoning:** "This function has a cyclomatic complexity of 12 and handles both data fetching and UI state mutation across lines 45–89 — these are separable concerns that make it untestable in isolation."

**Bad suggestion:** "Extract this into a helper function."
**Good suggestion:** "Extract lines 45–67 into a `parseResponseHeaders` function and call it from line 23 where the parsing currently happens inline."

If any items fail this test, iterate on the extraction prompt until they pass. Add this line to the prompt if needed:

```
The refactorSuggestion must be specific enough that a developer could 
implement it without asking any clarifying questions. Reference exact 
line numbers, function names, and variable names from the source.
```

Do not start Step 9 until every debt item in the demo repo passes the specificity test. Auto-fix quality has a hard ceiling set by suggestion quality.

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
      "refactorSuggestion": "<specific, actionable — must reference exact line numbers, function names, variable names>"
    }
  ]
}

File: {{filename}}
Static metrics: {{metrics_json}}
Source:
{{file_content}}
```

## Anthropic API Prompt (auto-fix generation)

```
You are an automated code refactoring agent. You will receive a source file, 
a specific debt item, and a refactor suggestion. Your job is to apply the fix 
and return the complete rewritten file.

Rules:
- Return the COMPLETE rewritten file — not a patch, not a snippet, the full content
- Only change what is necessary to address the specific debt item
- Do not introduce new dependencies, new exports, or behavioral changes
- If you are not confident you can fix this without understanding business context 
  you do not have, set rewrittenContent to null and explain in fixSummary
- Respond ONLY with valid JSON. No preamble, no markdown fences.

Schema:
{
  "file": "<filename>",
  "fixSummary": "<one sentence: what changed and why>",
  "confidence": <0-100 integer — be honest, not optimistic>,
  "changedLineRefs": [<line numbers that changed>],
  "rewrittenContent": "<complete file as a string, or null if not confident>",
  "verificationSteps": ["<what a reviewer should check>"]
}

Debt item: {{debt_item_json}}
Refactor suggestion: {{refactor_suggestion}}
Original file content:
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
9. **If Step 9 is built:** click "Auto-fix this" on the highest-severity complexity item → show the loading states → diff appears → point out the confidence score → apply it → show the branch was created → discard it to show the cleanup

**Step 9 demo talking point:** "It never touches your main branch. Every fix is on a throwaway branch with a passing syntax check before you even see the diff. You're always in control of what gets merged."

Total demo without auto-fix: under 3 minutes.
Total demo with auto-fix: under 5 minutes.
