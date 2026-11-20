import { describe, expect, it, vi } from "vitest";
import { scrubSentryEvent } from "@starter/shared/sentry";
import { initSentry } from "../lib/sentry.ts";

// legend-17az7: monitoring is off without a DSN and never ships request
// secrets or personal data.
describe("initSentry", () => {
  it("does not init without a DSN (no-op)", () => {
    const init = vi.fn();
    expect(initSentry({ dsn: undefined, init })).toBe(false);
    expect(initSentry({ dsn: "   ", init })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it("inits with sendDefaultPii off and the scrubbing hook", () => {
    const init = vi.fn();
    expect(initSentry({ dsn: "https://key@o1.ingest.sentry.io/1", init })).toBe(
      true,
    );
    const options = init.mock.calls[0]?.[0];
    expect(options.dsn).toBe("https://key@o1.ingest.sentry.io/1");
    expect(options.sendDefaultPii).toBe(false);
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
  });
});

describe("scrubSentryEvent", () => {
  it("drops cookies, auth headers, body, query, user, email and phone", () => {
    const event = scrubSentryEvent({
      message: "login failed for budi@example.com call 0812-3456-7890",
      user: { id: "u1", email: "budi@example.com", ip_address: "1.2.3.4" },
      request: {
        url: "https://api.example.com/api/x?token=abc&email=a@b.co",
        cookies: { session: "s3cret" },
        data: { password: "hunter2" },
        query_string: "token=abc",
        headers: {
          Cookie: "session=s3cret",
          Authorization: "Bearer abc",
          "X-Device-Token": "dev",
          "User-Agent": "vitest",
        },
      },
      exception: {
        values: [{ type: "Error", value: "no user +62 812 3456 7890" }],
      },
    });
    const text = JSON.stringify(event);
    for (const leak of [
      "s3cret",
      "hunter2",
      "Bearer",
      "token=abc",
      "budi@example.com",
      "3456",
      "1.2.3.4",
    ])
      expect(text).not.toContain(leak);
    expect(event.request.headers).toEqual({ "User-Agent": "vitest" });
    expect(event.request.url).toBe("https://api.example.com/api/x");
    expect(event).not.toHaveProperty("user");
  });
});
