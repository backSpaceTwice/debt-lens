import { healthColorClass } from '../utils.js';

function TerminalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 6 9 12 4 18" />
      <line x1="12" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 9 8 9" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function formatShortDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function Sidebar({ repos = [], activeFullName, onSelectRepo, onDeleteRepo, loading }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-icon"><TerminalIcon /></span>
        <div>
          <div className="sidebar-brand-title">Project Analysis</div>
          <div className="sidebar-brand-version">v2.4.0-stable</div>
        </div>
      </div>

      {repos.length > 0 && (
        <div className="sidebar-history">
          <div className="sidebar-section-label">
            <HistoryIcon />
            History
          </div>
          <div className="history-list">
            {repos.map(({ owner, repo, healthScore, analyzedAt }) => {
              const fullName = `${owner}/${repo}`;
              const active = fullName === activeFullName;
              return (
                <div
                  key={fullName}
                  className={`history-item${active ? ' history-item-active' : ''}`}
                >
                  <button
                    type="button"
                    className="history-item-main"
                    onClick={() => onSelectRepo(owner, repo)}
                    disabled={loading}
                  >
                    <span className={`history-score ${healthColorClass(healthScore)}`}>
                      {healthScore}
                    </span>
                    <span className="history-meta">
                      <span className="history-name">{fullName}</span>
                      <span className="history-time">{formatShortDate(analyzedAt)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="history-delete-btn"
                    onClick={() => onDeleteRepo(owner, repo)}
                    disabled={loading}
                    aria-label={`Remove ${fullName} from history`}
                    title="Remove from history"
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
