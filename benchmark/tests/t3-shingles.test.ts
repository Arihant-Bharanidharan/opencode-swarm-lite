import { test, expect } from "bun:test";
import { shingles } from "../workspace/t3-shingles.ts";

test("all k-shingles in order", () => {
  expect(shingles("abcde", 2)).toEqual(["ab", "bc", "cd", "de"]);
});

test("every shingle has exactly length k", () => {
  const out = shingles("abcdefgh", 3);
  expect(out).toEqual(["abc", "bcd", "cde", "def", "efg", "fgh"]);
  expect(out.every((s) => s.length === 3)).toBe(true);
});

test("count is len(text) - k + 1", () => {
  const text = "the quick brown fox";
  for (let k = 1; k <= 6; k++) {
    expect(shingles(text, k).length).toBe(text.length - k + 1);
  }
});

test("duplicates preserved", () => {
  expect(shingles("aaa", 2)).toEqual(["aa", "aa"]);
});

test("degenerate cases", () => {
  expect(shingles("", 3)).toEqual([]);
  expect(shingles("ab", 3)).toEqual([]);
  expect(shingles("ab", 5)).toEqual([]);
  expect(shingles("abc", 0)).toEqual([]);
  expect(shingles("abc", -1)).toEqual([]);
});
