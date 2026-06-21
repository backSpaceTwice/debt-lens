function TerminalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 6 9 12 4 18" />
      <line x1="12" y1="18" x2="20" y2="18" />
    </svg>
  );
}

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-icon"><TerminalIcon /></span>
        <div>
          <div className="sidebar-brand-title">Project Analysis</div>
          <div className="sidebar-brand-version">v2.4.0-stable</div>
        </div>
      </div>
    </aside>
  );
}
