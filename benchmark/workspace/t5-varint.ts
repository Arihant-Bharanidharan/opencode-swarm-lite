/**
 * Unsigned LEB128 varint encoding / decoding.
 *
 * Contract:
 *   - `writeVarint(n)` produces the minimal big-endian-free (little-endian
 *     groups) LEB128 byte sequence: 7 payload bits per byte, high bit set on
 *     every byte except the last.
 *   - `readVarint(bytes, offset)` returns `{ value, next }` where `next` is the
 *     index immediately after the final byte of the varint.
 *   - `readVarint(writeVarint(n), 0).value === n` for every n in
 *     [0, 2^31 - 1].
 *   - Throws on a truncated varint.
 */

export function writeVarint(n: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new Error("n must be a non-negative integer");
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

export function readVarint(
  bytes: readonly number[],
  offset: number,
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error("truncated varint");
    value |= (byte & 0x7f) << shift;
    i++;
    if ((byte & 0x80) === 0) break;
    shift += 8; // 7 payload bits per byte
  }
  return { value, next: i };
}
