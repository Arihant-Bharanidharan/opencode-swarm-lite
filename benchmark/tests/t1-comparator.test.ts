import { test, expect } from "bun:test";
import { sortByScore, type ScoredItem } from "../workspace/t1-comparator.ts";

const items: ScoredItem[] = [
  { id: "delta", score: 10 },
  { id: "alpha", score: 10 },
  { id: "gamma", score: 20 },
  { id: "beta", score: 10 },
  { id: "epsilon", score: 5 },
];

test("primary key is score descending", () => {
  const out = sortByScore(items);
  expect(out.map((i) => i.score)).toEqual([20, 10, 10, 10, 5]);
});

test("ties break by id ascending", () => {
  const out = sortByScore(items);
  expect(out.map((i) => i.id)).toEqual([
    "gamma",
    "alpha",
    "beta",
    "delta",
    "epsilon",
  ]);
});

test("tie-break is byte order not locale order", () => {
  const weird = [
    { id: "B", score: 1 },
    { id: "a", score: 1 },
    { id: "A", score: 1 },
  ];
  expect(sortByScore(weird).map((i) => i.id)).toEqual(["A", "B", "a"]);
});

test("does not mutate input and returns all elements", () => {
  const snapshot = items.map((i) => i.id).sort();
  const out = sortByScore(items);
  expect(out.map((i) => i.id).sort()).toEqual(snapshot);
  expect(items.map((i) => i.id)).toEqual([
    "delta",
    "alpha",
    "gamma",
    "beta",
    "epsilon",
  ]);
});

test("empty and single input", () => {
  expect(sortByScore([])).toEqual([]);
  expect(sortByScore([{ id: "x", score: 0 }]).map((i) => i.id)).toEqual(["x"]);
});
