// plausiblePaidAt bounds (no database). DOIT's paid time is trusted only
// between the intent's creation (minus 5 min) and now (plus 5 min).
import { describe, expect, it } from "vitest";
import { plausiblePaidAt } from "../services/payment-paid-at";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const CREATED = new Date("2026-11-08T10:00:00.000Z");
const MIN = 60_000;

describe("plausiblePaidAt", () => {
  it("keeps a paid time inside the window, as ISO UTC", () => {
    expect(plausiblePaidAt("2026-11-08T18:30:00+07:00", CREATED, NOW)).toBe(
      "2026-11-08T11:30:00.000Z",
    );
  });

  it("accepts the edges: createdAt - 5 min and now + 5 min", () => {
    const lower = new Date(CREATED.getTime() - 5 * MIN).toISOString();
    const upper = new Date(NOW.getTime() + 5 * MIN).toISOString();
    expect(plausiblePaidAt(lower, CREATED, NOW)).toBe(lower);
    expect(plausiblePaidAt(upper, CREATED, NOW)).toBe(upper);
  });

  it("falls back to now just outside the window", () => {
    const early = new Date(CREATED.getTime() - 5 * MIN - 1).toISOString();
    const late = new Date(NOW.getTime() + 5 * MIN + 1).toISOString();
    expect(plausiblePaidAt(early, CREATED, NOW)).toBe(NOW.toISOString());
    expect(plausiblePaidAt(late, CREATED, NOW)).toBe(NOW.toISOString());
  });

  it("falls back to now for a time a day ahead", () => {
    expect(plausiblePaidAt("2026-11-09T12:00:00.000Z", CREATED, NOW)).toBe(
      NOW.toISOString(),
    );
  });

  it("with createdAt null checks only the upper bound", () => {
    expect(plausiblePaidAt("2020-01-01T00:00:00.000Z", null, NOW)).toBe(
      "2020-01-01T00:00:00.000Z",
    );
    expect(plausiblePaidAt("2026-11-09T12:00:00.000Z", null, NOW)).toBe(
      NOW.toISOString(),
    );
  });

  it("falls back to now for a missing or unparsable candidate", () => {
    expect(plausiblePaidAt(null, CREATED, NOW)).toBe(NOW.toISOString());
    expect(plausiblePaidAt(undefined, CREATED, NOW)).toBe(NOW.toISOString());
    expect(plausiblePaidAt("not a time", CREATED, NOW)).toBe(NOW.toISOString());
  });
});
