import { useState } from 'react';

const DEMO_URL = 'https://github.com/sindresorhus/slugify';

export default function RepoInput({ onAnalyze, loading }) {
  const [url, setUrl] = useState('');
  const [fileCount, setFileCount] = useState(30);

  function handleSubmit(e) {
    e.preventDefault();
    const target = url.trim() || DEMO_URL;
    onAnalyze(target, fileCount);
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
        <div className="file-count-control">
          <label className="file-count-label" htmlFor="file-count">Files</label>
          <input
            id="file-count"
            className="file-count-input"
            type="number"
            min={1}
            max={50}
            value={fileCount}
            onChange={(e) =>
              setFileCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))
            }
            disabled={loading}
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </form>
      <button className="btn btn-ghost" onClick={loadDemo} disabled={loading}>
        Load demo repo
      </button>
    </div>
  );
}
