import { useState } from 'react';
import RepoInput from './components/RepoInput.jsx';
import HealthDashboard from './components/HealthDashboard.jsx';

export default function App() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleAnalyze(repoUrl) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">DebtLens</h1>
        <p className="app-subtitle">Technical debt scanner for GitHub repositories</p>
      </header>

      <main className="app-main">
        <RepoInput onAnalyze={handleAnalyze} loading={loading} />

        {loading && (
          <div className="loading-state">
            <div className="spinner" />
            <p>Fetching files, running static analysis, and consulting the AI&hellip;</p>
            <p className="loading-note">Analyzing up to 50 most-recently-modified files</p>
          </div>
        )}

        {error && (
          <div className="error-state">
            <strong>Analysis failed:</strong> {error}
          </div>
        )}

        {result && !loading && <HealthDashboard data={result} />}
      </main>
    </div>
  );
}
