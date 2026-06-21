import { useState, useMemo } from 'react';

const CATEGORIES = ['complexity', 'test', 'dependency', 'documentation'];

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

function itemKey(item) {
  return `${item.file}::${item.id}`;
}

function SortButton({ label, sortKey, current, dir, onSort }) {
  const active = current === sortKey;
  return (
    <button
      className={`sort-btn${active ? ' sort-active' : ''}`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span className="sort-arrow">{dir === 'desc' ? ' ↓' : ' ↑'}</span>}
    </button>
  );
}

function DebtRow({ item, expanded, onToggle, onSelect }) {
  return (
    <div className={`debt-row-wrapper${expanded ? ' expanded' : ''}`}>
      <div
        className="debt-row"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onToggle()}
      >
        <span className={`sev-badge ${severityClass(item.severity)}`}>
          {item.severity}
        </span>
        <span className={`cat-tag cat-${item.category}`}>
          {CAT_LABEL[item.category]}
        </span>
        <span className="debt-file" title={item.file}>
          {item.file}
        </span>
        <span className="debt-summary">{item.summary}</span>
        <span className="expand-arrow">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="debt-detail">
          <div className="detail-section">
            <span className="detail-label">Why this is debt</span>
            <p className="detail-reasoning">{item.reasoning}</p>
          </div>
          {item.refactorSuggestion && (
            <div className="detail-section">
              <span className="detail-label">Suggested fix</span>
              <p className="detail-refactor">{item.refactorSuggestion}</p>
            </div>
          )}
          {item.lineRefs?.length > 0 && (
            <div className="detail-meta">
              <span className="detail-label">Lines</span>
              <span className="detail-linerefs">
                {item.lineRefs.slice(0, 10).join(', ')}
                {item.lineRefs.length > 10 ? ` +${item.lineRefs.length - 10} more` : ''}
              </span>
              <button
                className="btn btn-ghost btn-sm view-file-btn"
                onClick={(e) => { e.stopPropagation(); onSelect(item); }}
              >
                View lines →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DebtList({ debtResults, onSelect }) {
  const [sortKey, setSortKey] = useState('severity');
  const [sortDir, setSortDir] = useState('desc');
  const [active, setActive] = useState(new Set(CATEGORIES));
  const [expandedKey, setExpandedKey] = useState(null);

  const allItems = useMemo(
    () =>
      debtResults.flatMap((r) =>
        r.debtItems.map((item) => ({ ...item, file: r.file, category: r.category }))
      ),
    [debtResults]
  );

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'severity' ? 'desc' : 'asc');
    }
  }

  function toggleCategory(cat) {
    setActive((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  function toggleExpand(key) {
    setExpandedKey((prev) => (prev === key ? null : key));
  }

  const displayed = useMemo(() => {
    const filtered = allItems.filter((item) => active.has(item.category));
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'severity') cmp = a.severity - b.severity;
      else if (sortKey === 'category') cmp = a.category.localeCompare(b.category);
      else if (sortKey === 'file') cmp = a.file.localeCompare(b.file);
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [allItems, active, sortKey, sortDir]);

  if (allItems.length === 0) return null;

  return (
    <div className="debt-list">
      <div className="debt-list-toolbar">
        <h2 className="debt-list-title">
          Debt Items
          <span className="debt-count">{displayed.length}</span>
        </h2>
        <div className="debt-filters">
          {CATEGORIES.map((cat) => (
            <label
              key={cat}
              className={`filter-chip cat-chip-${cat}${active.has(cat) ? ' chip-active' : ''}`}
            >
              <input
                type="checkbox"
                checked={active.has(cat)}
                onChange={() => toggleCategory(cat)}
              />
              {CAT_LABEL[cat]}
            </label>
          ))}
        </div>
      </div>

      <div className="debt-table">
        <div className="debt-table-head">
          <SortButton label="Severity" sortKey="severity" current={sortKey} dir={sortDir} onSort={toggleSort} />
          <SortButton label="Category" sortKey="category" current={sortKey} dir={sortDir} onSort={toggleSort} />
          <SortButton label="File"     sortKey="file"     current={sortKey} dir={sortDir} onSort={toggleSort} />
          <span className="col-summary">Summary</span>
          <span />
        </div>

        <div className="debt-table-body">
          {displayed.map((item, i) => {
            const key = `${itemKey(item)}::${i}`;
            return (
              <DebtRow
                key={key}
                item={item}
                expanded={expandedKey === key}
                onToggle={() => toggleExpand(key)}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
