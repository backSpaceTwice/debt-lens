// index.js — DebtLens backend entry point.
//
// Step 1 (current): CLI driver.
//   node index.js <github-url>
// traverses the repo, runs the static analysis pass, and prints a JSON
// metrics object for each analyzed file. No LLM, no server yet.
//
// Later steps add LLM extraction (step 2) and an Express server.

import './env.js'; // load .env before anything reads process.env
import { getRepoFiles } from './github.js';
import {
  analyzeFile,
  analyzeDependencies,
  buildRepoIndex,
} from './staticAnalysis.js';

/**
 * Run the full static-analysis pass over a repo and return per-file metrics.
 */
export async function analyzeRepo(repoUrl) {
  const { meta, files, allPaths } = await getRepoFiles(repoUrl);
  const repoIndex = buildRepoIndex(allPaths);

  console.log('🧮 Running static analysis...\n');

  const fileMetrics = [];
  for (const file of files) {
    const metrics = analyzeFile(file, repoIndex);

    // Dependency manifests get an extra async pass (npm / PyPI age lookups).
    const dependency = await analyzeDependencies(file);
    if (dependency) metrics.dependency = dependency;

    fileMetrics.push(metrics);
  }

  return { meta, fileMetrics };
}

async function main() {
  const repoUrl = process.argv[2];
  if (!repoUrl) {
    console.error('Usage: node index.js <github-repo-url>');
    console.error('Example: node index.js https://github.com/expressjs/express');
    process.exit(1);
  }

  try {
    const { meta, fileMetrics } = await analyzeRepo(repoUrl);

    // Print one JSON metrics object per file (the Step 1 done-when condition).
    for (const metrics of fileMetrics) {
      console.log(JSON.stringify(metrics, null, 2));
    }

    console.log(
      `\n✅ Analyzed ${fileMetrics.length} files from ${meta.fullName} ` +
        `(${meta.language || 'unknown language'}).`
    );
    if (!process.env.GITHUB_TOKEN) {
      console.log(
        'ℹ️  Tip: set GITHUB_TOKEN to raise the GitHub rate limit ' +
          '(60 → 5000 req/hour).'
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
