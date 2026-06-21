// index.js — DebtLens backend entry point.
//
// CLI driver:
//   node index.js <github-url>
//
// Step 1: traverse the repo and run the static-analysis pass (no LLM).
// Step 2: complexity-debt extraction (top files by loc × maxNestingDepth).
// Step 3: extend extraction to all four categories — complexity, test,
//         dependency, documentation — each selected by its own static-metric
//         criterion and validated with the same line-ref grounding.
//
// Later steps add severity scoring and an Express server.

import './env.js'; // load .env before anything reads process.env
import { getRepoFiles } from './github.js';
import {
  analyzeFile,
  analyzeDependencies,
  buildRepoIndex,
} from './staticAnalysis.js';
import {
  extractComplexityDebt,
  extractTestDebt,
  extractDependencyDebt,
  extractDocumentationDebt,
} from './llmExtractor.js';
import { scoreRepo, WEIGHTS } from './scorer.js';

const PER_CATEGORY_LIMIT = 5;

/**
 * Run the full static-analysis pass over a repo.
 * Returns the file contents alongside the metrics so the LLM steps can use
 * both without re-fetching.
 */
export async function analyzeRepo(repoUrl, fileCount = 30, onProgress = null) {
  onProgress?.({ step: 'fetch', message: 'Fetching repository files…' });
  const { meta, files, allPaths } = await getRepoFiles(repoUrl, fileCount);
  onProgress?.({ step: 'fetch_done', message: `${files.length} files retrieved`, fileCount: files.length });
  const repoIndex = buildRepoIndex(allPaths);

  console.log('🧮 Running static analysis...');
  onProgress?.({ step: 'analysis', message: 'Running static analysis…' });

  const fileMetrics = [];
  for (const file of files) {
    const metrics = analyzeFile(file, repoIndex);

    // Dependency manifests get an extra async pass (npm / PyPI age lookups).
    const dependency = await analyzeDependencies(file);
    if (dependency) metrics.dependency = dependency;

    fileMetrics.push(metrics);
  }

  onProgress?.({ step: 'analysis_done', message: 'Static analysis complete' });
  return { meta, files, fileMetrics };
}

// ---------------------------------------------------------------------------
// Per-category file selection — each criterion comes straight from CLAUDE.md.
// Only real source files are eligible for code-level categories.
// ---------------------------------------------------------------------------

const isSource = (m) => m.language !== 'other';

/** Complexity: highest loc × maxNestingDepth. */
export function selectComplexityFiles(fileMetrics, limit = PER_CATEGORY_LIMIT) {
  return fileMetrics
    .filter(isSource)
    .map((m) => ({ m, score: m.loc * m.maxNestingDepth }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/** Test debt: files with no corresponding test file (largest first). */
export function selectTestDebtFiles(fileMetrics, limit = PER_CATEGORY_LIMIT) {
  return fileMetrics
    .filter((m) => isSource(m) && m.hasTestFile === false)
    .sort((a, b) => b.loc - a.loc)
    .slice(0, limit);
}

/** Documentation debt: docstringRatio < 0.5 with functionCount > 5. */
export function selectDocumentationFiles(fileMetrics, limit = PER_CATEGORY_LIMIT) {
  return fileMetrics
    .filter((m) => isSource(m) && m.functionCount > 5 && m.docstringRatio < 0.5)
    .sort((a, b) => b.functionCount - a.functionCount)
    .slice(0, limit);
}

/** Dependency debt: manifests with a dependency older than ~365 days. */
export function selectDependencyFiles(fileMetrics, limit = PER_CATEGORY_LIMIT) {
  return fileMetrics
    .filter(
      (m) =>
        m.dependency &&
        (m.dependency.staleCount > 0 || m.dependency.maxDependencyAge > 365)
    )
    .sort((a, b) => b.dependency.maxDependencyAge - a.dependency.maxDependencyAge)
    .slice(0, limit);
}

// Run at most CONCURRENCY LLM calls simultaneously to stay within rate limits
// while still being much faster than fully sequential.
const CONCURRENCY = 10;

async function runWithConcurrency(tasks) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/**
 * Run all four debt-category extractions over their selected files.
 * All LLM calls run in parallel (capped at CONCURRENCY) across all categories.
 * @returns flat array of { file, category, debtItems } (already line-validated)
 */
export async function extractAllDebt(files, fileMetrics, onProgress = null) {
  const contentByPath = new Map(files.map((f) => [f.path, f]));

  const jobs = [
    { name: 'complexity',    fn: extractComplexityDebt,    files: selectComplexityFiles(fileMetrics) },
    { name: 'test',          fn: extractTestDebt,          files: selectTestDebtFiles(fileMetrics) },
    { name: 'dependency',    fn: extractDependencyDebt,    files: selectDependencyFiles(fileMetrics) },
    { name: 'documentation', fn: extractDocumentationDebt, files: selectDocumentationFiles(fileMetrics) },
  ];

  const total = jobs.reduce((s, j) => s + j.files.length, 0);
  console.log(`\n🤖 LLM extraction — ${total} file(s) across 4 categories (concurrency ${CONCURRENCY})...`);
  onProgress?.({ step: 'llm', message: 'Analyzing with AI…', done: 0, total });

  let completed = 0;
  const tasks = [];
  for (const job of jobs) {
    for (const metrics of job.files) {
      const file = contentByPath.get(metrics.path);
      if (!file) continue;
      tasks.push(async () => {
        const result = await job.fn(file, metrics);
        completed++;
        console.log(`   ✓ [${job.name}] ${metrics.path} — ${result.debtItems.length} item(s)`);
        onProgress?.({ step: 'llm', message: metrics.path, done: completed, total });
        return result;
      });
    }
  }

  const settled = await runWithConcurrency(tasks);
  return settled.filter(Boolean);
}

async function main() {
  const repoUrl = process.argv[2];
  if (!repoUrl) {
    console.error('Usage: node index.js <github-repo-url>');
    console.error('Example: node index.js https://github.com/expressjs/express');
    process.exit(1);
  }

  try {
    const { meta, files, fileMetrics } = await analyzeRepo(repoUrl);
    console.log(`   Static analysis done for ${fileMetrics.length} files.`);

    const debtResults = await extractAllDebt(files, fileMetrics);

    // Print the validated, line-grounded debt items (per file, per category).
    console.log('\n===== Debt items (validated, line-grounded) =====\n');
    for (const result of debtResults) {
      if (result.debtItems.length === 0) continue;
      console.log(JSON.stringify(result, null, 2));
    }

    // Severity scoring.
    const { overallHealth, categoryScores, fileScores } = scoreRepo(
      fileMetrics,
      debtResults,
      WEIGHTS
    );

    // Per-category tally.
    const byCategory = {};
    let total = 0;
    for (const r of debtResults) {
      byCategory[r.category] = (byCategory[r.category] || 0) + r.debtItems.length;
      total += r.debtItems.length;
    }

    console.log(`\n✅ ${meta.fullName}: ${total} debt item(s) total`);
    for (const cat of ['complexity', 'test', 'dependency', 'documentation']) {
      console.log(`   ${cat.padEnd(14)} ${byCategory[cat] || 0}`);
    }

    console.log('\n===== Repo health scores =====');
    console.log(`   Overall health   ${overallHealth}/100`);
    console.log(`   Weights: complexity=${WEIGHTS.complexity} test=${WEIGHTS.test} deps=${WEIGHTS.dependency} docs=${WEIGHTS.documentation}`);
    console.log('\n   Per-category debt severity (avg of LLM-graded items):');
    for (const cat of ['complexity', 'test', 'dependency', 'documentation']) {
      console.log(`   ${cat.padEnd(14)} ${categoryScores[cat]}`);
    }
    console.log('\n   Top 5 files by severity score:');
    for (const f of fileScores.slice(0, 5)) {
      console.log(`   ${f.score.toFixed(1).padStart(5)}  ${f.path}`);
    }
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, not when imported by later steps.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
