// server.js — DebtLens Express server.
// POST /analyze  { repoUrl } → full analysis JSON

import './env.js';
import express from 'express';
import cors from 'cors';
import { analyzeRepo, extractAllDebt } from './index.js';
import { scoreRepo, WEIGHTS } from './scorer.js';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/analyze', async (req, res) => {
  const { repoUrl, fileCount } = req.body ?? {};
  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' });
  }
  const cap = Math.min(50, Math.max(1, parseInt(fileCount) || 30));

  try {
    const { meta, files, fileMetrics } = await analyzeRepo(repoUrl, cap);
    const debtResults = await extractAllDebt(files, fileMetrics);
    const { overallHealth, categoryScores, fileScores } = scoreRepo(
      fileMetrics,
      debtResults,
      WEIGHTS
    );

    // Include source content only for files that have debt items so the
    // frontend drilldown can render a source viewer without a second request.
    const debtPaths = new Set(debtResults.map((r) => r.file));
    const fileContents = {};
    for (const f of files) {
      if (debtPaths.has(f.path)) fileContents[f.path] = f.content;
    }

    res.json({
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
    });
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () =>
  console.log(`DebtLens backend listening on http://localhost:${PORT}`)
);
