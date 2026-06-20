// index.js — DebtLens backend entry point.
//
// CLI driver:
//   node index.js <github-url>
//
// Step 1: traverse the repo and run the static-analysis pass (no LLM).
// Step 2: pick the 10 files with the highest loc × maxNestingDepth score,
//         send each to the Anthropic API, and print validated, line-grounded
//         complexity-debt items.
//
// Later steps add the other debt categories, scoring, and an Express server.

import './env.js'; // load .env before anything reads process.env
import { getRepoFiles } from './github.js';
import {
  analyzeFile,
  analyzeDependencies,
  buildRepoIndex,
} from './staticAnalysis.js';
import { extractComplexityDebt } from './llmExtractor.js';

const COMPLEXITY_FILE_LIMIT = 10;

/**
 * Run the full static-analysis pass over a repo.
 * Returns the file contents alongside the metrics so later (LLM) steps can use
 * both without re-fetching.
 */
export async function analyzeRepo(repoUrl) {
  const { meta, files, allPaths } = await getRepoFiles(repoUrl);
  const repoIndex = buildRepoIndex(allPaths);

  console.log('🧮 Running static analysis...');

  const fileMetrics = [];
  for (const file of files) {
    const metrics = analyzeFile(file, repoIndex);

    // Dependency manifests get an extra async pass (npm / PyPI age lookups).
    const dependency = await analyzeDependencies(file);
    if (dependency) metrics.dependency = dependency;

    fileMetrics.push(metrics);
  }

  return { meta, files, fileMetrics };
}

/**
 * Pick the files to run complexity extraction on: highest loc × maxNestingDepth.
 * Only real source files are eligible — markdown/config carry no code-complexity
 * debt, so we don't spend LLM calls on them.
 */
export function selectComplexityFiles(fileMetrics, limit = COMPLEXITY_FILE_LIMIT) {
  return fileMetrics
    .filter((m) => m.language !== 'other')
    .map((m) => ({ metrics: m, score: m.loc * m.maxNestingDepth }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.metrics);
}

/**
 * Step 2: run complexity-debt extraction over the selected files.
 * @returns array of { file, debtItems } (debtItems already line-validated)
 */
export async function extractComplexityForRepo(files, fileMetrics) {
  const contentByPath = new Map(files.map((f) => [f.path, f]));
  const selected = selectComplexityFiles(fileMetrics);

  console.log(
    `\n🤖 Extracting complexity debt from the top ${selected.length} files ` +
      `by loc × maxNestingDepth (Anthropic API)...`
  );

  const results = [];
  for (const metrics of selected) {
    const file = contentByPath.get(metrics.path);
    if (!file) continue;
    const score = metrics.loc * metrics.maxNestingDepth;
    process.stdout.write(`   • ${metrics.path} (score ${score}) ... `);
    const result = await extractComplexityDebt(file, metrics);
    console.log(`${result.debtItems.length} grounded item(s)`);
    results.push(result);
  }

  return results;
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

    const debtResults = await extractComplexityForRepo(files, fileMetrics);

    // Print the validated, line-grounded debt items (Step 2 done-when).
    console.log('\n===== Complexity debt (validated, line-grounded) =====\n');
    for (const result of debtResults) {
      if (result.debtItems.length === 0) continue;
      console.log(JSON.stringify(result, null, 2));
    }

    const filesWithDebt = debtResults.filter((r) => r.debtItems.length > 0).length;
    const totalItems = debtResults.reduce((n, r) => n + r.debtItems.length, 0);

    console.log(
      `\n✅ ${meta.fullName}: ${totalItems} complexity-debt item(s) across ` +
        `${filesWithDebt} file(s) (of ${debtResults.length} analyzed).`
    );
    if (filesWithDebt < 3) {
      console.log(
        'ℹ️  Fewer than 3 files returned grounded debt — try a larger / messier repo.'
      );
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
