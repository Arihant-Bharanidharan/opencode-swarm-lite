import { test, expect } from "bun:test";
import { addBusinessDays, isoDate } from "../workspace/t6-business-days.ts";

const d = (s: string) => new Date(`${s}T00:00:00`);

test("one business day after a Monday", () => {
  expect(isoDate(addBusinessDays(d("2024-07-01"), 1))).toBe("2024-07-02");
});

test("weekend is skipped", () => {
  // Friday + 1 business day = Monday
  expect(isoDate(addBusinessDays(d("2024-07-05"), 1))).toBe("2024-07-08");
});

test("five business days spans the weekend", () => {
  expect(isoDate(addBusinessDays(d("2024-07-01"), 5))).toBe("2024-07-08");
});

test("holidays are skipped", () => {
  const holidays = new Set(["2024-07-04"]);
  // Wed Jul 3 + 1 = Fri Jul 5 (Jul 4 is a holiday, Jul 3 is the start)
  expect(isoDate(addBusinessDays(d("2024-07-03"), 1, holidays))).toBe("2024-07-05");
});

test("consecutive holidays collapse", () => {
  const holidays = new Set(["2024-12-24", "2024-12-25", "2024-12-26"]);
  // Tue Dec 23 + 1 = Fri Dec 27
  expect(isoDate(addBusinessDays(d("2024-12-23"), 1, holidays))).toBe("2024-12-27");
});

test("n === 0 returns the next business day", () => {
  expect(isoDate(addBusinessDays(d("2024-07-05"), 0))).toBe("2024-07-08");
  expect(isoDate(addBusinessDays(d("2024-07-01"), 0))).toBe("2024-07-02");
});

test("start date itself is never counted", () => {
  // If the start were counted, this would return 2024-07-05.
  expect(isoDate(addBusinessDays(d("2024-07-01"), 4))).toBe("2024-07-05");
});

test("negative n throws", () => {
  expect(() => addBusinessDays(d("2024-07-01"), -1)).toThrow();
});
