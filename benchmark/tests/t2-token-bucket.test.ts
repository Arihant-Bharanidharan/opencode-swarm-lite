import { test, expect } from "bun:test";
import { TokenBucket } from "../workspace/t2-token-bucket.ts";

test("drains to zero then refills over time", () => {
  const b = new TokenBucket(10, 1); // 1 token/sec
  expect(b.tryConsume(10, 1000)).toBe(true);
  expect(b.available(1000)).toBe(0);
  expect(b.tryConsume(1, 1500)).toBe(false); // only 0.5 tokens
  expect(b.tryConsume(1, 2000)).toBe(true); // 1.0 tokens
});

test("capacity clamps the refill", () => {
  const b = new TokenBucket(5, 1000);
  expect(b.tryConsume(5, 1000)).toBe(true);
  expect(b.available(100000)).toBe(5);
});

test("out-of-order timestamps add zero tokens and never remove tokens", () => {
  const b = new TokenBucket(10, 1);
  b.tryConsume(10, 1000); // empty
  b.tryConsume(5, 2000); // +1 token -> 1 token, consume fails
  const at2000 = b.available(2000);
  expect(at2000).toBeCloseTo(1, 9);

  // Several out-of-order reads must not change the balance.
  b.tryConsume(0, 1500);
  expect(b.available(1500)).toBeCloseTo(1, 9);
  b.tryConsume(0, 500);
  expect(b.available(500)).toBeCloseTo(1, 9);
  b.tryConsume(0, 250);
  expect(b.available(250)).toBeCloseTo(1, 9);
  expect(b.tryConsume(1, 250)).toBe(false);
});

test("balance never goes negative", () => {
  const b = new TokenBucket(3, 1);
  b.tryConsume(3, 1000);
  b.available(500); // out of order
  expect(b.available(500)).toBeGreaterThanOrEqual(0);
});

test("failed consume deducts nothing", () => {
  const b = new TokenBucket(2, 0);
  expect(b.tryConsume(5, 1000)).toBe(false);
  expect(b.available(1000)).toBe(2);
});
