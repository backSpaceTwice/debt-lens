// staticAnalysis.js — computable, LLM-free metrics for a single source file.
//
// Everything here is deterministic and grounded: no model calls, no guessing.
// These metrics are the "real static signals" the LLM later reasons on top of.
//
// Per-file metrics produced:
//   loc              — non-blank lines of code
//   functionCount    — rough count of functions/methods (regex per language)
//   maxNestingDepth  — deepest indentation level in the file
//   todoCount        — count of TODO / FIXME / HACK / XXX markers
//   hasTestFile      — does a corresponding test file exist in the repo?
//   docstringRatio   — fraction of public functions/classes that are documented
//
// Dependency age (npm / PyPI lookups) lives in analyzeDependencies() because
// it is async and only applies to manifest files.

const LANG_BY_EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', tsx: 'ts',
  py: 'py',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  php: 'php',
};

function extOf(path) {
  const base = path.split('/').pop();
  return base.includes('.') ? base.split('.').pop().toLowerCase() : '';
}

function langOf(path) {
  return LANG_BY_EXT[extOf(path)] || 'other';
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;

/** Count non-blank lines. */
function countLoc(lines) {
  return lines.filter((l) => l.trim().length > 0).length;
}

/** Count TODO/FIXME/HACK/XXX markers across the file. */
function countTodos(content) {
  const matches = content.match(TODO_RE);
  return matches ? matches.length : 0;
}

/**
 * Rough function/method count. Intentionally a regex heuristic (per the spec):
 * we want an order-of-magnitude signal, not a parser.
 */
function countFunctions(content, lang) {
  let count = 0;
  if (lang === 'js' || lang === 'ts') {
    count += (content.match(/\bfunction\b/g) || []).length;
    count += (content.match(/=>/g) || []).length;
    // class methods: `name(...) {` not preceded by a keyword
    count += (content.match(/^\s*[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*\{/gm) || []).length;
  } else if (lang === 'py') {
    count += (content.match(/^\s*def\s+\w+/gm) || []).length;
    count += (content.match(/\blambda\b/g) || []).length;
  } else if (lang === 'go') {
    count += (content.match(/\bfunc\b/g) || []).length;
  } else if (lang === 'ruby') {
    count += (content.match(/^\s*def\s+\w+/gm) || []).length;
  } else {
    // generic fallback covers C-family, Java, Rust, PHP reasonably well
    count += (content.match(/\b(function|func|def|fn)\b/g) || []).length;
    count += (content.match(/^\s*[a-zA-Z_][\w:<>*&\s]*\s+\w+\s*\([^)]*\)\s*\{/gm) || [])
      .length;
  }
  return count;
}

/**
 * Detect the file's indentation unit (smallest positive indent step in spaces).
 * Tabs count as one level each. Defaults to 2 when nothing is detectable.
 */
function detectIndentUnit(lines) {
  const widths = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^( +)/);
    if (m) widths.add(m[1].length);
  }
  let unit = 0;
  for (const w of widths) {
    if (unit === 0 || w < unit) unit = w;
  }
  return unit || 2;
}

/**
 * Max nesting depth, measured by indentation level. Robust across brace and
 * indentation languages because both indent their nested blocks.
 */
function computeMaxNestingDepth(lines) {
  const unit = detectIndentUnit(lines);
  let max = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^([ \t]*)/);
    const ws = m ? m[1] : '';
    const tabs = (ws.match(/\t/g) || []).length;
    const spaces = ws.length - tabs;
    const level = tabs + Math.floor(spaces / unit);
    if (level > max) max = level;
  }
  return max;
}

/**
 * Fraction of public functions/classes that carry a docstring or JSDoc.
 * Heuristic but deterministic; returns 1 when there are no public symbols
 * (nothing undocumented to penalize).
 */
function computeDocstringRatio(lines, lang) {
  let publicSymbols = 0;
  let documented = 0;

  if (lang === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(def|class)\s+(\w+)/);
      if (!m) continue;
      const name = m[2];
      if (name.startsWith('_')) continue; // private / dunder
      publicSymbols++;
      // docstring = first non-blank line of the body is a triple-quoted string
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (/^\s*("""|''')/.test(lines[j])) documented++;
        break;
      }
    }
  } else if (lang === 'js' || lang === 'ts') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(
        /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class)\s+(\w+)/
      );
      if (!m) continue;
      const name = m[5];
      if (name.startsWith('_')) continue;
      publicSymbols++;
      // documented = a JSDoc/block/line comment immediately precedes it
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (prev === '') continue;
        if (prev.endsWith('*/') || prev.startsWith('//') || prev.startsWith('*')) {
          documented++;
        }
        break;
      }
    }
  } else {
    // For other languages we don't have a reliable doc heuristic; treat as
    // fully documented so we don't emit a misleading penalty.
    return 1;
  }

  if (publicSymbols === 0) return 1;
  return documented / publicSymbols;
}

/**
 * Does a test file exist in the repo for this source file?
 * Looks for common test-name conventions among all repo paths.
 */
function hasCorrespondingTestFile(path, allPathsSet, allPathsLower) {
  const base = path.split('/').pop();
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : '';

  // If this file IS a test, it trivially "has tests".
  if (/(\.|_|^)(test|spec)(\.|_|s?$)/i.test(base) || /(^|\/)tests?\//i.test(path)) {
    return true;
  }

  // Candidate test filenames derived from the stem.
  const candidates = [
    `${stem}.test.${ext}`,
    `${stem}.spec.${ext}`,
    `${stem}_test.${ext}`,
    `test_${stem}.${ext}`,
    `${stem}Test.${ext}`,
    `${stem}.test.js`,
    `${stem}.spec.js`,
  ].map((c) => c.toLowerCase());

  // Match by basename anywhere in the repo (tests often live in /tests or
  // __tests__ rather than beside the source).
  for (const p of allPathsLower) {
    const b = p.split('/').pop();
    if (candidates.includes(b)) return true;
  }
  return false;
}

/**
 * Compute all synchronous static metrics for one file.
 *
 * @param {{path: string, content: string}} file
 * @param {{allPathsSet: Set<string>, allPathsLower: string[]}} repoIndex
 */
export function analyzeFile(file, repoIndex) {
  const { path, content } = file;
  const lines = content.split(/\r?\n/);
  const lang = langOf(path);

  return {
    path,
    language: lang,
    loc: countLoc(lines),
    functionCount: countFunctions(content, lang),
    maxNestingDepth: computeMaxNestingDepth(lines),
    todoCount: countTodos(content),
    hasTestFile: hasCorrespondingTestFile(
      path,
      repoIndex.allPathsSet,
      repoIndex.allPathsLower
    ),
    docstringRatio: Number(computeDocstringRatio(lines, lang).toFixed(3)),
  };
}

/**
 * Build the repo index used by analyzeFile (so we compute it once, not per file).
 */
export function buildRepoIndex(allPaths) {
  return {
    allPathsSet: new Set(allPaths),
    allPathsLower: allPaths.map((p) => p.toLowerCase()),
  };
}

// ---------------------------------------------------------------------------
// Dependency age (async — npm registry / PyPI lookups)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const depAgeCache = new Map(); // `${ecosystem}:${name}` -> ageDays | null

function daysSince(isoDate) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / DAY_MS);
}

/** Age in days since the latest published version of an npm package. */
async function npmAge(name) {
  const key = `npm:${name}`;
  if (depAgeCache.has(key)) return depAgeCache.get(key);
  let age = null;
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const latest = data['dist-tags']?.latest;
      const when = data.time?.[latest] || data.time?.modified;
      age = daysSince(when);
    }
  } catch {
    age = null;
  }
  depAgeCache.set(key, age);
  return age;
}

/** Age in days since the latest release of a PyPI package. */
async function pypiAge(name) {
  const key = `pypi:${name}`;
  if (depAgeCache.has(key)) return depAgeCache.get(key);
  let age = null;
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const version = data.info?.version;
      const releases = data.releases?.[version] || [];
      const uploaded = releases[0]?.upload_time_iso_8601 || releases[0]?.upload_time;
      age = daysSince(uploaded);
    }
  } catch {
    age = null;
  }
  depAgeCache.set(key, age);
  return age;
}

function parsePackageJsonDeps(content) {
  try {
    const pkg = JSON.parse(content);
    return Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    });
  } catch {
    return [];
  }
}

function parseRequirementsTxtDeps(content) {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
    // strip version specifiers / extras: "requests[security]>=2.0" -> "requests"
    .map((l) => l.split(/[<>=!~;[ ]/)[0].trim())
    .filter(Boolean);
}

/**
 * For a dependency manifest, look up each dependency's age and summarize.
 * Returns null for non-manifest files.
 *
 * @returns {Promise<null | {ecosystem, deps: Record<string, number|null>,
 *   maxDependencyAge: number, staleCount: number}>}
 */
export async function analyzeDependencies(file) {
  const base = file.path.split('/').pop();
  let ecosystem, names;

  if (base === 'package.json') {
    ecosystem = 'npm';
    names = parsePackageJsonDeps(file.content);
  } else if (base === 'requirements.txt') {
    ecosystem = 'pypi';
    names = parseRequirementsTxtDeps(file.content);
  } else {
    return null;
  }

  const lookup = ecosystem === 'npm' ? npmAge : pypiAge;
  const deps = {};
  let maxDependencyAge = 0;
  let staleCount = 0;

  // Lookups in parallel; each is individually cached and failure-tolerant.
  const results = await Promise.all(
    names.map(async (name) => ({ name, age: await lookup(name) }))
  );
  for (const { name, age } of results) {
    deps[name] = age;
    if (typeof age === 'number') {
      if (age > maxDependencyAge) maxDependencyAge = age;
      if (age > 365) staleCount++;
    }
  }

  return { ecosystem, deps, maxDependencyAge, staleCount };
}

export const __internals = {
  langOf,
  computeMaxNestingDepth,
  computeDocstringRatio,
  countFunctions,
  hasCorrespondingTestFile,
};
