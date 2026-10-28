/**
 * Longest common subsequence.
 *
 * Contract:
 *   - `lcsLength(a, b)` returns the LCS length via DP.
 *   - `lcs(a, b)` returns ONE longest common subsequence, reconstructed by
 *     backtracking the same DP table.
 *   - The reconstruction must satisfy: result is a subsequence of both inputs
 *     AND result.length === lcsLength(a, b).
 */

export function lcsLength(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[n][m];
}

export function lcs(a: string, b: string): string {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = n;
  let j = m;
  let out = "";
  while (i > 1 && j > 1) {
    if (a[i - 1] === b[j - 1]) {
      out = a[i - 1] + out;
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return out;
}
