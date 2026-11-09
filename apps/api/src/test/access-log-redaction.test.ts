import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createLogger } from "../lib/logger";

// legend-qni9: the public purchase order share token is a bearer credential in
// the URL path. It must stay out of the access log whether the request line
// carries a relative target or an absolute-form one (RFC 9112 section 3.2.2).
const TOKEN = "tok_SECRET_0123456789abcdef";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean))
        lines.push(JSON.parse(line));
      done();
    },
  });
  return {
    lines,
    logger: createLogger({ level: "debug", destination: stream }),
  };
}

describe("Access log redaction of public PO share tokens", () => {
  const { lines, logger } = capture();
  const server = createApp({ logger }).listen(0);
  const port = () => (server.address() as AddressInfo).port;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.once("listening", () => resolve());
      }),
  );
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  // Raw request so the request target is sent exactly as given.
  function send(target: string) {
    return new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: port(),
          method: "GET",
          path: target,
          headers: { host: `127.0.0.1:${port()}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  async function logOutputFor(target: string) {
    lines.length = 0;
    await send(target);
    // pino-http writes on response finish; give the stream a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return JSON.stringify(lines);
  }

  it.each([
    ["relative path", `/api/public/purchase-orders/${TOKEN}`],
    ["relative path with query", `/api/public/purchase-orders/${TOKEN}?x=1`],
    [
      "absolute URL",
      `http://example.test/api/public/purchase-orders/${TOKEN}`,
    ],
    [
      "absolute URL with query",
      `http://example.test:8080/api/public/purchase-orders/${TOKEN}?x=1`,
    ],
    [
      "absolute https URL, mixed case path",
      `https://example.test/API/Public/Purchase-Orders/${TOKEN}`,
    ],
  ])("keeps the token out of the log for a %s", async (_name, target) => {
    const output = await logOutputFor(target);
    expect(output).toContain("[redacted]");
    expect(output).not.toContain(TOKEN);
  });

  // legend-9wbc: the e-receipt token (legend-93a) is a bearer credential on
  // /api/public/receipts/<token> and /<token>/pdf, in origin-form and
  // absolute-form request targets alike. The pre-fix safeUrl split on "?" and
  // anchored the path regexes at "^/api/...", so any absolute-form target
  // ("http://host/api/public/receipts/<token>") never matched and the token
  // reached the log; that breaks the not.toContain(TOKEN) assertion below.
  it.each([
    ["origin-form", `/api/public/receipts/${TOKEN}`],
    ["origin-form pdf", `/api/public/receipts/${TOKEN}/pdf`],
    ["origin-form with query", `/api/public/receipts/${TOKEN}?x=1`],
    ["origin-form pdf with query", `/api/public/receipts/${TOKEN}/pdf?x=1`],
    ["absolute-form", `http://example.test/api/public/receipts/${TOKEN}`],
    [
      "absolute-form pdf",
      `http://example.test/api/public/receipts/${TOKEN}/pdf`,
    ],
    [
      "absolute-form with port and query",
      `http://example.test:8080/api/public/receipts/${TOKEN}?x=1`,
    ],
    [
      "absolute-form pdf with query",
      `http://example.test/api/public/receipts/${TOKEN}/pdf?x=1`,
    ],
    [
      "uppercase scheme",
      `HTTP://example.test/api/public/receipts/${TOKEN}`,
    ],
    [
      "uppercase scheme pdf with query",
      `HTTP://example.test/api/public/receipts/${TOKEN}/pdf?x=1`,
    ],
  ])(
    "keeps the receipt token out of the log for an %s URL",
    async (_name, target) => {
      const output = await logOutputFor(target);
      expect(output).toContain("/api/public/receipts/[redacted]");
      expect(output).not.toContain(TOKEN);
    },
  );

  it("still blanks credential-like query values on an absolute URL", async () => {
    const output = await logOutputFor(
      "http://example.test/api/health?token=QUERYSECRET&page=2",
    );
    expect(output).not.toContain("QUERYSECRET");
    expect(output).toContain("page=2");
  });
});
