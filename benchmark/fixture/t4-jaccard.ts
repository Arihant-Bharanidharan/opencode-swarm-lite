/**
 * Jaccard similarity of two string sets.
 *
 * Contract:
 *   - jaccard(A, B) = |A intersect B| / |A union B|
 *   - Empty union => 0 (avoid divide-by-zero).
 *   - Inputs are only read, never mutated.
 */

export function jaccard(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter++;
  }
  const denominator = a.size + b.size;
  if (denominator === 0) return 0;
  return inter / denominator;
}
