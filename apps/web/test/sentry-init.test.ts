import { describe, expect, it, vi } from "vitest";
import { initWebSentry } from "../src/lib/sentry.ts";

// legend-17az7: no DSN = the SDK is not loaded or initialised.
describe("initWebSentry", () => {
  it("is a no-op without a DSN", async () => {
    const load = vi.fn();
    expect(await initWebSentry({ dsn: undefined, load })).toBe(false);
    expect(await initWebSentry({ dsn: "", load })).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("inits with sendDefaultPii off and scrubbing hooks", async () => {
    const init = vi.fn();
    const load = vi.fn(async () => ({ init }));
    expect(
      await initWebSentry({ dsn: "https://key@o1.ingest.sentry.io/1", load }),
    ).toBe(true);
    const options = init.mock.calls[0]?.[0];
    expect(options.sendDefaultPii).toBe(false);
    const event = options.beforeSend({
      request: { cookies: { a: "b" }, headers: { cookie: "a=b", Accept: "x" } },
    });
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.headers).toEqual({ Accept: "x" });
  });
});
