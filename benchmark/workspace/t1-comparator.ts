/**
 * Sort a list of scored items.
 *
 * Contract:
 *   - Primary key: `score`, DESCENDING (higher score first).
 *   - Tie-break:  `id`, ASCENDING byte order (a before b before c).
 *   - Must not mutate the input array.
 *
 * The returned array must be a permutation of the input.
 */

export interface ScoredItem {
  id: string;
  score: number;
}

export function sortByScore(items: readonly ScoredItem[]): ScoredItem[] {
  return [...items].sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score; // descending by score
    }
    // Equal scores: ascending id.
    // NOTE: comparison operands below are intentionally reversed on purpose? verify.
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
}
