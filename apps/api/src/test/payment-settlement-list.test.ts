// C4b (legend-osqou.8): the outlet's imported settlement reports, read by the
// Duitku settlement import screen and the reconciliation panel. Contract: GET
// /api/payments/admin/reconciliation/settlements?outletId=... Same access as
// the import (payment.reconcile at the outlet), filtered by tenant and outlet
// in SQL, cursor-paginated newest first.
//
// Reports are seeded straight into the table (the import itself is covered by
// payment-settlement-import.test.ts) on business days in 2018, which no other
// test file uses, so the assertions only ever see this file's rows.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const LIST = "/api/payments/admin/reconciliation/settlements";
const PREFIX = `LST-${randomBytes(3).toString("hex")}`;
// The whole window this file seeds into.
const FROM = "2018-03-01";
const TO = "2018-03-31";

const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const userIds: string[] = [];
let manager: ReturnType<typeof agent>;
let scopedB: ReturnType<typeof agent>;
let warehouse: ReturnType<typeof agent>;

async function asTenant<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function member(
  template: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const client = agent(app);
  const email = await signUp(client, `Settlement list ${template}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, template],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      role.rows[0]!.id,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return client;
}

type Seed = {
  tenant?: string;
  outlet?: string;
  provider?: string;
  periodStart: string;
  periodEnd?: string;
  /** Amount of each (unmatched) line; the totals follow from them. */
  lines: number[];
  createdAt: string;
};

async function seed(o: Seed): Promise<string> {
  const tenant = o.tenant ?? tenantId;
  const outlet = o.outlet ?? outletA;
  const id = randomUUID();
  const gross = o.lines.reduce((sum, amount) => sum + amount, 0);
  const fee = o.lines.length * 700;
  await asTenant(tenant, async (c) => {
    await c.query(
      `INSERT INTO payment_settlements
         (id, tenant_id, outlet_id, source, provider, reference, period_start, period_end,
          gross_idr, fee_idr, net_idr, line_count, content_hash, imported_by, created_at)
       VALUES ($1, $2, $3, 'gateway', $4, $5, $6, $7, $8, $9, $10, $11, $12, 'seed', $13::timestamptz)`,
      [
        id,
        tenant,
        outlet,
        o.provider ?? "duitku",
        `${PREFIX}-${id.slice(0, 8)}`,
        o.periodStart,
        o.periodEnd ?? o.periodStart,
        gross,
        fee,
        gross - fee,
        o.lines.length,
        randomBytes(32).toString("hex"),
        o.createdAt,
      ],
    );
    for (const [index, amount] of o.lines.entries())
      await c.query(
        `INSERT INTO payment_settlement_lines
           (tenant_id, outlet_id, settlement_id, line_no, reference, amount_idr, fee_idr, match_status)
         VALUES ($1, $2, $3, $4, $5, $6, 700, 'unmatched')`,
        [tenant, outlet, id, index + 1, `L${index + 1}-${id}`, amount],
      );
  });
  return id;
}

const list = (
  client: ReturnType<typeof agent>,
  query: Record<string, string>,
) => client.get(LIST).set(originHeader).query(query);

const ids = (body: { data: { id: string }[] }) => body.data.map((r) => r.id);

let older: string; // outlet A, duitku, 3 Mar
let newer: string; // outlet A, duitku, 10-12 Mar
let doit: string; // outlet A, doit, 20 Mar
let ofB: string; // outlet B
let ofOther: string; // another tenant

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  manager = await member("owner", { type: "tenant" });
  scopedB = await member("owner", { type: "outlet", id: outletB });
  warehouse = await member("warehouse", { type: "outlet", id: outletA });
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Settlement list other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `setl-list-${otherTenant}`,
      JSON.stringify(cafeLegendPlatformFixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other')",
    [otherBrand, otherTenant, `brand-${otherBrand}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Other', false)",
    [otherLegal, otherTenant],
  );
  await owner.query(
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHERL', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
  older = await seed({
    periodStart: "2018-03-03",
    lines: [50_000, 25_000],
    createdAt: "2018-03-04T02:00:00Z",
  });
  newer = await seed({
    periodStart: "2018-03-10",
    periodEnd: "2018-03-12",
    lines: [120_000],
    createdAt: "2018-03-13T02:00:00Z",
  });
  doit = await seed({
    provider: "doit",
    periodStart: "2018-03-20",
    lines: [10_000],
    createdAt: "2018-03-21T02:00:00Z",
  });
  ofB = await seed({
    outlet: outletB,
    periodStart: "2018-03-10",
    lines: [99_000],
    createdAt: "2018-03-11T02:00:00Z",
  });
  ofOther = await seed({
    tenant: otherTenant,
    outlet: otherOutlet,
    periodStart: "2018-03-10",
    lines: [77_000],
    createdAt: "2018-03-11T03:00:00Z",
  });
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // a missing table must not hide the real (fail-first) test failures
    }
  };
  for (const tenant of [tenantId, otherTenant])
    await quiet(() =>
      asTenant(tenant, async (c) => {
        await c.query(
          "DELETE FROM payment_settlement_lines WHERE tenant_id = $1 AND settlement_id IN (SELECT id FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE $2)",
          [tenant, `${PREFIX}-%`],
        );
        await c.query(
          "DELETE FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE $2",
          [tenant, `${PREFIX}-%`],
        );
      }),
    );
  await quiet(() =>
    owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]),
  );
  await quiet(() =>
    owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]),
  );
  await quiet(() =>
    owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]),
  );
  await quiet(() =>
    owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [userIds],
    ),
  );
  await owner.end();
});

describe("C4b legend-osqou.8 settlement list", () => {
  it("lists the outlet's reports newest first with server totals and line counts", async () => {
    const response = await list(manager, {
      outletId: outletA,
      periodFrom: FROM,
      periodTo: TO,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(ids(response.body)).toEqual([doit, newer, older]);
    const first = response.body.data.find(
      (row: { id: string }) => row.id === older,
    );
    expect(first).toMatchObject({
      outletId: outletA,
      source: "gateway",
      provider: "duitku",
      terminalId: null,
      batchNo: null,
      periodStart: "2018-03-03",
      periodEnd: "2018-03-03",
      grossIdr: 75_000,
      feeIdr: 1_400,
      netIdr: 73_600,
      lineCount: 2,
      matchedLines: 0,
      mismatchLines: 0,
      unmatchedLines: 2,
      casesCreated: 0,
      createdAt: "2018-03-04T02:00:00.000Z",
    });
  });

  it("filters by provider, source and an overlapping period", async () => {
    const duitku = await list(manager, {
      outletId: outletA,
      provider: "duitku",
      periodFrom: FROM,
      periodTo: TO,
    });
    expect(ids(duitku.body)).toEqual([newer, older]);
    const edc = await list(manager, {
      outletId: outletA,
      source: "edc",
      periodFrom: FROM,
      periodTo: TO,
    });
    expect(ids(edc.body)).toEqual([]);
    // 11 Mar falls inside 10-12 Mar: the report overlaps the window.
    const overlap = await list(manager, {
      outletId: outletA,
      periodFrom: "2018-03-11",
      periodTo: "2018-03-11",
    });
    expect(ids(overlap.body)).toEqual([newer]);
    const reversed = await list(manager, {
      outletId: outletA,
      periodFrom: "2018-03-12",
      periodTo: "2018-03-10",
    });
    expect(reversed.status).toBe(422);
  });

  it("pages with an opaque cursor and refuses a forged one", async () => {
    const query = { outletId: outletA, periodFrom: FROM, periodTo: TO };
    const one = await list(manager, { ...query, limit: "2" });
    expect(ids(one.body)).toEqual([doit, newer]);
    expect(typeof one.body.meta.nextCursor).toBe("string");
    const two = await list(manager, {
      ...query,
      limit: "2",
      cursor: one.body.meta.nextCursor,
    });
    expect(ids(two.body)).toEqual([older]);
    expect(two.body.meta.nextCursor).toBeNull();
    const forged = await list(manager, {
      ...query,
      cursor: Buffer.from('["x","y"]').toString("base64url"),
    });
    expect(forged.status).toBe(422);
  });

  it("TEN-02 needs a session and an outlet", async () => {
    const anonymous = await agent(app)
      .get(LIST)
      .set(originHeader)
      .query({ outletId: outletA });
    expect(anonymous.status).toBe(401);
    const noOutlet = await list(manager, {});
    expect(noOutlet.status).toBe(422);
  });

  it("RBAC a member without payment.reconcile gets 403", async () => {
    const response = await list(warehouse, {
      outletId: outletA,
      periodFrom: FROM,
      periodTo: TO,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("TEN-03 an administrator of another outlet sees only that outlet", async () => {
    const denied = await list(scopedB, {
      outletId: outletA,
      periodFrom: FROM,
      periodTo: TO,
    });
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toContain(older);
    const own = await list(scopedB, {
      outletId: outletB,
      periodFrom: FROM,
      periodTo: TO,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(ids(own.body)).toEqual([ofB]);
  });

  it("TEN-01 another tenant's outlet and reports never show", async () => {
    const response = await list(manager, {
      outletId: otherOutlet,
      periodFrom: FROM,
      periodTo: TO,
    });
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(ofOther);
    const own = await list(manager, {
      outletId: outletA,
      periodFrom: FROM,
      periodTo: TO,
    });
    expect(ids(own.body)).not.toContain(ofOther);
    expect(ids(own.body)).not.toContain(ofB);
  });
});
