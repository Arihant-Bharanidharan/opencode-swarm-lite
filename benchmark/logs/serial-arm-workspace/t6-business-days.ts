/**
 * Business-day arithmetic.
 *
 * Contract:
 *   - `addBusinessDays(start, n)` returns the date that is exactly `n` business
 *     days AFTER `start` (the start date itself is never counted).
 *   - Business days exclude Saturday and Sunday.
 *   - `holidays` is a set of ISO dates (YYYY-MM-DD) that are also skipped.
 *   - `n === 0` returns the next business day strictly after `start`.
 *   - `n < 0` throws.
 */

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addBusinessDays(
  start: Date,
  n: number,
  holidays: ReadonlySet<string> = new Set(),
): Date {
  if (n < 0) throw new Error("n must be >= 0");
  if (!Number.isInteger(n)) throw new Error("n must be an integer");
  const d = new Date(start.getTime());
  let count = 0;
  // n === 0 still means "the next business day strictly after start",
  // so we always advance at least one business day (target = max(1, n)).
  while (count < Math.max(1, n)) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(isoDate(d))) {
      count++;
    }
  }
  return d;
}
