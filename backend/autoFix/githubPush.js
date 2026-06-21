// githubPush.js — real "Apply fix" backend.
//
// The auto-fix lives on an isolated scratch git repo whose baseline is a single
// synthetic commit (see fixApplier.js) — its history is NOT the user's repo, so
// a literal `git push` of that branch would create an unrelated-history branch
// and a broken compare/PR. Instead we use the GitHub API to:
//   1. read the rewritten file out of the scratch repo,
//   2. create a branch off the real repo's default branch,
//   3. commit the rewritten file onto it (one-file diff, shared history),
//   4. return the compare URL so the UI can open a PR.
//
// This needs GITHUB_TOKEN with write access (repo / public_repo). If the token
// is missing, or the push fails (no write access, etc.), we fall back to
// returning the rewritten file content for client-side download — never a
// silent failure.

import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const GITHUB_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'DebtLens',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** Map a failed GitHub response to a plain, user-safe reason. */
function ghError(res, owner, repo) {
  if (res.status === 401) return 'GitHub auth failed (401) — check GITHUB_TOKEN.';
  if (res.status === 403) {
    return `no write access to ${owner}/${repo} with the configured GITHUB_TOKEN (403).`;
  }
  if (res.status === 404) return `${owner}/${repo} not found, or the token can't see it (404).`;
  return `GitHub API error (${res.status}).`;
}

/** Read the rewritten file out of the scratch repo (it lives on `branch`). */
async function readRewritten(repoPath, branch, filePath) {
  await simpleGit(repoPath).checkout(branch).catch(() => {});
  return fs.readFile(path.join(repoPath, filePath), 'utf8');
}

/**
 * Create the branch on the real repo and commit the rewritten file onto it.
 * @returns {{ status: 'pushed', compareUrl, branch, baseBranch }}
 * @throws  Error with a user-safe message on any GitHub failure.
 */
async function pushViaApi({ token, owner, repo, branch, filePath, content, fix }) {
  const headers = ghHeaders(token);
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

  // 1. Default branch + its head commit SHA.
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(ghError(repoRes, owner, repo));
  const baseBranch = (await repoRes.json()).default_branch;

  const refRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    { headers }
  );
  if (!refRes.ok) throw new Error(`could not read the ${baseBranch} ref (${refRes.status}).`);
  const headSha = (await refRes.json()).object.sha;

  // 2. Existing file's blob SHA on the default branch (required to update it).
  let fileSha;
  const fileRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(baseBranch)}`,
    { headers }
  );
  if (fileRes.ok) fileSha = (await fileRes.json()).sha; // 404 → new file, leave unset

  // 3. Create the fix branch off the default branch's head.
  const branchRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }),
  });
  // 422 = ref already exists (re-apply) — tolerate and commit onto it.
  if (!branchRes.ok && branchRes.status !== 422) {
    throw new Error(ghError(branchRes, owner, repo));
  }

  // 4. Commit the rewritten file onto the branch.
  const putBody = {
    message: `fix(debtlens): ${fix.fixSummary || 'apply auto-fix'}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (fileSha) putBody.sha = fileSha;
  const putRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) throw new Error(ghError(putRes, owner, repo));

  return {
    status: 'pushed',
    compareUrl: `https://github.com/${owner}/${repo}/compare/${baseBranch}...${branch}?expand=1`,
    branch,
    baseBranch,
  };
}

/**
 * Apply a generated fix to the real GitHub repo (or fall back to download).
 *
 * @param {{repoPath, branch, owner, repo, fix}} args
 * @returns {Promise<
 *    | { status: 'pushed', compareUrl, branch, baseBranch }
 *    | { status: 'download', filename, content, reason }
 *    | { status: 'error', error }
 *  >}
 */
export async function pushFixToGitHub({ repoPath, branch, owner, repo, fix }) {
  const filePath = fix.file;
  const filename = path.basename(filePath);

  let content;
  try {
    content = await readRewritten(repoPath, branch, filePath);
  } catch (err) {
    // Can't proceed and can't even offer a download — keep the temp repo so the
    // user can still Discard it; report the error.
    return { status: 'error', error: `could not read the fixed file — ${err.message}` };
  }

  const token = process.env.GITHUB_TOKEN;
  const download = (reason) => ({ status: 'download', filename, content, reason });

  let result;
  if (!token) {
    result = download('GITHUB_TOKEN is not set on the server.');
  } else {
    try {
      result = await pushViaApi({ token, owner, repo, branch, filePath, content, fix });
    } catch (err) {
      result = download(err.message); // e.g. no write access to a public demo repo
    }
  }

  // The scratch repo has served its purpose (content is captured) — clean it up.
  await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
  return result;
}
