import { useEffect, useState } from 'react';
import TopBar from './components/TopBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import RepoInput from './components/RepoInput.jsx';
import HealthDashboard from './components/HealthDashboard.jsx';
import DebtList from './components/DebtList.jsx';
import FileDrilldown from './components/FileDrilldown.jsx';

const STAGES = [
  { key: 'fetch',    label: 'Fetching repository files' },
  { key: 'analysis', label: 'Running static analysis' },
  { key: 'llm',      label: 'Analyzing with AI' },
  { key: 'scoring',  label: 'Scoring results' },
];

function stageState(key, steps) {
  const seen = new Set(steps.map((s) => s.step));
  const after = (k) => {
    const idx = STAGES.findIndex((s) => s.key === k);
    return STAGES.slice(idx + 1).some((s) => seen.has(s.key));
  };

  if (key === 'fetch') {
    if (seen.has('fetch_done') || after('fetch')) return 'done';
    if (seen.has('fetch')) return 'active';
  }
  if (key === 'analysis') {
    if (seen.has('analysis_done') || seen.has('llm') || seen.has('scoring')) return 'done';
    if (seen.has('analysis')) return 'active';
  }
  if (key === 'llm') {
    if (seen.has('scoring')) return 'done';
    if (seen.has('llm') || seen.has('analysis_done')) return 'active';
  }
  if (key === 'scoring') {
    if (seen.has('scoring')) return 'active';
  }
  return 'pending';
}

function LoadingSteps({ steps }) {
  const fetchDone = steps.find((s) => s.step === 'fetch_done');
  const llmSteps  = steps.filter((s) => s.step === 'llm');
  const lastLlm   = llmSteps[llmSteps.length - 1];

  return (
    <div className="loading-steps">
      {STAGES.map(({ key, label }) => {
        const state = stageState(key, steps);
        return (
          <div key={key} className={`loading-step step-${state}`}>
            <span className="step-icon">
              {state === 'done' ? '✓' : state === 'active' ? '●' : '○'}
            </span>
            <span className="step-label">
              {label}
              {key === 'fetch' && fetchDone && (
                <span className="step-detail"> — {fetchDone.fileCount} files</span>
              )}
              {key === 'llm' && lastLlm && state === 'active' && (
                <span className="step-detail"> — {lastLlm.done}/{lastLlm.total} files</span>
              )}
            </span>
            {state === 'active' && (
              <span className="step-spinner" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function classifyError(message) {
  if (/rate limit/i.test(message)) return 'rate-limit';
  if (/private repo|not found/i.test(message)) return 'private-repo';
  return 'general';
}

function ErrorState({ message }) {
  const type = classifyError(message);
  const hints = {
    'rate-limit': 'GitHub allows 60 unauthenticated requests per hour. Set a GITHUB_TOKEN in the backend .env to raise this to 5 000/hour, or wait for the reset time shown above.',
    'private-repo': 'DebtLens only supports public repositories. Check the URL and make sure the repo is public.',
  };
  return (
    <div className="error-state">
      <div className="error-message"><strong>Analysis failed:</strong> {message}</div>
      {hints[type] && <div className="error-hint">{hints[type]}</div>}
    </div>
  );
}

export default function App() {
  const [result, setResult]           = useState(null);
  const [loading, setLoading]         = useState(false);
  const [loadingSteps, setLoadingSteps] = useState([]);
  const [error, setError]             = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [repos, setRepos] = useState([]);

  async function refreshRepos() {
    try {
      const res = await fetch('/api/repos');
      if (res.ok) setRepos(await res.json());
    } catch {
      // Sidebar history is best-effort — silently skip on failure.
    }
  }

  useEffect(() => {
    refreshRepos();
  }, []);

  async function handleSelectRepo(owner, repo) {
    setError(null);
    setSelectedItem(null);
    try {
      const res = await fetch(`/api/repos/${owner}/${repo}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteRepo(owner, repo) {
    try {
      await fetch(`/api/repos/${owner}/${repo}`, { method: 'DELETE' });
    } catch {
      // Best-effort — refreshRepos() below will reflect whatever the server actually has.
    }
    if (result?.meta?.fullName === `${owner}/${repo}`) {
      setResult(null);
      setSelectedItem(null);
    }
    refreshRepos();
  }

  async function handleAnalyze(repoUrl, fileCount) {
    setLoading(true);
    setLoadingSteps([]);
    setError(null);
    setResult(null);
    setSelectedItem(null);

    try {
      const res = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, fileCount }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          let msg;
          try { msg = JSON.parse(part.slice(6)); } catch { continue; }

          if (msg.type === 'progress') {
            setLoadingSteps((prev) => [...prev, msg]);
          } else if (msg.type === 'done') {
            setResult(msg.result);
            refreshRepos();
          } else if (msg.type === 'error') {
            throw new Error(msg.message);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      {selectedItem && result?.fileContents && (
        <FileDrilldown
          item={selectedItem}
          fileContent={result.fileContents[selectedItem.file] ?? ''}
          repoFullName={result.meta?.fullName}
          onClose={() => setSelectedItem(null)}
        />
      )}

      <TopBar />

      <div className="app-body">
        <Sidebar
          repos={repos}
          activeFullName={result?.meta?.fullName ?? null}
          onSelectRepo={handleSelectRepo}
          onDeleteRepo={handleDeleteRepo}
          loading={loading}
        />

        <div className="app-content">
          <header className="app-header">
            <h1 className="app-title">DebtLens</h1>
            <p className="app-subtitle">Technical debt scanner for GitHub repositories</p>
          </header>

          <main className="app-main">
            <RepoInput onAnalyze={handleAnalyze} loading={loading} />

            {loading && <LoadingSteps steps={loadingSteps} />}

            {error && <ErrorState message={error} />}

            {result && !loading && (
              <>
                <HealthDashboard data={result} />
                <DebtList
                  debtResults={result.debtResults}
                  onSelect={setSelectedItem}
                />
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
