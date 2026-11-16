// legend-912 (implementer D): QR and VA release-recon rows that stay open for
// more than 72 hours without provider proof are listed in the finance
// exceptions list as the new kind `release_recon_unproven`.
// Written fail-first from docs/briefs/912-3p1.md ("Revisi pembagian", D) and
// the finance-exceptions contract (the list route, its query validator and the
// style of accounting-finance-exceptions.test.ts), not from the implementation.
//
// Rules under test:
// - an OPEN row of the QR queue (pos_qris_release_reconciliations) or the VA
//   queue (payment_va_releases) created more than 72 h ago is listed; this
//   stays true past 7 days (no row is closed by a timer);
// - a younger open row, or a resolved row of any age, is not listed;
// - another tenant's row never shows (items nor summary).
//
// Assumptions (the brief is silent, stated so they can be contested):
// - The kind is `release_recon_unproven` (brief: "mis. release_recon_unproven");
//   the route accepts it as a `kind` filter (200, not 400).
// - Like `receipt_pending_stale`, this kind is age-based and ignores the
//   from/to window: a March window and a January 2025 window list the same rows.
// - Where the recon row id / payment intent id sit in the item is not asserted:
//   an item is matched when its serialized JSON contains the recon row id (ULID
//   or uuid form) or the payment intent id.
// - The item amount and detail text are not asserted (brief gives none).
// - The 72 h threshold is PAID_WATCH_MS of pos-qris-release-recon.ts; rows are
//   seeded at 73 h (listed) and 71 h (not listed) to stay clear of the exact
//   boundary and of clock drift.
// - Rows are seeded by direct inserts (closed QR hold, pending intent), on
//   outlets created by this file, so counts are exact and other suites sharing
//   the DB do not disturb them.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-d-finance-exception.test.ts" heavy pnpm test

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

const authApp = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const seedOutlet = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const PATH = "/api/accounting/finance-exceptions";
const KIND = "release_recon_unproven";
const MARCH = { from: "2026-03-01", to: "2026-03-31" };
const OLD_WINDOW = { from: "2025-01-01", to: "2025-01-31" };

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

type Item = {
  kind: string;
  outletId: string | null;
  occurredAt: string;
  refType: string;
  refId: string;
  amountIdr: number | null;
  detail: string | null;
};
type Payload = {
  summary: {
    kind: string;
    count: number;
    amountIdr: number;
    knownAmountCount: number;
  }[];
  items: Item[];
  truncated: boolean;
};

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
  const email = `fin-exc-912-${randomUUID()}@example.com`;
  const signUp = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({
      name: "Finance exceptions 912",
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
     SELECT $1, $2, 'Finance exceptions 912 other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [id, `finexc912-${unique()}`, tenantId],
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

// ---- seeding of the two queues ------------------------------------------

type Seeded = { ulid: string; uuid: string; intentId: string };
type QueueRow = {
  tenant?: string;
  outlet: string;
  ageHours: number;
  /** "open" (default) or a resolved row. */
  resolved?: boolean;
  amountIdr?: number;
};

async function seedOrderRow(tenant: string, outlet: string): Promise<string> {
  const uuid = ulidToUuid(createUlid());
  await asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 50000, 0, 0, 0, 0, 50000,
         'completed', '2026-03-10'::date, '2026-03-10T05:00:00Z'::timestamptz)`,
      [uuid, tenant, outlet, `R912-${unique()}${unique()}`],
    ),
  );
  return uuid;
}

async function seedIntentRow(
  tenant: string,
  outlet: string,
  method: "qris" | "va",
  amountIdr: number,
): Promise<string> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 0, 'seed')`,
    [
      linkId,
      tenant,
      outlet,
      randomBytes(32).toString("hex"),
      `R912-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, instructions, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'doit', $6, $7, 'pending',
             $8::jsonb, now() - interval '200 hours')`,
    [
      intentId,
      tenant,
      outlet,
      linkId,
      method,
      amountIdr,
      `r912-${intentId}`,
      JSON.stringify(
        method === "qris"
          ? { method: "qris", qrPayload: "test", issuer: null }
          : { method: "va", bankCode: "bmri", vaNumber: "8808123456789" },
      ),
    ],
  );
  return intentId;
}

/** A force-released QR code: a closed hold plus its recon queue row. */
async function seedQr(row: QueueRow): Promise<Seeded> {
  const tenant = row.tenant ?? tenantId;
  const amountIdr = row.amountIdr ?? 33_000;
  const orderUuid = await seedOrderRow(tenant, row.outlet);
  const intentId = await seedIntentRow(tenant, row.outlet, "qris", amountIdr);
  const holdUuid = ulidToUuid(createUlid());
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await asTenant(tenant, async (client) => {
    await client.query(
      `INSERT INTO pos_qris_holds
         (tenant_id, id, outlet_id, order_id, payment_intent_id, amount_idr, state,
          opened_at, closed_at, close_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'closed',
               now() - ($7::int + 1) * interval '1 hour',
               now() - $7::int * interval '1 hour', 'force_released')`,
      [
        tenant,
        holdUuid,
        row.outlet,
        orderUuid,
        intentId,
        amountIdr,
        Math.floor(row.ageHours),
      ],
    );
    await client.query(
      `INSERT INTO pos_qris_release_reconciliations
         (tenant_id, id, outlet_id, hold_id, payment_intent_id, status, reason, attempts,
          next_check_at, last_provider_status, created_at, resolved_at, resolution)
       VALUES ($1, $2, $3, $4, $5, $6, 'force_released', 3,
               now() + interval '1 day', $7,
               now() - $8::numeric * interval '1 hour',
               CASE WHEN $6::text = 'resolved' THEN now() - interval '1 hour' END,
               CASE WHEN $6::text = 'resolved' THEN 'provider_expired' END)`,
      [
        tenant,
        uuid,
        row.outlet,
        holdUuid,
        intentId,
        row.resolved ? "resolved" : "open",
        row.resolved ? "expired" : "pending",
        row.ageHours,
      ],
    );
  });
  return { ulid, uuid, intentId };
}

/** A staff-released VA code: the release row is its own recon queue row. */
async function seedVa(row: QueueRow): Promise<Seeded> {
  const tenant = row.tenant ?? tenantId;
  const amountIdr = row.amountIdr ?? 41_000;
  const orderUuid = await seedOrderRow(tenant, row.outlet);
  const intentId = await seedIntentRow(tenant, row.outlet, "va", amountIdr);
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await asTenant(tenant, (client) =>
    client.query(
      `INSERT INTO payment_va_releases
         (tenant_id, id, outlet_id, payment_intent_id, order_id, reason, released_by,
          approved_by, override_id, status, attempts, next_check_at, last_provider_status,
          created_at, resolved_at, resolution)
       VALUES ($1, $2, $3, $4, $5, 'Bank tidak menjawab status VA', 'seed-staff',
               'seed-manager', $6, $7, 3, now() + interval '1 day', $8,
               now() - $9::numeric * interval '1 hour',
               CASE WHEN $7::text = 'resolved' THEN now() - interval '1 hour' END,
               CASE WHEN $7::text = 'resolved' THEN 'provider_expired' END)`,
      [
        tenant,
        uuid,
        row.outlet,
        intentId,
        orderUuid,
        ulidToUuid(createUlid()),
        row.resolved ? "resolved" : "open",
        row.resolved ? "expired" : "pending",
        row.ageHours,
      ],
    ),
  );
  return { ulid, uuid, intentId };
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
const summaryOf = (payload: Payload, kind: string) => {
  const entry = payload.summary.find((row) => row.kind === kind);
  return { count: entry?.count ?? 0 };
};
const itemsOfKind = (payload: Payload) =>
  payload.items.filter((item) => item.kind === KIND);
/** The item that names this queue row (by row id, either form, or intent id). */
const itemFor = (items: Item[], row: Seeded) =>
  items.find((item) => {
    const text = JSON.stringify(item);
    return (
      text.includes(row.ulid) ||
      text.includes(row.uuid) ||
      text.includes(row.intentId)
    );
  });

// ---- world --------------------------------------------------------------

let finance: { cookie: string; userId: string };
let scoped: { cookie: string; userId: string };
let cashier: { cookie: string; userId: string };
let outletA: string;
let outletB: string;
let outletEmpty: string;
let other: OtherWorld;
const w = {} as {
  qrOld: Seeded;
  vaOld: Seeded;
  qrAncient: Seeded;
  qrYoung: Seeded;
  vaYoung: Seeded;
  qrResolved: Seeded;
  vaResolved: Seeded;
  vaOldB: Seeded;
  qrOther: Seeded;
  vaOther: Seeded;
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn();
  await assignTemplate(finance.userId, "finance");
  cashier = await signedIn();
  await assignTemplate(cashier.userId, "cashier");
  outletA = await newOutlet("Recon 912 A");
  outletB = await newOutlet("Recon 912 B");
  outletEmpty = await newOutlet("Recon 912 Kosong");
  scoped = await signedIn();
  await assignTemplate(scoped.userId, "finance", outletB);
  other = await newOtherTenant();

  // Listed: open and older than 72 h (73 h), QR and VA.
  w.qrOld = await seedQr({ outlet: outletA, ageHours: 73 });
  w.vaOld = await seedVa({ outlet: outletA, ageHours: 73 });
  // Listed too: open past the 7 day cap. No timer ever closes a row.
  w.qrAncient = await seedQr({ outlet: outletA, ageHours: 24 * 9 });
  // Not listed: open but younger than 72 h (71 h).
  w.qrYoung = await seedQr({ outlet: outletA, ageHours: 71 });
  w.vaYoung = await seedVa({ outlet: outletA, ageHours: 71 });
  // Not listed: resolved, however old.
  w.qrResolved = await seedQr({
    outlet: outletA,
    ageHours: 24 * 5,
    resolved: true,
  });
  w.vaResolved = await seedVa({
    outlet: outletA,
    ageHours: 24 * 5,
    resolved: true,
  });
  // Another outlet of the same tenant.
  w.vaOldB = await seedVa({ outlet: outletB, ageHours: 80 });
  // Another tenant: open and ancient, must never show in tenant A.
  w.qrOther = await seedQr({
    tenant: other.tenant,
    outlet: other.outlet,
    ageHours: 100,
    amountIdr: 99_000,
  });
  w.vaOther = await seedVa({
    tenant: other.tenant,
    outlet: other.outlet,
    ageHours: 100,
    amountIdr: 98_000,
  });
}, 120_000);

afterAll(async () => {
  // Queue rows are never deleted (append-only evidence), so they stay in the
  // disposable DB.
  await owner.end();
});

// ---- tests --------------------------------------------------------------

describe("legend-912 D: release_recon_unproven", () => {
  it("accepts the new kind as a filter (200, not 400)", async () => {
    const response = await get(finance.cookie, {
      ...MARCH,
      outletId: outletA,
      kind: KIND,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("lists open QR and VA recon rows older than 72 hours, once each, on their outlet", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletA,
      kind: KIND,
    });
    const items = itemsOfKind(payload);
    for (const row of [w.qrOld, w.vaOld]) {
      const item = itemFor(items, row);
      expect(item, `row ${row.ulid} missing`).toBeDefined();
      expect(item?.outletId).toBe(outletA);
    }
    // One item per row, no duplicates.
    expect(items.filter((item) => itemFor([item], w.qrOld))).toHaveLength(1);
    expect(items.filter((item) => itemFor([item], w.vaOld))).toHaveLength(1);
  });

  it("an open row past the 7 day cap stays listed: no timer closes it", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletA,
      kind: KIND,
    });
    expect(itemFor(itemsOfKind(payload), w.qrAncient)).toBeDefined();
  });

  it("leaves out an open row younger than 72 hours and any resolved row", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletA,
      kind: KIND,
    });
    const items = itemsOfKind(payload);
    for (const row of [w.qrYoung, w.vaYoung, w.qrResolved, w.vaResolved])
      expect(itemFor(items, row), `row ${row.ulid} must not be listed`).toBe(
        undefined,
      );
    // Exactly the three old open rows of outlet A.
    expect(items).toHaveLength(3);
    expect(summaryOf(payload, KIND).count).toBe(3);
  });

  it("is not limited by the from/to window: an old window lists the same rows", async () => {
    const payload = await fetchList(finance.cookie, {
      ...OLD_WINDOW,
      outletId: outletA,
      kind: KIND,
    });
    expect(itemsOfKind(payload)).toHaveLength(3);
    expect(summaryOf(payload, KIND).count).toBe(3);
  });

  it("without the kind filter the rows still show, and the summary names the kind", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletA,
    });
    expect(itemFor(itemsOfKind(payload), w.qrOld)).toBeDefined();
    expect(itemFor(itemsOfKind(payload), w.vaOld)).toBeDefined();
    expect(summaryOf(payload, KIND).count).toBe(3);
  });

  it("another kind filter does not return these rows", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletA,
      kind: "edge_receipt_skipped",
    });
    expect(itemsOfKind(payload)).toEqual([]);
    expect(summaryOf(payload, KIND).count).toBe(0);
  });

  it("the outletId filter partitions rows by outlet", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletB,
      kind: KIND,
    });
    const items = itemsOfKind(payload);
    expect(items).toHaveLength(1);
    expect(itemFor(items, w.vaOldB)).toBeDefined();
    expect(itemFor(items, w.vaOld)).toBeUndefined();
  });

  it("an outlet with no stuck recon row shows an empty list and a zero summary", async () => {
    const payload = await fetchList(finance.cookie, {
      ...MARCH,
      outletId: outletEmpty,
      kind: KIND,
    });
    expect(payload.items).toEqual([]);
    expect(summaryOf(payload, KIND).count).toBe(0);
    expect(payload.truncated).toBe(false);
  });

  it("another tenant's stuck rows never show in tenant A, items or summary", async () => {
    const payload = await fetchList(finance.cookie, { ...MARCH, kind: KIND });
    for (const row of [w.qrOther, w.vaOther])
      expect(itemFor(payload.items, row)).toBeUndefined();
    expect(payload.items.map((item) => item.amountIdr)).not.toContain(99_000);
    expect(payload.items.map((item) => item.amountIdr)).not.toContain(98_000);
    // The tenant-wide view of tenant A still holds tenant A's own rows.
    expect(itemFor(payload.items, w.qrOld)).toBeDefined();
    expect(itemFor(payload.items, w.vaOldB)).toBeDefined();
  });

  it("an outlet-scoped caller sees only its outlet's stuck rows", async () => {
    const payload = await fetchList(scoped.cookie, { ...MARCH, kind: KIND });
    expect(itemFor(payload.items, w.vaOldB)).toBeDefined();
    for (const row of [w.qrOld, w.vaOld, w.qrAncient])
      expect(itemFor(payload.items, row)).toBeUndefined();
    const asked = await fetchList(scoped.cookie, {
      ...MARCH,
      kind: KIND,
      outletId: outletA,
    });
    expect(asked.items).toEqual([]);
    expect(summaryOf(asked, KIND).count).toBe(0);
  });

  it("is denied without accounting.journal.view and without a session", async () => {
    const asCashier = await get(cashier.cookie, { ...MARCH, kind: KIND });
    expect(asCashier.status).toBe(403);
    const anonymous = await request(host)
      .get(PATH)
      .query({ ...MARCH, kind: KIND });
    expect(anonymous.status).toBe(401);
  });

  it("is read-only: listing changes no queue row", async () => {
    const snapshot = async () => {
      const [qr, va] = await Promise.all([
        owner.query(
          "SELECT id, status, attempts, next_check_at, resolved_at, resolution FROM pos_qris_release_reconciliations WHERE outlet_id = $1 ORDER BY id",
          [outletA],
        ),
        owner.query(
          "SELECT id, status, attempts, next_check_at, resolved_at, resolution FROM payment_va_releases WHERE outlet_id = $1 ORDER BY id",
          [outletA],
        ),
      ]);
      return JSON.stringify([qr.rows, va.rows]);
    };
    const before = await snapshot();
    await fetchList(finance.cookie, { ...MARCH, outletId: outletA });
    expect(await snapshot()).toBe(before);
  });
});
