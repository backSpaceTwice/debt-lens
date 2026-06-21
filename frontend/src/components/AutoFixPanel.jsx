import { useEffect, useRef, useState } from 'react';

// Step 9d — auto-fix panel. Triggered from the FileDrilldown sidebar.
//
// Lifecycle: on mount it POSTs the file + debt item to /api/autofix, which
// generates the fix (9a), applies it to an isolated temp branch + syntax-checks
// it (9b), and returns a unified diff (9c). This component renders the diff,
// the honest confidence score, and Apply / Discard controls — and never shows a
// diff for a fix that was declined or failed its syntax check.
//
// Safety/UX invariants honored here:
//   - confidence is always visible
//   - declined / syntax-failed fixes show the plain reason, never a blank panel
//   - the empty "no changes detected" case is shown explicitly
//   - closing without applying discards the temp branch (best effort on unmount)

const LOADING_STEPS = ['Generating fix…', 'Checking syntax…', 'Building diff…'];

function confidenceClass(c) {
  if (c >= 80) return 'sev-green';
  if (c >= 65) return 'sev-amber';
  return 'sev-red';
}

/** Split a unified-diff string into classified lines for coloring. */
function diffLines(diff) {
  return diff.split('\n').map((line, i) => {
    let kind = 'context';
    if (line.startsWith('@@')) kind = 'hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) kind = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) kind = 'del';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('=')) kind = 'meta';
    return { key: i, kind, text: line };
  });
}

export default function AutoFixPanel({ item, fileContent, repoFullName, onClose }) {
  const [phase, setPhase] = useState('loading'); // loading | done
  const [stepIdx, setStepIdx] = useState(0);
  const [result, setResult] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null); // {mode:'pushed'|'download', ...}
  const [applyError, setApplyError] = useState(null);
  const applied = applyResult !== null;

  // "owner/repo" → parts for the push endpoint.
  const [owner, repo] = (repoFullName ?? '/').split('/');

  // Keep the latest applied-fix coordinates for unmount cleanup without
  // re-running the effect.
  const cleanupRef = useRef({ repoPath: null, branch: null, applied: false });

  // Close on Escape.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') handleClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cosmetic step ticker while the single request is in flight.
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = setInterval(
      () => setStepIdx((i) => Math.min(i + 1, LOADING_STEPS.length - 1)),
      1100
    );
    return () => clearInterval(t);
  }, [phase]);

  // Kick off the auto-fix request once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/autofix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: { path: item.file, content: fileContent },
            debtItem: item,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          setResult({ status: 'error', reason: data.error ?? `HTTP ${res.status}` });
        } else {
          setResult(data);
          if (data.status === 'applied') {
            cleanupRef.current = { repoPath: data.repoPath, branch: data.branch, applied: false };
          }
        }
      } catch (err) {
        if (alive) setResult({ status: 'error', reason: err.message });
      } finally {
        if (alive) setPhase('done');
      }
    })();

    return () => {
      alive = false;
      // Best-effort cleanup if the panel unmounts with an un-applied fix.
      const { repoPath, branch, applied: wasApplied } = cleanupRef.current;
      if (repoPath && !wasApplied) {
        fetch('/api/autofix/discard', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath, branch }),
          keepalive: true,
        }).catch(() => {});
        cleanupRef.current = { repoPath: null, branch: null, applied: false };
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function discardOnServer() {
    if (!result || result.status !== 'applied' || applied) return;
    cleanupRef.current = { repoPath: null, branch: null, applied: false };
    try {
      await fetch('/api/autofix/discard', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: result.repoPath, branch: result.branch }),
      });
    } catch { /* best effort */ }
  }

  async function handleClose() {
    await discardOnServer();
    onClose();
  }

  async function handleApply() {
    setApplyError(null);
    setApplying(true);
    try {
      const res = await fetch('/api/autofix/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: result.repoPath,
          branch: result.branch,
          owner,
          repo,
          fix: result.fix,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status === 'error') {
        setApplyError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      // The backend consumed (and removed) the scratch repo — don't re-discard.
      cleanupRef.current = { repoPath: null, branch: null, applied: true };

      if (data.status === 'pushed') {
        setApplyResult({ mode: 'pushed', compareUrl: data.compareUrl });
        window.open(data.compareUrl, '_blank', 'noopener,noreferrer');
      } else if (data.status === 'download') {
        // No write access / no token → download the rewritten file instead.
        const blob = new Blob([data.content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setApplyResult({ mode: 'download', filename: data.filename, reason: data.reason });
      }
    } catch (err) {
      setApplyError(err.message);
    } finally {
      setApplying(false);
    }
  }

  async function handleDiscard() {
    await discardOnServer();
    onClose();
  }

  const r = result;

  return (
    <div
      className="drilldown-overlay"
      onClick={(e) => { e.stopPropagation(); handleClose(); }}
    >
      <div className="autofix-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drilldown-header">
          <div className="drilldown-header-left">
            <span className="drilldown-path">Auto-fix · {item.file}</span>
          </div>
          <button className="drilldown-close" onClick={handleClose} aria-label="Close">✕</button>
        </div>

        <div className="autofix-body">
          {/* ── Loading ──────────────────────────────────────────────── */}
          {phase === 'loading' && (
            <div className="autofix-loading">
              {LOADING_STEPS.map((label, i) => (
                <div
                  key={label}
                  className={`loading-step step-${i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'pending'}`}
                >
                  <span className="step-icon">{i < stepIdx ? '✓' : i === stepIdx ? '●' : '○'}</span>
                  <span className="step-label">{label}</span>
                  {i === stepIdx && <span className="step-spinner" />}
                </div>
              ))}
            </div>
          )}

          {/* ── Declined (9a gate) ───────────────────────────────────── */}
          {phase === 'done' && r?.status === 'declined' && (
            <div className="autofix-notice">
              <div className="autofix-notice-title">Couldn’t auto-fix this</div>
              <p className="autofix-notice-text">{r.reason}</p>
              {typeof r.confidence === 'number' && (
                <p className="autofix-notice-sub">Model confidence was {r.confidence}%.</p>
              )}
            </div>
          )}

          {/* ── Syntax failed (9b gate) ──────────────────────────────── */}
          {phase === 'done' && r?.status === 'syntax_failed' && (
            <div className="autofix-notice autofix-notice-fail">
              <div className="autofix-notice-title">Fix failed the syntax check</div>
              <p className="autofix-notice-text">
                The generated change didn’t parse, so it was discarded automatically — no diff is shown.
              </p>
              {r.detail && <pre className="autofix-detail">{r.detail}</pre>}
            </div>
          )}

          {/* ── Unexpected error ─────────────────────────────────────── */}
          {phase === 'done' && r?.status === 'error' && (
            <div className="autofix-notice autofix-notice-fail">
              <div className="autofix-notice-title">Auto-fix error</div>
              <p className="autofix-notice-text">{r.reason}</p>
            </div>
          )}

          {/* ── Applied, but no actual changes ───────────────────────── */}
          {phase === 'done' && r?.status === 'applied' && !r.hasChanges && (
            <div className="autofix-notice">
              <div className="autofix-notice-title">No changes detected</div>
              <p className="autofix-notice-text">
                The model returned the file unchanged — there was nothing to safely rewrite for this item.
              </p>
            </div>
          )}

          {/* ── Applied with a real diff ─────────────────────────────── */}
          {phase === 'done' && r?.status === 'applied' && r.hasChanges && (
            <>
              <div className="autofix-meta">
                <span className={`sev-badge ${confidenceClass(r.fix.confidence)}`}>
                  {r.fix.confidence}
                </span>
                <span className="autofix-confidence-text">
                  {r.fix.confidence}% confident — review before merging
                  {!r.syntaxChecked && ' · syntax check skipped for this file type'}
                </span>
              </div>

              <p className="autofix-summary">{r.fix.fixSummary}</p>

              <div className="autofix-diff">
                {diffLines(r.diff).map(({ key, kind, text }) => (
                  <div key={key} className={`diff-line diff-${kind}`}>{text || ' '}</div>
                ))}
              </div>

              {r.fix.verificationSteps?.length > 0 && (
                <div className="autofix-verify">
                  <span className="sidebar-label">Reviewer should check</span>
                  <ul className="autofix-verify-list">
                    {r.fix.verificationSteps.map((v, i) => <li key={i}>{v}</li>)}
                  </ul>
                </div>
              )}

              <div className="autofix-actions">
                {applyResult?.mode === 'pushed' ? (
                  <span className="autofix-applied-note">
                    Pushed to GitHub —{' '}
                    <a href={applyResult.compareUrl} target="_blank" rel="noreferrer">
                      open the pull request
                    </a>
                    .
                  </span>
                ) : applyResult?.mode === 'download' ? (
                  <span className="autofix-applied-note">
                    Downloaded <code>{applyResult.filename}</code> — apply it manually.
                    {applyResult.reason ? ` (${applyResult.reason})` : ''}
                  </span>
                ) : (
                  <>
                    <button className="btn btn-primary" onClick={handleApply} disabled={applying}>
                      {applying ? 'Applying…' : 'Apply fix'}
                    </button>
                    <button className="btn btn-ghost" onClick={handleDiscard} disabled={applying}>
                      Discard
                    </button>
                    {applyError && <span className="autofix-apply-error">{applyError}</span>}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
