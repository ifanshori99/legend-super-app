// legend-z2kaf: the unauthenticated MCP dynamic client registration
// (POST /oauth/register) keys its per-IP hourly budget with clientIpKey
// (lib/client-ip-key.ts, legend-6jgd2). Written from the card text and the
// clientIpKey contract, never from the route implementation.
//
// Contract under test:
// - two different IPs (IPv4, or IPv6 in different /64) do not share the
//   per-IP quota;
// - IPv6 addresses inside one /64, however spelled, share one quota;
// - a forged X-Forwarded-For never moves the key (TRUST_PROXY stays refused,
//   so the probe app keeps Express's default `trust proxy` = off).
//
// Observable behavior: a request inside its budget reaches body validation and
// answers 400 `invalid_client_metadata` (an empty body registers nothing, so
// no client row is written); an over-budget request answers 429
// `access_denied`.
//
// Assumptions (spec silent):
// - The per-IP budget is 10 per hour (REGISTER_PER_HOUR, the route's documented
//   number); tests spend 10 and expect the 11th to be refused.
// - The route keeps its budgets in module state, so every test loads a fresh
//   copy of the router (vi.resetModules) to start from empty budgets and to
//   stay below the separate global cap of 60 per hour.
// - The tenant gate (module flag, platform lock) is stubbed open; the card is
//   about the key only.
// - The `x-test-peer` header is test scaffolding that stands in for the socket
//   address (Express `req.ip` with trust proxy off).
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/ai-platform-lock.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-platform-lock.ts")>()),
  isMcpModuleDisabled: async () => false,
  isAiPlatformLocked: async () => false,
}));

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const HOST = "tenant-a.example.test";
const PER_IP = 10;

// Addresses inside 2001:db8:0:1::/64, spelled differently.
const SAME_64 = [
  "2001:db8:0:1::1",
  "2001:DB8:0:1:aaaa:bbbb:cccc:dddd",
  "2001:0db8:0000:0001::6",
  "2001:db8:0:1:ffff:ffff:ffff:ffff",
] as const;
const OTHER_64 = "2001:db8:0:2::1";

type Headers = { peer?: string; forwardedFor?: string };

async function freshApp() {
  vi.resetModules();
  const { tenantContext } = await import("../middleware/tenant.ts");
  const { mcpOAuthRouter } = await import("../routes/mcp.routes.ts");
  const app = express();
  // Trust proxy stays at Express's default (off): X-Forwarded-For is ignored.
  app.use((req, _res, next) => {
    const peer = req.get("x-test-peer");
    if (peer !== undefined)
      Object.defineProperty(req, "ip", { value: peer, configurable: true });
    next();
  });
  app.use(
    tenantContext({
      required: false,
      resolveDomain: async (hostname) =>
        hostname === HOST ? { tenantId: TENANT_ID, brandId: null } : null,
      verifyCredential: async () => null,
    }),
  );
  app.use(mcpOAuthRouter);
  return app;
}

function register(app: express.Express, headers: Headers = {}) {
  const req = request(app).post("/oauth/register").set("Host", HOST).send({});
  if (headers.peer !== undefined) req.set("x-test-peer", headers.peer);
  if (headers.forwardedFor !== undefined)
    req.set("X-Forwarded-For", headers.forwardedFor);
  return req;
}

async function expectAllowed(res: PromiseLike<request.Response>) {
  // Inside the budget the request reaches body validation.
  const allowed = await res;
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(400);
  expect(allowed.body.error).toBe("invalid_client_metadata");
}

async function expectLimited(res: PromiseLike<request.Response>) {
  const limited = await res;
  expect(limited.status, JSON.stringify(limited.body)).toBe(429);
  expect(limited.body.error).toBe("access_denied");
}

async function spend(
  app: express.Express,
  headers: (index: number) => Headers,
  count = PER_IP,
) {
  for (let i = 0; i < count; i += 1)
    await expectAllowed(register(app, headers(i)));
}

describe("legend-z2kaf MCP dynamic registration keys its per-IP budget on the client IP key", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("legend-z2kaf two different IPv4 addresses do not share a registration quota", async () => {
    const app = await freshApp();
    await spend(app, () => ({ peer: "203.0.113.10" }));
    await expectLimited(register(app, { peer: "203.0.113.10" }));
    await expectAllowed(register(app, { peer: "203.0.113.11" }));
  });

  it("legend-z2kaf two IPv6 addresses in different /64 do not share a registration quota", async () => {
    const app = await freshApp();
    await spend(app, () => ({ peer: SAME_64[0] }));
    await expectLimited(register(app, { peer: SAME_64[0] }));
    await expectAllowed(register(app, { peer: OTHER_64 }));
  });

  it("legend-z2kaf IPv6 addresses inside one /64 share one registration quota", async () => {
    const app = await freshApp();
    // Ten requests, each from a different address (and spelling) of one /64.
    await spend(app, (i) => ({
      peer:
        SAME_64[i] ??
        `2001:db8:0:1:0:0:${(i + 1).toString(16)}:${(i + 2).toString(16)}`,
    }));
    await expectLimited(register(app, { peer: "2001:db8:0:1::abcd" }));
    await expectLimited(register(app, { peer: SAME_64[0] }));
  });

  it("legend-z2kaf a forged X-Forwarded-For does not give a client a fresh registration quota", async () => {
    const app = await freshApp();
    // Real socket address (no override): every request is the same client.
    await spend(app, (i) => ({ forwardedFor: `198.51.100.${i + 1}` }));
    await expectLimited(register(app, { forwardedFor: "198.51.100.200" }));
    await expectLimited(register(app, { forwardedFor: "2001:db8:0:9::1" }));
  });

  it("legend-z2kaf a forged X-Forwarded-For cannot spend another client's registration quota", async () => {
    const app = await freshApp();
    const victim = "203.0.113.50";
    const attacker = "203.0.113.60";
    // The attacker claims to be the victim, again and again.
    await spend(app, () => ({ peer: attacker, forwardedFor: victim }));
    await expectLimited(
      register(app, { peer: attacker, forwardedFor: victim }),
    );
    // The victim's own bucket is untouched.
    await expectAllowed(register(app, { peer: victim }));
  });
});
