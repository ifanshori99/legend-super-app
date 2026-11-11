// SSR visitor IP forwarding (bead legend-moe5).
//
// Written from the card design, not the implementation. Contract assumed:
//   - Module `../middleware/ssr-visitor-ip` exports `ssrVisitorIp(options?)`.
//     Assumption: `options.secret` overrides env `SSR_SHARED_SECRET`; with no
//     secret the feature is off (today's behavior).
//   - The web server sends `x-starter-ssr-auth` (the shared secret) and
//     `x-starter-visitor-ip` (the visitor address).
//   - Right secret + valid IP => `req.ssrVisitorIp`, and the per-IP bucket is
//     charged with that address (the internalIps skip no longer applies).
//   - Wrong, missing or unset secret => header ignored. In every case both
//     headers are deleted so no later code ever sees them.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler, notFound } from "../middleware/error-handler";
import {
  publicRateLimit,
  type PublicRateLimitOptions,
} from "../middleware/public-rate-limit";
import { ssrVisitorIp } from "../middleware/ssr-visitor-ip";
import { tenantContext } from "../middleware/tenant";

const SECRET = "s3cret-".padEnd(40, "x");
const OTHER_SECRET = "0ther--".padEnd(40, "y");
const TENANT_A = randomUUID();
const HOST_A = "tenant-a.example.test";
const WEB_SERVER_IP = "10.0.0.5";

type Seen = { headers: Record<string, unknown>; visitor: unknown };

function probeApp(
  options: Partial<PublicRateLimitOptions>,
  secret: string | null = SECRET,
  seen: Seen[] = [],
) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    tenantContext({
      required: false,
      resolveDomain: async (hostname) =>
        hostname === HOST_A ? { tenantId: TENANT_A, brandId: null } : null,
      verifyCredential: async () => null,
    }),
  );
  app.use("/api/qr", ssrVisitorIp({ secret: secret ?? undefined }));
  app.use(
    "/api/qr",
    publicRateLimit({ perIp: 1000, perTenant: 1000, ...options }),
    (req, res) => {
      seen.push({
        headers: { ...req.headers },
        visitor: (req as unknown as { ssrVisitorIp?: unknown }).ssrVisitorIp,
      });
      res.json({ data: { ok: true } });
    },
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function read(
  app: express.Express,
  socketIp: string,
  headers: Record<string, string> = {},
) {
  let req = request(app)
    .get("/api/qr/menu/probe")
    .set("Host", HOST_A)
    .set("X-Forwarded-For", socketIp);
  for (const [name, value] of Object.entries(headers))
    req = req.set(name, value);
  return req;
}

const ssr = (visitor: string, secret = SECRET) => ({
  "x-starter-ssr-auth": secret,
  "x-starter-visitor-ip": visitor,
});

describe("SSR visitor IP header (legend-moe5)", () => {
  it("legend-moe5 charges the per-IP bucket by visitor IP when the secret matches", async () => {
    const app = probeApp({ perIp: 1, internalIps: [WEB_SERVER_IP] });
    await read(app, WEB_SERVER_IP, ssr("203.0.113.10")).expect(200);
    const limited = await read(app, WEB_SERVER_IP, ssr("203.0.113.10")).expect(
      429,
    );
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    // Another visitor behind the same web server keeps their own window.
    await read(app, WEB_SERVER_IP, ssr("203.0.113.11")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.11")).expect(429);
  });

  it("legend-moe5 buckets by visitor IP even when the web server is not an internal address", async () => {
    const app = probeApp({ perIp: 1, internalIps: [] });
    await read(app, WEB_SERVER_IP, ssr("203.0.113.12")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.13")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.12")).expect(429);
  });

  it("legend-moe5 buckets IPv6 visitors", async () => {
    const app = probeApp({ perIp: 1, internalIps: [WEB_SERVER_IP] });
    await read(app, WEB_SERVER_IP, ssr("2001:db8::1")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("2001:db8::1")).expect(429);
  });

  it("legend-moe5 keeps the tenant bucket capping SSR traffic", async () => {
    const app = probeApp({
      perIp: 1000,
      perTenant: 2,
      internalIps: [WEB_SERVER_IP],
    });
    await read(app, WEB_SERVER_IP, ssr("203.0.113.14")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.15")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.16")).expect(429);
  });

  it("legend-moe5 ignores a wrong secret: no per-IP bucket for the claimed address", async () => {
    const app = probeApp({ perIp: 1, internalIps: [WEB_SERVER_IP] });
    // Internal address stays exempt from the per-IP bucket, as without the header.
    for (let i = 0; i < 3; i += 1) {
      await read(
        app,
        WEB_SERVER_IP,
        ssr(`203.0.113.${20 + i}`, OTHER_SECRET),
      ).expect(200);
    }
    // And the claimed address was never charged.
    await read(app, "203.0.113.20").expect(200);
  });

  it("legend-moe5 ignores the visitor header without any secret", async () => {
    const app = probeApp({ perIp: 1, internalIps: [WEB_SERVER_IP] });
    for (let i = 0; i < 3; i += 1) {
      await read(app, WEB_SERVER_IP, {
        "x-starter-visitor-ip": `203.0.113.${30 + i}`,
      }).expect(200);
    }
    await read(app, "203.0.113.30").expect(200);
  });

  it("legend-moe5 lets a client not reset its bucket by spoofing the visitor IP", async () => {
    const app = probeApp({ perIp: 1, internalIps: [] });
    const attacker = "198.51.100.7";
    await read(app, attacker).expect(200);
    await read(app, attacker).expect(429);
    // Rotating the claimed address, with no or a wrong secret, changes nothing.
    await read(app, attacker, {
      "x-starter-visitor-ip": "203.0.113.40",
    }).expect(429);
    await read(app, attacker, ssr("203.0.113.41", OTHER_SECRET)).expect(429);
    await read(app, attacker, {
      "x-starter-ssr-auth": "",
      "x-starter-visitor-ip": "203.0.113.42",
    }).expect(429);
  });

  it("legend-moe5 does not let a client spend another visitor's bucket without the secret", async () => {
    const app = probeApp({ perIp: 1, internalIps: [] });
    const victim = "203.0.113.50";
    // Attacker claims the victim's address with a wrong secret, twice.
    await read(app, "198.51.100.8", ssr(victim, OTHER_SECRET)).expect(200);
    await read(app, "198.51.100.8", ssr(victim, OTHER_SECRET)).expect(429);
    // The victim's own window is untouched.
    await read(app, victim).expect(200);
  });

  it("legend-moe5 ignores a non-IP visitor value even with the right secret", async () => {
    const app = probeApp({ perIp: 1, internalIps: [WEB_SERVER_IP] });
    for (const bad of [
      "not-an-ip",
      "203.0.113.1, 203.0.113.2",
      "999.1.1.1",
      "",
    ]) {
      await read(app, WEB_SERVER_IP, ssr(bad)).expect(200);
    }
    // No bucket was charged for junk: internal exemption still applies.
    await read(app, WEB_SERVER_IP, ssr("also bad")).expect(200);
  });

  it("legend-moe5 is off when no secret is configured", async () => {
    const app = probeApp({ perIp: 1, internalIps: [WEB_SERVER_IP] }, null);
    for (let i = 0; i < 3; i += 1) {
      await read(app, WEB_SERVER_IP, ssr(`203.0.113.${60 + i}`)).expect(200);
    }
    await read(app, "203.0.113.60").expect(200);
  });

  it("legend-moe5 exposes the visitor only with the right secret and always strips both headers", async () => {
    const seen: Seen[] = [];
    const app = probeApp({ internalIps: [WEB_SERVER_IP] }, SECRET, seen);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.70")).expect(200);
    await read(app, WEB_SERVER_IP, ssr("203.0.113.71", OTHER_SECRET)).expect(
      200,
    );
    await read(app, WEB_SERVER_IP, {
      "x-starter-visitor-ip": "203.0.113.72",
    }).expect(200);
    await read(app, WEB_SERVER_IP).expect(200);
    expect(seen.map((entry) => entry.visitor)).toEqual([
      "203.0.113.70",
      undefined,
      undefined,
      undefined,
    ]);
    for (const entry of seen) {
      expect(entry.headers["x-starter-visitor-ip"]).toBeUndefined();
      expect(entry.headers["x-starter-ssr-auth"]).toBeUndefined();
    }
  });
});
