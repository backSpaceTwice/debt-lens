/** Collapse a sorted array of integers into range strings.
 *  [257,258,259,261,262,263] → "257-259, 261-263"
 *  [42,43,44]               → "42-44"
 *  [42]                     → "42"
 */
export function toRanges(lineRefs) {
  if (!lineRefs?.length) return '';
  const sorted = [...lineRefs].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

/** Color band for a 0–100 health score (green > 70, amber 40–70, red < 40). */
export function healthColorClass(score) {
  if (score > 70) return 'score-green';
  if (score >= 40) return 'score-amber';
  return 'score-red';
}
