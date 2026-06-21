import { useState } from 'react';

const DEMO_URL = 'https://github.com/sindresorhus/slugify';

export default function RepoInput({ onAnalyze, loading }) {
  const [url, setUrl] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const target = url.trim() || DEMO_URL;
    onAnalyze(target);
  }

  function loadDemo() {
    setUrl(DEMO_URL);
  }

  return (
    <div className="repo-input-container">
      <form className="repo-input-form" onSubmit={handleSubmit}>
        <input
          className="repo-input-field"
          type="url"
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={loading}
        >
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </form>
      <button className="btn btn-ghost" onClick={loadDemo} disabled={loading}>
        Load demo repo
      </button>
    </div>
  );
}
