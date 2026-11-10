import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createLogger } from "../lib/logger";

// Customer search puts the WhatsApp number in the query string
// (GET /api/customers?q=081234567890). It is personal data and must stay out
// of the access log, however the number is formatted.
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

describe("Access log redaction of phone numbers in query values", () => {
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
    ["plain", "q=081234567890", "081234567890"],
    ["plus 62", "q=%2B6281234567890", "6281234567890"],
    ["spaced", "q=0812%203456%207890", "0812 3456 7890"],
    ["dashed", "q=0812-3456-7890", "0812-3456-7890"],
  ])("keeps a %s number out of the log", async (_name, query, digits) => {
    const output = await logOutputFor(`/api/customers?${query}`);
    expect(output).toContain("q=%5Bredacted%5D");
    expect(output).not.toContain(digits);
    expect(output).not.toContain(encodeURIComponent(digits));
  });

  it("keeps short numeric values such as pagination", async () => {
    const output = await logOutputFor("/api/customers?page=2&limit=50");
    expect(output).toContain("page=2");
    expect(output).toContain("limit=50");
  });
});
