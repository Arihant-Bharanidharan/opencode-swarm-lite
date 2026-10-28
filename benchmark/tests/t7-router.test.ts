import { test, expect } from "bun:test";
import { chooseRoute, score } from "../workspace/t7-router.ts";

test("score formula", () => {
  expect(score({ id: "a", quality: 90, latencyMs: 100 })).toBe(900);
  expect(score({ id: "b", quality: 80, latencyMs: 200 })).toBe(400);
  expect(score({ id: "c", quality: 50, latencyMs: 0 })).toBe(50000); // guard div by 0
});

test("chooses the highest score", () => {
  const routes = [
    { id: "slow-good", quality: 90, latencyMs: 100 }, // 900  <- best
    { id: "fast-weak", quality: 80, latencyMs: 200 }, // 400
    { id: "mid", quality: 70, latencyMs: 50 }, // 1400
  ];
  expect(chooseRoute(routes).id).toBe("mid");
});

test("chooses best when it is last", () => {
  const routes = [
    { id: "a", quality: 10, latencyMs: 100 }, // 100
    { id: "b", quality: 20, latencyMs: 100 }, // 200  <- best
  ];
  expect(chooseRoute(routes).id).toBe("b");
});

test("ties resolve to earliest input position", () => {
  const routes = [
    { id: "first", quality: 100, latencyMs: 100 }, // 1000
    { id: "second", quality: 50, latencyMs: 50 }, // 1000
    { id: "third", quality: 25, latencyMs: 25 }, // 1000
  ];
  expect(chooseRoute(routes).id).toBe("first");
});

test("single route", () => {
  expect(chooseRoute([{ id: "only", quality: 1, latencyMs: 1 }]).id).toBe("only");
});

test("empty throws", () => {
  expect(() => chooseRoute([])).toThrow();
});

test("does not mutate input", () => {
  const routes = [
    { id: "a", quality: 1, latencyMs: 10 },
    { id: "b", quality: 2, latencyMs: 10 },
  ];
  chooseRoute(routes);
  expect(routes.map((r) => r.id)).toEqual(["a", "b"]);
});
