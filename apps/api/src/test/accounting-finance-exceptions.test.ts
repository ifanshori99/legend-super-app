// Finance exceptions list (bead legend-4oclu; brief
// docs/briefs/662-finance-exceptions-contract.md). Written fail-first from the
// brief, not from the implementation: GET /api/accounting/finance-exceptions
// does not exist yet. Real Better Auth, RLS and PostgreSQL on the disposable
// test DB. The real `apiRouter` is mounted on a small host app that pins the
// tenant (same pattern as accounting-cash-deposits.test.ts), so the suite
// needs no router export name and fails with 404 until the route is
// registered in routes/index.ts.
//
// Rows are seeded by direct inserts, all dated in March 2026 with a unique
// timestamp each (05:MM UTC = 12:MM in Jakarta, so every business-date
// reading gives the same day) and on outlets this file creates, so the exact
// counts are not disturbed by other suites sharing the DB. The payout kind has
// no outlet or date control (the posting is stamped now), so it is checked by
// batch id and by a before/after delta.
//
// Assumptions (the brief is silent, stated so they can be contested):
// - The body is the bare `{ summary, items, truncated }` of the brief; a
//   `{ data: ... }` envelope (the style of the cash-deposit routes) is read too.
// - `summary` only holds kinds that have rows (brief: "Tanpa data: array
//   kosong"); a missing kind is read as { count: 0, amountIdr: 0 }.
// - A null amount (order not found) adds nothing to the summary amount.
// - `occurredAt` of an edge ingest row is the ingest/order time; the tests give
//   the ingest row, the order and the business date the same instant.
// - `payload.orderId` of a parked event is the order ULID (as the events carry
//   it); the order row id is ulidToUuid(ULID).
// - Validation failures (missing/bad from or to, span over 92 days, unknown
//   kind) answer 400, like the other accounting list routes.
// - An outlet-scoped caller asking for an outlet outside its scope gets 200
//   with nothing ("outlet di luar scope tidak terlihat"), not 403.
// - The "finance" role template holds accounting.journal.view and may be
//   assigned at outlet scope (cash-deposit tests assign it that way); the
//   "cashier" template does not hold it.
// - The fee amount of a skipped payout fee is the fee total of the batch:
//   3 items x 5_000 (the same figure the fee journal books in
//   payroll-payout-hardening.test.ts).

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { apiRouter } from "../routes/index";
import { originHeader } from "./helpers";
import {
  ANDI,
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
} from "./payroll-payout-fixtures";

const W = installPayoutWorld("finexc");
const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const seedOutlet = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const PATH = "/api/accounting/finance-exceptions";

const host = express();
host.use(
  "/api",
  tenantContext({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
    fallback: async (req) => ({
      tenantId: req.get("x-test-tenant") ?? tenantId,
      brandId: null,
      source: "session" as const,
    }),
  }),
);
host.use("/api", apiRouter);
host.use(notFound);
host.use(errorHandler);

type Kind =
  | "edge_tax_unsnapshotted"
  | "edge_void_unsupported"
  | "edge_receipt_skipped"
  | "edge_link_dead_letter"
  | "payout_fee_not_posted"
  | "receipt_pending_stale";
const KINDS: Kind[] = [
  "edge_tax_unsnapshotted",
  "edge_void_unsupported",
  "edge_receipt_skipped",
  "edge_link_dead_letter",
  "payout_fee_not_posted",
];
type Item = {
  kind: Kind;
  outletId: string | null;
  occurredAt: string;
  refType: string;
  refId: string;
  amountIdr: number | null;
  detail: string | null;
};
type Payload = {
  summary: {
    kind: Kind;
    count: number;
    amountIdr: number;
    knownAmountCount: number;
  }[];
  items: Item[];
  truncated: boolean;
};

const SECRET = "RAHASIA-PAYLOAD-0812";
const MARCH = { from: "2026-03-01", to: "2026-03-31" };

// ---- plumbing -----------------------------------------------------------

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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const email = `fin-exc-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({
      name: "Finance exceptions",
      email,
      password: "Test-password-123!",
    });
  if (signUp.status !== 200) throw new Error(`Sign-up ${signUp.status}`);
  const cookie = (signUp.headers["set-cookie"] as unknown as string[])
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await request(authApp)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  return { cookie, userId: session.body.user.id as string };
}

async function assignTemplate(
  userId: string,
  templateKey: string,
  outletId: string | null = null,
) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id, outletId ? "outlet" : "tenant", outletId],
  );
}

async function newOutlet(label: string): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $3, 'Jl. Uji 1', 'Asia/Jakarta', opening_hours, 'active'
       FROM outlets WHERE tenant_id = $4 AND id = $5`,
      [
        id,
        `X${unique()}`.toUpperCase().slice(0, 12),
        label,
        tenantId,
        seedOutlet,
      ],
    ),
  );
  return id;
}

type OtherWorld = { tenant: string; outlet: string };
async function newOtherTenant(): Promise<OtherWorld> {
  const id = randomUUID();
  const brandId = randomUUID();
  const entityId = randomUUID();
  const outlet = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Finance exceptions other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `finexc-${unique()}`, tenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Lain', false)",
    [entityId, id],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Lain', 'Jl. Lain', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outlet, id, brandId, entityId, `L${unique()}`.toUpperCase()],
  );
  return { tenant: id, outlet };
}

const stamp = (day: string, hour: number, minute: number) =>
  `2026-03-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

async function seedNode(tenant: string, outlet: string): Promise<string> {
  const id = randomUUID();
  await asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
       VALUES ($1, $2, $3, 'primary', 'Mini PC uji pengecualian', $4)`,
      [id, tenant, outlet, randomBytes(32).toString("hex")],
    ),
  );
  return id;
}

type OrderSeed = {
  tenant: string;
  outlet: string;
  at: string;
  taxIdr: number;
  subtotalIdr?: number;
  ingest?: "ingested" | "refused" | null;
  snapshotRuleId?: string;
};
async function seedOrder(
  seed: OrderSeed,
): Promise<{ uuid: string; ulid: string; totalIdr: number }> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const subtotal = seed.subtotalIdr ?? 100_000;
  const total = subtotal + seed.taxIdr;
  await asTenant(seed.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
         'completed', $8::date, $9::timestamptz)`,
      [
        uuid,
        seed.tenant,
        seed.outlet,
        `FX-${unique()}${unique()}`,
        subtotal,
        seed.taxIdr,
        total,
        seed.at.slice(0, 10),
        seed.at,
      ],
    );
    if (seed.ingest)
      await client.query(
        `INSERT INTO edge_order_ingests
           (tenant_id, order_id, outlet_id, paid_event_id, state, reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
        [
          seed.tenant,
          uuid,
          seed.outlet,
          randomUUID(),
          seed.ingest,
          seed.ingest === "refused" ? "order_exists" : null,
          seed.at,
        ],
      );
    if (seed.snapshotRuleId)
      await client.query(
        `INSERT INTO tax_snapshots
           (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id,
            tax_rule_code, tax_rule_version, tax_type, rate_bp, price_includes_tax,
            gross_idr, tax_base_idr, service_charge_idr, tax_idr)
         VALUES ($1, $2, $3, 'order', $4, $5::date, $6, 'PBJT-FX', 1, 'pbjt', 1000,
           false, $7, $7, 0, $8)`,
        [
          randomUUID(),
          seed.tenant,
          seed.outlet,
          uuid,
          seed.at.slice(0, 10),
          seed.snapshotRuleId,
          subtotal,
          seed.taxIdr,
        ],
      );
  });
  return { uuid, ulid, totalIdr: total };
}

async function seedParked(
  tenant: string,
  outlet: string,
  lastFailedAt: string,
  errorCode: string,
  orderUlid: string,
) {
  await asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO auto_journal_parked
         (tenant_id, outlet_id, idempotency_key, event_id, event_name, payload,
          error_code, retryable, first_failed_at, last_failed_at, next_retry_at)
       VALUES ($1, $2, $3, $4, 'order.voided', $5::jsonb, $6, false,
         '2026-02-20T05:00:00Z', $7::timestamptz, NULL)`,
      [
        tenant,
        outlet,
        `aj:sale-void:${orderUlid}`,
        createUlid(),
        JSON.stringify({ orderId: orderUlid, customerPhone: SECRET }),
        errorCode,
        lastFailedAt,
      ],
    ),
  );
}

async function seedSkip(
  tenant: string,
  outlet: string,
  orderUuid: string,
  at: string,
) {
  await asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO edge_receipt_skips
         (tenant_id, outlet_id, order_id, receipt_number, reason, event_id, created_at)
       VALUES ($1, $2, $3, $4, 'uji_lewati', $5, $6::timestamptz)`,
      [tenant, outlet, orderUuid, `R-${unique()}`, randomUUID(), at],
    ),
  );
}

async function seedDeadLetter(
  tenant: string,
  outlet: string,
  node: string,
  at: string,
) {
  await asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO edge_link_dead_letters
         (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq,
          aggregate_type, aggregate_id, aggregate_sequence, bytes, reason, event, created_at)
       VALUES ($1, $2, $3, 'edge_to_cloud', $4, 1, 'order', $5, 1, 2000000,
         'frame_too_large', $6::jsonb, $7::timestamptz)`,
      [
        tenant,
        outlet,
        node,
        randomUUID(),
        randomUUID(),
        JSON.stringify({ customerPhone: SECRET }),
        at,
      ],
    ),
  );
}

/** `count` receipt skips on one outlet, one minute apart from `start`. */
async function seedManySkips(
  outlet: string,
  count: number,
  start: string,
  oldestOrderId: string = randomUUID(),
) {
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO edge_receipt_skips
         (tenant_id, outlet_id, order_id, receipt_number, reason, event_id, created_at)
       SELECT $1, $2, CASE WHEN n = 0 THEN $5::uuid ELSE gen_random_uuid() END, 'R-' || n::text, 'uji_lewati', gen_random_uuid(),
              $3::timestamptz + (n || ' minutes')::interval
         FROM generate_series(0, $4::int - 1) AS n`,
      [tenantId, outlet, start, count, oldestOrderId],
    ),
  );
}

// ---- HTTP ---------------------------------------------------------------

const get = (
  cookie: string,
  query: Record<string, string | undefined>,
  tenantHeader?: string,
) => {
  const call = request(host).get(PATH).set("Cookie", cookie).query(query);
  return tenantHeader ? call.set("x-test-tenant", tenantHeader) : call;
};
const payloadOf = (body: { data?: Payload } & Partial<Payload>): Payload =>
  (body.data ?? body) as Payload;
async function fetchList(
  cookie: string,
  query: Record<string, string | undefined>,
): Promise<Payload> {
  const response = await get(cookie, query);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return payloadOf(response.body);
}
const summaryOf = (payload: Payload, kind: Kind) => {
  const entry = payload.summary.find((row) => row.kind === kind);
  return { count: entry?.count ?? 0, amountIdr: entry?.amountIdr ?? 0 };
};
const itemsOfKind = (payload: Payload, kind: Kind) =>
  payload.items.filter((item) => item.kind === kind);
const instants = (items: Item[]) =>
  items.map((item) => new Date(item.occurredAt).toISOString()).sort();
const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

// ---- world --------------------------------------------------------------

let finance: { cookie: string; userId: string };
let scoped: { cookie: string; userId: string };
let cashier: { cookie: string; userId: string };
let nobody: { cookie: string; userId: string };
let outletA: string;
let outletB: string;
let outletEmpty: string;
let outletMany: string;
let outletExact: string;
let other: OtherWorld;
const seeded = {} as {
  taxA1: { uuid: string; totalIdr: number };
  taxA2: { uuid: string };
  taxB1: { uuid: string };
  taxOther: { uuid: string };
  orderForVoid: { uuid: string; totalIdr: number };
  otherOrder: { ulid: string };
  unsnapshottedUuids: string[];
  excludedUuids: string[];
};

const T = {
  a1: stamp("10", 5, 1),
  a2: stamp("10", 5, 2),
  b1: stamp("10", 6, 1),
  voidA1: stamp("12", 5, 1),
  voidA2: stamp("12", 5, 2),
  voidA3: stamp("12", 5, 4),
  voidB: stamp("12", 6, 1),
  skipA1: stamp("13", 5, 1),
  skipA2: stamp("13", 5, 2),
  skipB: stamp("13", 6, 1),
  deadA: stamp("14", 5, 1),
  deadB: stamp("14", 6, 1),
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  cashier = await signedIn();
  await assignTemplate(cashier.userId, "cashier");
  nobody = await signedIn();
  outletA = await newOutlet("Pengecualian A");
  outletB = await newOutlet("Pengecualian B");
  outletEmpty = await newOutlet("Pengecualian Kosong");
  outletMany = await newOutlet("Pengecualian 501");
  outletExact = await newOutlet("Pengecualian 500");
  scoped = await signedIn();
  await assignTemplate(scoped.userId, "finance", outletB);
  other = await newOtherTenant();

  const ruleId = randomUUID();
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, $3, 'pbjt uji', 'pbjt', 1000, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
    [ruleId, tenantId, `PBJT-FX-${unique()}`.toUpperCase(), finance.userId],
  );

  // Kind 1: edge orders with tax > 0 and no tax_snapshots row.
  const taxA1 = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: T.a1,
    taxIdr: 11_000,
    ingest: "ingested",
  });
  const taxA2 = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: T.a2,
    taxIdr: 3_000,
    ingest: "ingested",
  });
  const taxB1 = await seedOrder({
    tenant: tenantId,
    outlet: outletB,
    at: T.b1,
    taxIdr: 2_000,
    ingest: "ingested",
  });
  // Not listed: snapshot present, tax 0, ingest refused, not an edge order.
  const withSnapshot = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: stamp("10", 5, 3),
    taxIdr: 5_000,
    ingest: "ingested",
    snapshotRuleId: ruleId,
  });
  const zeroTax = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: stamp("10", 5, 4),
    taxIdr: 0,
    ingest: "ingested",
  });
  const refused = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: stamp("10", 5, 5),
    taxIdr: 4_000,
    ingest: "refused",
  });
  const notEdge = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: stamp("10", 5, 6),
    taxIdr: 9_000,
    ingest: null,
  });
  const taxOther = await seedOrder({
    tenant: other.tenant,
    outlet: other.outlet,
    at: stamp("10", 7, 1),
    taxIdr: 99_000,
    ingest: "ingested",
  });

  // Kinds 2 and 3 look an order total up.
  const orderForVoid = await seedOrder({
    tenant: tenantId,
    outlet: outletA,
    at: stamp("11", 5, 0),
    taxIdr: 0,
    subtotalIdr: 55_000,
    ingest: null,
  });
  const otherOrder = await seedOrder({
    tenant: other.tenant,
    outlet: other.outlet,
    at: stamp("11", 7, 0),
    taxIdr: 0,
    subtotalIdr: 777_000,
    ingest: null,
  });

  // Kind 2: only AUTO_JOURNAL_VOID_UNSUPPORTED rows count.
  await seedParked(
    tenantId,
    outletA,
    T.voidA1,
    "AUTO_JOURNAL_VOID_UNSUPPORTED",
    orderForVoid.ulid,
  );
  await seedParked(
    tenantId,
    outletA,
    T.voidA2,
    "AUTO_JOURNAL_VOID_UNSUPPORTED",
    createUlid(),
  );
  await seedParked(
    tenantId,
    outletA,
    stamp("12", 5, 3),
    "AUTO_JOURNAL_PAYLOAD_INVALID",
    createUlid(),
  );
  // The order belongs to another tenant: it must not be found, amount null.
  await seedParked(
    tenantId,
    outletA,
    T.voidA3,
    "AUTO_JOURNAL_VOID_UNSUPPORTED",
    otherOrder.ulid,
  );
  await seedParked(
    tenantId,
    outletB,
    T.voidB,
    "AUTO_JOURNAL_VOID_UNSUPPORTED",
    createUlid(),
  );
  await seedParked(
    other.tenant,
    other.outlet,
    stamp("12", 7, 1),
    "AUTO_JOURNAL_VOID_UNSUPPORTED",
    otherOrder.ulid,
  );

  // Kind 3: receipt skips.
  await seedSkip(tenantId, outletA, orderForVoid.uuid, T.skipA1);
  await seedSkip(tenantId, outletA, randomUUID(), T.skipA2);
  await seedSkip(tenantId, outletB, randomUUID(), T.skipB);
  await seedSkip(
    other.tenant,
    other.outlet,
    otherOrder.uuid,
    stamp("13", 7, 1),
  );

  // Kind 4: dead letters.
  const nodeA = await seedNode(tenantId, outletA);
  const nodeB = await seedNode(tenantId, outletB);
  const nodeOther = await seedNode(other.tenant, other.outlet);
  await seedDeadLetter(tenantId, outletA, nodeA, T.deadA);
  await seedDeadLetter(tenantId, outletB, nodeB, T.deadB);
  await seedDeadLetter(
    other.tenant,
    other.outlet,
    nodeOther,
    stamp("14", 7, 1),
  );

  // Truncation boundary: 501 rows are cut to 500, exactly 500 are not.
  const oldestKnown = await seedOrder({
    tenant: tenantId,
    outlet: outletMany,
    at: "2026-03-20T00:00:00Z",
    taxIdr: 0,
    subtotalIdr: 1_234,
  });
  await seedManySkips(
    outletMany,
    501,
    "2026-03-20T00:00:00Z",
    oldestKnown.uuid,
  );
  await seedManySkips(outletExact, 500, "2026-03-20T00:00:00Z");

  seeded.taxA1 = taxA1;
  seeded.taxA2 = taxA2;
  seeded.taxB1 = taxB1;
  seeded.taxOther = taxOther;
  seeded.orderForVoid = orderForVoid;
  seeded.otherOrder = otherOrder;
  seeded.unsnapshottedUuids = [taxA1.uuid, taxA2.uuid, taxB1.uuid];
  seeded.excludedUuids = [
    withSnapshot.uuid,
    zeroTax.uuid,
    refused.uuid,
    notEdge.uuid,
  ];
}, 120_000);

afterAll(async () => {
  // Orders, ingests, parked events and dead letters are append-only evidence,
  // so they stay in the disposable DB.
  await owner.end();
});

// ---- tests --------------------------------------------------------------

describe("finance-exceptions: access", () => {
  it("answers 401 without a session", async () => {
    const response = await request(host).get(PATH).query(MARCH);
    expect(response.status).toBe(401);
  });

  it("answers 403 to a signed-in user without accounting.journal.view", async () => {
    for (const user of [nobody, cashier]) {
      const response = await get(user.cookie, MARCH);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain("edge_");
    }
  });

  it("a finance user of tenant A sees nothing when asking as another tenant", async () => {
    const response = await get(finance.cookie, MARCH, other.tenant);
    expect(response.status).toBe(403);
  });
});

describe("finance-exceptions: validation", () => {
  it("requires both from and to", async () => {
    expect((await get(finance.cookie, { from: MARCH.from })).status).toBe(400);
    expect((await get(finance.cookie, { to: MARCH.to })).status).toBe(400);
    expect((await get(finance.cookie, {})).status).toBe(400);
  });

  it("refuses a malformed date, from after to, a span over 92 days and an unknown kind", async () => {
    expect(
      (await get(finance.cookie, { from: "10-03-2026", to: MARCH.to })).status,
    ).toBe(400);
    expect(
      (await get(finance.cookie, { from: "2026-03-31", to: "2026-03-01" }))
        .status,
    ).toBe(400);
    expect(
      (await get(finance.cookie, { from: "2026-01-01", to: "2026-04-05" }))
        .status,
    ).toBe(400);
    expect(
      (await get(finance.cookie, { ...MARCH, kind: "bukan_jenis" })).status,
    ).toBe(400);
  });

  it("refuses an outletId that is not a UUID", async () => {
    expect(
      (await get(finance.cookie, { ...MARCH, outletId: "outlet-1" })).status,
    ).toBe(400);
  });
});

describe("finance-exceptions: empty state", () => {
  it("returns empty arrays and truncated false when nothing matches", async () => {
    const payload = await fetchList(finance.cookie, {
      from: "2026-01-05",
      to: "2026-01-06",
      outletId: outletEmpty,
    });
    expect(payload.items).toEqual([]);
    expect(payload.summary.every((row) => row.count === 0)).toBe(true);
    expect(payload.truncated).toBe(false);
  });

  it("an outlet with no exceptions in a busy window is empty too", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletEmpty,
    });
    expect(payload.items).toEqual([]);
    expect(payload.truncated).toBe(false);
  });
});

describe("finance-exceptions: each kind lists its rows exactly once", () => {
  let payload: Payload;
  beforeAll(async () => {
    payload = await fetchList(finance.cookie, { ...MARCH, outletId: outletA });
  });

  it("edge_tax_unsnapshotted: edge orders with tax and no snapshot, valued at the order tax", async () => {
    const items = itemsOfKind(payload, "edge_tax_unsnapshotted");
    expect(instants(items)).toEqual([T.a1, T.a2].sort());
    const byOrder = new Map(items.map((item) => [item.refId, item]));
    expect(byOrder.get(seeded.taxA1.uuid)?.amountIdr).toBe(11_000);
    expect(byOrder.get(seeded.taxA2.uuid)?.amountIdr).toBe(3_000);
    // Old rows have no tax_flag: no detail.
    for (const item of items) expect(item.detail).toBeNull();
    for (const excluded of seeded.excludedUuids)
      expect(items.map((item) => item.refId)).not.toContain(excluded);
    expect(summaryOf(payload, "edge_tax_unsnapshotted")).toEqual({
      count: 2,
      amountIdr: 14_000,
    });
  });

  it("edge_void_unsupported: only the unsupported-void parked rows, valued at the order total (null when the order is not found)", async () => {
    const items = itemsOfKind(payload, "edge_void_unsupported");
    expect(instants(items)).toEqual([T.voidA1, T.voidA2, T.voidA3].sort());
    const at = (instant: string) =>
      items.find((item) => new Date(item.occurredAt).toISOString() === instant);
    expect(at(T.voidA1)?.amountIdr).toBe(seeded.orderForVoid.totalIdr);
    expect(at(T.voidA2)?.amountIdr).toBeNull();
    // The order id belongs to another tenant: not found here, so null.
    expect(at(T.voidA3)?.amountIdr).toBeNull();
    expect(summaryOf(payload, "edge_void_unsupported")).toEqual({
      count: 3,
      amountIdr: seeded.orderForVoid.totalIdr,
    });
  });

  it("edge_receipt_skipped: amount is the order total when the order exists, else null", async () => {
    const items = itemsOfKind(payload, "edge_receipt_skipped");
    expect(instants(items)).toEqual([T.skipA1, T.skipA2].sort());
    const at = (instant: string) =>
      items.find((item) => new Date(item.occurredAt).toISOString() === instant);
    expect(at(T.skipA1)?.amountIdr).toBe(seeded.orderForVoid.totalIdr);
    expect(at(T.skipA2)?.amountIdr).toBeNull();
    expect(summaryOf(payload, "edge_receipt_skipped")).toEqual({
      count: 2,
      amountIdr: seeded.orderForVoid.totalIdr,
    });
  });

  it("edge_link_dead_letter: listed with a null amount", async () => {
    const items = itemsOfKind(payload, "edge_link_dead_letter");
    expect(instants(items)).toEqual([T.deadA]);
    expect(items[0]!.amountIdr).toBeNull();
    expect(summaryOf(payload, "edge_link_dead_letter")).toEqual({
      count: 1,
      amountIdr: 0,
    });
  });

  it("every item carries only the documented fields, in this outlet, ordered by occurredAt descending", async () => {
    expect(payload.items.length).toBe(2 + 3 + 2 + 1);
    for (const item of payload.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "amountIdr",
          "detail",
          "kind",
          "occurredAt",
          "outletId",
          "refId",
          "refType",
        ].sort(),
      );
      expect(item.outletId).toBe(outletA);
      expect(item.refType.length).toBeGreaterThan(0);
      expect(item.refId.length).toBeGreaterThan(0);
    }
    const times = payload.items.map((item) =>
      new Date(item.occurredAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const keys = payload.items.map(
      (item) => `${item.kind}|${item.refType}|${item.refId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns no raw payload or personal data", async () => {
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it("a tax-flag detail (tax_missing / tax_mismatch) is passed through as the item detail", async () => {
    const outlet = await newOutlet("Pengecualian Flag");
    const missing = await seedOrder({
      tenant: tenantId,
      outlet,
      at: stamp("15", 5, 1),
      taxIdr: 1_500,
      ingest: "ingested",
    });
    const mismatch = await seedOrder({
      tenant: tenantId,
      outlet,
      at: stamp("15", 5, 2),
      taxIdr: 2_500,
      ingest: "ingested",
    });
    await asTenant(tenantId, async (client) => {
      for (const [uuid, flag] of [
        [missing.uuid, "tax_missing"],
        [mismatch.uuid, "tax_mismatch"],
      ] as const)
        await client.query(
          "UPDATE edge_order_ingests SET tax_flag = $3 WHERE tenant_id = $1 AND order_id = $2",
          [tenantId, uuid, flag],
        );
    });
    const flagged = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outlet,
      kind: "edge_tax_unsnapshotted",
    });
    const detailOf = (uuid: string) =>
      flagged.items.find((item) => item.refId === uuid)?.detail;
    expect(detailOf(missing.uuid)).toBe("tax_missing");
    expect(detailOf(mismatch.uuid)).toBe("tax_mismatch");
  });
});

describe("finance-exceptions: known summary amounts", () => {
  it.each([
    ["edge_link_dead_letter", "a", 1, 0, 0],
    ["edge_receipt_skipped", "b", 1, 0, 0],
    ["edge_void_unsupported", "b", 1, 0, 0],
    ["edge_receipt_skipped", "a", 2, 1, null],
    ["edge_void_unsupported", "a", 3, 1, null],
    ["edge_tax_unsnapshotted", "a", 2, 2, 14_000],
  ] as const)(
    "%s outlet %s counts only known amounts and preserves totals",
    async (kind, outlet, count, knownAmountCount, amount) => {
      const payload = await fetchList(finance.cookie, {
        ...MARCH,
        outletId: outlet === "a" ? outletA : outletB,
        kind,
      });
      expect(payload.summary).toEqual([
        {
          kind,
          count,
          amountIdr: amount ?? seeded.orderForVoid.totalIdr,
          knownAmountCount,
        },
      ]);
    },
  );

  it("zero is known for both SQL and resolved-order summaries", async () => {
    const outlet = await newOutlet("Pengecualian nilai nol");
    const at = stamp("16", 5, 1);
    const order = await seedOrder({
      tenant: tenantId,
      outlet,
      at,
      taxIdr: 0,
      subtotalIdr: 0,
    });
    await seedSkip(tenantId, outlet, order.uuid, at);
    await seedParked(
      tenantId,
      outlet,
      at,
      "AUTO_JOURNAL_VOID_UNSUPPORTED",
      order.ulid,
    );
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outlet,
    });
    for (const kind of ["edge_receipt_skipped", "edge_void_unsupported"]) {
      expect(payload.summary.find((row) => row.kind === kind)).toEqual({
        kind,
        count: 1,
        amountIdr: 0,
        knownAmountCount: 1,
      });
    }
    expect(payload.items.every((item) => item.amountIdr === 0)).toBe(true);
  });
});

describe("finance-exceptions: tenant-wide view and summary", () => {
  it("without an outlet filter both outlets appear once each; summary equals the full counts", async () => {
    // Window ends before the 20th: the bulk skips seeded for the truncation
    // tests (1001 rows on that day) would otherwise fill the 500-item cap.
    const payload = await fetchList(finance.cookie, {
      from: "2026-03-01",
      to: "2026-03-19",
    });
    const mine = payload.items.filter(
      (item) => item.outletId === outletA || item.outletId === outletB,
    );
    expect(mine.length).toBe(8 + 4);
    const keys = payload.items.map(
      (item) => `${item.kind}|${item.refType}|${item.refId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    // The other tenant's rows are never present, whatever the window.
    expect(payload.items.some((item) => item.outletId === other.outlet)).toBe(
      false,
    );
    expect(payload.items.map((item) => item.refId)).not.toContain(
      seeded.taxOther.uuid,
    );
    expect(
      summaryOf(payload, "edge_tax_unsnapshotted").count,
    ).toBeGreaterThanOrEqual(3);
    expect(
      summaryOf(payload, "edge_tax_unsnapshotted").amountIdr,
    ).toBeGreaterThanOrEqual(16_000);
  });

  it("the other tenant's amounts never leak into tenant A's summary", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      kind: "edge_tax_unsnapshotted",
    });
    // 99_000 is the other tenant's order tax; tenant A's total is far lower.
    expect(payload.items.map((item) => item.amountIdr)).not.toContain(99_000);
    expect(payload.items.map((item) => item.outletId)).not.toContain(
      other.outlet,
    );
  });

  it("asking for another tenant's outlet returns nothing", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: other.outlet,
    });
    expect(payload.items).toEqual([]);
    expect(payload.summary.every((row) => row.count === 0)).toBe(true);
  });
});

describe("finance-exceptions: filters", () => {
  it("kind keeps one kind in items and in the summary", async () => {
    for (const kind of KINDS.slice(0, 4)) {
      const payload = await fetchList(finance.cookie, {
        ...MARCH,
        outletId: outletA,
        kind,
      });
      expect(payload.items.length).toBeGreaterThan(0);
      expect(payload.items.every((item) => item.kind === kind)).toBe(true);
      expect(
        payload.summary.filter((row) => row.count > 0).map((row) => row.kind),
      ).toEqual([kind]);
    }
  });

  it("outletId keeps that outlet only, and the two outlets partition the rows", async () => {
    const a = await fetchList(finance.cookie, { ...MARCH, outletId: outletA });
    const b = await fetchList(finance.cookie, { ...MARCH, outletId: outletB });
    expect(a.items.every((item) => item.outletId === outletA)).toBe(true);
    expect(b.items.every((item) => item.outletId === outletB)).toBe(true);
    expect(a.items.length).toBe(8);
    expect(b.items.length).toBe(4);
    expect(summaryOf(b, "edge_tax_unsnapshotted")).toEqual({
      count: 1,
      amountIdr: 2_000,
    });
    expect(summaryOf(b, "edge_void_unsupported")).toEqual({
      count: 1,
      amountIdr: 0,
    });
    expect(summaryOf(b, "edge_receipt_skipped")).toEqual({
      count: 1,
      amountIdr: 0,
    });
    expect(summaryOf(b, "edge_link_dead_letter")).toEqual({
      count: 1,
      amountIdr: 0,
    });
  });

  it("from and to are inclusive business dates and filter every kind", async () => {
    const onlySkips = await fetchList(finance.cookie, {
      from: "2026-03-13",
      to: "2026-03-13",
      outletId: outletA,
    });
    expect(onlySkips.items.map((item) => item.kind)).toEqual([
      "edge_receipt_skipped",
      "edge_receipt_skipped",
    ]);
    expect(summaryOf(onlySkips, "edge_receipt_skipped").count).toBe(2);
    expect(summaryOf(onlySkips, "edge_tax_unsnapshotted").count).toBe(0);

    const fromTenth = await fetchList(finance.cookie, {
      from: "2026-03-10",
      to: "2026-03-12",
      outletId: outletA,
    });
    expect(new Set(fromTenth.items.map((item) => item.kind))).toEqual(
      new Set(["edge_tax_unsnapshotted", "edge_void_unsupported"]),
    );
    expect(fromTenth.items.length).toBe(2 + 3);

    const quiet = await fetchList(finance.cookie, {
      from: "2026-03-15",
      to: "2026-03-19",
      outletId: outletA,
    });
    expect(quiet.items).toEqual([]);
  });

  it("a parked event is dated by its last failure, not its first", async () => {
    // first_failed_at is 2026-02-20 for every parked row; the last failure is in March.
    const february = await fetchList(finance.cookie, {
      from: "2026-02-15",
      to: "2026-02-25",
      outletId: outletA,
      kind: "edge_void_unsupported",
    });
    expect(february.items).toEqual([]);
  });
});

describe("finance-exceptions: truncation", () => {
  const day = { from: "2026-03-20", to: "2026-03-20" };

  it("501 rows: items are cut to the newest 500, truncated is true, summary counts all 501", async () => {
    const payload = await fetchList(finance.cookie, {
      ...day,
      outletId: outletMany,
    });
    expect(payload.items.length).toBe(500);
    expect(payload.truncated).toBe(true);
    expect(payload.summary).toEqual([
      {
        kind: "edge_receipt_skipped",
        count: 501,
        amountIdr: 1_234,
        knownAmountCount: 1,
      },
    ]);
    expect(payload.items.every((item) => item.amountIdr === null)).toBe(true);
    const times = payload.items.map((item) =>
      new Date(item.occurredAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The oldest row (minute 0) is the one that was cut.
    const oldest = new Date("2026-03-20T00:00:00Z").getTime();
    expect(Math.min(...times)).toBeGreaterThan(oldest);
    expect(Math.max(...times)).toBe(oldest + 500 * 60_000);
  });

  it("exactly 500 rows: nothing is cut and truncated is false", async () => {
    const payload = await fetchList(finance.cookie, {
      ...day,
      outletId: outletExact,
    });
    expect(payload.items.length).toBe(500);
    expect(payload.truncated).toBe(false);
    expect(summaryOf(payload, "edge_receipt_skipped").count).toBe(500);
  });

  it("a small result is not truncated", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletB,
    });
    expect(payload.truncated).toBe(false);
  });
});

describe("finance-exceptions: outlet scope", () => {
  it("an outlet-scoped caller sees only its outlet", async () => {
    const payload = await fetchList(scoped.cookie, MARCH);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items.every((item) => item.outletId === outletB)).toBe(true);
    expect(payload.items.length).toBe(4);
    expect(summaryOf(payload, "edge_tax_unsnapshotted")).toEqual({
      count: 1,
      amountIdr: 2_000,
    });
    expect(payload.items.map((item) => item.refId)).not.toContain(
      seeded.taxA1.uuid,
    );
  });

  it("asking for an outlet outside the scope shows nothing", async () => {
    const payload = await fetchList(scoped.cookie, {
      ...MARCH,
      outletId: outletA,
    });
    expect(payload.items).toEqual([]);
    expect(payload.summary.every((row) => row.count === 0)).toBe(true);
    expect(payload.truncated).toBe(false);
  });

  it("summary of a scoped caller is computed over its outlets only", async () => {
    const payload = await fetchList(scoped.cookie, {
      ...MARCH,
      kind: "edge_receipt_skipped",
    });
    expect(summaryOf(payload, "edge_receipt_skipped").count).toBe(1);
  });
});

describe("finance-exceptions: payout_fee_not_posted", () => {
  const BUDI_NET = 4_250_000;
  const SITI_NET = 3_100_500;
  const ANDI_NET = 5_000_001;
  const FEE_TOTAL = 3 * 5_000;
  const slips = () => [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const MAPPING_WHERE = `tenant_id = $1 AND legal_entity_id = $2 AND role = 'bank_charges'`;

  async function exportedRun() {
    const list = slips();
    const runId = await W.seedRun(list);
    await W.postLockedJournal(runId, list);
    const batchId = await W.exportedBatch(runId);
    const items = (await W.itemsOf(batchId)).filter(
      (item) => item.status === "exported",
    );
    return { batchId, items };
  }

  /** Removes the bank_charges mapping; returns the function that puts it back. */
  async function breakMapping() {
    const [mapping] = await W.rowsOf(
      `SELECT account_id FROM account_mappings WHERE ${MAPPING_WHERE}`,
      [W.tenantId, W.entityId()],
    );
    expect(mapping, "premise: the fixture maps bank charges").toBeDefined();
    await W.asTenant(
      (c) =>
        c.query(`DELETE FROM account_mappings WHERE ${MAPPING_WHERE}`, [
          W.tenantId,
          W.entityId(),
        ]),
      true,
    );
    return () =>
      W.asTenant(
        (c) =>
          c.query(
            `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
             VALUES ($1, $2, 'bank_charges', $3)`,
            [W.tenantId, W.entityId(), mapping!.account_id],
          ),
        true,
      );
  }

  it("lists a settled batch whose fee was skipped, once, valued at the fee; a batch with the fee posted is not listed", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const window = { from: addDays(today, -2), to: addDays(today, 2) };
    const query = { ...window, kind: "payout_fee_not_posted" };
    const before = await fetchList(finance.cookie, query);
    const scopedBefore = await fetchList(scoped.cookie, query);

    const posted = await exportedRun();
    await W.confirm(
      posted.batchId,
      W.succeedItems(posted.batchId, posted.items),
    );
    const skipped = await exportedRun();
    const restore = await breakMapping();
    try {
      await W.confirm(
        skipped.batchId,
        W.succeedItems(skipped.batchId, skipped.items),
      );
    } finally {
      await restore();
    }
    const [skippedPosting] = await W.postingsOf(skipped.batchId);
    expect(skippedPosting!.fee_posted, "premise").toBe(false);

    const after = await fetchList(finance.cookie, query);
    const mine = after.items.filter((item) => item.detail === skipped.batchId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.kind).toBe("payout_fee_not_posted");
    expect(mine[0]!.amountIdr).toBe(FEE_TOTAL);
    expect(after.items.map((item) => item.detail)).not.toContain(
      posted.batchId,
    );
    expect(after.truncated).toBe(false);
    expect(summaryOf(after, "payout_fee_not_posted").count).toBe(
      summaryOf(before, "payout_fee_not_posted").count + 1,
    );
    expect(summaryOf(after, "payout_fee_not_posted").amountIdr).toBe(
      summaryOf(before, "payout_fee_not_posted").amountIdr + FEE_TOTAL,
    );
    expect(
      after.summary.find((row) => row.kind === "payout_fee_not_posted")
        ?.knownAmountCount,
    ).toBe(
      (before.summary.find((row) => row.kind === "payout_fee_not_posted")
        ?.knownAmountCount ?? 0) + 1,
    );

    // No amount of money or bank data beyond the fee leaks into the row.
    expect(JSON.stringify(mine[0])).not.toContain(String(BUDI_NET));

    // Without a kind filter the payout kind is part of the mixed list.
    const mixed = await fetchList(finance.cookie, window);
    expect(mixed.items.some((item) => item.detail === skipped.batchId)).toBe(
      true,
    );

    // The posting has no outlet: an outletId filter leaves it out ...
    const forOutlet = await fetchList(finance.cookie, {
      ...query,
      outletId: outletA,
    });
    expect(forOutlet.items.map((item) => item.detail)).not.toContain(
      skipped.batchId,
    );

    // ... and a caller limited to an outlet does not see tenant-wide rows.
    const scopedAfter = await fetchList(scoped.cookie, query);
    expect(scopedAfter.items.map((item) => item.detail)).not.toContain(
      skipped.batchId,
    );
    expect(summaryOf(scopedAfter, "payout_fee_not_posted")).toEqual(
      summaryOf(scopedBefore, "payout_fee_not_posted"),
    );

    // Outside its date the row is not listed.
    const lastYear = await fetchList(finance.cookie, {
      from: "2025-03-01",
      to: "2025-03-31",
      kind: "payout_fee_not_posted",
    });
    expect(lastYear.items.map((item) => item.detail)).not.toContain(
      skipped.batchId,
    );
  }, 120_000);
});

// legend-z13t: parked AUTO_JOURNAL_RECEIPT_PENDING auto-journals that wait for
// their payment.paid receipt for more than one day. Written fail-first from
// docs/briefs/845-finance-view-access.md, not from the implementation.
// Assumptions (the brief is silent on the exact item shape):
// - kind is `receipt_pending_stale`; the item keeps the documented 7 fields
//   and may add more (the brief only says to include order id, intent id,
//   amount and outbox state, not where they live).
// - Where order id, intent id and outbox state sit in the item is not
//   asserted: the serialized item must contain the order id (ULID or its uuid
//   form), the intent id, and a state word ("pending" while the event waits in
//   the outbox, "dead" for a dead-lettered one).
// - amountIdr is the amount of the payment intent.
// - The parked payload carries the order id (ULID) and the intent id.
// - Stale means first_failed_at older than one day; the from/to window does
//   not filter this kind (a March window still lists a row parked this week).
describe("finance-exceptions: receipt_pending_stale", () => {
  const KIND = "receipt_pending_stale" as const;
  type Parked = {
    intentId: string;
    orderUlid: string;
    amountIdr: number;
    outlet: string;
    tenant: string;
  };
  const made: Parked[] = [];
  let outletStale: string;
  let outletOther: string;
  let outletNone: string;
  let pendingStale: Parked;
  let deadStale: Parked;
  let fresh: Parked;
  let otherCode: Parked;
  let foreignOutletRow: Parked;
  let foreignTenantRow: Parked;

  async function seedIntentRow(
    tenant: string,
    outlet: string,
    amountIdr: number,
  ): Promise<string> {
    const linkId = randomUUID();
    const intentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
      [
        linkId,
        tenant,
        outlet,
        randomBytes(32).toString("hex"),
        `RP-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
          status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(),
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [intentId, tenant, outlet, linkId, amountIdr, `rp-${intentId}`],
    );
    return intentId;
  }

  async function seedStale(opts: {
    tenant?: string;
    outlet: string;
    amountIdr: number;
    ageHours: number;
    errorCode?: string;
    outbox: "pending" | "dead";
  }): Promise<Parked> {
    const tenant = opts.tenant ?? tenantId;
    const intentId = await seedIntentRow(tenant, opts.outlet, opts.amountIdr);
    const orderUlid = createUlid();
    await asTenant(tenant, async (client) => {
      const outboxId = randomUUID();
      await client.query(
        `INSERT INTO domain_event_outbox
           (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
         VALUES ($1, $2, $3, $4, 'payment', $5, 1, $6, 'cloud-sync')`,
        [
          tenant,
          outboxId,
          opts.outlet,
          randomUUID(),
          intentId,
          // The table check ties the event to its row's tenant, outlet,
          // aggregate type and sequence.
          JSON.stringify({
            id: createUlid(),
            tenantId: tenant,
            outletId: opts.outlet,
            name: "payment.paid",
            aggregateType: "payment",
            aggregateId: intentId,
            sequence: 1,
            payload: { intentId, receivedIdr: opts.amountIdr },
          }),
        ],
      );
      if (opts.outbox === "dead")
        await client.query(
          `UPDATE domain_event_outbox
              SET dispatch_state = 'dead', dead_lettered_at = now() - interval '10 days'
            WHERE tenant_id = $1 AND id = $2`,
          [tenant, outboxId],
        );
      await client.query(
        `INSERT INTO auto_journal_parked
           (tenant_id, outlet_id, idempotency_key, event_id, event_name, payload,
            error_code, retryable, first_failed_at, last_failed_at, next_retry_at)
         VALUES ($1, $2, $3, $4, 'order.paid', $5::jsonb, $6, true,
           now() - make_interval(hours => $7::int), now(), now() + interval '1 hour')`,
        [
          tenant,
          opts.outlet,
          `aj:sale:${orderUlid}`,
          createUlid(),
          JSON.stringify({
            orderId: orderUlid,
            intentId,
            customerPhone: SECRET,
          }),
          opts.errorCode ?? "AUTO_JOURNAL_RECEIPT_PENDING",
          opts.ageHours,
        ],
      );
    });
    const row = {
      intentId,
      orderUlid,
      amountIdr: opts.amountIdr,
      outlet: opts.outlet,
      tenant,
    };
    made.push(row);
    return row;
  }

  const refIdMatches = (item: Item, row: Parked) => {
    const text = JSON.stringify(item);
    return [row.orderUlid, ulidToUuid(row.orderUlid), row.intentId].some((id) =>
      text.includes(id),
    );
  };
  const itemFor = (items: Item[], row: Parked) =>
    items.find((item) => refIdMatches(item, row));

  beforeAll(async () => {
    outletStale = await newOutlet("Resi tertunda basi");
    outletOther = await newOutlet("Resi tertunda lain");
    outletNone = await newOutlet("Resi tertunda kosong");
    pendingStale = await seedStale({
      outlet: outletStale,
      amountIdr: 110_000,
      ageHours: 48,
      outbox: "pending",
    });
    deadStale = await seedStale({
      outlet: outletStale,
      amountIdr: 55_000,
      ageHours: 72,
      outbox: "dead",
    });
    fresh = await seedStale({
      outlet: outletStale,
      amountIdr: 33_000,
      ageHours: 12,
      outbox: "pending",
    });
    otherCode = await seedStale({
      outlet: outletStale,
      amountIdr: 44_000,
      ageHours: 96,
      errorCode: "AUTO_JOURNAL_RECEIPT_MISSING",
      outbox: "pending",
    });
    foreignOutletRow = await seedStale({
      outlet: outletOther,
      amountIdr: 22_000,
      ageHours: 50,
      outbox: "pending",
    });
    const otherWorld = await newOtherTenant();
    foreignTenantRow = await seedStale({
      tenant: otherWorld.tenant,
      outlet: otherWorld.outlet,
      amountIdr: 99_000,
      ageHours: 60,
      outbox: "pending",
    });
  }, 60_000);

  afterAll(async () => {
    const intents = made.map((row) => row.intentId);
    await owner.query(
      "DELETE FROM domain_event_outbox WHERE aggregate_id = ANY($1::uuid[])",
      [intents],
    );
    await owner.query(
      "DELETE FROM auto_journal_parked WHERE idempotency_key = ANY($1::text[])",
      [made.map((row) => `aj:sale:${row.orderUlid}`)],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intents],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE reference LIKE 'RP-%' AND created_by = 'seed' AND id NOT IN (SELECT payment_link_id FROM payment_intents)",
    );
  });

  it("lists a receipt pending for over a day with order, intent, amount and outbox state, and leaves out fresh or other-code rows", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletStale,
    });
    const items = itemsOfKind(payload, KIND);
    expect(items).toHaveLength(2);

    const pending = itemFor(items, pendingStale)!;
    expect(pending, "stale pending receipt is listed").toBeDefined();
    expect(pending.outletId).toBe(outletStale);
    expect(pending.amountIdr).toBe(110_000);
    const pendingText = JSON.stringify(pending);
    expect(pendingText).toContain(pendingStale.intentId);
    expect(
      pendingText.includes(pendingStale.orderUlid) ||
        pendingText.includes(ulidToUuid(pendingStale.orderUlid)),
      "the order id is in the item",
    ).toBe(true);
    expect(pendingText).toMatch(/pending/i);

    const dead = itemFor(items, deadStale)!;
    expect(dead, "stale dead-lettered receipt is listed").toBeDefined();
    expect(dead.amountIdr).toBe(55_000);
    const deadText = JSON.stringify(dead);
    expect(deadText).toContain(deadStale.intentId);
    expect(deadText).toMatch(/dead/i);

    expect(itemFor(items, fresh)).toBeUndefined();
    expect(itemFor(items, otherCode)).toBeUndefined();
    expect(JSON.stringify(payload.items)).not.toContain(SECRET);
    expect(summaryOf(payload, KIND)).toEqual({
      count: 2,
      amountIdr: 110_000 + 55_000,
    });
    // The documented fields stay on every item.
    for (const item of items)
      expect(Object.keys(item)).toEqual(
        expect.arrayContaining([
          "amountIdr",
          "detail",
          "kind",
          "occurredAt",
          "outletId",
          "refId",
          "refType",
        ]),
      );
  });

  it("the kind filter is accepted and keeps only this kind", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletStale,
      kind: KIND,
    });
    expect(payload.items.length).toBe(2);
    expect(payload.items.every((item) => item.kind === KIND)).toBe(true);
  });

  it("is not limited by the from/to window: a row parked this week shows under an old window", async () => {
    const old = await fetchList(finance.cookie, {
      from: "2025-01-01",
      to: "2025-01-31",
      outletId: outletStale,
      kind: KIND,
    });
    expect(old.items).toHaveLength(2);
  });

  it("an outlet with no stale receipt shows an empty list and a zero summary", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletNone,
      kind: KIND,
    });
    expect(payload.items).toEqual([]);
    expect(summaryOf(payload, KIND)).toEqual({ count: 0, amountIdr: 0 });
    expect(payload.truncated).toBe(false);
  });

  it("the outletId filter partitions rows by outlet", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletOther,
      kind: KIND,
    });
    expect(payload.items).toHaveLength(1);
    expect(itemFor(payload.items, foreignOutletRow)).toBeDefined();
    expect(itemFor(payload.items, pendingStale)).toBeUndefined();
  });

  it("an outlet-scoped caller never sees a stale receipt of an outlet outside its scope", async () => {
    // `scoped` is finance on outletB only; both seeded outlets are outside it.
    const payload = await fetchList(scoped.cookie, { ...MARCH, kind: KIND });
    for (const row of [pendingStale, deadStale, foreignOutletRow])
      expect(itemFor(payload.items, row)).toBeUndefined();
    const asked = await fetchList(scoped.cookie, {
      ...MARCH,
      kind: KIND,
      outletId: outletStale,
    });
    expect(asked.items).toEqual([]);
    expect(summaryOf(asked, KIND)).toEqual({ count: 0, amountIdr: 0 });
  });

  it("another tenant's stale receipt never shows in tenant A, items or summary", async () => {
    const payload = await fetchList(finance.cookie, { ...MARCH, kind: KIND });
    expect(itemFor(payload.items, foreignTenantRow)).toBeUndefined();
    expect(payload.items.map((item) => item.amountIdr)).not.toContain(99_000);
  });

  it("is denied without accounting.journal.view and without a session", async () => {
    const asCashier = await get(cashier.cookie, { ...MARCH, kind: KIND });
    expect(asCashier.status).toBe(403);
    const anonymous = await request(host)
      .get(PATH)
      .query({ ...MARCH, kind: KIND });
    expect(anonymous.status).toBe(401);
  });

  it("is read-only: listing changes no parked row, outbox row, intent or journal", async () => {
    const snapshot = async () => {
      const intents = made.map((row) => row.intentId);
      const keys = made.map((row) => `aj:sale:${row.orderUlid}`);
      const [parked, outbox, paid, journals] = await Promise.all([
        owner.query(
          "SELECT idempotency_key, error_code, retryable, first_failed_at, last_failed_at, next_retry_at FROM auto_journal_parked WHERE idempotency_key = ANY($1::text[]) ORDER BY idempotency_key",
          [keys],
        ),
        owner.query(
          "SELECT id, status, dispatch_state, dead_lettered_at FROM domain_event_outbox WHERE aggregate_id = ANY($1::uuid[]) ORDER BY id",
          [intents],
        ),
        owner.query(
          "SELECT id, status, amount_idr::text FROM payment_intents WHERE id = ANY($1::uuid[]) ORDER BY id",
          [intents],
        ),
        owner.query(
          "SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1",
          [tenantId],
        ),
      ]);
      return [parked.rows, outbox.rows, paid.rows, journals.rows];
    };
    const before = await snapshot();
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletStale,
      kind: KIND,
    });
    // Premise: the rows are really listed, so the read was exercised.
    expect(itemsOfKind(payload, KIND)).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
  });
});

// legend-853 (second opinion, finding 2): a POS sale pays through
// pos_order_tenders, and orders.payment_intent_id is null for POS. A receipt
// pending for over a day must still show the order's intent(s) and the state
// of their payment.paid outbox row. Written fail-first from the DTO contract
// (FinanceExceptionReceiptPendingDto in @starter/shared/types/api), not from
// the implementation.
// Assumptions:
// - The detail lives in `item.receiptPending` ({ orderId, intentId,
//   outboxState }), as the shared DTO documents; outboxState is one of
//   pending | dead_lettered | delivered | missing.
// - The parked payload of these rows carries only the order ULID (a POS
//   receipt-pending park has no intent id in it), so the intent can only be
//   found through the order's tenders.
// - With several intents on one order (a replaced QR, or a split tender), the
//   item stays one row per parked sale; intentId is any one of the order's
//   intents, and outboxState reflects the intent that still waits in the
//   outbox ("pending" beats "missing" for the other intent).
// - A tender with no payment intent (cash) keeps intentId null and "missing".
describe("finance-exceptions: receipt_pending_stale via POS tenders", () => {
  const KIND = "receipt_pending_stale" as const;
  type Receipt = {
    orderId: string | null;
    intentId: string | null;
    outboxState: "pending" | "dead_lettered" | "delivered" | "missing";
  };
  type PosSale = {
    orderUlid: string;
    orderUuid: string;
    intents: { id: string; amountIdr: number }[];
  };
  const sales: PosSale[] = [];
  const linkIds: string[] = [];
  const intentLinks = new Map<string, string>();
  const dpSales = new Set<string>();
  let outlet: string;

  async function seedIntent(amountIdr: number): Promise<string> {
    const linkId = randomUUID();
    const intentId = randomUUID();
    linkIds.push(linkId);
    intentLinks.set(intentId, linkId);
    await owner.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed-853')`,
      [
        linkId,
        tenantId,
        outlet,
        randomBytes(32).toString("hex"),
        `PT-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
          status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(),
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [intentId, tenantId, outlet, linkId, amountIdr, `pt-${intentId}`],
    );
    return intentId;
  }

  async function seedOutbox(
    intentId: string,
    amountIdr: number,
    state: "pending" | "dead",
  ): Promise<void> {
    const outboxId = randomUUID();
    await owner.query(
      `INSERT INTO domain_event_outbox
         (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
       VALUES ($1, $2, $3, $4, 'payment', $5, 1, $6, 'cloud-sync')`,
      [
        tenantId,
        outboxId,
        outlet,
        randomUUID(),
        intentId,
        JSON.stringify({
          id: createUlid(),
          tenantId,
          outletId: outlet,
          name: "payment.paid",
          aggregateType: "payment",
          aggregateId: intentId,
          sequence: 1,
          payload: { intentId, receivedIdr: amountIdr },
        }),
      ],
    );
    if (state === "dead")
      await owner.query(
        `UPDATE domain_event_outbox
            SET dispatch_state = 'dead', dead_lettered_at = now() - interval '10 days'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, outboxId],
      );
  }

  /** A stale-parked POS sale whose payment lives in tenders only. */
  async function seedPosSale(
    tenders: {
      amountIdr: number;
      withIntent: boolean;
      outbox?: "pending" | "dead";
      status?: "captured" | "voided";
    }[],
    // A parked event that names its own intent (order_issue.charge_paid),
    // separate from the order's tenders.
    payloadIntent?: { amountIdr: number; outbox?: "pending" | "dead" },
  ): Promise<PosSale> {
    const orderUlid = createUlid();
    const orderUuid = ulidToUuid(orderUlid);
    const total = tenders.reduce((sum, row) => sum + row.amountIdr, 0);
    await owner.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'awaiting_payment', '2026-03-10', '2026-03-10T05:00:00Z')`,
      [orderUuid, tenantId, outlet, `PT-${unique()}${unique()}`, total],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderUuid, tenantId, outlet],
    );
    const intents: PosSale["intents"] = [];
    let payloadIntentId: string | null = null;
    if (payloadIntent) {
      payloadIntentId = await seedIntent(payloadIntent.amountIdr);
      if (payloadIntent.outbox)
        await seedOutbox(
          payloadIntentId,
          payloadIntent.amountIdr,
          payloadIntent.outbox,
        );
      intents.push({ id: payloadIntentId, amountIdr: payloadIntent.amountIdr });
    }
    for (const tender of tenders) {
      if (!tender.withIntent) {
        await owner.query(
          `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, amount_idr,
              received_idr, change_idr, status, requested_at, resolved_at)
           VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
          [tenantId, outlet, orderUuid, tender.amountIdr],
        );
        continue;
      }
      const intentId = await seedIntent(tender.amountIdr);
      const link = await owner.query<{ payment_link_id: string }>(
        "SELECT payment_link_id FROM payment_intents WHERE id = $1",
        [intentId],
      );
      await owner.query(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
            payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
            status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
                 $7, now(), $8)`,
        [
          tenantId,
          outlet,
          orderUuid,
          link.rows[0]!.payment_link_id,
          intentId,
          tender.amountIdr,
          tender.status ?? "captured",
          new Date(),
        ],
      );
      if (tender.outbox)
        await seedOutbox(intentId, tender.amountIdr, tender.outbox);
      intents.push({ id: intentId, amountIdr: tender.amountIdr });
    }
    await owner.query(
      `INSERT INTO auto_journal_parked
         (tenant_id, outlet_id, idempotency_key, event_id, event_name, payload,
          error_code, retryable, first_failed_at, last_failed_at, next_retry_at)
       VALUES ($1, $2, $3, $4, $6, $5::jsonb, 'AUTO_JOURNAL_RECEIPT_PENDING', true,
         now() - interval '48 hours', now(), now() + interval '1 hour')`,
      [
        tenantId,
        outlet,
        `aj:sale:${orderUlid}`,
        createUlid(),
        JSON.stringify({
          orderId: orderUlid,
          customerPhone: SECRET,
          ...(payloadIntentId ? { paymentIntentId: payloadIntentId } : {}),
        }),
        payloadIntentId ? "order_issue.charge_paid" : "order.paid",
      ],
    );
    const sale = { orderUlid, orderUuid, intents };
    sales.push(sale);
    return sale;
  }

  /** Native DP sources deliberately carry no order/tender payment intent. */
  async function seedDepositSource(
    sale: PosSale,
    source: "allocation" | "credit" | "refund",
    state: "pending" | "dead" = "pending",
    options: { useAt?: string; indirect?: boolean } = {},
  ): Promise<string> {
    dpSales.add(sale.orderUuid);
    const intentId = await seedIntent(80_000);
    sale.intents.push({ id: intentId, amountIdr: 80_000 });
    await seedOutbox(intentId, 80_000, state);
    if (source === "refund") {
      const refundId = randomUUID();
      await owner.query(
        "UPDATE orders SET status='completed' WHERE tenant_id=$1 AND id=$2 AND status<>'completed'",
        [tenantId, sale.orderUuid],
      );
      await owner.query(
        `INSERT INTO pos_order_refunds
           (id, tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
            requested_by, approved_by, approval_request_id, refunded_at)
         VALUES ($1,$2,$3,$4,20000,'customer_request','DP return',
                 '[{"method":"deposit","amountIdr":20000}]','cashier','manager',$5,now())`,
        [refundId, tenantId, outlet, sale.orderUuid, randomUUID()],
      );
      await owner.query(
        `INSERT INTO pos_deposit_refunds
           (tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at)
         VALUES ($1,$2,$3,$4,$5,20000,now())`,
        [tenantId, outlet, sale.orderUuid, refundId, intentId],
      );
      await owner.query(
        `UPDATE auto_journal_parked SET event_name='order.refunded',
           payload=payload || jsonb_build_object('refundId',$3::text)
         WHERE tenant_id=$1 AND idempotency_key=$2`,
        [tenantId, `aj:sale:${sale.orderUlid}`, refundId],
      );
      return intentId;
    }
    async function session(): Promise<string> {
      const zoneId = randomUUID();
      const tableId = randomUUID();
      const sessionId = randomUUID();

      await owner.query(
        `INSERT INTO floor_zones(id,tenant_id,outlet_id,name,payment_mode,hours)
         VALUES($1,$2,$3,$4,'pay_first','[]')`,
        [zoneId, tenantId, outlet, `DP ${zoneId}`],
      );
      await owner.query(
        `INSERT INTO tables(id,tenant_id,outlet_id,zone_id,code,capacity,type,layout)
         VALUES($1,$2,$3,$4,$5,4,'regular','{}')`,
        [tableId, tenantId, outlet, zoneId, unique().toUpperCase()],
      );
      await owner.query(
        `INSERT INTO table_sessions(id,tenant_id,outlet_id,table_id,pax,payment_mode,status,
             session_token_hash,session_token_sealed)
         VALUES($1,$2,$3,$4,2,'pay_first','open',$5,'sealed')`,
        [sessionId, tenantId, outlet, tableId, randomBytes(32).toString("hex")],
      );
      return sessionId;
    }
    const originalSession = await session();
    const destination = source === "credit" ? await session() : originalSession;
    const reservationId = randomUUID();

    await owner.query(
      `INSERT INTO reservations(id,tenant_id,outlet_id,guest_name,reserved_for,duration_minutes,pax,
           deposit_idr,deposit_payment_id,policy_snapshot,status,source,table_session_id,seated_at)
       VALUES($1,$2,$3,'Guest DP',now(),90,2,80000,$4,'{}','seated','staff',$5,now())`,
      [reservationId, tenantId, outlet, intentId, originalSession],
    );
    if (source === "allocation")
      await owner.query(
        `INSERT INTO reservation_deposit_allocations
           (tenant_id,outlet_id,reservation_id,table_session_id,payment_intent_id,amount_idr)
         VALUES($1,$2,$3,$4,$5,80000)`,
        [tenantId, outlet, reservationId, destination, intentId],
      );
    else {
      const profileId = randomUUID();
      const remainderId = randomUUID();

      await owner.query(
        `INSERT INTO customer_profiles(id,tenant_id,name,membership_status,whatsapp_verified_at)
         VALUES($1,$2,'DP credit owner','active',now())`,
        [profileId, tenantId],
      );
      await owner.query(
        `INSERT INTO reservation_deposit_remainders
           (id,tenant_id,outlet_id,reservation_id,table_session_id,payment_intent_id,
            customer_profile_id,amount_idr,remaining_idr,kind)
         VALUES($1,$2,$3,$4,$5,$6,$7,80000,0,'customer_credit')`,
        [
          remainderId,
          tenantId,
          outlet,
          reservationId,
          originalSession,
          intentId,
          profileId,
        ],
      );
      await owner.query(
        `INSERT INTO reservation_customer_credit_uses
           (tenant_id,outlet_id,remainder_id,table_session_id,amount_idr,idempotency_key,created_at)
         VALUES($1,$2,$3,$4,80000,$5,$6)`,
        [
          tenantId,
          outlet,
          remainderId,
          destination,
          randomUUID(),
          options.useAt ?? "2026-03-10T04:00:00Z",
        ],
      );
      if (options.indirect) {
        // The current session reaches another receipt through the old session.
        // A direct-only lookup would display the pending credit receipt and
        // miss this dead-lettered receipt in the connected component.
        const indirectIntent = await seedIntent(10_000);
        sale.intents.push({ id: indirectIntent, amountIdr: 10_000 });
        await seedOutbox(indirectIntent, 10_000, "dead");
        const indirectReservation = randomUUID();

        await owner.query(
          `INSERT INTO reservations(id,tenant_id,outlet_id,guest_name,reserved_for,duration_minutes,pax,
               deposit_idr,deposit_payment_id,policy_snapshot,status,source,table_session_id,seated_at)
           VALUES($1,$2,$3,'Shared DP',now(),90,2,10000,$4,'{}','seated','staff',$5,now())`,
          [
            indirectReservation,
            tenantId,
            outlet,
            indirectIntent,
            originalSession,
          ],
        );
        await owner.query(
          `INSERT INTO reservation_deposit_allocations
             (tenant_id,outlet_id,reservation_id,table_session_id,payment_intent_id,amount_idr)
           VALUES($1,$2,$3,$4,$5,10000)`,
          [
            tenantId,
            outlet,
            indirectReservation,
            originalSession,
            indirectIntent,
          ],
        );
        await owner.query(
          `INSERT INTO reservation_deposit_allocations
             (tenant_id,outlet_id,reservation_id,table_session_id,payment_intent_id,amount_idr)
           VALUES($1,$2,$3,$4,$5,80000)`,
          [tenantId, outlet, reservationId, originalSession, intentId],
        );
      }
    }
    await owner.query(
      `UPDATE orders SET table_session_id=$3, deposit_applied_idr=80000,
         subtotal_idr=100000,total_idr=100000 WHERE tenant_id=$1 AND id=$2`,
      [tenantId, sale.orderUuid, destination],
    );
    await owner.query(
      "UPDATE pos_orders SET completed_at='2026-03-10T05:00:00Z' WHERE tenant_id=$1 AND order_id=$2",
      [tenantId, sale.orderUuid],
    );
    return intentId;
  }

  async function receiptOf(sale: PosSale): Promise<{
    item: Item;
    receipt: Receipt;
  }> {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outlet,
      kind: KIND,
    });
    const item = itemsOfKind(payload, KIND).find((row) => {
      const text = JSON.stringify(row);
      return text.includes(sale.orderUlid) || text.includes(sale.orderUuid);
    });
    expect(item, "the stale POS sale is listed").toBeDefined();
    const receipt = (item as unknown as { receiptPending?: Receipt })
      .receiptPending;
    expect(receipt, "the item carries receiptPending").toBeDefined();
    return { item: item!, receipt: receipt! };
  }

  let pendingSale: PosSale;
  let deadSale: PosSale;
  let noOutboxSale: PosSale;
  let cashSale: PosSale;
  let multiSale: PosSale;
  let splitDeadSale: PosSale;
  let chargePaidSale: PosSale;
  let voidedTenderSale: PosSale;

  beforeAll(async () => {
    outlet = await newOutlet("Resi tender POS");
    pendingSale = await seedPosSale([
      { amountIdr: 120_000, withIntent: true, outbox: "pending" },
    ]);
    deadSale = await seedPosSale([
      { amountIdr: 65_000, withIntent: true, outbox: "dead" },
    ]);
    noOutboxSale = await seedPosSale([{ amountIdr: 40_000, withIntent: true }]);
    cashSale = await seedPosSale([{ amountIdr: 30_000, withIntent: false }]);
    // Two intents on one order: the first QR has no outbox row, the second
    // still waits in the outbox.
    multiSale = await seedPosSale([
      { amountIdr: 50_000, withIntent: true },
      { amountIdr: 70_000, withIntent: true, outbox: "pending" },
    ]);
    // A cash tender next to a QR tender with a dead-lettered receipt.
    splitDeadSale = await seedPosSale([
      { amountIdr: 20_000, withIntent: false },
      { amountIdr: 80_000, withIntent: true, outbox: "dead" },
    ]);
    // A charge_paid park names its own intent (receipt still pending); another
    // tender of the order has a dead-lettered receipt that must not win.
    chargePaidSale = await seedPosSale(
      [{ amountIdr: 90_000, withIntent: true, outbox: "dead" }],
      { amountIdr: 25_000, outbox: "pending" },
    );
    // A voided QR tender (its receipt still pending) next to captured cash:
    // the journal never waits for a voided tender.
    voidedTenderSale = await seedPosSale([
      { amountIdr: 20_000, withIntent: false },
      {
        amountIdr: 80_000,
        withIntent: true,
        outbox: "pending",
        status: "voided",
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    // DP fixtures include immutable completed-sale/refund evidence and stay in
    // this disposable database, like the top-level finance fixtures.
    const cleanupSales = sales.filter((sale) => !dpSales.has(sale.orderUuid));
    const orders = cleanupSales.map((sale) => sale.orderUuid);
    const intents = cleanupSales.flatMap((sale) =>
      sale.intents.map((i) => i.id),
    );
    await owner.query(
      "DELETE FROM domain_event_outbox WHERE aggregate_id = ANY($1::uuid[])",
      [intents],
    );
    await owner.query(
      "DELETE FROM auto_journal_parked WHERE idempotency_key = ANY($1::text[])",
      [cleanupSales.map((sale) => `aj:sale:${sale.orderUlid}`)],
    );
    await owner.query(
      "DELETE FROM pos_order_tenders WHERE order_id = ANY($1::uuid[])",
      [orders],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intents],
    );
    await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds.filter((id) =>
        cleanupSales.some((sale) =>
          sale.intents.some((intent) => intentLinks.get(intent.id) === id),
        ),
      ),
    ]);
    await owner.query(
      "DELETE FROM pos_orders WHERE order_id = ANY($1::uuid[])",
      [orders],
    );
    await owner.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
  });

  it("a POS sale paid by a QR tender shows the tender's intent and its pending outbox state", async () => {
    const { item, receipt } = await receiptOf(pendingSale);
    expect(receipt.intentId).toBe(pendingSale.intents[0]!.id);
    expect(receipt.outboxState).toBe("pending");
    expect(item.amountIdr).toBe(120_000);
  });

  it("a dead-lettered receipt of a tender intent shows dead_lettered", async () => {
    const { receipt } = await receiptOf(deadSale);
    expect(receipt.intentId).toBe(deadSale.intents[0]!.id);
    expect(receipt.outboxState).toBe("dead_lettered");
  });

  it("a tender intent with no payment.paid outbox row shows the intent and missing", async () => {
    const { item, receipt } = await receiptOf(noOutboxSale);
    expect(receipt.intentId).toBe(noOutboxSale.intents[0]!.id);
    expect(receipt.outboxState).toBe("missing");
    expect(item.amountIdr).toBe(40_000);
  });

  it("a sale paid only in cash has no intent: intentId null and missing", async () => {
    const { receipt } = await receiptOf(cashSale);
    expect(receipt.intentId).toBeNull();
    expect(receipt.outboxState).toBe("missing");
  });

  it("several intents on one order: the item stays one row and reflects the intent still waiting in the outbox", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outlet,
      kind: KIND,
    });
    const rows = itemsOfKind(payload, KIND).filter((row) => {
      const text = JSON.stringify(row);
      return (
        text.includes(multiSale.orderUlid) || text.includes(multiSale.orderUuid)
      );
    });
    expect(rows, "one row per parked sale").toHaveLength(1);
    const { receipt } = await receiptOf(multiSale);
    expect(multiSale.intents.map((i) => i.id)).toContain(receipt.intentId);
    expect(receipt.outboxState).toBe("pending");
  });

  it("a cash tender next to a QR tender still finds the QR intent and its dead-lettered receipt", async () => {
    const { receipt } = await receiptOf(splitDeadSale);
    expect(receipt.intentId).toBe(splitDeadSale.intents[0]!.id);
    expect(receipt.outboxState).toBe("dead_lettered");
  });

  it("a parked event that names its intent shows only that intent, not another tender's dead-lettered one", async () => {
    const { item, receipt } = await receiptOf(chargePaidSale);
    // intents[0] is the payload intent (seeded first).
    expect(receipt.intentId).toBe(chargePaidSale.intents[0]!.id);
    expect(receipt.outboxState).toBe("pending");
    expect(item.amountIdr).toBe(25_000);
  });

  it("a voided tender is ignored: no intent, missing, valued at the order total", async () => {
    const { item, receipt } = await receiptOf(voidedTenderSale);
    expect(receipt.intentId).toBeNull();
    expect(receipt.outboxState).toBe("missing");
    expect(item.amountIdr).toBe(100_000);
  });

  it("a split tender intent is valued at the order total, not the QR share", async () => {
    const { item } = await receiptOf(splitDeadSale);
    expect(item.amountIdr).toBe(100_000);
  });

  it("the summary still counts one row per stale sale", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outlet,
      kind: KIND,
    });
    expect(summaryOf(payload, KIND).count).toBe(8);
  });
  describe("legend-1get7 DP receipt sources", () => {
    it("a pending DP receipt wins over the delivered QR tender receipt", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: true, outbox: "pending" },
      ]);
      await owner.query(
        "UPDATE domain_event_outbox SET status='delivered', delivered_at=now() WHERE tenant_id=$1 AND aggregate_id=$2",
        [tenantId, sale.intents[0]!.id],
      );
      const intentId = await seedDepositSource(sale, "allocation");
      const { receipt, item } = await receiptOf(sale);
      expect(receipt.intentId).toBe(intentId);
      expect(receipt.outboxState).toBe("pending");
      expect(item.amountIdr).toBe(100_000);
    });

    it("resolves the allocated reservation DP beside cash and keeps the full order amount", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      const intentId = await seedDepositSource(sale, "allocation");
      const { receipt, item } = await receiptOf(sale);
      expect(receipt.intentId).toBe(intentId);
      expect(receipt.outboxState).toBe("pending");
      expect(item.amountIdr).toBe(100_000);
    });

    it("resolves a reused customer-credit DP from its original remainder receipt", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      const intentId = await seedDepositSource(sale, "credit", "dead");
      const { receipt, item } = await receiptOf(sale);
      expect(receipt.intentId).toBe(intentId);
      expect(receipt.outboxState).toBe("dead_lettered");
      expect(item.amountIdr).toBe(100_000);
    });

    it("resolves the exact DP release intent of a parked POS refund", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      await seedDepositSource(sale, "refund", "dead");
      const intentId = await seedDepositSource(sale, "refund");
      const { receipt } = await receiptOf(sale);
      expect(receipt.intentId).toBe(intentId);
      expect(receipt.outboxState).toBe("pending");
    });

    it("follows the connected old session to the other receipt blocking the DP", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      await seedDepositSource(sale, "credit", "pending", { indirect: true });
      const { receipt } = await receiptOf(sale);
      expect(receipt.intentId).toBe(sale.intents.at(-1)!.id);
      expect(receipt.outboxState).toBe("dead_lettered");
    });

    it("ignores customer credit committed one microsecond after the sale", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      await seedDepositSource(sale, "credit", "dead", {
        useAt: "2026-03-10T05:00:00.000001Z",
      });
      const { receipt } = await receiptOf(sale);
      expect(receipt.intentId).toBeNull();
      expect(receipt.outboxState).toBe("missing");
    });

    it("does not resolve an allocation belonging to another outlet", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      const intentId = await seedDepositSource(sale, "allocation", "dead");
      await owner.query(
        "UPDATE reservation_deposit_allocations SET outlet_id=$3 WHERE tenant_id=$1 AND payment_intent_id=$2",
        [tenantId, intentId, outletB],
      );
      const { receipt } = await receiptOf(sale);
      expect(receipt.intentId).toBeNull();
      expect(receipt.outboxState).toBe("missing");
    });

    it("listing DP exceptions leaves the source facts and money unchanged", async () => {
      const sale = await seedPosSale([
        { amountIdr: 20_000, withIntent: false },
      ]);
      const intentId = await seedDepositSource(sale, "allocation");
      async function facts() {
        return (
          await owner.query(
            `SELECT
             (SELECT to_jsonb(o) FROM orders o WHERE tenant_id=$1 AND id=$2) AS sale,
             (SELECT to_jsonb(i) FROM payment_intents i WHERE tenant_id=$1 AND id=$3) AS intent,
             (SELECT jsonb_agg(to_jsonb(a)) FROM reservation_deposit_allocations a
               WHERE tenant_id=$1 AND payment_intent_id=$3) AS allocations,
             (SELECT count(*)::int FROM payment_refunds WHERE tenant_id=$1 AND payment_intent_id=$3) AS refunds,
             (SELECT count(*)::int FROM payment_unallocated_funds WHERE tenant_id=$1 AND payment_intent_id=$3) AS unallocated,
             (SELECT count(*)::int FROM journal_entries WHERE tenant_id=$1) AS journals`,
            [tenantId, sale.orderUuid, intentId],
          )
        ).rows;
      }
      const before = await facts();
      await receiptOf(sale);
      await receiptOf(sale);
      expect(await facts()).toEqual(before);
    });

    it("an explicit payload intent still takes precedence over a dead-lettered DP", async () => {
      const sale = await seedPosSale(
        [{ amountIdr: 20_000, withIntent: false }],
        { amountIdr: 25_000, outbox: "pending" },
      );
      const expectedIntent = sale.intents[0]!.id;
      await seedDepositSource(sale, "allocation", "dead");
      const { receipt, item } = await receiptOf(sale);
      expect(receipt.intentId).toBe(expectedIntent);
      expect(receipt.outboxState).toBe("pending");
      expect(item.amountIdr).toBe(25_000);
    });
  });
});
