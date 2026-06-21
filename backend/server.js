// server.js — DebtLens Express server.
// POST /analyze  → text/event-stream with progress events + final result

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

    send('done', {
      result: {
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
      },
    });
  } catch (err) {
    console.error('Analysis error:', err.message);
    send('error', { message: err.message });
  }

  res.end();
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () =>
  console.log(`DebtLens backend listening on http://localhost:${PORT}`)
);
