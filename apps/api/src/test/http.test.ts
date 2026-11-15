import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { originHeader, WEB_ORIGIN } from "./helpers";

const app = createApp();

describe("HTTP plumbing", () => {
  it("reports liveness and readiness", async () => {
    expect((await request(app).get("/api/health")).body).toEqual({
      status: "ok",
      scanner: "disabled",
    });
    expect((await request(app).get("/api/health/ready")).body).toEqual({
      status: "ok",
      database: "ok",
    });
  });

  it("allows CORS with credentials for the web origin only", async () => {
    const allowed = await request(app)
      .options("/api/me/access")
      .set("Origin", WEB_ORIGIN)
      .set("Access-Control-Request-Method", "POST");
    expect(allowed.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const denied = await request(app)
      .options("/api/me/access")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes payout export filename and checksum to the web origin", async () => {
    const path =
      "/api/hris/payroll/disbursement-batches/01ARZ3NDEKTSV4RRFFQ69G5FAV/export";
    const preflight = await request(app)
      .options(path)
      .set("Origin", WEB_ORIGIN)
      .set("Access-Control-Request-Method", "POST");
    const actual = await request(app).post(path).set("Origin", WEB_ORIGIN);

    expect(preflight.status).toBe(204);
    expect(actual.status).toBe(401);
    for (const response of [preflight, actual]) {
      expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      const exposed = String(response.headers["access-control-expose-headers"])
        .toLowerCase()
        .split(",")
        .map((header) => header.trim());
      expect(exposed).toContain("content-disposition");
      expect(exposed).toContain("x-content-checksum-sha256");
    }
  });

  // legend-8tv6: payment-admin configuration writes are PUT and carry their
  // retry identity in Idempotency-Key, so the preflight must allow both.
  it("allows the Idempotency-Key preflight for PUT from the web origin only", async () => {
    const allowed = await request(app)
      .options("/api/payments/admin/routing/qris")
      .set("Origin", WEB_ORIGIN)
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "content-type,idempotency-key");
    expect(allowed.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(allowed.headers["access-control-allow-methods"]).toContain("PUT");
    expect(
      String(allowed.headers["access-control-allow-headers"]).toLowerCase(),
    ).toContain("idempotency-key");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const denied = await request(app)
      .options("/api/payments/admin/routing/qris")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "idempotency-key");
    // Without Allow-Origin the browser blocks the response, so no header list
    // can make an untrusted page call the API.
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("generates or echoes a safe X-Request-Id", async () => {
    const generated = await request(app).get("/api/health");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await request(app)
      .get("/api/health")
      .set("X-Request-Id", "trace-123");
    expect(echoed.headers["x-request-id"]).toBe("trace-123");

    const unsafe = await request(app)
      .get("/api/health")
      .set("X-Request-Id", "bad id <script>");
    // A freshly minted UUID can randomly contain the hex substring "bad", so
    // the response must be a new canonical v4 UUID, not merely a value that
    // avoids that substring.
    const unsafeId = unsafe.headers["x-request-id"];
    expect(unsafeId).toBeDefined();
    expect(unsafeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(unsafeId).not.toBe("bad id <script>");
  });

  it("refuses oversized Better Auth bodies before they are read", async () => {
    const response = await request(app)
      .post("/api/auth/sign-up/email")
      .set(originHeader)
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          name: "x".repeat(200 * 1024),
          email: "too-big@example.com",
          password: "Test-password-123!",
        }),
      );
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("refuses a streamed Better Auth body without a Content-Length", async () => {
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth/sign-in/email`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...originHeader },
          // A stream has no known length, so it goes out chunked.
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            },
          }),
          duplex: "half",
        },
      );
      expect(response.status).toBe(411);
    } finally {
      server.close();
    }
  });

  it("answers unknown routes with the JSON error envelope", async () => {
    const response = await request(app).get("/nope");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: response.headers["x-request-id"],
      },
    });
  });
});
