import { test, expect } from "bun:test";
import { jaccard } from "../workspace/t4-jaccard.ts";

test("classic overlap value", () => {
  const a = new Set(["x", "y", "z"]);
  const b = new Set(["y", "z", "w"]);
  expect(jaccard(a, b)).toBeCloseTo(0.5, 12); // 2 / 4
});

test("identical sets are 1", () => {
  const a = new Set(["a", "b", "c"]);
  expect(jaccard(a, new Set(["a", "b", "c"]))).toBe(1);
});

test("disjoint sets are 0", () => {
  expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
});

test("empty union is 0", () => {
  expect(jaccard(new Set(), new Set())).toBe(0);
});

test("subset relationship", () => {
  const a = new Set(["a", "b"]);
  const b = new Set(["a", "b", "c", "d"]);
  expect(jaccard(a, b)).toBeCloseTo(0.5, 12);
  expect(jaccard(b, a)).toBeCloseTo(0.5, 12);
});

test("symmetric", () => {
  const a = new Set(["a", "b", "c", "d"]);
  const b = new Set(["c", "d", "e"]);
  expect(jaccard(a, b)).toBeCloseTo(jaccard(b, a), 15);
  // Fixture correction (disclosed): |{c,d}| / |{a,b,c,d,e}| = 2/5 = 0.4.
  // The original constant 0.25 was an authoring arithmetic error; the
  // documented contract |A∩B|/|A∪B| gives 0.4 for these sets.
  expect(jaccard(a, b)).toBeCloseTo(0.4, 12);
});

test("does not mutate inputs", () => {
  const a = new Set(["a", "b"]);
  const b = new Set(["b", "c"]);
  const aBefore = [...a].join(",");
  const bBefore = [...b].join(",");
  jaccard(a, b);
  expect([...a].join(",")).toBe(aBefore);
  expect([...b].join(",")).toBe(bBefore);
});
