// Edge hardening for the staff pin down-sync (beads legend-wg5t items 5 and 8b,
// from legend-zinn). Complements test/staff-pin-sync.test.ts (legend-obh5).
//
// - Item 8b: GET /api/edge-sync/staff-pin-records is rate limited per client IP
//   and per presented credential BEFORE the credential check reads the database.
//   The limiter tests need no database: the verifier is a counting stub.
// - Item 5 (replaced by legend-t9ii): the export no longer has a settle window;
//   its release is commit-ordered, so no clock can release or hold a row.
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { TenantContext } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { mintEdgeCredential } from "../edge/credential.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { createStaffPinSyncRouter } from "../routes/staff-pin-sync.routes.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  listStaffPinRecordsSince,
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const path = "/api/edge-sync/staff-pin-records";

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

function nodeCredential(edgeNodeId: string = randomUUID()) {
  return {
    edgeNodeId,
    token: mintEdgeCredential({ tenantId, outletId: bandung, edgeNodeId })
      .token,
  };
}

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterEach(() => {
  setEdgeCredentialVerifier(null);
  vi.useRealTimers();
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

// ------------------------------------------------- legend-wg5t 8b rate limit

describe("legend-wg5t 8b staff pin sync rate limit (before credential check)", () => {
  function appWith(options: Parameters<typeof createStaffPinSyncRouter>[0]) {
    const app = express();
    app.use(path, createStaffPinSyncRouter(options));
    app.use(errorHandler);
    return app;
  }

  /** Counts verifier calls: a 429 must never reach it (it reads the database). */
  function countingVerifier() {
    const calls = { count: 0 };
    setEdgeCredentialVerifier(async () => {
      calls.count += 1;
      return null;
    });
    return calls;
  }

  it("answers 429 RATE_LIMITED with Retry-After and no-store per claimed node, without reaching the verifier, and leaves another node alone", async () => {
    const calls = countingVerifier();
    let clock = 1_000_000;
    const app = appWith({
      perIp: 1_000,
      perNode: 2,
      windowMs: 60_000,
      now: () => clock,
    });
    const a = nodeCredential();
    const b = nodeCredential();
    const get = (token: string) =>
      request(app).get(path).set("Authorization", `Bearer ${token}`);

    expect((await get(a.token)).status).toBe(401);
    expect((await get(a.token)).status).toBe(401);
    expect(calls.count).toBe(2);

    const limited = await get(a.token);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(calls.count).toBe(2);

    // A different node has its own budget.
    expect((await get(b.token)).status).toBe(401);
    expect(calls.count).toBe(3);

    // The window reopens.
    clock += 61_000;
    expect((await get(a.token)).status).toBe(401);
  });

  it("a forged bearer for a node's id cannot spend the real node's budget", async () => {
    countingVerifier();
    const app = appWith({ perIp: 1_000, perNode: 2, windowMs: 60_000 });
    const get = (token: string) =>
      request(app).get(path).set("Authorization", `Bearer ${token}`);
    const real = nodeCredential();
    // Same tenant, outlet and node id, wrong secret each time.
    for (let i = 0; i < 5; i += 1)
      expect((await get(nodeCredential(real.edgeNodeId).token)).status).toBe(
        401,
      );
    expect((await get(real.token)).status).toBe(401);
    expect((await get(real.token)).status).toBe(401);
    expect((await get(real.token)).status).toBe(429);
  });

  it("answers 429 per client IP across many node ids, even for bearers that do not parse", async () => {
    const calls = countingVerifier();
    const app = appWith({
      perIp: 3,
      perNode: 1_000,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (
          await request(app)
            .get(path)
            .set("Authorization", `Bearer ${nodeCredential().token}`)
        ).status,
      );
    expect(statuses).toEqual([401, 401, 401]);
    const limited = await request(app)
      .get(path)
      .set("Authorization", `Bearer edge-${randomUUID()}`);
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    const anonymous = await request(app).get(path);
    expect(anonymous.status).toBe(429);
    expect(calls.count).toBe(3);
  });
});

// ----------------------------------------------- legend-wg5t 5 settle on DB clock

describe("legend-wg5t 5 / legend-t9ii the export release does not depend on any clock", () => {
  const node: VerifiedEdgeNode = {
    tenantId,
    outletId: bandung,
    edgeNodeId: randomUUID(),
  };

  async function staffWithPin(): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf settle', $2)`,
      [id, `${id}@example.test`],
    );
    createdUserIds.push(id);
    const {
      rows: [role],
    } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
      [tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', $2)`,
      [tenantId, id, role!.id, bandung],
    );
    await setStaffPin(
      tenant,
      id,
      { outletId: bandung, userId: id },
      { pin: "582914" },
      { now: new Date() },
    );
    return id;
  }

  async function exported() {
    const rows: string[] = [];
    let since: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await listStaffPinRecordsSince(node, { since, limit: 100 });
      rows.push(...result.data.map((row) => row.userId));
      if (result.meta.nextCursor === null) break;
      since = result.meta.nextCursor;
    }
    return rows;
  }

  it("releases a row committed a moment ago whatever its updated_at says (no settle window)", async () => {
    const user = await staffWithPin();
    // A database clock stamp in the future would have held the row back
    // behind the old settle cutoff; the commit order does not care.
    await owner.query(
      `UPDATE staff_pins SET updated_at = now() + interval '1 hour'
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, user],
    );
    let listed: string[] = [];
    for (let attempt = 0; attempt < 50 && !listed.includes(user); attempt++) {
      // A transaction of another test file open right now only delays this.
      listed = await exported();
      if (!listed.includes(user))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(listed).toContain(user);
  });
});
