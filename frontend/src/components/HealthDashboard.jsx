const CATEGORY_LABELS = {
  complexity: 'Complexity',
  test: 'Test Coverage',
  dependency: 'Dependencies',
  documentation: 'Documentation',
};

// categoryScores from the backend are average LLM severity (0=no debt, 100=max debt).
// Invert to a health score so color bands are consistent: green > 70, amber 40-70, red < 40.
function severityToHealth(severity) {
  return Math.round(100 - severity);
}

function colorClass(score) {
  if (score > 70) return 'score-green';
  if (score >= 40) return 'score-amber';
  return 'score-red';
}

function ScoreRing({ score }) {
  const cls = colorClass(score);
  return (
    <div className={`score-ring ${cls}`}>
      <span className="score-ring-value">{score}</span>
      <span className="score-ring-label">/100</span>
    </div>
  );
}

function CategoryCard({ category, severity }) {
  const health = severityToHealth(severity);
  const cls = colorClass(health);
  return (
    <div className={`category-card ${cls}-border`}>
      <div className="category-name">{CATEGORY_LABELS[category]}</div>
      <div className={`category-score ${cls}`}>{health}</div>
      <div className="category-band-label">{bandLabel(health)}</div>
    </div>
  );
}

function bandLabel(score) {
  if (score > 70) return 'Healthy';
  if (score >= 40) return 'Needs attention';
  return 'Critical';
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function HealthDashboard({ data }) {
  const { meta, overallHealth, categoryScores } = data;

  return (
    <div className="dashboard">
      <div className="dashboard-overall">
        <div className="overall-left">
          <h2 className="repo-name">{meta.fullName}</h2>
          <div className="repo-meta">
            {meta.language && <span className="meta-pill">{meta.language}</span>}
            <span className="meta-pill">{meta.fileCount} files analyzed</span>
            <span className="meta-pill">Analyzed {formatDate(meta.analyzedAt)}</span>
          </div>
          <p className="repo-meta-note">Top 50 most-recently-modified files</p>
        </div>
        <div className="overall-right">
          <div className="overall-label">Overall Health</div>
          <ScoreRing score={overallHealth} />
        </div>
      </div>

      <div className="category-grid">
        {['complexity', 'test', 'dependency', 'documentation'].map((cat) => (
          <CategoryCard
            key={cat}
            category={cat}
            severity={categoryScores[cat] ?? 0}
          />
        ))}
      </div>
    </div>
  );
}
