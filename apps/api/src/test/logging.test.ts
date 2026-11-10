import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { createLogger } from "../lib/logger";
import { agent, originHeader, signUp } from "./helpers";

// Make one authenticated route fail unexpectedly, with a message that must
// never leak. `guard.fail` is only switched on by the 500 test below.
const guard = vi.hoisted(() => ({ fail: false }));
vi.mock("../middleware/tenant", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../middleware/tenant")>();
  return {
    ...original,
    requireTenantContext: ((req, res, next) => {
      if (guard.fail) throw new Error("boom: postgres://user:secret@db/app");
      return original.requireTenantContext(req, res, next);
    }) satisfies typeof original.requireTenantContext,
  };
});

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

describe("Server logging", () => {
  it("writes one access line per request with reqId and userId, and no secrets", async () => {
    const { lines, logger } = capture();
    const client = agent(createApp({ logger }));
    const email = await signUp(client);
    await client
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({ email, password: "Test-password-123!" });
    await client.get("/api/platform/packages");

    const output = JSON.stringify(lines);
    expect(output).not.toContain("Test-password-123!");
    expect(output).not.toMatch(/session_token=/);

    const signIn = lines.find(
      (line) =>
        line.msg === "POST /api/auth/sign-in/email 200" ||
        String(line.msg).startsWith("POST /api/auth/sign-in/email 200"),
    );
    expect(signIn).toMatchObject({ level: 30, service: "api" });
    expect(signIn?.reqId).toEqual(expect.any(String));

    // A signed-in user outside platform_admins gets 403: a 4xx logs as warn.
    const refused = lines.find((line) =>
      String(line.msg).startsWith("GET /api/platform/packages"),
    );
    expect(refused).toMatchObject({ level: 40, userId: expect.any(String) });
  });

  it("logs unexpected errors once with a stack while the client gets a generic 500", async () => {
    const { lines, logger } = capture();
    const client = agent(createApp({ logger }));
    await signUp(client);

    guard.fail = true;
    let response;
    try {
      response = await client
        .get("/api/me/access")
        .set("X-Request-Id", "trace-500");
    } finally {
      guard.fail = false;
    }
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Try again.",
        requestId: "trace-500",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("boom");

    const errors = lines.filter((line) => line.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      reqId: "trace-500",
      msg: "GET /api/me/access 500",
    });
    expect((errors[0].err as { stack: string }).stack).toContain("boom");
  });
});
