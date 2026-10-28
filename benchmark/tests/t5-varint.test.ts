import { test, expect } from "bun:test";
import { writeVarint, readVarint } from "../workspace/t5-varint.ts";

const vectors: Array<[number, number[]]> = [
  [0, [0x00]],
  [1, [0x01]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [300, [0xac, 0x02]],
  [16383, [0xff, 0x7f]],
  [16384, [0x80, 0x80, 0x01]],
  [2147483647, [0xff, 0xff, 0xff, 0xff, 0x07]],
];

test("encoding vectors match canonical LEB128", () => {
  for (const [n, bytes] of vectors) {
    expect(writeVarint(n)).toEqual(bytes);
  }
});

test("decode consumes exactly the encoded bytes", () => {
  const buf = [0xac, 0x02, 0xff, 0xff, 0xff, 0xff, 0x07, 0x2a];
  const first = readVarint(buf, 0);
  expect(first.value).toBe(300);
  expect(first.next).toBe(2);
  const second = readVarint(buf, first.next);
  expect(second.value).toBe(2147483647);
  expect(second.next).toBe(7);
});

test("roundtrip over full unsigned 31-bit range sample", () => {
  const samples = [0, 1, 2, 63, 64, 127, 128, 255, 256, 300, 4095, 4096, 65535, 65536, 1234567, 2147483647];
  for (const n of samples) {
    const enc = writeVarint(n);
    const dec = readVarint(enc, 0);
    expect(dec.value).toBe(n);
    expect(dec.next).toBe(enc.length);
  }
});

test("truncated varint throws", () => {
  // Fixture correction (disclosed): the original bytes [0x80, 0x01] are a
  // VALID minimal varint for 128 (see the vectors table above) and must
  // decode, not throw — the suite was self-contradictory. A truncated
  // varint carries a set continuation bit on its final available byte:
  expect(() => readVarint([0x80], 0)).toThrow();
  expect(() => readVarint([0x81, 0x80, 0x80], 0)).toThrow();
});

test("negative or non-integer rejects on encode", () => {
  expect(() => writeVarint(-1)).toThrow();
  expect(() => writeVarint(1.5)).toThrow();
});
