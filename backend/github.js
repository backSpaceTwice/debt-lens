// github.js — GitHub REST API traversal for DebtLens.
//
// Responsibilities:
//   - Parse a public GitHub repo URL into { owner, repo }
//   - List the repo's source files, filtering out noise (node_modules,
//     config JSON, lockfiles, binaries)
//   - Order by recency and cap at the 50 most-recently-modified files
//   - Fetch file contents, caching in memory for the session
//
// Auth: works unauthenticated (GitHub allows 60 req/hour). Set GITHUB_TOKEN
// in the environment to raise the limit to 5000 req/hour — strongly
// recommended, since traversing a repo costs roughly one request per file.

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_CAP = 50;

// In-memory caches, keyed for the lifetime of the process. Re-running an
// analysis on the same repo will not re-hit the GitHub API.
const blobCache = new Map(); // sha -> decoded file content (string)
const jsonCache = new Map(); // url -> parsed JSON response

// Directories and file patterns we never analyze. Lockfiles, vendored deps,
// build output, and config JSON carry no meaningful source-level debt signal.
const IGNORED_DIRS = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'vendor/',
  'venv/',
  '.venv/',
  '__pycache__/',
  'coverage/',
  '.next/',
  'out/',
];

const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
]);

// Binary / non-source extensions. We only want to reason over text source.
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp',
  'pdf', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'webm',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a',
  'lock', 'map', 'min.js', 'min.css',
]);

// Manifests we keep even though they're config — they carry dependency-debt
// signal that staticAnalysis / the dependency category cares about.
const KEPT_MANIFESTS = new Set(['package.json', 'requirements.txt']);

/**
 * Parse a GitHub repo URL (or "owner/repo" shorthand) into its parts.
 * Accepts forms like:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export function parseRepoUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Repo URL is required');
  }
  let s = input.trim();

  // git@github.com:owner/repo.git
  const sshMatch = s.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // strip protocol + host if present
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/$/, '');

  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Could not parse "owner/repo" from: ${input}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function authHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'DebtLens',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch + parse a GitHub JSON endpoint, with caching and clear errors. */
async function ghFetch(url) {
  if (jsonCache.has(url)) return jsonCache.get(url);

  const res = await fetch(url, { headers: authHeaders() });

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const mins = Math.max(0, Math.ceil((reset - Date.now()) / 60000));
      throw new Error(
        `GitHub rate limit exceeded (resets in ~${mins} min). ` +
          `Set GITHUB_TOKEN to raise the limit from 60 to 5000 req/hour.`
      );
    }
    throw new Error(`GitHub returned 403 for ${url} (forbidden / abuse limit)`);
  }
  if (res.status === 404) {
    throw new Error(`Not found: ${url} (private repo, wrong URL, or empty repo?)`);
  }
  if (!res.ok) {
    throw new Error(`GitHub request failed (${res.status}) for ${url}`);
  }

  const data = await res.json();
  jsonCache.set(url, data);
  return data;
}

/** Should this path be analyzed at all? */
function isAnalyzablePath(path) {
  const lower = path.toLowerCase();
  if (IGNORED_DIRS.some((d) => lower.includes(d))) return false;

  const base = path.split('/').pop();
  if (IGNORED_FILES.has(base)) return false;

  // Keep dependency manifests explicitly.
  if (KEPT_MANIFESTS.has(base)) return true;

  // Drop other top-level config JSON / YAML — low source-debt signal.
  if (lower.endsWith('.json') || lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    return false;
  }

  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (BINARY_EXT.has(ext)) return false;
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return false;

  return true;
}

/** Resolve the repo's default branch and basic metadata. */
async function getRepoMeta(owner, repo) {
  const data = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}`);
  return {
    defaultBranch: data.default_branch,
    language: data.language,
    fullName: data.full_name,
    description: data.description,
  };
}

/** Get the full recursive file tree for a branch (1 request). */
async function getTree(owner, repo, branch) {
  const data = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  );
  if (data.truncated) {
    console.warn(
      '⚠️  Tree was truncated by GitHub (very large repo). ' +
        'Working with the partial tree.'
    );
  }
  return (data.tree || []).filter((node) => node.type === 'blob');
}

/**
 * Order candidate paths by recency of modification.
 *
 * GitHub's commit list endpoint doesn't include per-commit file lists, so we
 * walk recent commits one at a time (bounded by a request budget) and collect
 * the paths they touch, in order. This is the "recency heuristic" surfaced in
 * the UI. If commit data is unavailable or the budget runs out, any remaining
 * candidates keep their tree order as a stable fallback.
 */
async function orderByRecency(owner, repo, branch, candidatePaths, fileCap) {
  const candidateSet = new Set(candidatePaths);
  const ordered = [];
  const seen = new Set();

  try {
    const commits = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/commits?sha=${branch}&per_page=30`
    );

    const COMMIT_DETAIL_BUDGET = 25;
    const toFetch = commits.slice(0, COMMIT_DETAIL_BUDGET);

    // Fetch all commit details in parallel — same result, much faster.
    const details = await Promise.all(
      toFetch.map((c) =>
        ghFetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${c.sha}`)
      )
    );

    // Process in chronological order (most-recent first) to preserve recency ranking.
    for (const detail of details) {
      if (ordered.length >= fileCap) break;
      for (const file of detail.files || []) {
        if (candidateSet.has(file.filename) && !seen.has(file.filename)) {
          seen.add(file.filename);
          ordered.push(file.filename);
          if (ordered.length >= fileCap) break;
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  Recency ordering unavailable (${err.message}). Using tree order.`);
  }

  // Append any candidates we didn't see in recent commits, in tree order.
  for (const path of candidatePaths) {
    if (!seen.has(path)) ordered.push(path);
  }
  return ordered;
}

/** Fetch and decode a single file's content via its blob SHA (cached). */
async function fetchBlob(owner, repo, sha) {
  if (blobCache.has(sha)) return blobCache.get(sha);
  const data = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${sha}`);
  let content = '';
  if (data.encoding === 'base64') {
    content = Buffer.from(data.content, 'base64').toString('utf8');
  } else {
    content = data.content || '';
  }
  blobCache.set(sha, content);
  return content;
}

/**
 * Main entry point: traverse a repo and return the files to analyze.
 *
 * @param {string} repoUrl  public GitHub URL or "owner/repo"
 * @returns {Promise<{meta, files, allPaths}>}
 *   meta     — repo metadata (default branch, language, name, ...)
 *   files    — up to 50 most-recently-modified analyzable files:
 *              { path, sha, content }
 *   allPaths — every analyzable path in the repo (used for hasTestFile checks)
 */
export async function getRepoFiles(repoUrl, fileCount = 30) {
  const FILE_CAP = Math.min(MAX_FILE_CAP, Math.max(1, fileCount));
  const { owner, repo } = parseRepoUrl(repoUrl);
  console.log(`🔎 Traversing ${owner}/${repo} (cap: ${FILE_CAP} files)...`);

  const meta = await getRepoMeta(owner, repo);
  const tree = await getTree(owner, repo, meta.defaultBranch);

  // Build path -> sha map over the full tree, then filter to analyzable paths.
  const shaByPath = new Map();
  for (const node of tree) shaByPath.set(node.path, node.sha);

  const allPaths = tree.map((n) => n.path);
  const analyzablePaths = allPaths.filter(isAnalyzablePath);

  console.log(
    `   ${tree.length} files in tree, ${analyzablePaths.length} analyzable ` +
      `after filtering.`
  );

  const ordered = await orderByRecency(
    owner,
    repo,
    meta.defaultBranch,
    analyzablePaths,
    FILE_CAP
  );
  const selected = ordered.slice(0, FILE_CAP);

  console.log(
    `   Selected ${selected.length} most-recently-modified files ` +
      `(cap ${FILE_CAP}). Fetching contents...`
  );

  // Fetch all blobs in parallel — each is cached by SHA so re-runs are free.
  const files = (
    await Promise.all(
      selected.map(async (path) => {
        const sha = shaByPath.get(path);
        if (!sha) return null;
        try {
          const content = await fetchBlob(owner, repo, sha);
          return { path, sha, content };
        } catch (err) {
          console.warn(`   ⚠️  Skipping ${path}: ${err.message}`);
          return null;
        }
      })
    )
  ).filter(Boolean);

  return {
    meta: { owner, repo, ...meta, fileCount: files.length, fileCap: FILE_CAP },
    files,
    allPaths,
  };
}
