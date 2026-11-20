import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { scrubSentryEvent } from "@starter/shared/sentry";
import { initSentry } from "../lib/sentry.ts";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "../middleware/error-handler.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/node", () => ({ init: vi.fn(), captureException }));

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

describe("scrubSentryEvent allow list and tokens", () => {
  it("keeps only allow-listed headers", () => {
    const event = scrubSentryEvent({
      request: {
        headers: {
          "x-starter-ssr-auth": "ssr",
          "X-Pin-Proof": "pin",
          Referer: "https://web.example.com/t/abc123token/cart?x=1",
          Accept: "application/json",
          "x-request-id": "r1",
        },
      },
    });
    expect(event.request.headers).toEqual({
      Accept: "application/json",
      "x-request-id": "r1",
    });
  });

  it("tokenizes link URLs, transaction names, and breadcrumbs", () => {
    const event = scrubSentryEvent({
      transaction: "GET /api/payments/links/abc123token",
      request: {
        url: "https://api.example.com/api/payments/links/abc123token",
      },
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "/t/Zx9Token/cart?a=1#frag",
            to: "/bayar/Tok999",
            url: "/api/receipts/rcpt-1?sig=abc",
            "http.query": "sig=abc",
            "http.fragment": "frag",
          },
        },
      ],
      logentry: { message: "NIK 3171234567890123 mail a@b.co" },
    });
    const text = JSON.stringify(event);
    for (const leak of [
      "abc123token",
      "Zx9Token",
      "Tok999",
      "rcpt-1",
      "sig=abc",
      "frag",
      "3171234567890123",
      "a@b.co",
    ])
      expect(text).not.toContain(leak);
    expect(event.request.url).toBe(
      "https://api.example.com/api/payments/links/[token]",
    );
    expect(event.transaction).toBe("GET /api/payments/links/[token]");
    expect(event.breadcrumbs[0].data).toEqual({
      from: "/t/[token]/cart",
      to: "/bayar/[token]",
      url: "/api/receipts/[token]",
    });
  });
});

describe("error handler to Sentry", () => {
  it("sends the row-free copy of a DrizzleQueryError, without params", async () => {
    initSentry({ dsn: "https://key@o1.ingest.sentry.io/1", init: vi.fn() });
    const driver = Object.assign(
      new Error("Failed query: insert ...\nparams: secret-row-value"),
      {
        name: "DrizzleQueryError",
        query: "insert into t values ($1)",
        params: ["secret-row-value"],
      },
    );
    const app = express();
    app.use(requestContext);
    app.get("/", () => {
      throw driver;
    });
    app.use(errorHandler);
    const response = await request(app).get("/");
    expect(response.status).toBe(500);
    const sent = captureException.mock.calls[0]?.[0] as Error;
    expect(sent).not.toBe(driver);
    expect(sent).not.toHaveProperty("params");
    expect(JSON.stringify([sent.message, sent.stack])).not.toContain(
      "secret-row-value",
    );
  });
});
