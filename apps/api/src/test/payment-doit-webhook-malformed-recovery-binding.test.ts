// legend-aj5tv: recovery of a MALFORMED webhook row must process the event with
// the integration binding the recovery just stored.
//
// Scenario (from the so1180 review, finding P1-1): a tenant-wide integration T
// and an outlet integration O share one DOIT webhook secret. An `invoice.paid`
// event of a subscription bound to O was stored as a MALFORMED row owned by T
// (payload and verified_integration_ids NULL). T is then disabled. The genuine
// retry, signed with the shared secret, is attributed back to T's row; the row
// is filled with the verifying set [T, O] and the event must be processed with
// that set. Processing it with the stale owner-only binding [T] rejects the
// subscription bound to O (INTEGRATION_MISMATCH, status `ignored`) for good and
// the renewal is never recorded.
//
// Contract under test (observable state only):
// - one event row, still owned by T, binding contains T and O, status
//   `processed`, the invoice paid and the subscription active, once;
// - sweeps and a further resend change nothing (duplicate);
// - the same when the shared secret is T's previous in-grace secret;
// - money guard: a subscription bound to an integration that did NOT verify the
//   event is never paid, and a paid event whose amount differs from the invoice
//   never settles it.
//
// ASSUMPTIONS
// - "Payment proof" of a recurring invoice is its `paid_at` plus the
//   subscription turning `active`; there is no journal for it, so "no extra
//   journal rows" is pinned as "no extra outbox events for the invoice".
// - The first resend answers 200 with body status "processed"; later resends of
//   a processed event answer 200 with body status "duplicate" (as in
//   payment-recurring.test.ts).
// - Only tests 1-3 fail without the fix (status `ignored`); test 4 is a guard
//   that must hold with and without it.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import {
  clearDoitWebhookSecretCache,
  reprocessParkedRecurringEvents,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";

// A rotated secret stays valid as the previous secret for this long.
vi.mock("../services/platform-payment-gateway.service", async (original) => ({
  ...(await original<
    typeof import("../services/platform-payment-gateway.service")
  >()),
  gatewaySecretGraceMs: async () => 72 * 3_600_000,
}));

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const unique = () => randomBytes(4).toString("hex");
const PRICE = 150_000;
const MIN = 60_000;

let dedicated: SecondTenant;
let tenantId = "";
let outletId = "";
const integrationIds: string[] = [];
const planIds: string[] = [];
const subIds: string[] = [];

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

function jakartaMonthStart(monthOffset: number): string {
  const now = new Date(Date.now() + 7 * 3_600_000);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1),
  )
    .toISOString()
    .slice(0, 10);
}
const P_CUR = jakartaMonthStart(0);
const P_NEXT = jakartaMonthStart(1);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  dedicated = await createSecondTenant(owner, "malformedbind");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
});

afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const query = (text: string, values: unknown[]) => () =>
    owner.query(text, values);
  await step(
    query("DELETE FROM domain_event_outbox WHERE tenant_id = $1", [tenantId]),
  );
  await step(
    query(
      "DELETE FROM subscription_invoices WHERE subscription_id = ANY($1::uuid[])",
      [subIds],
    ),
  );
  await step(
    query(
      "DELETE FROM payment_recurring_subscriptions WHERE id = ANY($1::uuid[])",
      [subIds],
    ),
  );
  await step(
    query("DELETE FROM payment_recurring_plans WHERE id = ANY($1::uuid[])", [
      planIds,
    ]),
  );
  await step(
    query("DELETE FROM gateway_webhook_events WHERE tenant_id = $1", [
      tenantId,
    ]),
  );
  await step(
    query("DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])", [
      integrationIds,
    ]),
  );
  await step(() => sweepTenantRows(tenantId));
  await step(() => removeSecondTenant(owner, dedicated));
  await step(() => owner.end());
  if (errors.length > 0) throw errors[0];
});

async function sweepTenantRows(id: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [id],
    );
    const { rows } = await client.query<{ tbl: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text AS tbl
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.contype = 'f'
          AND c.confrelid IN ('public.tenants'::regclass, 'public.outlets'::regclass,
                              'public.brands'::regclass, 'public.legal_entities'::regclass)
          AND c.conrelid NOT IN ('public.tenants'::regclass, 'public.outlets'::regclass,
                                 'public.brands'::regclass, 'public.legal_entities'::regclass)`,
    );
    // `tbl` comes from pg_catalog (regclass text, already quoted), not input.
    for (const { tbl } of rows)
      await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Integration = { id: string; outletId: string | null; secret: string };

function remember(id: string) {
  if (!integrationIds.includes(id)) integrationIds.push(id);
}

/** An active DOIT integration on a fresh outlet (O, X). */
async function makeOutletIntegration(secret: string): Promise<Integration> {
  const outlet = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet MB', 'Jl. MB', '{}')`,
    [
      outlet,
      tenantId,
      dedicated.brandId,
      dedicated.legalEntityId,
      `MB-${unique()}`.toUpperCase(),
    ],
  );
  const created = await upsertIntegration(
    context(),
    {
      outletId: outlet as OutletId,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: { apiKey: `doit-key-${unique()}`, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(
    context(),
    created.id,
    { status: "active" },
    actor,
  );
  remember(created.id);
  clearDoitWebhookSecretCache();
  return { id: created.id, outletId: outlet, secret };
}

/** The tenant-wide integration T (outlet null). One per tenant: later calls
 * re-key and re-activate the same row. */
async function makeTenantWide(secret: string): Promise<Integration> {
  const created = await upsertIntegration(
    context(),
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: { apiKey: `doit-key-${unique()}`, webhookSecret: secret },
    },
    actor,
  );
  await setIntegrationStatus(
    context(),
    created.id,
    { status: "active" },
    actor,
  );
  remember(created.id);
  clearDoitWebhookSecretCache();
  return { id: created.id, outletId: null, secret };
}

async function disable(integration: Integration): Promise<void> {
  await setIntegrationStatus(
    context(),
    integration.id,
    { status: "disabled" },
    actor,
  );
  clearDoitWebhookSecretCache();
}

type Sub = {
  planId: string;
  subId: string;
  providerPlanId: string;
  providerSubId: string;
};

/** A plan and a pending_first_payment subscription bound to `integrationId`. */
async function seedSub(integrationId: string): Promise<Sub> {
  const sub: Sub = {
    providerPlanId: `plan_${unique()}`,
    providerSubId: `sub_${unique()}`,
    planId: randomUUID(),
    subId: randomUUID(),
  };
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', $5, 'month', 'active', $6)`,
    [sub.planId, tenantId, outletId, sub.providerPlanId, PRICE, integrationId],
  );
  planIds.push(sub.planId);
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_first_payment', $7)`,
    [
      sub.subId,
      tenantId,
      outletId,
      sub.planId,
      randomUUID(),
      sub.providerSubId,
      integrationId,
    ],
  );
  subIds.push(sub.subId);
  return sub;
}

function invoiceBody(
  type: "invoice.created" | "invoice.paid",
  sub: Pick<Sub, "providerPlanId" | "providerSubId">,
  invoiceId: string,
  amount = PRICE,
) {
  const paid = type === "invoice.paid";
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type,
    created_at: new Date().toISOString(),
    data: {
      invoice: {
        id: invoiceId,
        subscription_id: sub.providerSubId,
        plan_id: sub.providerPlanId,
        amount,
        currency: "IDR",
        period_start: P_CUR,
        period_end: P_NEXT,
        hosted_url: `https://pay.doit.example/invoices/${invoiceId}`,
        status: paid ? "paid" : "open",
        ...(paid ? { paid_at: new Date().toISOString() } : {}),
      },
    },
  };
}

function deliver(body: object, secret: string) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", `t=${t},v1=${mac}`)
    .send(raw);
}

/** A verified row of integration `integrationId` as an earlier delivery left it
 * with an unreadable body: payload NULL, no binding, failed MALFORMED. */
async function storeMalformedRow(eventId: string, integrationId: string) {
  await owner.query(
    `INSERT INTO gateway_webhook_events
       (tenant_id, provider, event_id, event_type, signature_valid, payload_hash,
        payload, provider_ref, status, attempts, last_error_code, received_at, updated_at,
        integration_id)
     VALUES ($1, 'doit', $2, NULL, true, $3, NULL, NULL, 'failed', 1, 'MALFORMED', now(), now(), $4)`,
    [tenantId, eventId, randomBytes(32).toString("hex"), integrationId],
  );
}

async function rowsOf(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    integration_id: string;
    last_error_code: string | null;
    payload: unknown;
    verified_integration_ids: string[] | null;
  }>(
    `SELECT status, integration_id, last_error_code, payload,
            verified_integration_ids::text[] AS verified_integration_ids
       FROM gateway_webhook_events
      WHERE tenant_id = $1 AND event_id = $2 AND signature_valid`,
    [tenantId, eventId],
  );
  return rows;
}

type InvoiceRow = {
  id: string;
  status: string;
  review_reason: string | null;
  paid_at: string | null;
};

async function invoicesOf(subId: string): Promise<InvoiceRow[]> {
  const { rows } = await owner.query<InvoiceRow>(
    `SELECT id, status, review_reason, paid_at::text AS paid_at
       FROM subscription_invoices WHERE subscription_id = $1 ORDER BY created_at`,
    [subId],
  );
  return rows;
}

async function subState(subId: string) {
  const { rows } = await owner.query<{
    status: string;
    activated_at: string | null;
    period_start: string | null;
    period_end: string | null;
  }>(
    `SELECT status, activated_at::text AS activated_at,
            to_char(current_period_start, 'YYYY-MM-DD') AS period_start,
            to_char(current_period_end, 'YYYY-MM-DD') AS period_end
       FROM payment_recurring_subscriptions WHERE id = $1`,
    [subId],
  );
  return rows[0]!;
}

async function outboxCountFor(invoiceUuid: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND (event->'payload')::text LIKE $2`,
    [tenantId, `%${invoiceUuid}%`],
  );
  return Number(rows[0]!.n);
}

type Scenario = {
  t: Integration;
  o: Integration;
  sub: Sub;
  invoiceId: string;
  paid: ReturnType<typeof invoiceBody>;
};

/** T (tenant-wide) and O (outlet) share `secret`. A subscription bound to O has
 * an open invoice. The `invoice.paid` event of that invoice is stored as a
 * MALFORMED row owned by T. */
async function malformedPaidEventOfO(secret: string): Promise<Scenario> {
  const t = await makeTenantWide(secret);
  const o = await makeOutletIntegration(secret);
  const sub = await seedSub(o.id);
  const invoiceId = `inv_${unique()}`;
  const created = await deliver(
    invoiceBody("invoice.created", sub, invoiceId),
    secret,
  );
  expect(created.status).toBe(200);
  expect(await invoicesOf(sub.subId)).toEqual([
    expect.objectContaining({ status: "open", review_reason: null }),
  ]);
  const paid = invoiceBody("invoice.paid", sub, invoiceId);
  await storeMalformedRow(paid.id, t.id);
  return { t, o, sub, invoiceId, paid };
}

/** The recovered event: one row still owned by T, bound to T and O, processed,
 * the invoice paid and the subscription active. */
async function expectRecoveredOnce(s: Scenario) {
  const rows = await rowsOf(s.paid.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "processed",
    integration_id: s.t.id,
  });
  expect(rows[0]!.last_error_code).not.toBe("INTEGRATION_MISMATCH");
  expect(rows[0]!.payload).not.toBeNull();
  expect([...(rows[0]!.verified_integration_ids ?? [])].sort()).toEqual(
    [s.t.id, s.o.id].sort(),
  );
  const invoices = await invoicesOf(s.sub.subId);
  expect(invoices).toHaveLength(1);
  expect(invoices[0]).toMatchObject({ status: "paid", review_reason: null });
  expect(invoices[0]!.paid_at).not.toBeNull();
  expect(await subState(s.sub.subId)).toMatchObject({
    status: "active",
    period_start: P_CUR,
    period_end: P_NEXT,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aj5tv a MALFORMED row of T recovered by a retry verified by the shared secret is processed with the stored T+O binding", () => {
  it("aj5tv-1 the renewal of a subscription bound to O is recorded once, on T's row, after T is disabled", async () => {
    const s = await malformedPaidEventOfO(
      `whsec-shared-${randomBytes(12).toString("hex")}`,
    );
    await disable(s.t);

    const response = await deliver(s.paid, s.o.secret);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectRecoveredOnce(s);
  });

  it("aj5tv-2 sweeps and a further resend change nothing: duplicate, no extra invoice, payment time or outbox event", async () => {
    const s = await malformedPaidEventOfO(
      `whsec-shared-${randomBytes(12).toString("hex")}`,
    );
    await disable(s.t);
    expect((await deliver(s.paid, s.o.secret)).status).toBe(200);
    await expectRecoveredOnce(s);

    const [invoice] = await invoicesOf(s.sub.subId);
    const before = {
      invoices: await invoicesOf(s.sub.subId),
      sub: await subState(s.sub.subId),
      outbox: await outboxCountFor(invoice!.id),
      rows: await rowsOf(s.paid.id),
    };

    await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 20 * MIN),
    );
    await reprocessParkedRecurringEvents(context(), new Date());
    await reprocessStoredWebhookEvents(
      context(),
      new Date(Date.now() + 60 * MIN),
      100,
    );
    await reprocessStoredWebhookEvents(context(), new Date(), 100);
    const again = await deliver(s.paid, s.o.secret);

    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");
    expect(await invoicesOf(s.sub.subId)).toEqual(before.invoices);
    expect(await subState(s.sub.subId)).toEqual(before.sub);
    expect(await outboxCountFor(invoice!.id)).toBe(before.outbox);
    expect(await rowsOf(s.paid.id)).toEqual(before.rows);
    await expectRecoveredOnce(s);
  });

  it("aj5tv-3 the shared secret is T's previous in-grace secret after T rotated: the renewal is still recorded once on T's row", async () => {
    const shared = `whsec-shared-${randomBytes(12).toString("hex")}`;
    const s = await malformedPaidEventOfO(shared);
    // T moves to a new secret: the shared one is now its previous secret and
    // still O's current one.
    await makeTenantWide(`whsec-rotated-${randomBytes(12).toString("hex")}`);
    await disable(s.t);

    const response = await deliver(s.paid, shared);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("processed");
    await expectRecoveredOnce(s);

    const again = await deliver(s.paid, shared);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");
    await expectRecoveredOnce(s);
  });
});

describe("aj5tv money guard: recovery never pays what the verifying integrations do not cover", () => {
  it("aj5tv-4 a subscription bound to a third integration X that did not verify the event is not paid", async () => {
    const shared = `whsec-shared-${randomBytes(12).toString("hex")}`;
    const t = await makeTenantWide(shared);
    await makeOutletIntegration(shared); // O: verifies, but owns no subscription here
    const x = await makeOutletIntegration(
      `whsec-x-${randomBytes(12).toString("hex")}`,
    );
    const sub = await seedSub(x.id);
    const invoiceId = `inv_${unique()}`;
    // The invoice was opened by X's own delivery.
    expect(
      (await deliver(invoiceBody("invoice.created", sub, invoiceId), x.secret))
        .status,
    ).toBe(200);
    const paid = invoiceBody("invoice.paid", sub, invoiceId);
    await storeMalformedRow(paid.id, t.id);
    await disable(t);

    await deliver(paid, shared);

    const rows = await rowsOf(paid.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ignored");
    expect(rows[0]!.last_error_code).toBe("INTEGRATION_MISMATCH");
    expect(rows[0]!.verified_integration_ids).not.toContain(x.id);
    const invoices = await invoicesOf(sub.subId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).not.toBe("paid");
    expect(await subState(sub.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
  });

  it("aj5tv-4 a recovered paid event whose amount differs from the invoice never settles it", async () => {
    const shared = `whsec-shared-${randomBytes(12).toString("hex")}`;
    const s = await malformedPaidEventOfO(shared);
    const wrong = invoiceBody(
      "invoice.paid",
      s.sub,
      s.invoiceId,
      PRICE + 1_000,
    );
    await storeMalformedRow(wrong.id, s.t.id);
    await disable(s.t);

    await deliver(wrong, shared);

    const invoices = await invoicesOf(s.sub.subId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).not.toBe("paid");
    expect(await subState(s.sub.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
  });
});
