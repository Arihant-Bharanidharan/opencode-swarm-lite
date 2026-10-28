import { test, expect } from "bun:test";
import { lcs, lcsLength } from "../workspace/t8-lcs.ts";

function isSubsequence(s: string, t: string): boolean {
  let i = 0;
  for (const ch of t) {
    if (i < s.length && s[i] === ch) i++;
  }
  return i === s.length;
}

const pairs: Array<[string, string]> = [
  ["abcde", "ace"],
  ["ABCBDAB", "BDCABA"],
  ["AXBYCZ", "ABC"],
  ["aggtab", "gxtxayb"],
  ["", "abc"],
  ["abc", ""],
  ["", ""],
  ["aaaa", "aa"],
  ["abc", "abc"],
];

test("lcsLength known values", () => {
  expect(lcsLength("abcde", "ace")).toBe(3);
  expect(lcsLength("ABCBDAB", "BDCABA")).toBe(4);
  expect(lcsLength("AXBYCZ", "ABC")).toBe(3);
  expect(lcsLength("aggtab", "gxtxayb")).toBe(4);
  expect(lcsLength("aaaa", "aa")).toBe(2);
  expect(lcsLength("", "abc")).toBe(0);
});

test("reconstructed LCS is a subsequence of both inputs", () => {
  for (const [a, b] of pairs) {
    const r = lcs(a, b);
    expect(isSubsequence(r, a)).toBe(true);
    expect(isSubsequence(r, b)).toBe(true);
  }
});

test("reconstructed LCS has the DP length", () => {
  for (const [a, b] of pairs) {
    const r = lcs(a, b);
    expect(r.length).toBe(lcsLength(a, b));
  }
});

test("specific reconstruction", () => {
  expect(lcs("AXBYCZ", "ABC")).toBe("ABC");
});

test("inputs are not mutated", () => {
  const a = "ABCBDAB";
  const b = "BDCABA";
  lcs(a, b);
  expect(a).toBe("ABCBDAB");
  expect(b).toBe("BDCABA");
});
