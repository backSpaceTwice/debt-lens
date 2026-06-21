// llmExtractor.js — LLM extraction across all four debt categories.
//
// Categories: complexity, test, dependency, documentation. Each has its own
// exported extraction function, but they share one parametrized core so the
// schema and the line-ref validation are identical everywhere.
//
// The complexity prompt is the CLAUDE.md "Anthropic API Prompt" used verbatim
// (the builder reproduces it byte-for-byte when its descriptor has no extra
// focus line); the other three categories adapt that same prompt — same rules,
// same schema, only the category noun, the schema's `category` value, and a
// category-specific focus line change.
//
// Hard guarantee (the project's core credibility claim): every returned debt
// item is validated so that ALL of its lineRefs point at lines that actually
// exist in the file. Any item with a hallucinated / out-of-bounds line number
// is dropped and logged — we never surface an ungrounded finding.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6'; // per project spec (CLAUDE.md tech stack)

// Per-category descriptor. `focus` is appended as an extra Rules bullet; for
// complexity it is null so the prompt matches CLAUDE.md verbatim.
const DESCRIPTORS = {
  complexity: {
    noun: 'complexity',
    category: 'complexity',
    focus: null,
  },
  test: {
    noun: 'test',
    category: 'test',
    focus:
      'this file having no corresponding test file (hasTestFile=false). ' +
      'Explain why THIS file in particular needs tests — cite the specific ' +
      'functions or branches that would go uncovered.',
  },
  dependency: {
    noun: 'dependency',
    category: 'dependency',
    focus:
      'dependencies whose latest release is over 365 days old (see the ' +
      'dependency ages in the metrics), and any TODO/FIXME comments about ' +
      'version upgrades. Cite the exact manifest line for each stale ' +
      'dependency and explain what the staleness implies.',
  },
  documentation: {
    noun: 'documentation',
    category: 'documentation',
    focus:
      'undocumented public APIs (docstringRatio below 0.5 with more than 5 ' +
      'functions). Name the specific public functions/classes that lack a ' +
      'docstring or JSDoc and cite their declaration lines.',
  },
};

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Add it to backend/.env (see .env.example).'
      );
    }
    client = new Anthropic();
  }
  return client;
}

/** The static metrics we hand the model (synchronous signals + dep ages). */
function metricsForLlm(metrics) {
  const out = {
    loc: metrics.loc,
    functionCount: metrics.functionCount,
    maxNestingDepth: metrics.maxNestingDepth,
    todoCount: metrics.todoCount,
    hasTestFile: metrics.hasTestFile,
    docstringRatio: metrics.docstringRatio,
  };
  if (metrics.dependency) out.dependency = metrics.dependency;
  return out;
}

/**
 * Build the prompt. For the complexity descriptor (focus=null) this is the
 * CLAUDE.md prompt verbatim; other descriptors add one focus bullet and change
 * the category noun + schema `category` value. Uses template interpolation (not
 * String.replace) so a `$` in the source can't be mangled by replacement
 * patterns.
 */
function buildPrompt(descriptor, filename, metricsJson, fileContent) {
  const { noun, category, focus } = descriptor;
  const focusLine = focus ? `\n- Focus on ${focus}` : '';
  return `You are a technical debt analyzer. You will receive a source file and its pre-computed static metrics.
Your job is to identify specific ${noun} debt items grounded in the actual code.

Rules:
- Only report a debt item if you can cite specific line numbers from the file
- Do not give generic advice ("add more comments") — every suggestion must reference the specific function or block
- If you cannot find real ${noun} debt, return an empty debtItems array
- Respond ONLY with valid JSON matching the schema below. No preamble, no markdown fences.${focusLine}

Schema:
{
  "file": "<filename>",
  "debtItems": [
    {
      "id": "<unique string>",
      "category": "${category}",
      "severity": <0-100 integer>,
      "summary": "<one sentence>",
      "reasoning": "<2-3 sentences referencing specific metrics or patterns>",
      "lineRefs": [<line numbers>],
      "refactorSuggestion": "<specific, actionable>"
    }
  ]
}

File: ${filename}
Static metrics: ${metricsJson}
Source:
${fileContent}`;
}

/** Pull the first text block out of an Anthropic response. */
function responseText(message) {
  const block = message.content.find((b) => b.type === 'text');
  return block ? block.text : '';
}

/** Parse the model's JSON reply, tolerating accidental code fences. */
function parseJsonReply(text) {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return JSON.parse(s);
}

/**
 * Validate every debt item's lineRefs against the real file.
 * Drops (and logs) any item with a missing/empty/out-of-bounds line number —
 * this is the line-level grounding guarantee. Also normalizes the category to
 * the descriptor's value so a mislabeled item can't slip through.
 *
 * @returns the kept items (a subset of the model's output)
 */
function validateLineRefs(debtItems, totalLines, filename, category) {
  const kept = [];
  for (const item of debtItems || []) {
    const refs = Array.isArray(item.lineRefs) ? item.lineRefs : [];

    if (refs.length === 0) {
      console.warn(
        `   ⚠️  ${filename}: dropping ${category} item "${item.id ?? item.summary}" — no lineRefs to ground it.`
      );
      continue;
    }

    const bad = refs.filter(
      (n) => !Number.isInteger(n) || n < 1 || n > totalLines
    );
    if (bad.length > 0) {
      console.warn(
        `   ⚠️  ${filename}: dropping ${category} item "${item.id ?? item.summary}" — ` +
          `lineRefs [${bad.join(', ')}] out of bounds (file has ${totalLines} lines).`
      );
      continue;
    }

    kept.push({ ...item, category });
  }
  return kept;
}

/**
 * Shared extraction core: one API call for one file under one category.
 *
 * @param {object} descriptor  one of DESCRIPTORS
 * @param {{path: string, content: string}} file
 * @param {object} metrics  static metrics from staticAnalysis.analyzeFile
 * @returns {Promise<{file: string, category: string, debtItems: object[]}>}
 */
async function runExtraction(descriptor, file, metrics) {
  const totalLines = file.content.split(/\r?\n/).length;
  const prompt = buildPrompt(
    descriptor,
    file.path,
    JSON.stringify(metricsForLlm(metrics)),
    file.content
  );

  let message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.warn(`   ⚠️  ${file.path} (${descriptor.category}): API call failed — ${err.message}`);
    return { file: file.path, category: descriptor.category, debtItems: [] };
  }

  let parsed;
  try {
    parsed = parseJsonReply(responseText(message));
  } catch (err) {
    console.warn(
      `   ⚠️  ${file.path} (${descriptor.category}): model did not return valid JSON — ${err.message}`
    );
    return { file: file.path, category: descriptor.category, debtItems: [] };
  }

  const validated = validateLineRefs(
    parsed.debtItems,
    totalLines,
    file.path,
    descriptor.category
  );
  return { file: file.path, category: descriptor.category, debtItems: validated };
}

// ---------------------------------------------------------------------------
// Per-category extraction functions (the public API)
// ---------------------------------------------------------------------------

export function extractComplexityDebt(file, metrics) {
  return runExtraction(DESCRIPTORS.complexity, file, metrics);
}

export function extractTestDebt(file, metrics) {
  return runExtraction(DESCRIPTORS.test, file, metrics);
}

export function extractDependencyDebt(file, metrics) {
  return runExtraction(DESCRIPTORS.dependency, file, metrics);
}

export function extractDocumentationDebt(file, metrics) {
  return runExtraction(DESCRIPTORS.documentation, file, metrics);
}

export const __internals = {
  buildPrompt,
  validateLineRefs,
  parseJsonReply,
  metricsForLlm,
  DESCRIPTORS,
};
