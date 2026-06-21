// fixApplier.js — Step 9b: apply a generated fix to an ISOLATED temp branch
// and gate it behind a syntax check before anything reaches the user.
//
// Safety invariants (CLAUDE.md §9e — never violate):
//   - NEVER write to the original repo's main branch. We don't even clone the
//     original repo; DebtLens only ever had the file *content* (fetched via the
//     GitHub API), so we build a throwaway scratch git repo containing just that
//     file, commit it as the baseline "main", and put the fix on its own
//     `debtlens/autofix-{timestamp}` branch. The user's repo is never touched.
//   - NEVER apply a fix without a passing syntax check. A failed check deletes
//     the branch immediately and returns a reason — no commit, no diff.
//   - ALWAYS delete the temp branch (and the whole scratch repo) on discard.
//
// Syntax check per language (CLAUDE.md §9b):
//   .js / .ts        → node --check
//   .py              → python -m py_compile
//   .go              → go vet
//   anything else    → skip the check, and cap effective confidence at 70
//
// Why a scratch repo instead of a full `git clone`: the 50-file cap means we
// rarely have the whole repo on hand, a deep clone is slow/fragile over the
// network, and a per-file syntax check + diff needs nothing more than the one
// file. Branch isolation, the commit history, and `git.checkout('main')` from
// the spec all still hold — main here is our baseline, not the user's.

import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const execFile = promisify(execFileCb);

// Effective-confidence ceiling for files we cannot syntax-check (CLAUDE.md §9b).
const UNCHECKED_CONFIDENCE_CEILING = 70;

// Extensions we run a real syntax check on, mapped to a checker key.
const CHECKER_BY_EXT = {
  js: 'node',
  mjs: 'node',
  cjs: 'node',
  ts: 'node',
  py: 'python',
  go: 'go',
};
// Note: .jsx / .tsx are deliberately absent — `node --check` cannot parse JSX,
// so they fall through to "skip check + confidence ceiling 70" rather than
// failing every valid React fix.

function extOf(filePath) {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Try `python3 -m py_compile`, then fall back to `python` if python3 is absent.
 * Normalises all three outcomes into the same {checked, ok, output} shape:
 *   - python3 (or python) succeeds        → checked:true,  ok:true
 *   - both python3 and python are missing  → checked:false, ok:true  (skip)
 *   - syntax error reported by interpreter → checked:true,  ok:false
 *
 * @param {string} absFilePath  absolute path to the file under check
 * @param {string} repoPath     scratch repo root (used as cwd)
 * @returns {Promise<{checked: boolean, ok: boolean, output: string}>}
 */
async function runPythonCheck(absFilePath, repoPath) {
  const pyArgs = ['-m', 'py_compile', absFilePath];

  // First attempt: python3
  try {
    const { stdout, stderr } = await execFile('python3', pyArgs, { cwd: repoPath });
    return { checked: true, ok: true, output: (stderr || stdout || '').trim() };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // python3 exists but reported a syntax error.
      return { checked: true, ok: false, output: (err.stderr || err.message || '').trim() };
    }
  }

  // Second attempt: plain python (python3 was not found)
  try {
    const { stdout, stderr } = await execFile('python', pyArgs, { cwd: repoPath });
    return { checked: true, ok: true, output: (stderr || stdout || '').trim() };
  } catch (err2) {
    if (err2.code === 'ENOENT') {
      return { checked: false, ok: true, output: 'python not installed — check skipped' };
    }
    return { checked: true, ok: false, output: (err2.stderr || err2.message || '').trim() };
  }
}

/**
 * Run the per-language syntax check on a file already written to disk.
 *
 * @param {string} absFilePath  absolute path to the written file
 * @param {string} repoPath     scratch repo root (used as cwd)
 * @returns {Promise<{checked: boolean, ok: boolean, output: string}>}
 *   checked=false → language unsupported, no check was run (caller caps confidence)
 */
export async function runSyntaxCheck(absFilePath, repoPath) {
  const ext = extOf(absFilePath);
  const checker = CHECKER_BY_EXT[ext];
  if (!checker) {
    return { checked: false, ok: true, output: `no syntax checker for .${ext}` };
  }

  // For JS/TS, ensure module syntax (import/export) parses. The scratch repo
  // has no package.json of its own (unless the file under fix *is* one, which
  // never reaches here), so drop a minimal {"type":"module"} marker so
  // `node --check` treats .js as ESM — matching this codebase.
  if (checker === 'node' && path.basename(absFilePath) !== 'package.json') {
    try {
      await fs.writeFile(
        path.join(repoPath, 'package.json'),
        JSON.stringify({ type: 'module' }),
        { flag: 'wx' } // don't clobber if one already exists
      );
    } catch {
      /* already exists — fine */
    }
  }

  if (checker === 'python') {
    return runPythonCheck(absFilePath, repoPath);
  }

  const commands = {
    node: ['node', ['--check', absFilePath]],
    go: ['go', ['vet', absFilePath]],
  };

  const [cmd, args] = commands[checker];
  try {
    const { stdout, stderr } = await execFile(cmd, args, { cwd: repoPath });
    return { checked: true, ok: true, output: (stderr || stdout || '').trim() };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { checked: false, ok: true, output: `${cmd} not installed — check skipped` };
    }
    // Real syntax / vet failure: non-zero exit with diagnostics.
    return { checked: true, ok: false, output: (err.stderr || err.message || '').trim() };
  }
}

/**
 * Build the isolated scratch git repo: a temp dir whose "main" branch holds the
 * original file content. The fix will later go on its own branch off this.
 *
 * @param {{path: string, content: string}} file  original file (path + content)
 * @returns {Promise<string>} repoPath of the scratch repo
 */
export async function prepareTempRepo(file) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'debtlens-autofix-'));
  const git = simpleGit(repoPath);

  await git.init();
  // Force the baseline branch name to "main" regardless of the host git's
  // init.defaultBranch — works before the first commit and on any git version.
  await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // Local identity so commits work even where no global git user is configured.
  await git.addConfig('user.email', 'autofix@debtlens.local');
  await git.addConfig('user.name', 'DebtLens AutoFix');

  const abs = path.join(repoPath, file.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, file.content);

  await git.add(file.path);
  await git.commit('chore(debtlens): baseline original file');

  return repoPath;
}

/**
 * Apply a generated fix to a fresh branch in an existing scratch repo, gated by
 * a syntax check. Mirrors the CLAUDE.md §9b reference flow.
 *
 * @param {string} repoPath  scratch repo from prepareTempRepo()
 * @param {object} fix       the `fix` object from fixGenerator.generateFix()
 * @returns {Promise<
 *    | { success: true, branch, commitHash, syntaxChecked, effectiveConfidence }
 *    | { success: false, reason, detail? }
 *  >}
 */
export async function applyFix(repoPath, fix) {
  const git = simpleGit(repoPath);
  const branch = `debtlens/autofix-${Date.now()}`;

  await git.checkoutLocalBranch(branch);

  const abs = path.join(repoPath, fix.file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, fix.rewrittenContent);

  // Syntax gate — before anything else gets committed.
  const syntax = await runSyntaxCheck(abs, repoPath);
  if (syntax.checked && !syntax.ok) {
    // Failed: tear the branch down immediately. No commit, no diff.
    await git.checkout('main');
    await git.deleteLocalBranch(branch, true);
    return { success: false, reason: 'syntax check failed', detail: syntax.output };
  }

  await git.add(fix.file);
  await git.commit(`fix(debtlens): ${fix.fixSummary}`);
  const commitHash = (await git.revparse(['HEAD'])).trim();

  // Files we couldn't syntax-check have their confidence capped (CLAUDE.md §9b).
  const effectiveConfidence = syntax.checked
    ? fix.confidence
    : Math.min(fix.confidence, UNCHECKED_CONFIDENCE_CEILING);

  return {
    success: true,
    branch,
    commitHash,
    syntaxChecked: syntax.checked,
    effectiveConfidence,
  };
}

/**
 * Discard a fix: return to main, delete the temp branch, and remove the whole
 * scratch repo. Satisfies "ALWAYS delete the temp branch on discard" (§9e) and
 * leaves nothing behind on disk.
 *
 * @param {string} repoPath
 * @param {string} [branch]  the autofix branch to delete (best-effort)
 */
export async function discardFix(repoPath, branch) {
  try {
    const git = simpleGit(repoPath);
    if (branch) {
      await git.checkout('main').catch(() => {});
      await git.deleteLocalBranch(branch, true).catch(() => {});
    }
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Convenience orchestrator: prepare a scratch repo for `file`, apply `fix`, and
 * return the apply result plus the repoPath (the caller keeps repoPath to later
 * build the diff in 9c or discard in 9e). On a syntax failure the scratch repo
 * is cleaned up here so the caller doesn't have to.
 *
 * @param {{path: string, content: string}} file
 * @param {object} fix  from fixGenerator.generateFix()
 */
export async function applyGeneratedFix(file, fix) {
  const repoPath = await prepareTempRepo(file);
  let result;
  try {
    result = await applyFix(repoPath, fix);
  } catch (err) {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
    return { success: false, reason: `apply failed — ${err.message}` };
  }
  if (!result.success) {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
    return result;
  }
  return { ...result, repoPath };
}

export const __internals = { extOf, CHECKER_BY_EXT, UNCHECKED_CONFIDENCE_CEILING };
