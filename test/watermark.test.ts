/**
 * Unit test for decodeWatermark in src/index.ts.
 * Verifies: a watermark encoded the way the plugin encodes it round-trips back
 * to its ASCII secret, and that every non-tag character is dropped.
 */
import { decodeWatermark } from "../src/index.js"

const SECRET = "SWARMLITE/ARIHANT/2026"

/**
 * Mirror of the plugin's encoder: each ASCII char -> Unicode tag codepoint
 * (U+E0000 + char code). The plugin's WATERMARK constant is not exported, so
 * the encoded input is reconstructed here.
 */
const encodeWatermark = (plain: string): string =>
  Array.from(plain)
    .map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0)))
    .join("")

let pass = 0
let fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`[PASS] ${name}`) } else { fail++; console.log(`[FAIL] ${name}`) }
}

const encoded = encodeWatermark(SECRET)

// 1. round-trip: the plugin-style encoded watermark decodes back to the secret
check(
  "plugin-encoded watermark decodes to SWARMLITE/ARIHANT/2026",
  decodeWatermark(encoded) === SECRET,
)

// 2. the encoded form really is encoded: only Unicode tag codepoints (U+E0000-U+E007F)
const codepoints = Array.from(encoded).map((ch) => ch.codePointAt(0) ?? 0)
check(
  "encoded watermark contains only U+E0000-U+E007F tag codepoints",
  codepoints.every((cp) => cp >= 0xe0000 && cp <= 0xe007f) && codepoints.length === SECRET.length,
)

// 3. plain ASCII with no tag characters decodes to the empty string
check("plain ASCII secret decodes to empty string", decodeWatermark(SECRET) === "")
check("plain ASCII sentence decodes to empty string", decodeWatermark("hello world 123") === "")

// 4. empty string decodes to the empty string
check("empty string decodes to empty string", decodeWatermark("") === "")

// 5. mixed input: a tag run surrounded by ASCII yields only the tag run's ASCII
const mixed = `MEMORY-HEADER\n${encodeWatermark("OK")}\ntrailing text`
check("mixed input decodes to just the tag run's ASCII", decodeWatermark(mixed) === "OK")

// 6. mixed input: the full watermark embedded between ASCII yields the secret
check(
  "embedded watermark decodes to the secret",
  decodeWatermark(`prefix${encoded}suffix`) === SECRET,
)

// 7. tag-range boundaries and neighbours
check("U+E0000 decodes to NUL", decodeWatermark(String.fromCodePoint(0xe0000)) === "\u0000")
check("U+E007F decodes to DEL", decodeWatermark(String.fromCodePoint(0xe007f)) === "\u007f")
check("just below the tag range is ignored", decodeWatermark(String.fromCodePoint(0xdffff)) === "")
check("just above the tag range is ignored", decodeWatermark(String.fromCodePoint(0xe0080)) === "")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
