import { describe, expect, it } from "vitest";
import { createSessionExtendLimiter } from "./session-extend-limiter.ts";

describe("AUTH-05 session extension limiter", () => {
  it("bounds entries and keeps a hot session limited during churn", () => {
    const limiter = createSessionExtendLimiter(3);
    limiter.check("hot", 0);
    limiter.check("old", 0);
    limiter.check("other", 0);
    for (let i = 1; i < 10; i++) limiter.check("hot", i);
    limiter.check("new", 10);
    expect(limiter.size()).toBe(3);
    expect(() => limiter.check("hot", 11)).toThrowError(
      expect.objectContaining({ status: 429, code: "RATE_LIMITED" }),
    );
    limiter.check("old", 12);
    expect(limiter.size()).toBe(3);
  });

  it("isolates sessions and resets exactly at the window boundary", () => {
    const limiter = createSessionExtendLimiter(4);
    for (let i = 0; i < 10; i++) limiter.check("a", 1000);
    expect(() => limiter.check("a", 60_999)).toThrow();
    expect(() => limiter.check("b", 60_999)).not.toThrow();
    expect(() => limiter.check("a", 61_000)).not.toThrow();
  });
});
