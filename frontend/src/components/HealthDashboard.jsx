import { useState } from 'react';
import { healthColorClass } from '../utils.js';

const CATEGORY_LABELS = {
  complexity:    'Complexity',
  test:          'Test Coverage',
  dependency:    'Dependencies',
  documentation: 'Documentation',
};

const CATEGORIES = ['complexity', 'test', 'dependency', 'documentation'];

const DEFAULT_WEIGHTS = { complexity: 35, test: 30, dependency: 20, documentation: 15 };

const SLIDER_COLORS = {
  complexity:    '#e8973a',
  test:          '#1f9d6e',
  dependency:    '#7c5cd6',
  documentation: '#5468c4',
};

function severityToHealth(severity) {
  return Math.round(100 - severity);
}

function bandLabel(score) {
  if (score > 70) return 'Healthy';
  if (score >= 40) return 'Needs attention';
  return 'Critical';
}

function ScoreRing({ score }) {
  const cls = healthColorClass(score);
  return (
    <div className={`score-ring ${cls}`} style={{ '--score': score }}>
      <span className="score-ring-value">{score}</span>
      <span className="score-ring-label">/100</span>
    </div>
  );
}

function CategoryCard({ category, severity }) {
  const health = severityToHealth(severity);
  const cls = healthColorClass(health);
  return (
    <div className={`category-card ${cls}-border`}>
      <div className="category-name">{CATEGORY_LABELS[category]}</div>
      <div className={`category-score ${cls}`}>{health}</div>
      <div className="category-band-label">{bandLabel(health)}</div>
    </div>
  );
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function HealthDashboard({ data }) {
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);

  const { meta, categoryScores } = data;

  const totalWeight = CATEGORIES.reduce((s, c) => s + (weights[c] ?? 0), 0) || 1;

  const overallHealth = Math.max(0, Math.min(100, Math.round(
    100 - CATEGORIES.reduce((sum, cat) => {
      return sum + (categoryScores[cat] ?? 0) * (weights[cat] ?? 0) / totalWeight;
    }, 0)
  )));

  function setWeight(cat, val) {
    setWeights((prev) => ({ ...prev, [cat]: Number(val) }));
  }

  function resetWeights() {
    setWeights(DEFAULT_WEIGHTS);
  }

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
        </div>
        <div className="overall-right">
          <div className="overall-label">Overall Health</div>
          <ScoreRing score={overallHealth} />
        </div>
      </div>

      <div className="category-grid">
        {CATEGORIES.map((cat) => (
          <CategoryCard
            key={cat}
            category={cat}
            severity={categoryScores[cat] ?? 0}
          />
        ))}
      </div>

      <div className="weight-panel">
        <div className="weight-panel-header">
          <span className="weight-panel-title">Severity Weights</span>
          <span className="weight-panel-hint">Drag to adjust how each category affects the overall health score</span>
          <button className="btn btn-ghost btn-sm weight-reset-btn" onClick={resetWeights}>
            Reset
          </button>
        </div>
        <div className="weight-rows">
          {CATEGORIES.map((cat) => {
            const pct = Math.round((weights[cat] ?? 0) / totalWeight * 100);
            return (
              <div key={cat} className="weight-row">
                <span className="weight-label">{CATEGORY_LABELS[cat]}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={weights[cat]}
                  onChange={(e) => setWeight(cat, e.target.value)}
                  className="weight-slider"
                  style={{ '--slider-color': SLIDER_COLORS[cat] }}
                />
                <span className="weight-pct">{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
