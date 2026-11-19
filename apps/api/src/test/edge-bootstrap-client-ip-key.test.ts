// legend-z2kaf: the edge bootstrap limiter (GET /api/edge-sync/bootstrap and
// /bootstrap/masters) keys its per-IP bucket with clientIpKey
// (lib/client-ip-key.ts, legend-6jgd2). Written from the card text and the
// clientIpKey contract, never from the route implementation.
//
// Contract under test, for both paths:
// - two different IPs (IPv4, or IPv6 in different /64) do not share a quota;
// - IPv6 addresses inside one /64, however spelled, share one quota;
// - a forged X-Forwarded-For never moves the key (TRUST_PROXY stays refused,
//   so the probe app keeps Express's default `trust proxy` = off).
//
// No database: the default edge credential verifier denies every node, so a
// request inside its budget answers 401 and an over-budget one answers 429
// before the verifier runs; the bundle builders are mocked away.
//
// Assumptions (spec silent):
// - A constant injected clock keeps every request inside one window.
// - The `x-test-peer` header is test scaffolding that stands in for the socket
//   address (Express `req.ip` with trust proxy off).
// - Every request carries a fresh well-formed credential, so the per-credential
//   and per-device budgets (set very high) never decide the outcome.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { createEdgeBootstrapRouter } from "../routes/edge-bootstrap.routes.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";

vi.mock("../services/edge-bootstrap.service.ts", () => ({
  buildEdgeBootstrapBundle: async () => ({ bundle: {}, signature: "stub" }),
}));
vi.mock("../services/edge-master-sync.service.ts", () => ({
  buildEdgeMasterSnapshot: async () => ({ snapshot: {}, signature: "stub" }),
}));

const mount = "/api/edge-sync/bootstrap";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OUTLET_ID = "22222222-2222-4222-8222-222222222222";

// Addresses inside 2001:db8:0:1::/64, spelled differently.
const SAME_64 = [
  "2001:db8:0:1::1",
  "2001:DB8:0:1:aaaa:bbbb:cccc:dddd",
  "2001:0db8:0000:0001::6",
  "2001:db8:0:1:ffff:ffff:ffff:ffff",
] as const;
const OTHER_64 = "2001:db8:0:2::1";

afterEach(() => {
  setEdgeCredentialVerifier(null);
});

type Probe = {
  name: string;
  route: string;
  options: (perIp: number) => Parameters<typeof createEdgeBootstrapRouter>[0];
};

const PROBES: Probe[] = [
  {
    name: "bootstrap",
    route: mount,
    options: (perIp) => ({
      perIp,
      perCredential: 1_000_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    }),
  },
  {
    name: "masters",
    route: `${mount}/masters`,
    options: (mastersPerIp) => ({
      mastersPerIp,
      mastersPerDevice: 1_000_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    }),
  },
];

describe.each(PROBES)(
  "legend-z2kaf edge $name rate limit keys on the client IP key",
  (probe) => {
    function appWith(perIp: number) {
      const app = express();
      // Trust proxy stays at Express's default (off): X-Forwarded-For is ignored.
      app.use((req, _res, next) => {
        const peer = req.get("x-test-peer");
        if (peer !== undefined)
          Object.defineProperty(req, "ip", { value: peer, configurable: true });
        next();
      });
      app.use(mount, createEdgeBootstrapRouter(probe.options(perIp)));
      app.use(errorHandler);
      return app;
    }

    function get(
      app: express.Express,
      headers: { peer?: string; forwardedFor?: string } = {},
    ) {
      const req = request(app)
        .get(probe.route)
        .set(
          "Authorization",
          `Bearer ${
            mintEdgeCredential({
              tenantId: TENANT_ID,
              outletId: OUTLET_ID,
              edgeNodeId: randomUUID(),
            }).token
          }`,
        );
      if (headers.peer !== undefined) req.set("x-test-peer", headers.peer);
      if (headers.forwardedFor !== undefined)
        req.set("X-Forwarded-For", headers.forwardedFor);
      return req;
    }

    async function expectAllowed(res: PromiseLike<request.Response>) {
      // Inside the budget the request reaches the (denying) credential check.
      expect((await res).status).toBe(401);
    }

    async function expectLimited(res: PromiseLike<request.Response>) {
      const limited = await res;
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMITED");
    }

    it("legend-z2kaf two different IPv4 addresses do not share a quota", async () => {
      const app = appWith(2);
      await expectAllowed(get(app, { peer: "203.0.113.10" }));
      await expectAllowed(get(app, { peer: "203.0.113.10" }));
      await expectLimited(get(app, { peer: "203.0.113.10" }));
      await expectAllowed(get(app, { peer: "203.0.113.11" }));
      await expectAllowed(get(app, { peer: "203.0.113.11" }));
      await expectLimited(get(app, { peer: "203.0.113.11" }));
    });

    it("legend-z2kaf two IPv6 addresses in different /64 do not share a quota", async () => {
      const app = appWith(2);
      await expectAllowed(get(app, { peer: SAME_64[0] }));
      await expectAllowed(get(app, { peer: SAME_64[0] }));
      await expectLimited(get(app, { peer: SAME_64[0] }));
      await expectAllowed(get(app, { peer: OTHER_64 }));
      await expectAllowed(get(app, { peer: OTHER_64 }));
      await expectLimited(get(app, { peer: OTHER_64 }));
    });

    it("legend-z2kaf IPv6 addresses inside one /64 share one quota", async () => {
      const app = appWith(3);
      await expectAllowed(get(app, { peer: SAME_64[0] }));
      await expectAllowed(get(app, { peer: SAME_64[1] }));
      await expectAllowed(get(app, { peer: SAME_64[2] }));
      await expectLimited(get(app, { peer: SAME_64[3] }));
      // The /64 stays limited for yet another spelling of the same prefix.
      await expectLimited(get(app, { peer: "2001:db8:0:1::99" }));
    });

    it("legend-z2kaf a forged X-Forwarded-For does not give a client fresh quota", async () => {
      const app = appWith(2);
      // Real socket address (no override): every request is the same client.
      await expectAllowed(get(app, { forwardedFor: "198.51.100.1" }));
      await expectAllowed(get(app, { forwardedFor: "198.51.100.2" }));
      await expectLimited(get(app, { forwardedFor: "198.51.100.3" }));
      await expectLimited(get(app, { forwardedFor: "2001:db8:0:9::1" }));
    });

    it("legend-z2kaf a forged X-Forwarded-For cannot spend another client's quota", async () => {
      const app = appWith(2);
      const victim = "203.0.113.50";
      const attacker = "203.0.113.60";
      // The attacker claims to be the victim, again and again.
      await expectAllowed(get(app, { peer: attacker, forwardedFor: victim }));
      await expectAllowed(get(app, { peer: attacker, forwardedFor: victim }));
      await expectLimited(get(app, { peer: attacker, forwardedFor: victim }));
      // The victim's own bucket is untouched.
      await expectAllowed(get(app, { peer: victim }));
      await expectAllowed(get(app, { peer: victim }));
      await expectLimited(get(app, { peer: victim }));
    });
  },
);
