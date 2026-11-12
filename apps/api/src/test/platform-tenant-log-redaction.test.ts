// legend-co93l: the account search term can contain a person's name or email.
// It must not escape through either pino-http req.url or its message, including
// refused requests and absolute-form targets accepted by the HTTP server.
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createLogger } from "../lib/logger";

const TENANT = "00000000-0000-4000-8000-000000000559";
const NAME = "NamaPribadi559";
const EMAIL = "PemilikPribadi559@example.test";
const BASE = `/api/platform/tenants/${TENANT}/accounts`;

describe("legend-co93l account search access logs", () => {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean))
        lines.push(JSON.parse(line));
      done();
    },
  });
  const logger = createLogger({ level: "debug", destination: stream });
  const server = createApp({ logger }).listen(0);
  const port = () => (server.address() as AddressInfo).port;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.once("listening", resolve);
      }),
  );
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  async function send(target: string) {
    lines.length = 0;
    await new Promise<void>((resolve, reject) => {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    return JSON.stringify(lines);
  }

  it.each([
    ["relative name", `${BASE}?q=${NAME}&limit=3`],
    ["relative email", `${BASE}?q=${encodeURIComponent(EMAIL)}&limit=3`],
    [
      "absolute email",
      `http://example.test${BASE}?q=${encodeURIComponent(EMAIL)}&limit=3`,
    ],
    [
      "mixed case path",
      `/API/Platform/Tenants/${TENANT}/Accounts?q=${NAME}&limit=3`,
    ],
    ["encoded query key", `${BASE}?%71=${NAME}&limit=3`],
    [
      "repeated query values",
      `${BASE}?q=${NAME}&q=${encodeURIComponent(EMAIL)}&limit=3`,
    ],
  ])(
    "TEN-04 AC12 redacts the term from %s requests",
    async (_label, target) => {
      const output = await send(target);
      expect(output).toContain("q=%5Bredacted%5D");
      expect(output).toContain("limit=3");
      expect(output).not.toContain(NAME);
      expect(output).not.toContain("PemilikPribadi559");
      expect(output).not.toContain(EMAIL);
      expect(output).not.toContain(encodeURIComponent(EMAIL));
    },
  );
});
