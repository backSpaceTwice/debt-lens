import { useEffect, useRef } from 'react';

const CAT_LABEL = {
  complexity:    'Complexity',
  test:          'Test',
  dependency:    'Deps',
  documentation: 'Docs',
};

function severityClass(s) {
  if (s >= 70) return 'sev-red';
  if (s >= 40) return 'sev-amber';
  return 'sev-green';
}

export default function FileDrilldown({ item, fileContent, onClose }) {
  const firstHlRef = useRef(null);
  const lineRefSet = new Set(item.lineRefs ?? []);
  const lines = (fileContent ?? '// file content unavailable').split('\n');
  const lineNumWidth = String(lines.length).length;

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scroll to first highlighted line whenever item changes
  useEffect(() => {
    firstHlRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [item]);

  // Track whether we've already assigned the ref for this render pass
  let firstHlAssigned = false;

  return (
    <div className="drilldown-overlay" onClick={onClose}>
      <div className="drilldown-panel" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────��───────────────── */}
        <div className="drilldown-header">
          <div className="drilldown-header-left">
            <span className="drilldown-path">{item.file}</span>
            {item.lineRefs?.length > 0 && (
              <span className="drilldown-hl-count">
                {item.lineRefs.length} line{item.lineRefs.length !== 1 ? 's' : ''} flagged
              </span>
            )}
          </div>
          <button className="drilldown-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Body: source + sidebar ──────────────────────────────────── */}
        <div className="drilldown-body">

          {/* Source viewer */}
          <div className="source-viewer">
            {lines.map((line, idx) => {
              const lineNum = idx + 1;
              const hl = lineRefSet.has(lineNum);
              let ref = null;
              if (hl && !firstHlAssigned) {
                ref = firstHlRef;
                firstHlAssigned = true;
              }
              return (
                <div
                  key={lineNum}
                  ref={ref}
                  className={`source-line${hl ? ' source-line-hl' : ''}`}
                >
                  <span
                    className="line-num"
                    style={{ minWidth: `${lineNumWidth + 1}ch` }}
                  >
                    {lineNum}
                  </span>
                  <span className="line-content">{line || ' '}</span>
                </div>
              );
            })}
          </div>

          {/* Sidebar */}
          <aside className="drilldown-sidebar">
            <div className="sidebar-badges">
              <span className={`sev-badge ${severityClass(item.severity)}`}>
                {item.severity}
              </span>
              <span className={`cat-tag cat-${item.category}`}>
                {CAT_LABEL[item.category]}
              </span>
            </div>

            <p className="sidebar-summary">{item.summary}</p>

            <div className="sidebar-section">
              <span className="sidebar-label">Why this is debt</span>
              <p className="sidebar-text">{item.reasoning}</p>
            </div>

            {item.refactorSuggestion && (
              <div className="sidebar-section">
                <span className="sidebar-label">Suggested fix</span>
                <p className="sidebar-refactor">{item.refactorSuggestion}</p>
              </div>
            )}

            {item.lineRefs?.length > 0 && (
              <div className="sidebar-section">
                <span className="sidebar-label">Flagged lines</span>
                <div className="lineref-chips">
                  {item.lineRefs.map((ln) => (
                    <span key={ln} className="lineref-chip">L{ln}</span>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
