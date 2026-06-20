// llmExtractor.js — Step 2: LLM extraction for complexity debt.
//
// Sends a source file + its pre-computed static metrics to the Anthropic API
// and gets back structured complexity-debt items grounded in real line numbers.
//
// Hard guarantee (the project's core credibility claim): every debt item we
// return is validated so that ALL of its lineRefs point at lines that actually
// exist in the file. Any item with a hallucinated / out-of-bounds line number
// is dropped and logged — we never surface an ungrounded finding.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6'; // per project spec (CLAUDE.md tech stack)

// The Anthropic API prompt, used VERBATIM from CLAUDE.md. Do not edit this text
// or the schema it pins — only the {{placeholders}} are substituted per file.
const PROMPT_TEMPLATE = `You are a technical debt analyzer. You will receive a source file and its pre-computed static metrics.
Your job is to identify specific complexity debt items grounded in the actual code.

Rules:
- Only report a debt item if you can cite specific line numbers from the file
- Do not give generic advice ("add more comments") — every suggestion must reference the specific function or block
- If you cannot find real complexity debt, return an empty debtItems array
- Respond ONLY with valid JSON matching the schema below. No preamble, no markdown fences.

Schema:
{
  "file": "<filename>",
  "debtItems": [
    {
      "id": "<unique string>",
      "category": "complexity",
      "severity": <0-100 integer>,
      "summary": "<one sentence>",
      "reasoning": "<2-3 sentences referencing specific metrics or patterns>",
      "lineRefs": [<line numbers>],
      "refactorSuggestion": "<specific, actionable>"
    }
  ]
}

File: {{filename}}
Static metrics: {{metrics_json}}
Source:
{{file_content}}`;

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

/** Fill the verbatim prompt template with this file's data. */
function buildPrompt(filename, metrics, fileContent) {
  // The static metrics we send the model (the synchronous, code-level signals).
  const metricsForLlm = {
    loc: metrics.loc,
    functionCount: metrics.functionCount,
    maxNestingDepth: metrics.maxNestingDepth,
    todoCount: metrics.todoCount,
    hasTestFile: metrics.hasTestFile,
    docstringRatio: metrics.docstringRatio,
  };
  return PROMPT_TEMPLATE.replace('{{filename}}', filename)
    .replace('{{metrics_json}}', JSON.stringify(metricsForLlm))
    .replace('{{file_content}}', fileContent);
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
    // strip ```json ... ``` fences if the model added them despite instructions
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return JSON.parse(s);
}

/**
 * Validate every debt item's lineRefs against the real file.
 * Drops (and logs) any item with a missing/empty/out-of-bounds line number —
 * this is the line-level grounding guarantee.
 *
 * @returns the kept items (a subset of the model's output)
 */
function validateLineRefs(debtItems, totalLines, filename) {
  const kept = [];
  for (const item of debtItems || []) {
    const refs = Array.isArray(item.lineRefs) ? item.lineRefs : [];

    if (refs.length === 0) {
      console.warn(
        `   ⚠️  ${filename}: dropping item "${item.id ?? item.summary}" — no lineRefs to ground it.`
      );
      continue;
    }

    const bad = refs.filter(
      (n) => !Number.isInteger(n) || n < 1 || n > totalLines
    );
    if (bad.length > 0) {
      console.warn(
        `   ⚠️  ${filename}: dropping item "${item.id ?? item.summary}" — ` +
          `lineRefs [${bad.join(', ')}] out of bounds (file has ${totalLines} lines).`
      );
      continue;
    }

    kept.push(item);
  }
  return kept;
}

/**
 * Extract validated complexity-debt items for a single file.
 *
 * @param {{path: string, content: string}} file
 * @param {object} metrics  static metrics from staticAnalysis.analyzeFile
 * @returns {Promise<{file: string, debtItems: object[]}>}
 */
export async function extractComplexityDebt(file, metrics) {
  const totalLines = file.content.split(/\r?\n/).length;
  const prompt = buildPrompt(file.path, metrics, file.content);

  let message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.warn(`   ⚠️  ${file.path}: API call failed — ${err.message}`);
    return { file: file.path, debtItems: [] };
  }

  let parsed;
  try {
    parsed = parseJsonReply(responseText(message));
  } catch (err) {
    console.warn(`   ⚠️  ${file.path}: model did not return valid JSON — ${err.message}`);
    return { file: file.path, debtItems: [] };
  }

  const validated = validateLineRefs(parsed.debtItems, totalLines, file.path);
  return { file: file.path, debtItems: validated };
}

export const __internals = { buildPrompt, validateLineRefs, parseJsonReply, PROMPT_TEMPLATE };
