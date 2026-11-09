// WS-03 S1: the guest QR routes mint an outlet-scoped context from the signed
// token (legend-7csf), and the guest table-session routes sit under the public
// per-IP limiter with a per-session bucket (legend-6ipw, legend-fpi9,
// legend-khiv part 4).
//
// The services are wrapped so the test can read the context the route handed
// them; the database is not needed for these cases. The RLS side (outlet
// policies narrow reads) is covered by db/outlet-rls.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { siteConfig } from "@starter/shared/site";
import { env } from "../config/env";
import { GUEST_SESSION_PER_MINUTE } from "../middleware/public-rate-limit";
import { signTableQrToken } from "../services/qr-token";
import { agent } from "./helpers";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
} from "./floor-test-helpers";

const seen = vi.hoisted(() => ({
  contexts: [] as unknown[],
  // false: the wrapped services only record the context and answer a stub;
  // true: they record it and run for real (the DB-backed cases below).
  passthrough: false,
}));

vi.mock("../services/guest-menu.service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../services/guest-menu.service")>();
  return {
    ...original,
    getQrMenu: vi.fn(async (...args: Parameters<typeof original.getQrMenu>) => {
      seen.contexts.push(args[0]);
      return seen.passthrough ? original.getQrMenu(...args) : { ok: true };
    }),
  };
});
vi.mock("../services/table-session.service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../services/table-session.service")>();
  return {
    ...original,
    openOrJoinTableSession: vi.fn(
      async (...args: Parameters<typeof original.openOrJoinTableSession>) => {
        seen.contexts.push(args[0]);
        return seen.passthrough
          ? original.openOrJoinTableSession(...args)
          : { ok: true };
      },
    ),
  };
});
vi.mock("../services/qr-order.service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../services/qr-order.service")>();
  return {
    ...original,
    getTableSessionView: vi.fn(
      async (...args: Parameters<typeof original.getTableSessionView>) => {
        seen.contexts.push(args[0]);
        return original.getTableSessionView(...args);
      },
    ),
    getSessionBill: vi.fn(
      async (...args: Parameters<typeof original.getSessionBill>) => {
        seen.contexts.push(args[0]);
        return original.getSessionBill(...args);
      },
    ),
  };
});

vi.mock("../services/service-request.service", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../services/service-request.service")
    >();
  return {
    ...original,
    createServiceRequest: vi.fn(
      async (...args: Parameters<typeof original.createServiceRequest>) => {
        seen.contexts.push(args[0]);
        return original.createServiceRequest(...args);
      },
    ),
  };
});

const { createApp } = await import("../app");

const { tenant, outlets } = cafeLegendFixtures;
const outletId = outlets[0].id;
const hostname = cafeLegendPlatformFixtures.domains[0].hostname as string;

type Scoped = {
  tenant: { tenantId: string };
  outletScope: { kind: string; outletIds?: readonly string[] };
};

function token(overrides: { tenantId?: string; outletId?: string } = {}) {
  return signTableQrToken({
    tenantId: overrides.tenantId ?? tenant.id,
    outletId: overrides.outletId ?? outletId,
    tableId: randomUUID(),
  });
}

beforeEach(() => {
  seen.contexts.length = 0;
  seen.passthrough = false;
});

afterAll(async () => {
  await owner.end();
});

describe("guest QR context is outlet scoped (legend-7csf)", () => {
  it("legend-7csf menu read runs in a context reaching only the token's outlet", async () => {
    const client = agent(createApp());
    const res = await client
      .get(`/api/qr/menu/${token()}`)
      .set("Host", hostname);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [context] = seen.contexts as Scoped[];
    expect(context.tenant.tenantId).toBe(tenant.id);
    expect(context.outletScope.kind).toBe("outlets");
    expect(context.outletScope.outletIds).toEqual([outletId]);
  });

  it("legend-7csf scan runs in a context reaching only the token's outlet", async () => {
    const client = agent(createApp());
    const res = await client
      .post("/api/qr/sessions")
      .set("Host", hostname)
      .send({ qrToken: token(), pax: 2, deviceHash: "a".repeat(64) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [context] = seen.contexts as Scoped[];
    expect(context.outletScope.kind).toBe("outlets");
    expect(context.outletScope.outletIds).toEqual([outletId]);
  });

  it("legend-7csf refuses a token signed for another tenant before any service runs", async () => {
    const client = agent(createApp());
    const res = await client
      .get(`/api/qr/menu/${token({ tenantId: randomUUID() })}`)
      .set("Host", hostname);
    expect(res.status).toBe(404);
    expect(seen.contexts).toEqual([]);
  });

  it("legend-7csf refuses a token with a forged payload", async () => {
    const client = agent(createApp());
    const [version, , signature] = token().split(".");
    const forged = Buffer.from(
      JSON.stringify({
        version: 1,
        tenantId: tenant.id,
        outletId: randomUUID(),
        tableId: randomUUID(),
        keyId: "v1",
        issuedAt: new Date().toISOString(),
      }),
    ).toString("base64url");
    const res = await client
      .get(`/api/qr/menu/${version}.${forged}.${signature}`)
      .set("Host", hostname);
    expect(res.status).toBe(404);
    expect(seen.contexts).toEqual([]);
  });
});

describe("guest table-session limiter (legend-6ipw, legend-fpi9, legend-khiv)", () => {
  const sessionPath = (id: string = randomUUID()) =>
    `/api/table-sessions/${id}`;

  it("limits guest session reads per IP", async () => {
    const client = agent(
      createApp({ publicRateLimit: { perIp: 1, internalIps: [] } }),
    );
    // No credential: 401 from the route, but it was counted once.
    const first = await client.get(sessionPath()).set("Host", hostname);
    expect(first.status).not.toBe(429);
    const limited = await client.get(sessionPath()).set("Host", hostname);
    expect(limited.status, JSON.stringify(limited.body)).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  const bearer = `Bearer ${"x".repeat(43)}`;

  it("limits one session without blocking other sessions on the same address", async () => {
    const client = agent(
      createApp({
        publicRateLimit: {
          perIp: 100_000,
          perTenant: 100_000,
          internalIps: [],
        },
      }),
    );
    const sessionId = randomUUID();
    const read = (id: string, credential = bearer) =>
      client
        .get(sessionPath(id))
        .set("Host", hostname)
        .set("Authorization", credential);
    // The session credential is shared by every device at the table, so the
    // per-session budget is a whole table's polling: 600 a minute.
    for (let i = 0; i < GUEST_SESSION_PER_MINUTE; i += 1) {
      const res = await read(sessionId);
      expect(res.status).not.toBe(429);
    }
    expect((await read(sessionId)).status).toBe(429);
    // Another table (its own credential) at the same venue address is untouched.
    expect(
      (await read(randomUUID(), `Bearer ${"z".repeat(43)}`)).status,
    ).not.toBe(429);
  }, 60_000);

  it("charges the session bucket only for a well-formed credential", async () => {
    const client = agent(
      createApp({
        publicRateLimit: {
          perIp: 100_000,
          perTenant: 100_000,
          internalIps: [],
        },
      }),
    );
    const sessionId = randomUUID();
    // Junk credentials never reach the per-session bucket, so they cannot
    // lock a real table out; the route answers 401 each time.
    for (let i = 0; i < 5; i += 1) {
      const res = await client
        .get(sessionPath(sessionId))
        .set("Host", hostname)
        .set("Authorization", "Bearer short");
      expect(res.status).toBe(401);
    }
  });

  it("counts guest traffic in its own tenant bucket", async () => {
    const client = agent(
      createApp({
        publicRateLimit: { perIp: 100_000, perTenant: 2, internalIps: [] },
      }),
    );
    const read = () =>
      client
        .get(sessionPath())
        .set("Host", hostname)
        .set("Authorization", bearer);
    expect((await read()).status).not.toBe(429);
    expect((await read()).status).not.toBe(429);
    const limited = await read();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("sizes the default guest tenant bucket apart from the public one", () => {
    expect(env.PUBLIC_RATE_LIMIT_GUEST_TENANT_PER_MINUTE).toBe(60_000);
    expect(env.PUBLIC_RATE_LIMIT_GUEST_TENANT_PER_MINUTE).toBeGreaterThan(
      env.PUBLIC_RATE_LIMIT_TENANT_PER_MINUTE,
    );
  });

  it("skips only staff POSTs that carry a staff session cookie", async () => {
    const staffCookie = `${siteConfig.id}.session_token=abc.def`;
    const staffPaths = ["confirm", "close", "move", "merge", "move-items"];
    const client = agent(
      createApp({ publicRateLimit: { perIp: 1, internalIps: [] } }),
    );
    for (const action of staffPaths) {
      for (let i = 0; i < 2; i += 1) {
        const res = await client
          .post(`${sessionPath()}/${action}`)
          .set("Host", hostname)
          .set("Cookie", staffCookie)
          .send({});
        expect(res.status, action).not.toBe(429);
      }
    }
    // The same POST without the cookie is charged to the IP bucket.
    const guestLike = () =>
      client.post(`${sessionPath()}/close`).set("Host", hostname).send({});
    expect((await guestLike()).status).not.toBe(429);
    expect((await guestLike()).status).toBe(429);
  });

  it("does not skip a staff cookie on a GET", async () => {
    const client = agent(
      createApp({ publicRateLimit: { perIp: 1, internalIps: [] } }),
    );
    const read = () =>
      client
        .get(sessionPath())
        .set("Host", hostname)
        .set("Cookie", `${siteConfig.id}.session_token=abc.def`);
    expect((await read()).status).not.toBe(429);
    expect((await read()).status).toBe(429);
  });

  it("a junk credential naming a victim's session id cannot lock the victim out", async () => {
    const client = agent(
      createApp({
        publicRateLimit: {
          perIp: 100_000,
          perTenant: 100_000,
          internalIps: [],
        },
      }),
    );
    const victimSession = randomUUID();
    const attack = () =>
      client
        .get(sessionPath(victimSession))
        .set("Host", hostname)
        .set("Authorization", `Bearer ${"j".repeat(43)}`);
    let blocked = 0;
    for (let i = 0; i < GUEST_SESSION_PER_MINUTE + 5; i += 1) {
      if ((await attack()).status === 429) blocked += 1;
    }
    // The attacker spends their own bucket...
    expect(blocked).toBe(5);
    // ...the table's real credential is untouched.
    const victim = await client
      .get(sessionPath(victimSession))
      .set("Host", hostname)
      .set("Authorization", `Bearer ${"v".repeat(43)}`);
    expect(victim.status).not.toBe(429);
  }, 60_000);

  it("default per-IP budget is sized for a venue NAT (10x the public read budget)", async () => {
    // Real defaults: a dining room of guests polling from one address must
    // not hit the public per-IP budget (600/min) within seconds.
    const client = agent(createApp({ publicRateLimit: { internalIps: [] } }));
    for (let i = 0; i < 30; i += 1) {
      const res = await client.get(sessionPath()).set("Host", hostname);
      expect(res.status).not.toBe(429);
    }
  });
});

describe("guest session routes run outlet scoped (legend-7csf)", () => {
  const ALL_DAY = [
    { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
  ];

  /** A real session in a fresh tenant, opened through the real scan. */
  async function seat() {
    const app = createApp();
    const isolated = await createIsolatedTenant(
      `s1-${randomUUID().slice(0, 6)}`,
    );
    const staff = await staffOfIsolatedTenant(app, isolated);
    const headers = { Host: isolated.hostname };
    const zone = await createZone(staff.client, { hours: ALL_DAY }, headers);
    const table = await createTable(staff.client, { zoneId: zone.id }, headers);
    const qr = await issueQr(staff.client, table.id, headers);
    seen.passthrough = true;
    const scanned = await scan(app, {
      token: qr.token,
      hostname: isolated.hostname,
    });
    expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
    seen.contexts.length = 0;
    return {
      app,
      isolated,
      sessionId: scanned.body.data.session.id as string,
      credential: scanned.body.data.sessionToken as string,
    };
  }

  it("legend-7csf reads and bills run in a context reaching only the session's outlet", async () => {
    const { app, isolated, sessionId, credential } = await seat();
    for (const path of ["", "/bill"]) {
      seen.contexts.length = 0;
      const res = await agent(app)
        .get(`/api/table-sessions/${sessionId}${path}`)
        .set("Host", isolated.hostname)
        .set("Authorization", `Bearer ${credential}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [context] = seen.contexts as Scoped[];
      expect(context.tenant.tenantId).toBe(isolated.tenantId);
      expect(context.outletScope.kind).toBe("outlets");
      expect(context.outletScope.outletIds).toEqual([isolated.outletId]);
    }
  });

  it("legend-7csf an unknown credential is 401 before any service runs", async () => {
    const { app, isolated, sessionId } = await seat();
    const res = await agent(app)
      .get(`/api/table-sessions/${sessionId}`)
      .set("Host", isolated.hostname)
      .set("Authorization", `Bearer ${"x".repeat(43)}`);
    expect(res.status).toBe(401);
    expect(seen.contexts).toEqual([]);
  });

  it("legend-7csf a credential of another tenant's session is 401 on this host", async () => {
    const first = await seat();
    const second = await seat();
    const res = await agent(first.app)
      .get(`/api/table-sessions/${second.sessionId}`)
      .set("Host", first.isolated.hostname)
      .set("Authorization", `Bearer ${second.credential}`);
    expect(res.status).toBe(401);
    expect(seen.contexts).toEqual([]);
  });

  it("legend-7csf the guest service request runs in a context reaching only the session's outlet", async () => {
    const { app, isolated, sessionId, credential } = await seat();
    const res = await agent(app)
      .post(`/api/table-sessions/${sessionId}/service-requests`)
      .set("Host", isolated.hostname)
      .set("Authorization", `Bearer ${credential}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [context] = seen.contexts as Scoped[];
    expect(context.tenant.tenantId).toBe(isolated.tenantId);
    expect(context.outletScope.kind).toBe("outlets");
    expect(context.outletScope.outletIds).toEqual([isolated.outletId]);
  });

  it("legend-7csf the guest service request with an unknown credential is 401 before the service runs", async () => {
    const { app, isolated, sessionId } = await seat();
    const res = await agent(app)
      .post(`/api/table-sessions/${sessionId}/service-requests`)
      .set("Host", isolated.hostname)
      .set("Authorization", `Bearer ${"x".repeat(43)}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(res.status).toBe(401);
    expect(seen.contexts).toEqual([]);
  });
});
