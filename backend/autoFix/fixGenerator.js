// fixGenerator.js — Step 9a: generate an auto-fix for a single debt item.
//
// This is the SECOND Anthropic call (the first being llmExtractor's debt
// detection). It takes one validated debt item plus the full original file and
// asks the model to return the COMPLETE rewritten file — not a patch, not a
// snippet — addressing only that item. Working with whole files avoids
// patch-application edge cases and is trivial to diff later (9c).
//
// The prompt is the CLAUDE.md "Anthropic API Prompt (auto-fix generation)"
// reproduced verbatim. Everything the model returns is treated as untrusted and
// re-validated here against the project's hard safety rules (CLAUDE.md §9a +
// "Key Constraints"):
//
//   - confidence must be an honest integer; drop anything < 65
//   - rewrittenContent must be the COMPLETE file, never null/partial — drop null
//   - changedLineRefs must overlap the debt item's original lineRefs — if they
//     don't intersect at all, the model changed something unrelated → drop
//
// A dropped fix is never silently swallowed: we return a structured `declined`
// result with a human-readable reason for the UI (9d) and log it.

import Anthropic from '@anthropic-ai/sdk';
import { structuredPatch } from 'diff';

const MODEL = 'claude-sonnet-4-6'; // same model as llmExtractor (CLAUDE.md spec)

// Server-side confidence floor. Any fix the model rates below this is declined
// before it can ever reach a syntax check or the user (CLAUDE.md Key Constraints).
const CONFIDENCE_FLOOR = 65;

// Structured-output schema for the fix. Passed as output_config.format so the
// model is constrained to emit exactly this JSON shape — it physically cannot
// lead with prose like "I need to:". This is the supported way to force JSON on
// claude-sonnet-4-6 (assistant prefill returns a 400 on this model family).
// rewrittenContent is nullable via anyOf so the model can still decline a fix.
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    fixSummary: { type: 'string' },
    confidence: { type: 'integer' },
    changedLineRefs: { type: 'array', items: { type: 'integer' } },
    rewrittenContent: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    verificationSteps: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'file',
    'fixSummary',
    'confidence',
    'changedLineRefs',
    'rewrittenContent',
    'verificationSteps',
  ],
  additionalProperties: false,
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

/** Pull the first text block out of an Anthropic response. */
function responseText(message) {
  const block = message.content.find((b) => b.type === 'text');
  return block ? block.text : '';
}

function parseJsonReply(text) {
  let s = text.trim();
  // strip code fences
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  s = s.trim();
  // if model wrapped JSON in prose, extract the object
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1) s = s.slice(start, end + 1);
  }
  return JSON.parse(s);
}

/**
 * Build the auto-fix generation prompt — verbatim from CLAUDE.md.
 * Uses template interpolation (not String.replace) so a `$` anywhere in the
 * source or debt JSON can't be mangled by replacement patterns.
 */
function buildPrompt(debtItemJson, refactorSuggestion, fileContent) {
  return `You are an automated code refactoring agent. You will receive a source file,
a specific debt item, and a refactor suggestion. Your job is to apply the fix
and return the complete rewritten file.

Rules:
- Return the COMPLETE rewritten file — not a patch, not a snippet, the full content
- Only change what is necessary to address the specific debt item
- Do not introduce new dependencies, new exports, or behavioral changes
- If you are not confident you can fix this without understanding business context
  you do not have, set rewrittenContent to null and explain in fixSummary
- Respond ONLY with valid JSON. No preamble, no markdown fences.

Schema:
{
  "file": "<filename>",
  "fixSummary": "<one sentence: what changed and why>",
  "confidence": <0-100 integer — be honest, not optimistic>,
  "changedLineRefs": [<line numbers that changed>],
  "rewrittenContent": "<complete file as a string, or null if not confident>",
  "verificationSteps": ["<what a reviewer should check>"]
}

Debt item: ${debtItemJson}
Refactor suggestion: ${refactorSuggestion}
Original file content:
${fileContent}`;
}

/** Build a `declined` result, logging the reason. */
function decline(reason, extra = {}) {
  console.warn(`   ⚠️  auto-fix declined — ${reason}`);
  return { status: 'declined', reason, ...extra };
}

/** Do the model's changedLineRefs intersect the debt item's original lineRefs? */
function refsOverlap(changedRefs, originalRefs) {
  const original = new Set(originalRefs);
  return changedRefs.some((n) => original.has(n));
}

/**
 * Derive the ORIGINAL-file line numbers that the rewrite actually touched, by
 * diffing the two versions. This is ground truth — the model's self-reported
 * changedLineRefs is unreliable (often empty), so we compute it ourselves and
 * use it both to ground the fix and to check overlap with the debt item.
 *
 * Removed/modified lines map to their original line number; a pure insertion
 * is anchored to the original line it follows. Returns a sorted, deduped list.
 */
function changedOriginalLines(original, rewritten) {
  const { hunks } = structuredPatch('a', 'b', original, rewritten, '', '', { context: 0 });
  const lines = new Set();
  for (const h of hunks) {
    let oldLine = h.oldStart;
    for (const l of h.lines) {
      const tag = l[0];
      if (tag === '-') {
        if (oldLine >= 1) lines.add(oldLine);
        oldLine++;
      } else if (tag === ' ') {
        oldLine++;
      } else if (tag === '+') {
        // Pure insertion: anchor to the line it follows (oldStart can be 0).
        if (oldLine >= 1) lines.add(oldLine);
      }
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Validate the parsed model response against all four server-side safety gates.
 *
 * @param {object} parsed          the parsed JSON reply from the model
 * @param {number[]} originalRefs  the debt item's lineRefs
 * @param {string} fileContent     the original file content
 * @returns {{ ok: true, changedLineRefs: number[] }
 *          | { ok: false, declineResult: object }}
 */
function validateFixResponse(parsed, originalRefs, fileContent) {
  // ── Gate 1: model voluntarily abstained (rewrittenContent null). ──────────
  if (parsed.rewrittenContent === null || parsed.rewrittenContent === undefined) {
    return {
      ok: false,
      declineResult: decline(
        "this change requires understanding business context the model doesn't have. " +
          'Review the suggestion manually.',
        { confidence: parsed.confidence, fixSummary: parsed.fixSummary }
      ),
    };
  }

  // ── Gate 2: rewrittenContent must be a complete, non-empty file string. ───
  if (typeof parsed.rewrittenContent !== 'string' || parsed.rewrittenContent.trim() === '') {
    return {
      ok: false,
      declineResult: decline('model returned an empty or non-string rewrittenContent.'),
    };
  }

  // ── Gate 3: confidence floor (honest integer, ≥ 65). ─────────────────────
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) {
    return {
      ok: false,
      declineResult: decline('model returned a non-numeric confidence.'),
    };
  }
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      ok: false,
      declineResult: decline(
        `model confidence ${confidence} is below the ${CONFIDENCE_FLOOR} floor.`,
        { confidence, fixSummary: parsed.fixSummary }
      ),
    };
  }

  // ── Gate 4: ground the change in the ACTUAL diff, not the model's report. ──
  // The model's changedLineRefs is unreliable (often empty even on real edits),
  // so we derive the changed original-file lines from the diff itself.
  const changedLineRefs = changedOriginalLines(fileContent, parsed.rewrittenContent);
  if (changedLineRefs.length === 0) {
    // No diff at all → the model returned the file unchanged.
    return {
      ok: false,
      declineResult: decline(
        'the model returned the file unchanged — there was nothing to safely rewrite.',
        { confidence, fixSummary: parsed.fixSummary }
      ),
    };
  }
  if (!refsOverlap(changedLineRefs, originalRefs)) {
    return {
      ok: false,
      declineResult: decline(
        `the rewrite touched lines [${changedLineRefs.join(', ')}] but the debt item ` +
          `flags lines [${originalRefs.join(', ')}] — the change is unrelated to the finding.`,
        { confidence }
      ),
    };
  }

  return { ok: true, changedLineRefs };
}

/**
 * Generate an auto-fix for one debt item.
 *
 * @param {{path: string, content: string}} file  the original file
 * @param {object} debtItem  a validated debt item (must carry lineRefs +
 *                           refactorSuggestion from llmExtractor)
 * @returns {Promise<
 *    | { status: 'generated', fix: {
 *          file, fixSummary, confidence, changedLineRefs,
 *          rewrittenContent, verificationSteps, originalContent
 *        } }
 *    | { status: 'declined', reason: string, confidence?: number, fixSummary?: string }
 *  >}
 *
 * `generated` means the fix passed every 9a server-side gate and is ready for
 * 9b (apply to temp branch + syntax check). `declined` means it was dropped —
 * the reason is safe to show the user verbatim.
 */
export async function generateFix(file, debtItem) {
  if (!file || typeof file.content !== 'string') {
    return decline('no original file content available to fix.');
  }
  const originalRefs = Array.isArray(debtItem?.lineRefs) ? debtItem.lineRefs : [];
  if (originalRefs.length === 0) {
    // Without grounding lines there's nothing to require the fix to overlap.
    return decline('debt item has no lineRefs to ground the fix against.');
  }

  const prompt = buildPrompt(
    JSON.stringify(debtItem),
    debtItem.refactorSuggestion ?? '(none provided)',
    file.content
  );

  let message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      // Sonnet 4.6 caps at 64K, but non-streaming requests above ~16K risk SDK
      // HTTP timeouts — stay under that for this single, non-streamed call.
      max_tokens: 16000,
      system:
        'You are a code rewriting engine. Output only raw JSON. ' +
        'Never write prose, explanations, or markdown. ' +
        'If you cannot perform a task, set rewrittenContent to null. ' +
        'Your response must be a single JSON object matching the provided schema.',
      // Structured outputs constrain the response to FIX_SCHEMA — this is what
      // eliminates the "I need to:" prose failures on large files.
      output_config: { format: { type: 'json_schema', schema: FIX_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    return decline(`API call failed — ${err.message}`);
  }

  // A truncated response (large whole-file rewrite hitting the token cap) yields
  // incomplete JSON. Surface a clear reason instead of a confusing parse error.
  if (message.stop_reason === 'max_tokens') {
    return decline(
      'the rewritten file was too large to generate in one pass. ' +
        'Fix this file manually.'
    );
  }
  // Safety classifiers can decline; structured output is not guaranteed then.
  if (message.stop_reason === 'refusal') {
    return decline('the model declined to rewrite this file.');
  }

  let parsed;
  try {
    parsed = parseJsonReply(responseText(message));
  } catch (err) {
    return decline(`model did not return valid JSON — ${err.message}`);
  }

  const validation = validateFixResponse(parsed, originalRefs, file.content);
  if (!validation.ok) {
    return validation.declineResult;
  }

  const { changedLineRefs } = validation;

  // Passed every gate. Carry the original content through so 9c can diff
  // without re-fetching, and 9b can write the rewritten file directly.
  return {
    status: 'generated',
    fix: {
      file: file.path,
      fixSummary: parsed.fixSummary ?? '',
      confidence: Number(parsed.confidence),
      changedLineRefs,
      rewrittenContent: parsed.rewrittenContent,
      verificationSteps: Array.isArray(parsed.verificationSteps)
        ? parsed.verificationSteps
        : [],
      originalContent: file.content,
    },
  };
}

export const __internals = {
  buildPrompt,
  parseJsonReply,
  refsOverlap,
  changedOriginalLines,
  validateFixResponse,
  CONFIDENCE_FLOOR,
};
