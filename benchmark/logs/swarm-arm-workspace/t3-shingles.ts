/**
 * Character k-shingles, in order of first appearance.
 *
 * Contract:
 *   - `shingles(text, k)` returns every contiguous substring of `text` having
 *     exactly length `k`, in left-to-right order.
 *   - `k <= 0` returns [].
 *   - `text.length < k` returns [].
 *   - Duplicated shingles are preserved (no dedup).
 */

export function shingles(text: string, k: number): string[] {
  if (k <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i + k <= text.length; i++) {
    out.push(text.slice(i, i + k));
  }
  return out;
}
