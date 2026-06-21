// repoStore.js — in-memory cache of completed repo analyses, keyed by
// "owner/repo" (matches result.meta.fullName from GitHub). Caps at MAX_REPOS
// entries, evicting the least-recently-analyzed repo when a new one would
// exceed the cap. Re-analyzing an existing repo refreshes its recency and
// overwrites the stored result rather than creating a duplicate entry.

const MAX_REPOS = 5;
const store = new Map(); // "owner/repo" -> full analysis result

export function saveResult(result) {
  const key = result.meta.fullName;
  store.delete(key); // drop + re-insert so it becomes the most recent
  store.set(key, result);
  if (store.size > MAX_REPOS) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
}

/** Most-recently-analyzed first. */
export function listRepos() {
  return [...store.entries()].reverse().map(([key, result]) => {
    const [owner, repo] = key.split('/');
    return {
      owner,
      repo,
      healthScore: result.overallHealth,
      analyzedAt: result.meta.analyzedAt,
      language: result.meta.language,
      fileCount: result.meta.fileCount,
    };
  });
}

export function getRepo(owner, repo) {
  return store.get(`${owner}/${repo}`) ?? null;
}

/** Returns true if an entry existed and was removed. */
export function deleteRepo(owner, repo) {
  return store.delete(`${owner}/${repo}`);
}
