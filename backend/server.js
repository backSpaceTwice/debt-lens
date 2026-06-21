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
  const { repoUrl } = req.body ?? {};
  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' });
  }

  try {
    const { meta, files, fileMetrics } = await analyzeRepo(repoUrl);
    const debtResults = await extractAllDebt(files, fileMetrics);
    const { overallHealth, categoryScores, fileScores } = scoreRepo(
      fileMetrics,
      debtResults,
      WEIGHTS
    );

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
