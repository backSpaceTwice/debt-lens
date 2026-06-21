// diffBuilder.js — Step 9c: build a unified diff between the original file and
// the rewritten (fixed) file, for the UI to render in 9d.
//
// We use the `diff` npm package's createTwoFilesPatch (not `git diff`): the spec
// calls for a parseable unified-diff string, and shelling out to git is harder
// to parse and slower than computing it in-process. The fix object from
// fixGenerator already carries both sides (originalContent + rewrittenContent),
// so this step is pure string-in / string-out — no git, no filesystem.
//
// Returns the unified diff string ONLY. No UI, no metadata wrapping here.

import { createTwoFilesPatch } from 'diff';

/**
 * Build a unified diff between two file contents — the §9c reference signature.
 *
 * @param {string} originalContent   the file before the fix
 * @param {string} rewrittenContent  the file after the fix
 * @param {string} filename          path used for the a/ b/ headers
 * @returns {string} a unified-diff patch string
 */
export function buildDiff(originalContent, rewrittenContent, filename) {
  return createTwoFilesPatch(
    `a/${filename}`,
    `b/${filename}`,
    originalContent ?? '',
    rewrittenContent ?? '',
    'original',
    'debtlens-fix'
  );
}

/**
 * Convenience over a `fix` object (fixGenerator.generateFix → .fix), which
 * already holds originalContent, rewrittenContent, and file.
 *
 * @param {{file: string, originalContent: string, rewrittenContent: string}} fix
 * @returns {string} the unified diff string
 */
export function buildDiffForFix(fix) {
  return buildDiff(fix.originalContent, fix.rewrittenContent, fix.file);
}
