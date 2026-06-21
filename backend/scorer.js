// scorer.js — severity scoring for DebtLens.
//
// computeSeverityScore() uses the exact formula from the project spec.
// Weights are module-level constants so Step 8 can expose them as sliders.

export const WEIGHTS = {
  complexity: 0.35,
  test:       0.30,
  dependency: 0.20,
  documentation: 0.15,
};

/** Clamp x to [0, 1] after linear scaling from [min, max]. */
function normalize(value, min, max) {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Compute a 0–100 severity score for one file given its static metrics.
 * `metrics.dependency.maxDependencyAge` is used for dependency debt; files
 * without a dependency block (i.e. non-manifest source files) contribute 0
 * to that component.
 */
export function computeSeverityScore(metrics, weights = WEIGHTS) {
  const complexity = normalize(metrics.loc * metrics.maxNestingDepth, 0, 5000) * 100;
  const testDebt   = metrics.hasTestFile ? 0 : 100;
  const depDebt    = normalize(
    metrics.dependency?.maxDependencyAge ?? 0,
    0,
    730
  ) * 100;
  const docDebt    = (1 - (metrics.docstringRatio ?? 0)) * 100;

  return (
    complexity * weights.complexity +
    testDebt   * weights.test +
    depDebt    * weights.dependency +
    docDebt    * weights.documentation
  );
}

/**
 * Score every file and return the repo-level summary.
 *
 * @param {object[]} fileMetrics  array of static-analysis metrics objects
 * @param {object[]} debtResults  flat array of { file, category, debtItems }
 * @param {object}   weights      optional weight overrides (defaults to WEIGHTS)
 * @returns {object} {
 *   overallHealth,        // 0–100 (100 = pristine)
 *   categoryScores,       // { complexity, test, dependency, documentation }
 *   fileScores,           // [{ path, score }] sorted by score desc
 * }
 */
export function scoreRepo(fileMetrics, debtResults, weights = WEIGHTS) {
  // Per-file severity scores.
  const fileScores = fileMetrics.map((m) => ({
    path:  m.path,
    score: computeSeverityScore(m, weights),
  })).sort((a, b) => b.score - a.score);

  // Overall repo health = 100 - mean(all file scores).
  const mean = fileScores.length
    ? fileScores.reduce((sum, f) => sum + f.score, 0) / fileScores.length
    : 0;
  const overallHealth = Math.round(100 - mean);

  // Per-category score = mean severity of the LLM-extracted debt items for
  // that category.  Items carry their own severity field set by the model.
  const buckets = { complexity: [], test: [], dependency: [], documentation: [] };
  for (const r of debtResults) {
    const cat = r.category;
    if (buckets[cat]) {
      for (const item of r.debtItems) {
        buckets[cat].push(item.severity ?? 50);
      }
    }
  }

  const categoryScores = {};
  for (const [cat, severities] of Object.entries(buckets)) {
    categoryScores[cat] = severities.length
      ? Math.round(severities.reduce((s, v) => s + v, 0) / severities.length)
      : 0;
  }

  return { overallHealth, categoryScores, fileScores };
}
