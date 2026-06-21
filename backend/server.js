// server.js — DebtLens Express server.
// POST /analyze  → text/event-stream with progress events + final result

import './env.js';
import express from 'express';
import cors from 'cors';
import { analyzeRepo, extractAllDebt, runAutoFix, discardAutoFix, pushAutoFix } from './index.js';
import { scoreRepo, WEIGHTS } from './scorer.js';
import { saveResult, listRepos, getRepo, deleteRepo } from './repoStore.js';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/analyze', async (req, res) => {
  const { repoUrl, fileCount } = req.body ?? {};
  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' });
  }
  const cap = Math.min(50, Math.max(1, parseInt(fileCount) || 30));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(type, data = {}) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const { meta, files, fileMetrics } = await analyzeRepo(repoUrl, cap, (p) =>
      send('progress', p)
    );

    const debtResults = await extractAllDebt(files, fileMetrics, (p) =>
      send('progress', p)
    );

    send('progress', { step: 'scoring', message: 'Scoring and building report…' });
    const { overallHealth, categoryScores, fileScores } = scoreRepo(
      fileMetrics,
      debtResults,
      WEIGHTS
    );

    const debtPaths = new Set(debtResults.map((r) => r.file));
    const fileContents = {};
    for (const f of files) {
      if (debtPaths.has(f.path)) fileContents[f.path] = f.content;
    }

    const result = {
      meta: {
        fullName: meta.fullName,
        language: meta.language ?? null,
        fileCount: fileMetrics.length,
        analyzedAt: new Date().toISOString(),
      },
      overallHealth,
      categoryScores,
      fileScores,
      debtResults,
      fileContents,
    };
    saveResult(result);
    send('done', { result });
  } catch (err) {
    console.error('Analysis error:', err.message);
    send('error', { message: err.message });
  }

  res.end();
});

// ── Multi-repo history (cached analyses, no re-analyzing) ──────────────────
// GET /api/repos → summary list of cached repos, most-recently-analyzed first
app.get('/api/repos', (req, res) => {
  res.json(listRepos());
});

// GET /api/repos/:owner/:repo → full cached result for one repo
app.get('/api/repos/:owner/:repo', (req, res) => {
  const { owner, repo } = req.params;
  const result = getRepo(owner, repo);
  if (!result) {
    return res.status(404).json({ error: `No cached analysis for ${owner}/${repo}` });
  }
  res.json(result);
});

// DELETE /api/repos/:owner/:repo → remove one repo from the history cache
app.delete('/api/repos/:owner/:repo', (req, res) => {
  const { owner, repo } = req.params;
  const existed = deleteRepo(owner, repo);
  if (!existed) {
    return res.status(404).json({ error: `No cached analysis for ${owner}/${repo}` });
  }
  res.json({ ok: true });
});

// ── Auto-fix (Step 9) ──────────────────────────────────────────────────────
// POST /api/autofix → generate + apply (isolated branch) + syntax-check + diff
app.post('/api/autofix', async (req, res) => {
  const { file, debtItem } = req.body ?? {};
  if (!file?.path || typeof file.content !== 'string' || !debtItem) {
    return res
      .status(400)
      .json({ error: 'file ({ path, content }) and debtItem are required' });
  }

  try {
    const result = await runAutoFix(file, debtItem);
    res.json(result);
  } catch (err) {
    console.error('Auto-fix error:', err.message);
    res.status(500).json({ status: 'error', reason: err.message });
  }
});

// POST /api/autofix/push → commit the fix to a branch on the real GitHub repo
// (via GITHUB_TOKEN) and return a compare URL; falls back to file download.
app.post('/api/autofix/push', async (req, res) => {
  const { repoPath, branch, owner, repo, fix } = req.body ?? {};
  if (!repoPath || !branch || !owner || !repo || !fix?.file) {
    return res
      .status(400)
      .json({ error: 'repoPath, branch, owner, repo, and fix.file are required' });
  }
  try {
    const result = await pushAutoFix({ repoPath, branch, owner, repo, fix });
    if (result.status === 'error') return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    console.error('Push error:', err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// DELETE /api/autofix/discard → tear down the temp branch + scratch repo
app.delete('/api/autofix/discard', async (req, res) => {
  const { repoPath, branch } = req.body ?? {};
  if (!repoPath) {
    return res.status(400).json({ error: 'repoPath is required' });
  }
  try {
    await discardAutoFix(repoPath, branch);
    res.json({ ok: true });
  } catch (err) {
    console.error('Discard error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () =>
  console.log(`DebtLens backend listening on http://localhost:${PORT}`)
);
