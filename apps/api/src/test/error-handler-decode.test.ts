import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { errorHandler } from "../middleware/error-handler";
import { createLogger } from "../lib/logger";
import { seededHostname } from "./floor-test-helpers";

const TOKEN = "SECRETRECEIPTTOKEN0123456789abcdef";

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
    logger: createLogger({ level: "trace", destination: stream }),
  };
}

// POS-07 / P3: Express 5 raises a 400 "Failed to decode param" error for a
// malformed percent-encoding. The e-receipt token is a bearer credential, so
// neither the response nor the log may echo the path, the param, or the
// URIError message and stack.
describe("malformed percent-encoding in a route param", () => {
  for (const path of [
    `/api/public/receipts/${TOKEN}%ZZ`,
    `/api/public/receipts/${TOKEN}%ZZ/pdf`,
    `/api/public/receipts/%ZZ${TOKEN}`,
  ]) {
    it(`answers a generic 400 and logs no secret for ${path.replace(TOKEN, "<TOKEN>")}`, async () => {
      const { lines, logger } = capture();
      const response = await request(createApp({ logger }))
        .get(path)
        .set({ Host: seededHostname });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toBe("The request URL is malformed.");
      expect(response.text).not.toContain(TOKEN);
      expect(response.text).not.toContain("%ZZ");
      expect(response.text).not.toMatch(/decode/i);

      const output = JSON.stringify(lines);
      expect(lines.length).toBeGreaterThan(0);
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain("%ZZ");
      expect(output).not.toMatch(
        /Failed to decode|URIError|decodeURIComponent/,
      );
    });
  }
});

// Only the router's decode error is downgraded: a URIError thrown by
// application code is a server bug and keeps the logged 500 path.
describe("a URIError from application code", () => {
  it("stays a logged 500", () => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      headersSent: false,
      err: undefined as Error | undefined,
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    };
    errorHandler(
      new URIError("URI malformed"),
      {} as Parameters<typeof errorHandler>[1],
      res as unknown as Parameters<typeof errorHandler>[2],
      () => undefined,
    );
    expect(sent.status).toBe(500);
    expect(res.err).toBeInstanceOf(URIError);
  });
});
