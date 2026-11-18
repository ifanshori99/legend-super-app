// DOIT Recurring Billing: invoice webhooks, money invariants and routes
// (bead legend-6c6; PRD "Tagihan Berulang" / "Langganan Bulanan", tables
// `subscription_invoices` and friends). Written from docs/briefs/
// 6c6-recurring-billing-design.md, not from the implementation. Fail-first:
// the tables, the dispatch branch and the routes do not exist yet.
//
// Setup: plans, subscriptions and seed invoices are inserted as the migration
// owner; invoice events are delivered through the real Express app on the
// existing verified DOIT webhook route, signed exactly like DOIT signs
// (`PayBridge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + raw)>`).
//
// ASSUMED wire contract (verify in legend-s5c): envelope `{ id, type,
// created_at, data: { invoice } }`, types `invoice.created` / `invoice.paid`,
// invoice `{ id, subscription_id, plan_id, amount, currency, period_start,
// period_end, hosted_url, status, paid_at? }`.
//
// Assumptions where the brief is silent:
// - An `invoice.paid` with no stored invoice (no prior `invoice.created`) never
//   activates the subscription (the invoice must have been `open`).
// - A paid event whose amount differs from the stored invoice never activates;
//   the invoice is not marked `paid` (it may become `needs_review`).
// - Unknown subscription: the stored event ends `failed` or `ignored` with a
//   non-null `last_error_code`; the HTTP status is not pinned (200 or 5xx).
// - Responses use the repo envelope `{ data }`; list routes answer `data: []`
//   when empty. Cross-outlet access answers 403 or 404 (both hide the row).
// - Route shapes: POST/GET `/api/payments/recurring/plans`, GET
//   `/subscriptions/:id`, GET `/subscriptions/:id/invoices`. The owner role in
//   the test database must carry `payment.recurring.manage`.
// - Outbox rows are domain_event_outbox rows (appendNotificationEvent; the
//   worker consumer later turns them into notification_outbox rows), matched
//   by event name `subscription.invoice_created` and the invoice id inside
//   the event payload text.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env";
import { createApp } from "../app";
import {
  cancelSubscription,
  getSubscription,
  pauseSubscription,
  promoteDueSubscriptionPeriods,
  resumeSubscription,
  startSubscription,
  subscriptionHasAccess,
} from "../services/payment-recurring.service";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import { runPaymentGatewayPollJob } from "../worker/payment-gateway-poll.job";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";

const app = createApp();
// Two tenants for the main suite, plus the shared fixture tenant:
// - tenantW: dedicated to this file (created in beforeAll, removed in
//   afterAll). Every webhook/service-level test (REC-01..05, 07..12) runs here
//   with its own outlets and DOIT integrations, so parallel suites that share
//   the fixture tenant (payment-webhook-api deletes its gateway_webhook_events
//   rows) cannot interfere.
// - tenantB: a second dedicated tenant for the cross-tenant cases.
// - fixtureTenant: the cafe-legend fixture tenant, used ONLY by the REC-06
//   route tests, which need its seeded roles. Rows there are created and
//   deleted by id, never with tenant-wide deletes.
const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const fixtureOutlet = cafeLegendAccessFixtures.outletIds.bandung;
const fixtureOutletOther = cafeLegendAccessFixtures.outletIds.bandung2;
let tenantW = "";
let outletW = "";
let outletW2 = "";
const tenantB = randomUUID();
const actor = randomUUID();
const webhookPath = (tenantId: string) =>
  `/api/webhooks/payments/doit/${tenantId}`;
const base = "/api/payments/recurring";
const PRICE = 150_000;
const OUTBOX_EVENT = "subscription.invoice_created";

// Billing periods are derived from the Asia/Jakarta business date so that
// "the period has not ended yet" (fix round 1, finding 3) holds whenever the
// suite runs. P_CUR..P_NEXT is a valid monthly invoice period that ends after
// today; P_PREV..P_CUR is the period before it.
function jakartaMonthStart(monthOffset: number): string {
  const now = new Date(Date.now() + 7 * 3_600_000);
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1),
  );
  return d.toISOString().slice(0, 10);
}
const P_PREV = jakartaMonthStart(-1);
const P_CUR = jakartaMonthStart(0);
const P_NEXT = jakartaMonthStart(1);
const P_AFTER_NEXT = jakartaMonthStart(2);
// A long-finished month: its invoice can be paid late but never makes a
// subscription active again.
const P_OLD_START = "2025-01-01";
const P_OLD_END = "2025-02-01";
const P_OLD_NEXT = "2025-03-01";

const secretA = `whsec-rec-a-${randomBytes(16).toString("hex")}`;
const secretB = `whsec-rec-b-${randomBytes(16).toString("hex")}`;
// A second active DOIT integration of tenant A (outlet B), with its own secret.
const secretAOther = `whsec-rec-a2-${randomBytes(16).toString("hex")}`;
let integrationA = "";
let integrationAOther = "";
// REC-06 FK anchor. The plan/subscription rows that REC-06 seeds on the shared
// fixture tenant need a gateway_integration_id (FK by id only, no tenant or
// provider in the key). The anchor lives on OUR dedicated tenantW, never on the
// fixture tenant: payment-webhook-api and the integration suites list every
// tenant_integrations row of the fixture tenant and parse each one, so any
// row of ours there (an unparseable provider, or an "active" row without a full
// credential reference) breaks them with 422 "An active integration needs
// stored credentials". Disabled, a valid provider value no other test seeds on
// tenantW, no credentials. Deleted by id.
let integrationFixture = "";

let dedicatedTenant: SecondTenant;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const integrationIds: string[] = [];
const planIds: string[] = [];
const subIds: string[] = [];
const userIds: string[] = [];
let manager: ReturnType<typeof agent>;
let outletBOnly: ReturnType<typeof agent>;
let noRole: ReturnType<typeof agent>;

function contextFor(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function seedIntegration(
  tenantId: string,
  webhookSecret: string,
  outletId: string | null = null,
  baseUrl = "http://127.0.0.1:9",
): Promise<string> {
  const context = contextFor(tenantId);
  const created = await upsertIntegration(
    context,
    {
      outletId: outletId as OutletId | null,
      provider: "doit",
      // Never contacted unless a test passes a fake DOIT server url.
      config: { baseUrl },
      credentials: { apiKey: `doit-key-${unique()}`, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(context, created.id, { status: "active" }, actor);
  integrationIds.push(created.id);
  return created.id;
}

// Raw INSERT, never upsertIntegration (it would need credentials and DOIT
// config). Status 'disabled' so gateway selection can never choose it;
// outlet-less with provider 'wifi_vendor' (a member of INTEGRATION_PROVIDERS so
// listIntegrations can parse it, unlike an invented value) which no test seeds
// on tenantW, so neither unique index (tenant, provider[, outlet]) can clash.
// It is deliberately NOT in integrationIds: the afterAll intent/child cleanup
// scoped to integrationIds must not touch it; it is deleted by its own id.
async function seedFixtureAnchorIntegration(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenant_integrations (id, tenant_id, outlet_id, provider, config, status)
     VALUES ($1, $2, NULL, 'wifi_vendor', '{}'::jsonb, 'disabled')`,
    [id, tenantW],
  );
  const check = await owner.query<{ status: string }>(
    "SELECT status FROM tenant_integrations WHERE id = $1",
    [id],
  );
  if (check.rows[0]?.status !== "disabled")
    throw new Error("Fixture anchor integration must stay disabled");
  return id;
}

async function signedIn(label: string, scope: "tenant" | "outlet" | "none") {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  if (scope !== "none") {
    const role = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
      [fixtureTenant],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        fixtureTenant,
        userId,
        role.rows[0]!.id,
        scope,
        scope === "outlet" ? fixtureOutletOther : null,
      ],
    );
  }
  return client;
}

beforeAll(async () => {
  // The recurring routes answer 503 unless this gate is on (default off).
  env.DOIT_RECURRING_ENABLED = true;
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // Dedicated active tenant with two outlets, a brand and a legal entity.
  const dedicated = await createSecondTenant(owner, "recurring");
  tenantW = dedicated.tenantId;
  outletW = dedicated.outletId;
  outletW2 = randomUUID();
  dedicatedTenant = dedicated;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantW],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B2', 'Jl. B2', '{}')`,
    [
      outletW2,
      tenantW,
      dedicated.brandId,
      dedicated.legalEntityId,
      `ISO2-${unique()}`.toUpperCase(),
    ],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant B Recurring', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":["doit"]}', $3, $4)`,
    [
      tenantB,
      `uji-recurring-${unique()}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 30,
        maxDevices: 10,
        aiRequestsPerMonth: 3,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 10_000,
        emailCostCapIdr: 1_000,
      }),
      actor,
    ],
  );
  integrationA = await seedIntegration(tenantW, secretA);
  integrationAOther = await seedIntegration(tenantW, secretAOther, outletW2);
  await seedIntegration(tenantB, secretB);
  integrationFixture = await seedFixtureAnchorIntegration();
  manager = await signedIn("Recurring manager", "tenant");
  outletBOnly = await signedIn("Recurring outlet B", "outlet");
  noRole = await signedIn("Recurring no role", "none");
});

afterAll(async () => {
  // tenantW and tenantB belong to this file alone, so tenant-wide deletes are
  // safe for them. The fixture tenant is shared: only rows we created, by id.
  // Every step runs in its own try/catch so one failure cannot skip the rest
  // (a skipped step used to leave rows that broke other suites); the first
  // error is rethrown at the end so a leak still fails this file visibly.
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
  const ours = [tenantW, tenantB];
  const intents =
    "(SELECT id FROM payment_intents WHERE gateway_integration_id = ANY($1::uuid[]))";

  await step(
    query("DELETE FROM domain_event_outbox WHERE tenant_id = ANY($1::uuid[])", [
      ours,
    ]),
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
    query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = ANY($1::uuid[])",
      [ours],
    ),
  );
  await step(
    query(
      `DELETE FROM payment_evidence WHERE payment_intent_id IN ${intents}`,
      [integrationIds],
    ),
  );
  // Intents minted on our own integrations can carry children: clear every
  // FK child first, scoped to our integration ids.
  for (const table of [
    "payment_unallocated_funds",
    "payment_refunds",
    "reservation_deposit_allocations",
    "edc_transactions",
    "order_issue_charges",
  ])
    await step(
      query(`DELETE FROM ${table} WHERE payment_intent_id IN ${intents}`, [
        integrationIds,
      ]),
    );
  await step(
    query(
      `UPDATE reservations SET deposit_payment_id = NULL WHERE deposit_payment_id IN ${intents}`,
      [integrationIds],
    ),
  );
  await step(
    query(
      "DELETE FROM payment_intents WHERE gateway_integration_id = ANY($1::uuid[])",
      [integrationIds],
    ),
  );
  await step(
    query("DELETE FROM tenant_integrations WHERE id = ANY($1::uuid[])", [
      integrationIds,
    ]),
  );
  // Anchor row (tenantW): our own row, by id (plans above are already gone).
  await step(
    query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationFixture || randomUUID(),
    ]),
  );
  await step(
    query("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
      userIds,
    ]),
  );
  // Whatever else the services wrote for our two tenants (audit_logs is the
  // known one: audit_logs_outlet_fk blocked removeSecondTenant). audit_logs is
  // append-only (trigger guard_audit_log), so deletes run with triggers off
  // (session_replication_role = replica, owner role) inside one transaction per
  // tenant. The child tables are discovered from the foreign keys that point
  // at tenants/outlets/brands/legal_entities, so a new child table cannot
  // reintroduce the leak. Scoped to tenantW and tenantB only.
  for (const tenantId of ours) await step(() => sweepTenantRows(tenantId));
  await step(query("DELETE FROM tenants WHERE id = $1", [tenantB]));
  await step(() => removeSecondTenant(owner, dedicatedTenant));
  await step(() => owner.end());
  if (errors.length > 0) throw errors[0];
});

async function sweepTenantRows(tenantId: string): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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
      await client.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [tenantId]);
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

type Fx = {
  tenantId: string;
  outletId: string;
  planId: string;
  providerPlanId: string;
  subId: string;
  providerSubId: string;
};

type SubStatus =
  | "pending_first_payment"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "provisioning"
  | "needs_reconcile";

async function seedFixture(
  options: {
    status?: SubStatus;
    periodStart?: string | null;
    periodEnd?: string | null;
    price?: number;
    interval?: "month" | "week";
    /** DOIT integration the plan and subscription are bound to (fix round 1,
     * finding 1). Defaults to tenant A's tenant-wide integration. */
    gatewayIntegrationId?: string;
    /** Round 3: null stores a row without a provider subscription id (only
     * allowed for provisioning / needs_reconcile). The event helpers still
     * carry `fx.providerSubId`. */
    providerSubId?: string | null;
    /** Round 3: a paid-ahead period stored next to the current one. Written by
     * a separate UPDATE so seeds that do not use it never touch the new
     * columns. */
    nextPeriodStart?: string;
    nextPeriodEnd?: string;
    /** "fixture" seeds on the shared cafe-legend fixture tenant (REC-06 route
     * tests only); the default is this file's dedicated tenant. */
    on?: "dedicated" | "fixture";
  } = {},
): Promise<Fx> {
  const useFixture = options.on === "fixture";
  const fx: Fx = {
    tenantId: useFixture ? fixtureTenant : tenantW,
    outletId: useFixture ? fixtureOutlet : outletW,
    planId: randomUUID(),
    providerPlanId: `plan_${unique()}`,
    subId: randomUUID(),
    providerSubId: `sub_${unique()}`,
  };
  const gatewayIntegrationId =
    options.gatewayIntegrationId ??
    (useFixture ? integrationFixture : integrationA);
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', $5, $6, 'active', $7)`,
    [
      fx.planId,
      fx.tenantId,
      fx.outletId,
      fx.providerPlanId,
      options.price ?? PRICE,
      options.interval ?? "month",
      gatewayIntegrationId,
    ],
  );
  planIds.push(fx.planId);
  const status = options.status ?? "pending_first_payment";
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            current_period_start, current_period_end, activated_at, paused_at, cancelled_at, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9,
             CASE WHEN $7::varchar IN ('active','past_due','paused','cancelled') THEN now() - interval '40 days' END,
             CASE WHEN $7::varchar = 'paused' THEN now() END,
             CASE WHEN $7::varchar = 'cancelled' THEN now() END,
             $10)`,
    [
      fx.subId,
      fx.tenantId,
      fx.outletId,
      fx.planId,
      randomUUID(),
      options.providerSubId === null ? null : fx.providerSubId,
      status,
      options.periodStart ?? null,
      options.periodEnd ?? null,
      gatewayIntegrationId,
    ],
  );
  subIds.push(fx.subId);
  if (options.nextPeriodStart && options.nextPeriodEnd)
    await owner.query(
      `UPDATE payment_recurring_subscriptions SET next_period_start = $2, next_period_end = $3 WHERE id = $1`,
      [fx.subId, options.nextPeriodStart, options.nextPeriodEnd],
    );
  return fx;
}

type EventOptions = {
  eventId?: string;
  invoiceId: string;
  amount?: number;
  status?: "open" | "paid" | "void" | "expired";
  periodStart?: string;
  periodEnd?: string;
  providerSubId?: string;
};

function invoiceEvent(
  type: "invoice.created" | "invoice.paid",
  fx: Fx,
  o: EventOptions,
) {
  const status = o.status ?? (type === "invoice.paid" ? "paid" : "open");
  return {
    id: o.eventId ?? `evt_${randomBytes(8).toString("hex")}`,
    type,
    created_at: new Date().toISOString(),
    data: {
      invoice: {
        id: o.invoiceId,
        subscription_id: o.providerSubId ?? fx.providerSubId,
        plan_id: fx.providerPlanId,
        amount: o.amount ?? PRICE,
        currency: "IDR",
        period_start: o.periodStart ?? P_CUR,
        period_end: o.periodEnd ?? P_NEXT,
        hosted_url: `https://pay.doit.example/invoices/${o.invoiceId}`,
        status,
        ...(status === "paid" ? { paid_at: new Date().toISOString() } : {}),
      },
    },
  };
}

function signatureHeader(raw: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

async function deliver(
  body: object,
  options: { tenantId?: string; secret?: string; header?: string } = {},
) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(webhookPath(options.tenantId ?? tenantW))
    .set("Content-Type", "application/json")
    .set(
      "PayBridge-Signature",
      options.header ?? signatureHeader(raw, options.secret ?? secretA),
    )
    .send(raw);
}

type InvoiceRow = {
  id: string;
  status: string;
  amount_idr: number;
  review_reason: string | null;
  notified_at: Date | null;
  paid_at: Date | null;
  hosted_url: string;
  period_start: string;
  period_end: string;
  updated_at: string;
};

async function invoiceRows(providerInvoiceId: string): Promise<InvoiceRow[]> {
  const { rows } = await owner.query<InvoiceRow>(
    `SELECT id, status, amount_idr::int AS amount_idr, review_reason, notified_at, paid_at, hosted_url,
            to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end,
            updated_at::text AS updated_at
     FROM subscription_invoices
     WHERE provider_invoice_id = $1`,
    [providerInvoiceId],
  );
  return rows;
}

type SubRow = {
  status: string;
  period_start: string | null;
  period_end: string | null;
  activated_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
};

async function subRow(subId: string): Promise<SubRow> {
  const { rows } = await owner.query<SubRow>(
    `SELECT status,
            to_char(current_period_start, 'YYYY-MM-DD') AS period_start,
            to_char(current_period_end, 'YYYY-MM-DD') AS period_end,
            activated_at::text AS activated_at,
            cancelled_at::text AS cancelled_at,
            updated_at::text AS updated_at
     FROM payment_recurring_subscriptions WHERE id = $1`,
    [subId],
  );
  return rows[0]!;
}

async function outboxCount(subscriptionInvoiceId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND (event->'payload')::text LIKE $3`,
    [tenantW, OUTBOX_EVENT, `%${subscriptionInvoiceId}%`],
  );
  return Number(rows[0]!.n);
}

async function outboxPayload(subscriptionInvoiceId: string) {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND (event->'payload')::text LIKE $3`,
    [tenantW, OUTBOX_EVENT, `%${subscriptionInvoiceId}%`],
  );
  return rows[0]?.payload;
}

async function webhookEvent(tenantId: string, eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
  }>(
    "SELECT status, last_error_code FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
    [tenantId, eventId],
  );
  return rows;
}

/** Stores an open invoice through a verified invoice.created event. */
async function createInvoice(fx: Fx, o: Partial<EventOptions> = {}) {
  const invoiceId = o.invoiceId ?? `inv_${unique()}`;
  const response = await deliver(
    invoiceEvent("invoice.created", fx, { ...o, invoiceId }),
  );
  expect(response.status).toBe(200);
  const [row] = await invoiceRows(invoiceId);
  return { invoiceId, row };
}

// ---------------------------------------------------------------------------
// invoice.created
// ---------------------------------------------------------------------------

describe("REC-01 invoice.created stores the invoice and notifies the customer once", () => {
  it("REC-01 a verified invoice.created stores an open invoice and queues one notification", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });

    const rows = await invoiceRows(body.data.invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "open",
      amount_idr: PRICE,
      review_reason: null,
      hosted_url: body.data.invoice.hosted_url,
      period_start: P_CUR,
      period_end: P_NEXT,
    });
    expect(rows[0]!.notified_at).not.toBeNull();
    const { rows: outboxDump } = await owner.query(
      `SELECT event->>'name' AS event_type, left((event->'payload')::text, 200) AS payload FROM domain_event_outbox
       WHERE tenant_id = $1 LIMIT 5`,
      [tenantW],
    );
    expect(
      await outboxCount(rows[0]!.id),
      `no ${OUTBOX_EVENT} outbox row; latest outbox rows: ${JSON.stringify(outboxDump)}`,
    ).toBe(1);
    expect(await outboxPayload(rows[0]!.id)).toMatchObject({
      subscriptionInvoiceId: rows[0]!.id,
      subscriptionId: fx.subId,
      amountIdr: PRICE,
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      hostedUrl: body.data.invoice.hosted_url,
    });
  });

  it("REC-01 invoice.created never activates the subscription", async () => {
    const fx = await seedFixture();
    await createInvoice(fx);
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      period_start: null,
      period_end: null,
      activated_at: null,
    });
  });

  it("REC-01 the same event id delivered twice stores one invoice and notifies once", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    expect((await deliver(body)).status).toBe(200);
    const second = await deliver(body);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");

    const rows = await invoiceRows(body.data.invoice.id);
    expect(rows).toHaveLength(1);
    expect(await outboxCount(rows[0]!.id)).toBe(1);
  });

  it("REC-01 a replay of the invoice under a new event id does not notify again", async () => {
    const fx = await seedFixture();
    const invoiceId = `inv_${unique()}`;
    const { row } = await createInvoice(fx, { invoiceId });
    const notifiedAt = row!.notified_at;
    expect(notifiedAt).not.toBeNull();

    expect(
      (await deliver(invoiceEvent("invoice.created", fx, { invoiceId })))
        .status,
    ).toBe(200);
    const rows = await invoiceRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notified_at).toEqual(notifiedAt);
    expect(await outboxCount(rows[0]!.id)).toBe(1);
  });

  it("REC-01 concurrent deliveries of one invoice.created store and notify once", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    const responses = await Promise.all([deliver(body), deliver(body)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const rows = await invoiceRows(body.data.invoice.id);
    expect(rows).toHaveLength(1);
    expect(await outboxCount(rows[0]!.id)).toBe(1);
  });

  // Changed in fix round 1 (finding 4): a second invoice for a taken period is
  // no longer dropped, it is kept visible as needs_review / DUPLICATE_PERIOD.
  // The full duplicate-period cases live in REC-07.
  it("REC-01 two open invoices for one period never both stay open", async () => {
    const fx = await seedFixture();
    await createInvoice(fx, { invoiceId: `inv_${unique()}` });
    await deliver(
      invoiceEvent("invoice.created", fx, { invoiceId: `inv_${unique()}` }),
    );
    const { rows } = await owner.query(
      "SELECT 1 FROM subscription_invoices WHERE subscription_id = $1 AND period_start = $2 AND status IN ('open','paid')",
      [fx.subId, P_CUR],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("REC-02 amount mismatch is parked for review", () => {
  it("REC-02 an invoice whose amount differs from the plan price is needs_review without notification", async () => {
    const fx = await seedFixture();
    const { row } = await createInvoice(fx, { amount: PRICE - 50_000 });
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "AMOUNT_MISMATCH",
      amount_idr: PRICE - 50_000,
    });
    expect(row!.notified_at).toBeNull();
    expect(await outboxCount(row!.id)).toBe(0);
  });

  it("REC-02 paying a needs_review invoice never activates the subscription", async () => {
    const fx = await seedFixture();
    const wrong = PRICE - 50_000;
    const { invoiceId } = await createInvoice(fx, { amount: wrong });
    const paid = await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, amount: wrong }),
    );
    expect(paid.status).toBe(200);
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
    const [row] = await invoiceRows(invoiceId);
    expect(row!.status).toBe("needs_review");
  });
});

// ---------------------------------------------------------------------------
// invoice.paid
// ---------------------------------------------------------------------------

describe("REC-03 invoice.paid activates only when verified, open and matching", () => {
  it("REC-03 the first paid invoice moves pending_first_payment to active with the invoice period", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    const response = await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, status: "processed" });

    expect(await subRow(fx.subId)).toMatchObject({
      status: "active",
      period_start: P_CUR,
      period_end: P_NEXT,
    });
    expect((await subRow(fx.subId)).activated_at).not.toBeNull();
    const [row] = await invoiceRows(invoiceId);
    expect(row!.status).toBe("paid");
    expect(row!.paid_at).not.toBeNull();
  });

  it("REC-03 a paid event whose amount differs from the stored invoice never activates", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, amount: PRICE + 1 }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
    const [row] = await invoiceRows(invoiceId);
    // Money did arrive with the wrong amount: the invoice is parked for
    // review with paid_at recorded, and never settled as paid.
    expect(row!.status).toBe("needs_review");
    expect(row!.paid_at).not.toBeNull();
  });

  it("REC-03 an event carrying a non-paid invoice status never activates", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, status: "open" }),
    );
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
    expect((await invoiceRows(invoiceId))[0]!.status).not.toBe("paid");
  });

  it("REC-03 a paid event for an invoice that was never stored does not activate", async () => {
    const fx = await seedFixture();
    await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId: `inv_${unique()}` }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
  });

  it("REC-03 an invoice that is no longer open (void) is not paid by a late event", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    await owner.query(
      "UPDATE subscription_invoices SET status = 'void' WHERE provider_invoice_id = $1",
      [invoiceId],
    );
    await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
    // Assumption: the brief does not say what a paid event does to a void
    // invoice. Money was received, so parking it as needs_review (as for a
    // cancelled subscription) is as safe as leaving it void. Pinned: it is
    // never `paid` and never activates the subscription.
    expect(["void", "needs_review"]).toContain(
      (await invoiceRows(invoiceId))[0]!.status,
    );
  });

  it("REC-03 a later paid invoice advances the period and moves past_due back to active", async () => {
    const fx = await seedFixture({
      status: "past_due",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_CUR,
        periodEnd: P_NEXT,
      }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "active",
      period_start: P_CUR,
      period_end: P_NEXT,
    });
  });

  it("REC-03 the same paid event id twice does not advance the period again", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx);
    const paid = invoiceEvent("invoice.paid", fx, { invoiceId });
    expect((await deliver(paid)).status).toBe(200);
    const after = await subRow(fx.subId);
    expect(after).toMatchObject({
      period_start: P_CUR,
      period_end: P_NEXT,
    });
    const replay = await deliver(paid);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("duplicate");
    expect(await subRow(fx.subId)).toEqual(after);
  });

  it("REC-03 a replayed paid invoice under a new event id changes nothing", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx);
    await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
    const subAfter = await subRow(fx.subId);
    const [invoiceAfter] = await invoiceRows(invoiceId);

    expect(
      (await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }))).status,
    ).toBe(200);
    expect(await subRow(fx.subId)).toEqual(subAfter);
    expect((await invoiceRows(invoiceId))[0]).toEqual(invoiceAfter);
  });

  it("REC-03 concurrent paid deliveries under different event ids settle once", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx);
    const responses = await Promise.all([
      deliver(invoiceEvent("invoice.paid", fx, { invoiceId })),
      deliver(invoiceEvent("invoice.paid", fx, { invoiceId })),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await subRow(fx.subId)).toMatchObject({
      status: "active",
      period_start: P_CUR,
      period_end: P_NEXT,
    });
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Paused and cancelled subscriptions
// ---------------------------------------------------------------------------

describe("REC-04 paused and cancelled subscriptions", () => {
  it("REC-04 an invoice for a paused subscription is stored but not notified", async () => {
    const fx = await seedFixture({
      status: "paused",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { row } = await createInvoice(fx);
    expect(row).toBeDefined();
    expect(row!.status).toBe("open");
    expect(row!.notified_at).toBeNull();
    expect(await outboxCount(row!.id)).toBe(0);
    expect((await subRow(fx.subId)).status).toBe("paused");
  });

  it("REC-04 an invoice for a cancelled subscription is stored but not notified", async () => {
    const fx = await seedFixture({
      status: "cancelled",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { row } = await createInvoice(fx);
    expect(row!.notified_at).toBeNull();
    expect(await outboxCount(row!.id)).toBe(0);
  });

  it("REC-04 a paid invoice on a cancelled subscription is needs_review and never reactivates", async () => {
    const fx = await seedFixture({
      status: "cancelled",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const before = await subRow(fx.subId);
    const { invoiceId } = await createInvoice(fx);
    const response = await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId }),
    );
    expect(response.status).toBe(200);
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("needs_review");
    const after = await subRow(fx.subId);
    expect(after.status).toBe("cancelled");
    expect(after.cancelled_at).toBe(before.cancelled_at);
    expect(after.period_start).toBe(before.period_start);
    expect(after.period_end).toBe(before.period_end);
  });
});

// ---------------------------------------------------------------------------
// Verification and tenant derivation
// ---------------------------------------------------------------------------

describe("REC-05 signature and tenant derivation", () => {
  it("REC-05 a bad signature answers 401 and stores no invoice", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    const response = await deliver(body, { secret: "not-the-tenant-secret" });
    expect(response.status).toBe(401);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
  });

  it("REC-05 a body changed after signing answers 401 and cannot activate", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    const signed = invoiceEvent("invoice.paid", fx, { invoiceId });
    const header = signatureHeader(JSON.stringify(signed), secretA);
    const tampered = invoiceEvent("invoice.paid", fx, {
      invoiceId,
      eventId: signed.id,
      amount: PRICE,
      periodEnd: "2027-12-01",
    });
    const response = await deliver(tampered, { header });
    expect(response.status).toBe(401);
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
  });

  it("REC-05 an unsigned delivery answers 401", async () => {
    const fx = await seedFixture();
    const response = await request(app)
      .post(webhookPath(tenantW))
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify(
          invoiceEvent("invoice.created", fx, { invoiceId: `inv_${unique()}` }),
        ),
      );
    expect(response.status).toBe(401);
  });

  it("REC-05 an event for tenant A's subscription sent to tenant B's webhook creates nothing", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    // Correctly signed for tenant B: verification passes, the subscription
    // lookup is scoped to tenant B and finds nothing.
    await deliver(body, { tenantId: tenantB, secret: secretB });
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
    const stored = await webhookEvent(tenantB, body.id);
    expect(
      stored.every((row) => ["failed", "ignored"].includes(row.status)),
    ).toBe(true);
  });

  it("REC-05 tenant A's secret does not verify on tenant B's webhook", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    const response = await deliver(body, {
      tenantId: tenantB,
      secret: secretA,
    });
    expect(response.status).toBe(401);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
  });

  it("REC-05 an unknown subscription creates no row and the event is marked with an error code", async () => {
    const fx = await seedFixture();
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
      providerSubId: `sub_missing_${unique()}`,
    });
    await deliver(body);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
    const [stored, ...rest] = await webhookEvent(tenantW, body.id);
    expect(rest).toEqual([]);
    expect(["failed", "ignored"]).toContain(stored!.status);
    expect(stored!.last_error_code).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routes: permission, outlet scope, validation, empty state
// ---------------------------------------------------------------------------

// Route tests run on the fixture tenant (it carries the seeded roles). They
// seed plans, subscriptions and invoices directly by id and never deliver
// webhooks, so they touch no tenant-wide state shared with other suites.
const onFixture = { on: "fixture" } as const;

describe("REC-06 recurring routes", () => {
  it("REC-06 every route requires a session", async () => {
    const fx = await seedFixture(onFixture);
    expect((await agent(app).get(`${base}/plans`)).status).toBe(401);
    expect(
      (await agent(app).get(`${base}/subscriptions/${fx.subId}`)).status,
    ).toBe(401);
    expect(
      (await agent(app).post(`${base}/plans`).set(originHeader).send({}))
        .status,
    ).toBe(401);
  });

  it("REC-06 a signed-in user without the recurring permission is refused", async () => {
    const fx = await seedFixture(onFixture);
    const list = await noRole.get(`${base}/plans?outletId=${fixtureOutlet}`);
    expect(list.status).toBe(403);
    const sub = await noRole.get(`${base}/subscriptions/${fx.subId}`);
    expect(sub.status).toBe(403);
    expect(JSON.stringify(sub.body)).not.toContain(fx.providerSubId);
  });

  it("REC-06 a tenant-wide manager reads a subscription, its plan list and its invoices", async () => {
    const fx = await seedFixture(onFixture);
    const invoiceRowId = randomUUID();
    await seedInvoiceRow(fx, {
      id: invoiceRowId,
      status: "open",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const sub = await manager.get(`${base}/subscriptions/${fx.subId}`);
    expect(sub.status).toBe(200);
    expect(sub.body.data.id).toBe(fx.subId);
    expect(sub.body.data.status).toBe("pending_first_payment");

    const plans = await manager.get(`${base}/plans?outletId=${fixtureOutlet}`);
    expect(plans.status).toBe(200);
    expect(plans.body.data.map((p: { id: string }) => p.id)).toContain(
      fx.planId,
    );

    const invoices = await manager.get(
      `${base}/subscriptions/${fx.subId}/invoices`,
    );
    expect(invoices.status).toBe(200);
    expect(Array.isArray(invoices.body.data)).toBe(true);
    expect(invoices.body.data.map((i: { id: string }) => i.id)).toContain(
      invoiceRowId,
    );
  });

  it("REC-06 a manager scoped to another outlet cannot read this outlet's subscription or invoices", async () => {
    const fx = await seedFixture(onFixture);
    await seedInvoiceRow(fx, {
      status: "open",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const sub = await outletBOnly.get(`${base}/subscriptions/${fx.subId}`);
    expect([403, 404]).toContain(sub.status);
    expect(JSON.stringify(sub.body)).not.toContain(fx.providerSubId);
    const invoices = await outletBOnly.get(
      `${base}/subscriptions/${fx.subId}/invoices`,
    );
    expect([403, 404]).toContain(invoices.status);
    const plans = await outletBOnly.get(
      `${base}/plans?outletId=${fixtureOutlet}`,
    );
    expect([403, 404]).toContain(plans.status);
  });

  it("REC-06 the outlet-scoped manager sees an empty plan list for its own outlet", async () => {
    // No plan is ever seeded on outlet B.
    const plans = await outletBOnly.get(
      `${base}/plans?outletId=${fixtureOutletOther}`,
    );
    expect(plans.status).toBe(200);
    expect(plans.body.data).toEqual([]);
  });

  it("REC-06 an unknown subscription id answers 404 NOT_FOUND", async () => {
    const response = await manager.get(`${base}/subscriptions/${randomUUID()}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("REC-06 a malformed subscription id is rejected by validation", async () => {
    const response = await manager.get(`${base}/subscriptions/not-a-uuid`);
    expect(response.status).toBe(422);
  });

  it("REC-06 plan creation rejects a client-supplied tenant, a non-positive price and a bad interval", async () => {
    const valid = {
      outletId: fixtureOutlet,
      name: "Paket Uji",
      amountIdr: PRICE,
      interval: "month",
    };
    const injected = await manager
      .post(`${base}/plans`)
      .set(originHeader)
      .send({ ...valid, tenantId: randomUUID() });
    expect(injected.status).toBe(422);
    for (const bad of [
      { ...valid, amountIdr: 0 },
      { ...valid, amountIdr: -1 },
      { ...valid, amountIdr: 1000.5 },
      { ...valid, interval: "year" },
    ]) {
      const response = await manager
        .post(`${base}/plans`)
        .set(originHeader)
        .send(bad);
      expect(response.status).toBe(422);
    }
  });

  it("REC-06 plan creation without the web origin is refused", async () => {
    const response = await manager.post(`${base}/plans`).send({
      outletId: fixtureOutlet,
      name: "Paket Uji",
      amountIdr: PRICE,
      interval: "month",
    });
    expect([401, 403]).toContain(response.status);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (architect findings 1, 2, 3, 4, 5, 7)
// ---------------------------------------------------------------------------
// ASSUMPTIONS (the brief names the codes, not every observable):
// - Rejections store the invoice as `needs_review` with `review_reason` equal
//   to the named code (PERIOD_MISMATCH, DUPLICATE_PERIOD) and never notify.
// - INTEGRATION_MISMATCH is recorded on the stored webhook event
//   (`last_error_code`, status failed or ignored); the HTTP status is not
//   pinned. Nothing else changes.
// - A "late" invoice period (already over) is paid but does not make a
//   subscription `active`; whether the stored period also moves is not pinned.

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Seeds an invoice row directly (owner), to set up an already-taken period. */
async function seedInvoiceRow(
  fx: Fx,
  o: {
    status: "open" | "paid" | "void";
    periodStart: string;
    periodEnd: string;
    providerInvoiceId?: string;
    id?: string;
  },
): Promise<string> {
  const providerInvoiceId = o.providerInvoiceId ?? `inv_${unique()}`;
  await owner.query(
    `INSERT INTO subscription_invoices (id, tenant_id, outlet_id, subscription_id, provider_invoice_id, period_start, period_end,
            amount_idr, hosted_url, status, source_event_id, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::varchar, $11,
             CASE WHEN $10::varchar = 'paid' THEN now() END)`,
    [
      o.id ?? randomUUID(),
      fx.tenantId,
      fx.outletId,
      fx.subId,
      providerInvoiceId,
      o.periodStart,
      o.periodEnd,
      PRICE,
      `https://pay.doit.example/invoices/${providerInvoiceId}`,
      o.status,
      randomUUID(),
    ],
  );
  return providerInvoiceId;
}

describe("REC-07 an invoice for an already-taken period is kept visible, never dropped", () => {
  it("REC-07 a second invoice for a period that already has an open invoice is needs_review DUPLICATE_PERIOD", async () => {
    const fx = await seedFixture();
    const first = await createInvoice(fx);
    const { invoiceId: secondId, row: second } = await createInvoice(fx);
    expect(secondId).not.toBe(first.invoiceId);
    expect(second).toBeDefined();
    expect(second).toMatchObject({
      status: "needs_review",
      review_reason: "DUPLICATE_PERIOD",
    });
    expect(second!.notified_at).toBeNull();
    expect(await outboxCount(second!.id)).toBe(0);
    // The first invoice is untouched.
    expect((await invoiceRows(first.invoiceId))[0]).toMatchObject({
      status: "open",
      review_reason: null,
    });
    expect(await outboxCount(first.row!.id)).toBe(1);
  });

  it("REC-07 a new invoice for a period that is already paid is stored needs_review, and paying it changes nothing", async () => {
    const fx = await seedFixture();
    await seedInvoiceRow(fx, {
      status: "paid",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const before = await subRow(fx.subId);
    const { invoiceId, row } = await createInvoice(fx);
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "DUPLICATE_PERIOD",
    });
    expect(row!.notified_at).toBeNull();

    const paid = await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
    expect(paid.status).toBe(200);
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("needs_review");
    expect(await subRow(fx.subId)).toEqual(before);
  });

  it("REC-07 a void invoice does not take its period: a new invoice for it is a normal open invoice", async () => {
    const fx = await seedFixture();
    await seedInvoiceRow(fx, {
      status: "void",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const { row } = await createInvoice(fx);
    expect(row).toMatchObject({ status: "open", review_reason: null });
    expect(row!.notified_at).not.toBeNull();
    expect(await outboxCount(row!.id)).toBe(1);
  });
});

describe("REC-08 the invoice period must match the plan interval and continue the subscription", () => {
  it("REC-08 a monthly plan invoice whose period is not one calendar month is needs_review PERIOD_MISMATCH", async () => {
    const fx = await seedFixture();
    const { row } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd: addDays(P_CUR, 7),
    });
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    expect(row!.notified_at).toBeNull();
    expect(await outboxCount(row!.id)).toBe(0);
  });

  it("REC-08 paying a period-mismatched invoice never activates the subscription", async () => {
    const fx = await seedFixture();
    const periodEnd = addDays(P_CUR, 7);
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd,
    });
    const paid = await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_CUR,
        periodEnd,
      }),
    );
    expect(paid.status).toBe(200);
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
      period_start: null,
      period_end: null,
    });
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("needs_review");
  });

  it("REC-08 a weekly plan accepts a 7-day period and rejects a month-long one", async () => {
    const fx = await seedFixture({ interval: "week" });
    const ok = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd: addDays(P_CUR, 7),
    });
    expect(ok.row).toMatchObject({ status: "open", review_reason: null });
    expect(ok.row!.notified_at).not.toBeNull();

    const other = await seedFixture({ interval: "week" });
    const bad = await createInvoice(other, {
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    expect(bad.row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    expect(bad.row!.notified_at).toBeNull();
  });

  it("REC-08 an invoice that starts where the current period ends is accepted", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { row } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    expect(row).toMatchObject({ status: "open", review_reason: null });
    expect(row!.notified_at).not.toBeNull();
  });

  it("REC-08 an invoice that skips a period (gap after the current period end) is PERIOD_MISMATCH and never activates", async () => {
    const fx = await seedFixture({
      status: "past_due",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId, row } = await createInvoice(fx, {
      periodStart: P_NEXT,
      periodEnd: P_AFTER_NEXT,
    });
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    expect(row!.notified_at).toBeNull();

    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_NEXT,
        periodEnd: P_AFTER_NEXT,
      }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "past_due",
      period_start: P_PREV,
      period_end: P_CUR,
    });
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("needs_review");
  });

  it("REC-08 an invoice for a period that already ended before the current period end is PERIOD_MISMATCH", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const { row } = await createInvoice(fx, {
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    expect(row!.notified_at).toBeNull();
  });
});

describe("REC-09 a paid invoice whose period is already over does not make the subscription active", () => {
  it("REC-09 a past_due subscription paid for a finished month stays past_due, the invoice is paid", async () => {
    const fx = await seedFixture({
      status: "past_due",
      periodStart: P_OLD_START,
      periodEnd: P_OLD_END,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_OLD_END,
      periodEnd: P_OLD_NEXT,
    });
    const paid = await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_OLD_END,
        periodEnd: P_OLD_NEXT,
      }),
    );
    expect(paid.status).toBe(200);
    expect((await subRow(fx.subId)).status).toBe("past_due");
    const [row] = await invoiceRows(invoiceId);
    expect(row!.status).toBe("paid");
    expect(row!.paid_at).not.toBeNull();
  });

  it("REC-09 a first payment for a finished month does not activate a pending subscription", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_OLD_START,
      periodEnd: P_OLD_END,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_OLD_START,
        periodEnd: P_OLD_END,
      }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });
});

describe("REC-10 the invoice must be signed by the integration the subscription belongs to", () => {
  function mismatchCode(eventId: string) {
    return webhookEvent(tenantW, eventId);
  }

  it("REC-10 an invoice.created signed by another active integration of the tenant stores nothing", async () => {
    const fx = await seedFixture(); // bound to integration A
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    const response = await deliver(body, { secret: secretAOther });
    // The signature is valid for the tenant (so not 401); the binding is not.
    expect(response.status).not.toBe(401);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
    const [stored, ...rest] = await mismatchCode(body.id);
    expect(rest).toEqual([]);
    expect(
      stored,
      `no gateway_webhook_events row; HTTP ${response.status} ${JSON.stringify(response.body)}`,
    ).toBeDefined();
    expect(["failed", "ignored"]).toContain(stored!.status);
    expect(stored!.last_error_code).toBe("INTEGRATION_MISMATCH");
  });

  it("REC-10 an invoice.paid signed by another integration never activates and changes nothing", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    const invoiceBefore = (await invoiceRows(invoiceId))[0];
    const subBefore = await subRow(fx.subId);

    const paid = invoiceEvent("invoice.paid", fx, { invoiceId });
    await deliver(paid, { secret: secretAOther });

    expect(await subRow(fx.subId)).toEqual(subBefore);
    expect((await invoiceRows(invoiceId))[0]).toEqual(invoiceBefore);
    const [stored] = await mismatchCode(paid.id);
    expect(["failed", "ignored"]).toContain(stored!.status);
    expect(stored!.last_error_code).toBe("INTEGRATION_MISMATCH");
  });

  it("REC-10 a subscription bound to the other integration accepts events signed by it, and refuses the tenant-wide one", async () => {
    const fx = await seedFixture({ gatewayIntegrationId: integrationAOther });

    const accepted = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    expect((await deliver(accepted, { secret: secretAOther })).status).toBe(
      200,
    );
    const [row] = await invoiceRows(accepted.data.invoice.id);
    expect(row).toMatchObject({ status: "open", review_reason: null });

    const refused = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    await deliver(refused, { secret: secretA });
    expect(await invoiceRows(refused.data.invoice.id)).toHaveLength(0);
    const [stored] = await mismatchCode(refused.id);
    expect(stored!.last_error_code).toBe("INTEGRATION_MISMATCH");
  });
});

describe("REC-11 cancel wins over a payment that lands while DOIT is being called", () => {
  it("REC-11 a subscription activated by invoice.paid during the DOIT cancel call still ends cancelled", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    let cancelCalls = 0;
    const clientFor = async () =>
      ({
        cancelSubscription: async () => {
          cancelCalls += 1;
          // The verified payment arrives while the cancel call is in flight.
          const paid = await deliver(
            invoiceEvent("invoice.paid", fx, { invoiceId }),
          );
          expect(paid.status).toBe(200);
          // Round 3 (item 10): DOIT's answer is checked (id + status).
          return { id: fx.providerSubId, status: "cancelled" };
        },
      }) as never;

    const result = await cancelSubscription(
      contextFor(tenantW),
      fx.subId,
      new Date(),
      { clientFor },
    );

    expect(cancelCalls).toBe(1);
    expect(result.status).toBe("cancelled");
    const after = await subRow(fx.subId);
    expect(after.status).toBe("cancelled");
    expect(after.cancelled_at).not.toBeNull();
    // The money is not hidden: the invoice that raced in is recorded as paid.
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });
});

describe("REC-12 a subscription can only be started for a live customer profile of the tenant", () => {
  const profileIds: string[] = [];
  const profileUserIds: string[] = [];

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan uji', $2, true)`,
      [id, `${id}@example.test`],
    );
    profileUserIds.push(id);
    return id;
  }

  async function insertProfile(
    tenantId: string,
    userId: string | null,
    status: "active" | "closed",
    mergedInto: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, merged_into_profile_id, whatsapp_verified_at)
       VALUES ($1, $2, $3, 'Pelanggan uji', $4::varchar, $5,
               CASE WHEN $4::varchar = 'active' THEN now() END)`,
      [id, tenantId, userId, status, mergedInto],
    );
    profileIds.push(id);
    return id;
  }

  afterAll(async () => {
    await owner.query(
      "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[]) AND merged_into_profile_id IS NOT NULL",
      [profileIds],
    );
    await owner.query(
      "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[])",
      [profileIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      profileUserIds,
    ]);
  });

  async function expectRefused(customerProfileId: string): Promise<void> {
    const fx = await seedFixture();
    let doitCalls = 0;
    const clientFor = async () =>
      ({
        createSubscription: async () => {
          doitCalls += 1;
          throw new Error("DOIT_CALLED");
        },
      }) as never;

    const error = await startSubscription(
      contextFor(tenantW),
      {
        planId: fx.planId,
        customerProfileId,
        idempotencyKey: `idem-${unique()}`,
      },
      { clientFor },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toBe("DOIT_CALLED");
    // 404 or 422, never a 5xx.
    const status = (error as { status?: number }).status;
    if (status !== undefined) expect([404, 422]).toContain(status);
    expect(doitCalls).toBe(0);
    const { rows } = await owner.query(
      // seedFixture already inserted fx.subId for this plan: only a NEW
      // subscription row means the refused start went through.
      "SELECT 1 FROM payment_recurring_subscriptions WHERE plan_id = $1 AND id <> $2",
      [fx.planId, fx.subId],
    );
    expect(rows).toHaveLength(0);
  }

  it("REC-12 an unknown customer profile is refused before DOIT is called", async () => {
    await expectRefused(randomUUID());
  });

  it("REC-12 another tenant's customer profile is refused before DOIT is called", async () => {
    const profileB = await insertProfile(tenantB, await insertUser(), "active");
    await expectRefused(profileB);
  });

  it("REC-12 a customer profile merged into another is refused before DOIT is called", async () => {
    const target = await insertProfile(tenantW, await insertUser(), "active");
    const merged = await insertProfile(tenantW, null, "closed", target);
    await expectRefused(merged);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 (architect round 2, findings 2, 3, 5, 6, 7; 1 and 8 live in
// payment-webhook-api.test.ts and payment-doit-recurring-wire.test.ts).
// Money rule: when in doubt, the choice that limits payment/access.
// ASSUMPTIONS:
// - Finding 2: two active integrations of the tenant may share one webhook
//   secret; an event signed with it is verified for both, so a subscription
//   bound to either one must accept it. The rotated-secret case is not
//   expressible without the rotation API of the integration service: not
//   covered here.
// - Finding 7: `deps.clientFor` receives the integration (id or row) it must
//   build the DOIT client for. Its argument shape is not pinned: the fake
//   records its arguments and the test looks for the integration id in them.
//   The fake throws once built, so nothing is sent to DOIT.
// ---------------------------------------------------------------------------

function jakartaToday(): string {
  return new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  });
}

describe("REC-13 an event verified by the integration the subscription is bound to is accepted", () => {
  let outletW3 = "";
  let integrationShared = "";

  beforeAll(async () => {
    outletW3 = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, 'Outlet B3', 'Jl. B3', '{}')`,
      [
        outletW3,
        tenantW,
        dedicatedTenant.brandId,
        dedicatedTenant.legalEntityId,
        `ISO3-${unique()}`.toUpperCase(),
      ],
    );
    // A second active integration of tenant A that shares tenant A's secret.
    integrationShared = await seedIntegration(tenantW, secretA, outletW3);
  });

  it("REC-13 a subscription bound to the integration that shares a secret accepts an event signed with it", async () => {
    const fx = await seedFixture({ gatewayIntegrationId: integrationShared });
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    const response = await deliver(body, { secret: secretA });
    expect(response.status).toBe(200);
    const [row] = await invoiceRows(body.data.invoice.id);
    expect(row).toMatchObject({ status: "open", review_reason: null });
    expect(row!.notified_at).not.toBeNull();
    const [stored] = await webhookEvent(tenantW, body.id);
    expect(stored!.last_error_code).toBeNull();
  });

  it("REC-13 the integration that shares the secret does not lose the subscription bound to the tenant-wide one", async () => {
    const fx = await seedFixture(); // bound to integration A
    const { invoiceId } = await createInvoice(fx);
    const paid = await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
    expect(paid.status).toBe(200);
    expect((await subRow(fx.subId)).status).toBe("active");
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });

  it("REC-13 an invoice.paid signed with the shared secret activates a subscription bound to the sharing integration", async () => {
    const fx = await seedFixture({ gatewayIntegrationId: integrationShared });
    const created = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    expect((await deliver(created, { secret: secretA })).status).toBe(200);
    const paid = invoiceEvent("invoice.paid", fx, {
      invoiceId: created.data.invoice.id,
    });
    expect((await deliver(paid, { secret: secretA })).status).toBe(200);
    expect((await subRow(fx.subId)).status).toBe("active");
  });

  it("REC-13 a secret that belongs to no integration the subscription is bound to is still INTEGRATION_MISMATCH", async () => {
    const fx = await seedFixture({ gatewayIntegrationId: integrationShared });
    const body = invoiceEvent("invoice.created", fx, {
      invoiceId: `inv_${unique()}`,
    });
    await deliver(body, { secret: secretAOther });
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
    const [stored] = await webhookEvent(tenantW, body.id);
    expect(stored!.last_error_code).toBe("INTEGRATION_MISMATCH");
  });
});

describe("REC-14 a paid event on a needs_review invoice records the payment and never activates", () => {
  const paidAt = async (providerInvoiceId: string) =>
    (await invoiceRows(providerInvoiceId))[0]!.paid_at;

  it("REC-14 an AMOUNT_MISMATCH invoice that is paid keeps needs_review, gets paid_at and never activates", async () => {
    const fx = await seedFixture();
    const wrong = PRICE - 50_000;
    const { invoiceId } = await createInvoice(fx, { amount: wrong });
    expect((await invoiceRows(invoiceId))[0]!.paid_at).toBeNull();

    const paid = await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, amount: wrong }),
    );
    expect(paid.status).toBe(200);
    const [row] = await invoiceRows(invoiceId);
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "AMOUNT_MISMATCH",
    });
    expect(row!.paid_at).not.toBeNull();
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
      period_start: null,
      period_end: null,
    });
  });

  it("REC-14 a second paid event for the same needs_review invoice does not move paid_at", async () => {
    const fx = await seedFixture();
    const wrong = PRICE - 50_000;
    const { invoiceId } = await createInvoice(fx, { amount: wrong });
    await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, amount: wrong }),
    );
    const first = await paidAt(invoiceId);
    expect(first).not.toBeNull();

    await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, amount: wrong }),
    );
    const [row] = await invoiceRows(invoiceId);
    expect(row!.status).toBe("needs_review");
    expect(row!.paid_at!.getTime()).toBe(first!.getTime());
  });

  it("REC-14 a paid invoice on a cancelled subscription is needs_review with paid_at set and the subscription stays cancelled", async () => {
    const fx = await seedFixture({
      status: "cancelled",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx);
    await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
    const [row] = await invoiceRows(invoiceId);
    expect(row!.status).toBe("needs_review");
    expect(row!.paid_at).not.toBeNull();
    expect((await subRow(fx.subId)).status).toBe("cancelled");
  });

  it("REC-14 a paid PERIOD_MISMATCH invoice keeps needs_review, gets paid_at and never activates", async () => {
    const fx = await seedFixture();
    const periodEnd = addDays(P_CUR, 7);
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_CUR,
        periodEnd,
      }),
    );
    const [row] = await invoiceRows(invoiceId);
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    expect(row!.paid_at).not.toBeNull();
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
  });

  it("REC-14 a paid DUPLICATE_PERIOD invoice keeps needs_review, gets paid_at and the subscription is untouched", async () => {
    const fx = await seedFixture();
    await seedInvoiceRow(fx, {
      status: "paid",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const before = await subRow(fx.subId);
    const { invoiceId } = await createInvoice(fx);
    await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
    const [row] = await invoiceRows(invoiceId);
    expect(row).toMatchObject({
      status: "needs_review",
      review_reason: "DUPLICATE_PERIOD",
    });
    expect(row!.paid_at).not.toBeNull();
    expect(await subRow(fx.subId)).toEqual(before);
  });
});

describe("REC-15 pause wins over a payment that lands while DOIT is being called", () => {
  async function pausedAt(subId: string): Promise<Date | null> {
    const { rows } = await owner.query<{ paused_at: Date | null }>(
      "SELECT paused_at FROM payment_recurring_subscriptions WHERE id = $1",
      [subId],
    );
    return rows[0]!.paused_at;
  }

  async function pauseDuringPayment(status: "active" | "past_due") {
    const fx = await seedFixture({
      status,
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    let pauseCalls = 0;
    const clientFor = async () =>
      ({
        pauseSubscription: async () => {
          pauseCalls += 1;
          // The verified payment arrives while the pause call is in flight.
          const paid = await deliver(
            invoiceEvent("invoice.paid", fx, {
              invoiceId,
              periodStart: P_CUR,
              periodEnd: P_NEXT,
            }),
          );
          expect(paid.status).toBe(200);
          // Round 3 (item 10): DOIT's answer is checked (id + status).
          return { id: fx.providerSubId, status: "paused" };
        },
      }) as never;

    const result = await pauseSubscription(
      contextFor(tenantW),
      fx.subId,
      new Date(),
      { clientFor },
    );
    expect(pauseCalls).toBe(1);
    return { fx, invoiceId, result };
  }

  it("REC-15 an active subscription whose renewal is paid during the DOIT pause call ends paused, never a CONFLICT", async () => {
    const { fx, invoiceId, result } = await pauseDuringPayment("active");
    expect(result.status).toBe("paused");
    expect((await subRow(fx.subId)).status).toBe("paused");
    expect(await pausedAt(fx.subId)).not.toBeNull();
    // The money is not hidden: the invoice that raced in is recorded as paid.
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });

  it("REC-15 a past_due subscription paid during the DOIT pause call ends paused, never a CONFLICT", async () => {
    // Assumption: pausing a past_due subscription is allowed.
    const { fx, result } = await pauseDuringPayment("past_due");
    expect(result.status).toBe("paused");
    expect((await subRow(fx.subId)).status).toBe("paused");
    expect(await pausedAt(fx.subId)).not.toBeNull();
  });
});

describe("REC-16 the period end is exclusive: a period ending today no longer gives access", () => {
  // Weekly plans keep the periods easy to place around the Asia/Jakarta
  // business date: (today - 7, today) is over, (today - 6, tomorrow) is not.
  it("REC-16 a first payment for a period that ends today does not activate; the invoice is paid", async () => {
    const today = jakartaToday();
    const fx = await seedFixture({ interval: "week" });
    const periodStart = addDays(today, -7);
    const { invoiceId } = await createInvoice(fx, {
      periodStart,
      periodEnd: today,
    });
    const paid = await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart,
        periodEnd: today,
      }),
    );
    expect(paid.status).toBe(200);
    expect(await subRow(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
    });
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });

  it("REC-16 a first payment for a period that ends tomorrow activates", async () => {
    const tomorrow = addDays(jakartaToday(), 1);
    const fx = await seedFixture({ interval: "week" });
    const periodStart = addDays(tomorrow, -7);
    const { invoiceId } = await createInvoice(fx, {
      periodStart,
      periodEnd: tomorrow,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart,
        periodEnd: tomorrow,
      }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "active",
      period_start: periodStart,
      period_end: tomorrow,
    });
  });

  it("REC-16 a past_due subscription paid for a period that ends today stays past_due", async () => {
    const today = jakartaToday();
    const periodStart = addDays(today, -7);
    const fx = await seedFixture({
      status: "past_due",
      interval: "week",
      periodStart: addDays(today, -14),
      periodEnd: periodStart,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart,
      periodEnd: today,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart,
        periodEnd: today,
      }),
    );
    expect((await subRow(fx.subId)).status).toBe("past_due");
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
  });

  it("REC-16 a past_due subscription paid for a period that ends tomorrow becomes active", async () => {
    const tomorrow = addDays(jakartaToday(), 1);
    const periodStart = addDays(tomorrow, -7);
    const fx = await seedFixture({
      status: "past_due",
      interval: "week",
      periodStart: addDays(tomorrow, -14),
      periodEnd: periodStart,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart,
      periodEnd: tomorrow,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart,
        periodEnd: tomorrow,
      }),
    );
    expect(await subRow(fx.subId)).toMatchObject({
      status: "active",
      period_end: tomorrow,
    });
  });
});

describe("REC-17 DOIT calls use the integration the plan and subscription are bound to", () => {
  // The subscription belongs to outlet W but is bound to the integration of
  // outlet W2. The outlet's own active integration is the tenant-wide one (A),
  // so a service that picks "the outlet's current integration" builds the
  // client for the wrong DOIT account.
  function recorder() {
    const calls: unknown[][] = [];
    const clientFor = (async (...args: unknown[]) => {
      calls.push(args);
      throw new Error("CLIENT_BUILT");
    }) as never;
    return { calls, clientFor };
  }

  function expectBoundIntegration(calls: unknown[][]) {
    expect(calls.length).toBeGreaterThan(0);
    const seen = safeJson(calls);
    expect(seen).toContain(integrationAOther);
    expect(seen).not.toContain(integrationA);
  }

  it("REC-17 pause builds the DOIT client for the subscription's own integration", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationAOther,
    });
    const { calls, clientFor } = recorder();
    await pauseSubscription(contextFor(tenantW), fx.subId, new Date(), {
      clientFor,
    }).catch(() => undefined);
    expectBoundIntegration(calls);
    // Nothing was sent to DOIT, so nothing changed.
    expect((await subRow(fx.subId)).status).toBe("active");
  });

  it("REC-17 resume builds the DOIT client for the subscription's own integration", async () => {
    const fx = await seedFixture({
      status: "paused",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationAOther,
    });
    const { calls, clientFor } = recorder();
    await resumeSubscription(contextFor(tenantW), fx.subId, new Date(), {
      clientFor,
    }).catch(() => undefined);
    expectBoundIntegration(calls);
    expect((await subRow(fx.subId)).status).toBe("paused");
  });

  it("REC-17 cancel builds the DOIT client for the subscription's own integration", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationAOther,
    });
    const { calls, clientFor } = recorder();
    await cancelSubscription(contextFor(tenantW), fx.subId, new Date(), {
      clientFor,
    }).catch(() => undefined);
    expectBoundIntegration(calls);
    expect((await subRow(fx.subId)).status).toBe("active");
  });

  describe("start", () => {
    let profileId = "";
    let profileUserId = "";

    beforeAll(async () => {
      profileUserId = randomUUID();
      await owner.query(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan uji', $2, true)`,
        [profileUserId, `${profileUserId}@example.test`],
      );
      profileId = randomUUID();
      await owner.query(
        `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
         VALUES ($1, $2, $3, 'Pelanggan uji', 'active', now())`,
        [profileId, tenantW, profileUserId],
      );
    });

    afterAll(async () => {
      await owner.query("DELETE FROM customer_profiles WHERE id = $1", [
        profileId,
      ]);
      await owner.query('DELETE FROM "user" WHERE id = $1', [profileUserId]);
    });

    it("REC-17 start builds the DOIT client for the plan's own integration", async () => {
      const fx = await seedFixture({ gatewayIntegrationId: integrationAOther });
      const { calls, clientFor } = recorder();
      await startSubscription(
        contextFor(tenantW),
        {
          planId: fx.planId,
          customerProfileId: profileId,
          idempotencyKey: `idem-${unique()}`,
        },
        { clientFor },
      ).catch(() => undefined);
      expectBoundIntegration(calls);
    });
  });
});

// ===========================================================================
// Round 3 (docs/briefs/469-doit-recurring-fixes.md, items 1-12)
// ===========================================================================
// Written from docs/briefs/469-design.md (contract names), not from the
// implementation. Items 3, 7 and 9 (webhook receipt, binding, parked events)
// live in payment-recurring-reconcile.test.ts. Item 5 (no second connection
// under FOR UPDATE) has no black-box handle: the option no longer exists and
// shared-secret acceptance is covered by REC-13 and REC-27.
//
// ASSUMPTIONS
// - DOIT answers to pause/resume/cancel are `{ id, status }` with status
//   "paused" / "active" / "cancelled" (the wire enum also allows "canceled";
//   only the double-l spelling is exercised here).
// - A CoreError exposes `.code` ("SERVICE_UNAVAILABLE", "CONFLICT").
// - `getSubscription(context, id)` and `subscriptionHasAccess` take the
//   Drizzle-style camelCase row (dates as "YYYY-MM-DD" strings).
// - The key stored in `start_idempotency_key` is the caller's key as given.
// - Not expressible: the 409 -> DUPLICATE_AT_PROVIDER branch (the adapter's
//   409 error shape is not in the contract) and item 5's pool-exhaustion case.

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function codeOf(run: Promise<unknown>): Promise<string | null> {
  return run.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
  );
}

/** A promise pair: `started` resolves when the held DOIT call begins,
 * `release()` lets it return. Makes interleavings deterministic (no sleeps). */
function gate() {
  let release!: () => void;
  let started!: () => void;
  return {
    released: new Promise<void>((resolve) => (release = resolve)),
    hasStarted: new Promise<void>((resolve) => (started = resolve)),
    release: () => release(),
    markStarted: () => started(),
  };
}

async function addOutlet(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. R3', '{}')`,
    [
      id,
      tenantW,
      dedicatedTenant.brandId,
      dedicatedTenant.legalEntityId,
      `R3${label}-${unique()}`.toUpperCase(),
      `Outlet ${label}`,
    ],
  );
  return id;
}

async function subExtra(subId: string) {
  const { rows } = await owner.query<{
    status: string;
    reconcile_reason: string | null;
    provider_subscription_id: string | null;
    paused_at: Date | null;
    cancelled_at: Date | null;
  }>(
    `SELECT status, reconcile_reason, provider_subscription_id, paused_at, cancelled_at
     FROM payment_recurring_subscriptions WHERE id = $1`,
    [subId],
  );
  return rows[0]!;
}

async function subNext(subId: string) {
  const { rows } = await owner.query<{
    status: string;
    period_start: string | null;
    period_end: string | null;
    next_start: string | null;
    next_end: string | null;
    activated_at: string | null;
  }>(
    `SELECT status,
            to_char(current_period_start, 'YYYY-MM-DD') AS period_start,
            to_char(current_period_end, 'YYYY-MM-DD') AS period_end,
            to_char(next_period_start, 'YYYY-MM-DD') AS next_start,
            to_char(next_period_end, 'YYYY-MM-DD') AS next_end,
            activated_at::text AS activated_at
     FROM payment_recurring_subscriptions WHERE id = $1`,
    [subId],
  );
  return rows[0]!;
}

/** The camelCase row `subscriptionHasAccess` takes, read back from the DB. */
async function accessInput(subId: string) {
  const row = await subNext(subId);
  return {
    status: row.status,
    currentPeriodStart: row.period_start,
    currentPeriodEnd: row.period_end,
    nextPeriodStart: row.next_start,
    nextPeriodEnd: row.next_end,
  } as never;
}

/** 12:00 Asia/Jakarta on a business date (05:00 UTC). */
const noonJakarta = (date: string) => new Date(`${date}T05:00:00.000Z`);

/** DOIT answer for a stop/resume call that the service must accept. */
const okAnswer = (fx: Fx, status: "paused" | "active" | "cancelled") => ({
  id: fx.providerSubId,
  status,
});

// A real customer profile for tests that call startSubscription.
async function seedProfile(): Promise<{
  profileId: string;
  cleanup: () => Promise<void>;
}> {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan uji', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  const profileId = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, 'Pelanggan uji', 'active', now())`,
    [profileId, tenantW, userId],
  );
  return {
    profileId,
    cleanup: async () => {
      await owner.query("DELETE FROM customer_profiles WHERE id = $1", [
        profileId,
      ]);
      await owner.query('DELETE FROM "user" WHERE id = $1', [userId]);
    },
  };
}

/** Rows startSubscription created for a plan (and registers them for cleanup). */
async function startedRows(planId: string, seededId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    reconcile_reason: string | null;
    provider_subscription_id: string | null;
    start_idempotency_key: string | null;
  }>(
    `SELECT id, status, reconcile_reason, provider_subscription_id, start_idempotency_key
     FROM payment_recurring_subscriptions WHERE plan_id = $1 AND id <> $2`,
    [planId, seededId],
  );
  for (const row of rows) subIds.push(row.id);
  return rows;
}

// ---------------------------------------------------------------------------
// REC-18 / REC-19 (items 1, 2): which integrations may bill, which may stop
// ---------------------------------------------------------------------------

describe("REC-18 start and resume refuse an integration that is not active; REC-19 pause and cancel still reach DOIT", () => {
  let server: http.Server;
  let baseUrl = "";
  let requests: { method: string; path: string }[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let integrationActive = "";
  let integrationDisabled = "";
  let profile: Awaited<ReturnType<typeof seedProfile>>;

  const recurringCalls = () =>
    requests.filter((r) => r.path.includes("/recurring"));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push({ method: req.method ?? "GET", path: req.url ?? "/" });
      req.resume();
      req.on("end", () => {
        const match = /subscriptions\/([^/]+)\/(pause|resume|cancel)$/.exec(
          req.url ?? "",
        );
        res.setHeader("content-type", "application/json");
        if (!match) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        const status = {
          pause: "paused",
          resume: "active",
          cancel: "cancelled",
        }[match[2] as "pause" | "resume" | "cancel"];
        res.end(
          JSON.stringify({
            id: decodeURIComponent(match[1]!),
            plan_id: "plan_stub",
            status,
          }),
        );
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    integrationActive = await seedIntegration(
      tenantW,
      `whsec-r3-act-${randomBytes(8).toString("hex")}`,
      await addOutlet("ACT"),
      baseUrl,
    );
    integrationDisabled = await seedIntegration(
      tenantW,
      `whsec-r3-dis-${randomBytes(8).toString("hex")}`,
      await addOutlet("DIS"),
      baseUrl,
    );
    await setIntegrationStatus(
      contextFor(tenantW),
      integrationDisabled,
      { status: "disabled" },
      actor,
    );
    profile = await seedProfile();
  });

  afterAll(async () => {
    await profile?.cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  it("REC-18 resume with an active integration reaches DOIT (control for the refusals below)", async () => {
    const fx = await seedFixture({
      status: "paused",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationActive,
    });
    const result = await resumeSubscription(ctxW(), fx.subId, new Date());
    expect(result.status).toBe("active");
    expect(
      recurringCalls().map((r) => r.method + " " + r.path.split("/").pop()),
    ).toEqual(["POST resume"]);
  });

  it("REC-18 resume on a disabled integration is SERVICE_UNAVAILABLE and DOIT is never called", async () => {
    const fx = await seedFixture({
      status: "paused",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationDisabled,
    });
    expect(await codeOf(resumeSubscription(ctxW(), fx.subId, new Date()))).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(recurringCalls()).toEqual([]);
    expect((await subRow(fx.subId)).status).toBe("paused");
  });

  it("REC-18 start on a disabled integration is SERVICE_UNAVAILABLE and DOIT is never called", async () => {
    const fx = await seedFixture({ gatewayIntegrationId: integrationDisabled });
    const code = await codeOf(
      startSubscription(ctxW(), {
        planId: fx.planId,
        customerProfileId: profile.profileId,
        idempotencyKey: `idem-${unique()}`,
      }),
    );
    await startedRows(fx.planId, fx.subId); // register any row for cleanup
    expect(code).toBe("SERVICE_UNAVAILABLE");
    expect(recurringCalls()).toEqual([]);
  });

  it("REC-19 pause still reaches DOIT after the provider was withdrawn from the tenant plan", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationActive,
    });
    await withdrawDoitFromPlan(async () => {
      const result = await pauseSubscription(ctxW(), fx.subId, new Date());
      expect(result.status).toBe("paused");
    });
    expect(recurringCalls().map((r) => r.path.split("/").pop())).toEqual([
      "pause",
    ]);
    expect((await subRow(fx.subId)).status).toBe("paused");
  });

  it("REC-19 cancel still reaches DOIT after the provider was withdrawn from the tenant plan", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationActive,
    });
    await withdrawDoitFromPlan(async () => {
      const result = await cancelSubscription(ctxW(), fx.subId, new Date());
      expect(result.status).toBe("cancelled");
    });
    expect(recurringCalls().map((r) => r.path.split("/").pop())).toEqual([
      "cancel",
    ]);
    expect((await subRow(fx.subId)).status).toBe("cancelled");
  });

  it("REC-19 pause and cancel reach DOIT through a disabled integration", async () => {
    const paused = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationDisabled,
    });
    expect(
      (await pauseSubscription(ctxW(), paused.subId, new Date())).status,
    ).toBe("paused");
    const cancelled = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      gatewayIntegrationId: integrationDisabled,
    });
    expect(
      (await cancelSubscription(ctxW(), cancelled.subId, new Date())).status,
    ).toBe("cancelled");
    expect(recurringCalls()).toHaveLength(2);
  });
});

const ctxW = () => contextFor(tenantW);

async function withdrawDoitFromPlan<T>(run: () => Promise<T>): Promise<T> {
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":[]}' WHERE id = $1`,
    [tenantW],
  );
  try {
    return await run();
  } finally {
    await owner.query(
      `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
      [tenantW],
    );
  }
}

// ---------------------------------------------------------------------------
// REC-20 (item 4): pause never overwrites cancel
// ---------------------------------------------------------------------------

describe("REC-20 pause vs cancel ends cancelled in either order", () => {
  it("REC-20 a pause whose DOIT call is still running when the cancel completes does not undo the cancel", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const held = gate();
    const pausing = pauseSubscription(ctxW(), fx.subId, new Date(), {
      clientFor: async () =>
        ({
          pauseSubscription: async () => {
            held.markStarted();
            await held.released;
            return okAnswer(fx, "paused");
          },
        }) as never,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await held.hasStarted;
    const cancelled = await cancelSubscription(ctxW(), fx.subId, new Date(), {
      clientFor: async () =>
        ({
          cancelSubscription: async () => okAnswer(fx, "cancelled"),
        }) as never,
    });
    expect(cancelled.status).toBe("cancelled");
    held.release();
    const outcome = await pausing;
    // Contract: a cancelled row never goes back to paused; pause returns the
    // latest state (it is not an error).
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.status).toBe("cancelled");
    const after = await subExtra(fx.subId);
    expect(after.status).toBe("cancelled");
    expect(after.cancelled_at).not.toBeNull();
  });

  it("REC-20 a cancel whose DOIT call is still running when the pause completes still ends cancelled", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const held = gate();
    const cancelling = cancelSubscription(ctxW(), fx.subId, new Date(), {
      clientFor: async () =>
        ({
          cancelSubscription: async () => {
            held.markStarted();
            await held.released;
            return okAnswer(fx, "cancelled");
          },
        }) as never,
    });
    await held.hasStarted;
    const paused = await pauseSubscription(ctxW(), fx.subId, new Date(), {
      clientFor: async () =>
        ({ pauseSubscription: async () => okAnswer(fx, "paused") }) as never,
    });
    expect(paused.status).toBe("paused");
    held.release();
    expect((await cancelling).status).toBe("cancelled");
    expect((await subExtra(fx.subId)).status).toBe("cancelled");
  });

  it.each([
    ["pause finishes last", 120, 5],
    ["cancel finishes last", 5, 120],
  ])(
    "REC-20 Promise.all of pause and cancel (%s) ends cancelled",
    async (_label, pauseMs, cancelMs) => {
      const fx = await seedFixture({
        status: "active",
        periodStart: P_CUR,
        periodEnd: P_NEXT,
      });
      await Promise.allSettled([
        pauseSubscription(ctxW(), fx.subId, new Date(), {
          clientFor: async () =>
            ({
              pauseSubscription: async () => {
                await sleep(pauseMs);
                return okAnswer(fx, "paused");
              },
            }) as never,
        }),
        cancelSubscription(ctxW(), fx.subId, new Date(), {
          clientFor: async () =>
            ({
              cancelSubscription: async () => {
                await sleep(cancelMs);
                return okAnswer(fx, "cancelled");
              },
            }) as never,
        }),
      ]);
      expect((await subExtra(fx.subId)).status).toBe("cancelled");
    },
  );

  it("REC-20 a resume whose row was cancelled while DOIT was being called is a CONFLICT and the row stays cancelled", async () => {
    const fx = await seedFixture({
      status: "paused",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const code = await codeOf(
      resumeSubscription(ctxW(), fx.subId, new Date(), {
        clientFor: async () =>
          ({
            resumeSubscription: async () => {
              await owner.query(
                "UPDATE payment_recurring_subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1",
                [fx.subId],
              );
              return okAnswer(fx, "active");
            },
          }) as never,
      }),
    );
    expect(code).toBe("CONFLICT");
    expect((await subExtra(fx.subId)).status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// REC-21 (item 6): paid_at of an unseen paid invoice comes from the payload
// ---------------------------------------------------------------------------

describe("REC-21 an unseen paid invoice keeps the payload's paid_at", () => {
  it("REC-21 paid_at is the paid_at DOIT sent, not the receive time", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const invoiceId = `inv_${unique()}`;
    const body = invoiceEvent("invoice.paid", fx, { invoiceId });
    const paidAt = new Date(Date.now() - 3 * 86_400_000);
    (body.data.invoice as { paid_at?: string }).paid_at = paidAt.toISOString();
    // Inside the early window an unseen paid invoice is retried (500 to DOIT);
    // after it the money is stored for review. The worker retry runs later.
    expect((await deliver(body)).status).toBe(500);
    await reprocessStoredWebhookEvents(
      ctxW(),
      new Date(Date.now() + 16 * 60_000),
    );
    const [row] = await invoiceRows(invoiceId);
    expect(row, "the unseen paid invoice is stored").toBeDefined();
    expect(row!.paid_at).not.toBeNull();
    expect(Math.abs(row!.paid_at!.getTime() - paidAt.getTime())).toBeLessThan(
      1000,
    );
  });
});

// ---------------------------------------------------------------------------
// REC-22 (item 8): start keeps a stable local intent and reference
// ---------------------------------------------------------------------------

describe("REC-22 start stores its intent before DOIT and retries with the same reference", () => {
  let profile: Awaited<ReturnType<typeof seedProfile>>;
  beforeAll(async () => {
    profile = await seedProfile();
  });
  afterAll(async () => {
    await profile?.cleanup();
  });

  const input = (fx: Fx, key: string) => ({
    planId: fx.planId,
    customerProfileId: profile.profileId,
    idempotencyKey: key,
  });
  const created = (
    fx: Fx,
    subId = `sub_${unique()}`,
    planId = fx.providerPlanId,
  ) => ({
    id: subId,
    plan_id: planId,
    status: "pending",
    first_invoice_url: null,
  });

  it("REC-22 the local row exists as provisioning (no provider id) while DOIT is being called", async () => {
    const fx = await seedFixture();
    const key = `idem-${unique()}`;
    let seenDuringCall: Awaited<ReturnType<typeof startedRows>> = [];
    await startSubscription(ctxW(), input(fx, key), {
      clientFor: async () =>
        ({
          createSubscription: async () => {
            seenDuringCall = await startedRows(fx.planId, fx.subId);
            return created(fx);
          },
        }) as never,
    });
    expect(seenDuringCall).toHaveLength(1);
    expect(seenDuringCall[0]).toMatchObject({
      status: "provisioning",
      provider_subscription_id: null,
      start_idempotency_key: key,
    });
    await startedRows(fx.planId, fx.subId);
  });

  it("REC-22 a response lost after DOIT accepted leaves needs_reconcile; the retry re-sends the same reference and ends with exactly one local row", async () => {
    const fx = await seedFixture();
    const key = `idem-${unique()}`;
    const sent: string[] = [];
    const providerId = `sub_${unique()}`;
    const lose = {
      clientFor: async () =>
        ({
          createSubscription: async (...args: unknown[]) => {
            sent.push(safeJson(args));
            throw new Error("ETIMEDOUT");
          },
        }) as never,
    };
    const firstCode = await codeOf(
      startSubscription(ctxW(), input(fx, key), lose),
    );
    expect(["SERVICE_UNAVAILABLE", "CONFLICT"]).toContain(firstCode);
    const afterFirst = await startedRows(fx.planId, fx.subId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "PROVIDER_ERROR",
      provider_subscription_id: null,
      start_idempotency_key: key,
    });
    const rowId = afterFirst[0]!.id;

    const result = await startSubscription(ctxW(), input(fx, key), {
      clientFor: async () =>
        ({
          createSubscription: async (...args: unknown[]) => {
            sent.push(safeJson(args));
            return created(fx, providerId);
          },
        }) as never,
    });
    expect(result.subscription.status).toBe("pending_first_payment");
    // Same reference (the row id) and same idempotency key on both calls.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[0]).toContain(rowId);
    const afterRetry = await startedRows(fx.planId, fx.subId);
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]).toMatchObject({
      id: rowId,
      status: "pending_first_payment",
      provider_subscription_id: providerId,
    });
  });

  it("REC-22 replaying a start that succeeded returns the same subscription without calling DOIT again", async () => {
    const fx = await seedFixture();
    const key = `idem-${unique()}`;
    let calls = 0;
    const deps = {
      clientFor: async () =>
        ({
          createSubscription: async () => {
            calls += 1;
            return created(fx);
          },
        }) as never,
    };
    const first = await startSubscription(ctxW(), input(fx, key), deps);
    const second = await startSubscription(ctxW(), input(fx, key), deps);
    expect(calls).toBe(1);
    expect(second.subscription.id).toBe(first.subscription.id);
    expect(await startedRows(fx.planId, fx.subId)).toHaveLength(1);
  });

  it("REC-22 a DOIT answer for another plan is needs_reconcile PLAN_MISMATCH with a CONFLICT, never pending_first_payment", async () => {
    const fx = await seedFixture();
    const code = await codeOf(
      startSubscription(ctxW(), input(fx, `idem-${unique()}`), {
        clientFor: async () =>
          ({
            createSubscription: async () =>
              created(fx, undefined, `plan_other_${unique()}`),
          }) as never,
      }),
    );
    expect(code).toBe("CONFLICT");
    const rows = await startedRows(fx.planId, fx.subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "needs_reconcile",
      reconcile_reason: "PLAN_MISMATCH",
    });
  });

  describe("a subscription that is not confirmed at the gateway never notifies or activates", () => {
    for (const status of ["needs_reconcile", "provisioning"] as const) {
      it(`REC-22 an invoice for a ${status} subscription is not notified`, async () => {
        const fx = await seedFixture({ status });
        const body = invoiceEvent("invoice.created", fx, {
          invoiceId: `inv_${unique()}`,
        });
        await deliver(body);
        const [row] = await invoiceRows(body.data.invoice.id);
        if (row) expect(row.notified_at).toBeNull();
        expect(await outboxCount(row?.id ?? randomUUID())).toBe(0);
      });
    }

    it("REC-22 a paid invoice of a needs_reconcile subscription is needs_review SUBSCRIPTION_NEEDS_RECONCILE and never activates", async () => {
      const fx = await seedFixture({ status: "needs_reconcile" });
      const invoiceId = await seedInvoiceRow(fx, {
        status: "open",
        periodStart: P_CUR,
        periodEnd: P_NEXT,
      });
      await deliver(invoiceEvent("invoice.paid", fx, { invoiceId }));
      expect((await invoiceRows(invoiceId))[0]).toMatchObject({
        status: "needs_review",
        review_reason: "SUBSCRIPTION_NEEDS_RECONCILE",
      });
      const after = await subNext(fx.subId);
      expect(after.status).toBe("needs_reconcile");
      expect(after.activated_at).toBeNull();
      expect(after.period_start).toBeNull();
    });

    it("REC-22 an event for a provisioning row without a provider id stays an unknown subscription", async () => {
      const fx = await seedFixture({
        status: "provisioning",
        providerSubId: null,
      });
      const body = invoiceEvent("invoice.created", fx, {
        invoiceId: `inv_${unique()}`,
      });
      await deliver(body);
      expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
      const [stored] = await webhookEvent(tenantW, body.id);
      expect(stored!.last_error_code).toBe("UNKNOWN_SUBSCRIPTION");
    });
  });
});

// ---------------------------------------------------------------------------
// REC-23 (item 10): DOIT's answer to pause/resume/cancel is checked
// ---------------------------------------------------------------------------

describe("REC-23 a pause, resume or cancel is only a success when DOIT's answer says so", () => {
  type Action = "pause" | "resume" | "cancel";
  const actions: Record<
    Action,
    {
      from: SubStatus;
      expected: "paused" | "active" | "cancelled";
      wrong: "paused" | "active" | "cancelled";
      run: typeof pauseSubscription;
      method: string;
    }
  > = {
    pause: {
      from: "active",
      expected: "paused",
      wrong: "active",
      run: pauseSubscription,
      method: "pauseSubscription",
    },
    resume: {
      from: "paused",
      expected: "active",
      wrong: "paused",
      run: resumeSubscription,
      method: "resumeSubscription",
    },
    cancel: {
      from: "active",
      expected: "cancelled",
      wrong: "active",
      run: cancelSubscription,
      method: "cancelSubscription",
    },
  };

  function call(action: Action, fx: Fx, answer: unknown) {
    const a = actions[action];
    return a.run(ctxW(), fx.subId, new Date(), {
      clientFor: async () => ({ [a.method]: async () => answer }) as never,
    });
  }

  for (const action of ["pause", "resume", "cancel"] as const) {
    const a = actions[action];
    const seed = () =>
      seedFixture({ status: a.from, periodStart: P_CUR, periodEnd: P_NEXT });

    it(`REC-23 ${action}: a matching id and status succeeds`, async () => {
      const fx = await seed();
      const result = await call(action, fx, okAnswer(fx, a.expected));
      expect(result.status).toBe(a.expected);
      expect((await subExtra(fx.subId)).status).toBe(a.expected);
    });

    it.each([
      [
        "another subscription id",
        () => ({ id: `sub_other_${unique()}`, status: a.expected }),
      ],
      [
        "the wrong status",
        (fx: Fx) => ({ id: fx.providerSubId, status: a.wrong }),
      ],
      [
        "an unrecognized status",
        (fx: Fx) => ({ id: fx.providerSubId, status: "weird" }),
      ],
      ["an empty answer", () => ({})],
    ])(
      `REC-23 ${action}: %s is needs_reconcile RESPONSE_MISMATCH with a CONFLICT`,
      async (_label, answer) => {
        const fx = await seed();
        const code = await codeOf(call(action, fx, answer(fx)));
        expect(code).toBe("CONFLICT");
        expect(await subExtra(fx.subId)).toMatchObject({
          status: "needs_reconcile",
          reconcile_reason: "RESPONSE_MISMATCH",
        });
      },
    );

    it(`REC-23 ${action}: a provider error changes nothing`, async () => {
      const fx = await seed();
      const run = actions[action].run(ctxW(), fx.subId, new Date(), {
        clientFor: async () =>
          ({
            [a.method]: async () => {
              throw new Error("DOIT_DOWN");
            },
          }) as never,
      });
      await codeOf(run);
      expect((await subExtra(fx.subId)).status).toBe(a.from);
    });
  }
});

// ---------------------------------------------------------------------------
// REC-24 (item 11): paying a future period keeps the current one
// ---------------------------------------------------------------------------

describe("REC-24 a payment for a future period is stored as the next period", () => {
  it("REC-24 paying next month while active keeps the current period, stores the next one and access stays", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_NEXT,
      periodEnd: P_AFTER_NEXT,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_NEXT,
        periodEnd: P_AFTER_NEXT,
      }),
    );
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: P_CUR,
      period_end: P_NEXT,
      next_start: P_NEXT,
      next_end: P_AFTER_NEXT,
    });
    expect(
      subscriptionHasAccess(await accessInput(fx.subId), new Date(), 3),
    ).toBe(true);
    // The day the next period starts the current one is over but the paid
    // next one carries the access.
    expect(
      subscriptionHasAccess(
        await accessInput(fx.subId),
        noonJakarta(P_NEXT),
        3,
      ),
    ).toBe(true);
  });

  it("REC-24 at period_start the next period moves into the current one and access continues", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      nextPeriodStart: P_NEXT,
      nextPeriodEnd: P_AFTER_NEXT,
    });
    // Before the start date nothing moves (never touches a row that is not due).
    await promoteDueSubscriptionPeriods(ctxW(), new Date());
    expect(await subNext(fx.subId)).toMatchObject({
      period_start: P_CUR,
      next_start: P_NEXT,
    });

    const result = await promoteDueSubscriptionPeriods(
      ctxW(),
      noonJakarta(P_NEXT),
    );
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: P_NEXT,
      period_end: P_AFTER_NEXT,
      next_start: null,
      next_end: null,
    });
    expect(
      subscriptionHasAccess(
        await accessInput(fx.subId),
        noonJakarta(P_NEXT),
        3,
      ),
    ).toBe(true);
    // Promoting again changes nothing.
    await promoteDueSubscriptionPeriods(ctxW(), noonJakarta(P_NEXT));
    expect((await subNext(fx.subId)).period_start).toBe(P_NEXT);
  });

  it("REC-24 a first payment for a period that starts tomorrow gives no access today and activates when promoted", async () => {
    const tomorrow = addDays(jakartaToday(), 1);
    const end = addDays(tomorrow, 7);
    const fx = await seedFixture({ interval: "week" });
    const { invoiceId } = await createInvoice(fx, {
      periodStart: tomorrow,
      periodEnd: end,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: tomorrow,
        periodEnd: end,
      }),
    );
    expect((await invoiceRows(invoiceId))[0]!.status).toBe("paid");
    expect(await subNext(fx.subId)).toMatchObject({
      status: "pending_first_payment",
      activated_at: null,
      period_start: null,
      next_start: tomorrow,
      next_end: end,
    });
    expect(
      subscriptionHasAccess(await accessInput(fx.subId), new Date(), 3),
    ).toBe(false);

    await promoteDueSubscriptionPeriods(ctxW(), noonJakarta(tomorrow));
    const after = await subNext(fx.subId);
    expect(after).toMatchObject({
      status: "active",
      period_start: tomorrow,
      period_end: end,
      next_start: null,
    });
    expect(after.activated_at).not.toBeNull();
    expect(
      subscriptionHasAccess(
        await accessInput(fx.subId),
        noonJakarta(tomorrow),
        3,
      ),
    ).toBe(true);
  });

  it("REC-24 continuity is checked against the stored next period: the invoice after it is accepted", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_CUR,
      periodEnd: P_NEXT,
      nextPeriodStart: P_NEXT,
      nextPeriodEnd: P_AFTER_NEXT,
    });
    const afterThat = jakartaMonthStart(3);
    const { invoiceId, row } = await createInvoice(fx, {
      periodStart: P_AFTER_NEXT,
      periodEnd: afterThat,
    });
    expect(row).toMatchObject({ status: "open", review_reason: null });
    // The one right after that unpaid open invoice is parked (brief 488 item
    // 8), not a mismatch; it opens once the open one is paid.
    const parked = await createInvoice(fx, {
      periodStart: afterThat,
      periodEnd: jakartaMonthStart(4),
    });
    expect(parked.row).toMatchObject({
      status: "needs_review",
      review_reason: "AWAITING_PREVIOUS_PERIOD",
    });
    // And one that leaves a gap after everything stored is still a mismatch.
    const skipped = await createInvoice(fx, {
      periodStart: jakartaMonthStart(5),
      periodEnd: jakartaMonthStart(6),
    });
    expect(skipped.row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    void invoiceId;
  });

  it("REC-24 a period that already covers today is applied as before (current period moves)", async () => {
    const fx = await seedFixture({
      status: "active",
      periodStart: P_PREV,
      periodEnd: P_CUR,
    });
    const { invoiceId } = await createInvoice(fx, {
      periodStart: P_CUR,
      periodEnd: P_NEXT,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId,
        periodStart: P_CUR,
        periodEnd: P_NEXT,
      }),
    );
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: P_CUR,
      period_end: P_NEXT,
      next_start: null,
    });
  });

  it("REC-24 promotion never touches paused, cancelled or needs_reconcile rows", async () => {
    const rows = [];
    for (const status of ["paused", "cancelled", "needs_reconcile"] as const) {
      const fx = await seedFixture({
        status,
        periodStart: P_PREV,
        periodEnd: P_CUR,
        nextPeriodStart: P_CUR,
        nextPeriodEnd: P_NEXT,
      });
      rows.push({ fx, status });
    }
    await promoteDueSubscriptionPeriods(ctxW(), noonJakarta(P_CUR));
    for (const { fx, status } of rows)
      expect(await subNext(fx.subId)).toMatchObject({
        status,
        period_start: P_PREV,
        next_start: P_CUR,
      });
  });

  it("REC-24 reading a subscription promotes its own due next period", async () => {
    const today = jakartaToday();
    const fx = await seedFixture({
      status: "active",
      interval: "week",
      periodStart: addDays(today, -7),
      periodEnd: today,
      nextPeriodStart: today,
      nextPeriodEnd: addDays(today, 7),
    });
    const read = await getSubscription(ctxW(), fx.subId);
    expect(read.status).toBe("active");
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: today,
      period_end: addDays(today, 7),
      next_start: null,
    });
  });

  describe("subscriptionHasAccess checks both bounds (start inclusive, end exclusive, Asia/Jakarta date)", () => {
    const sub = (over: Record<string, unknown> = {}) =>
      ({
        status: "active",
        currentPeriodStart: "2026-01-01",
        currentPeriodEnd: "2026-02-01",
        nextPeriodStart: null,
        nextPeriodEnd: null,
        ...over,
      }) as never;
    // 2026-01-01 00:00 Asia/Jakarta = 2025-12-31T17:00Z.
    it("REC-24 the first day gives access, the day before does not", () => {
      expect(
        subscriptionHasAccess(sub(), new Date("2025-12-31T17:00:00.000Z"), 3),
      ).toBe(true);
      expect(
        subscriptionHasAccess(sub(), new Date("2025-12-31T16:59:59.000Z"), 3),
      ).toBe(false);
    });
    it("REC-24 the end date itself gives no access, the day before does", () => {
      expect(
        subscriptionHasAccess(sub(), new Date("2026-01-31T16:59:59.000Z"), 3),
      ).toBe(true);
      expect(
        // Grace 0: the paid period alone decides (the outlet default of 3 days
        // keeps access a few days longer, see REC-44).
        subscriptionHasAccess(sub(), new Date("2026-01-31T17:00:00.000Z"), 0),
      ).toBe(false);
    });
    it("REC-24 the next period grants access after the current one, with no gap day", () => {
      const withNext = sub({
        nextPeriodStart: "2026-02-01",
        nextPeriodEnd: "2026-03-01",
      });
      expect(
        subscriptionHasAccess(
          withNext,
          new Date("2026-01-31T17:00:00.000Z"),
          3,
        ),
      ).toBe(true);
      expect(
        subscriptionHasAccess(
          withNext,
          new Date("2026-02-28T16:59:59.000Z"),
          3,
        ),
      ).toBe(true);
      expect(
        subscriptionHasAccess(
          withNext,
          new Date("2026-02-28T17:00:00.000Z"),
          3,
        ),
      ).toBe(false);
    });
    it("REC-24 only an active subscription has access", () => {
      for (const status of [
        "pending_first_payment",
        "past_due",
        "paused",
        "cancelled",
        "provisioning",
        "needs_reconcile",
      ])
        expect(
          subscriptionHasAccess(
            sub({ status }),
            new Date("2026-01-15T05:00:00.000Z"),
            3,
          ),
        ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// REC-25 (item 12): a paid event whose payload is not paid is ignored
// ---------------------------------------------------------------------------

describe("REC-25 invoice.paid with a payload status other than paid is ignored before anything is stored", () => {
  it.each(["open", "void"] as const)(
    "REC-25 an unseen invoice in an invoice.paid event with payload status %s stores nothing",
    async (status) => {
      const fx = await seedFixture();
      const body = invoiceEvent("invoice.paid", fx, {
        invoiceId: `inv_${unique()}`,
        status,
      });
      const before = await subRow(fx.subId);
      await deliver(body);
      expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
      expect(await subRow(fx.subId)).toEqual(before);
      const [stored] = await webhookEvent(tenantW, body.id);
      expect(["ignored", "processed"]).toContain(stored!.status);
    },
  );

  it("REC-25 a stored open invoice stays open (never needs_review) when the paid event says open", async () => {
    const fx = await seedFixture();
    const { invoiceId } = await createInvoice(fx);
    const before = (await invoiceRows(invoiceId))[0];
    await deliver(
      invoiceEvent("invoice.paid", fx, { invoiceId, status: "open" }),
    );
    expect((await invoiceRows(invoiceId))[0]).toEqual(before);
    expect((await subRow(fx.subId)).status).toBe("pending_first_payment");
  });
});

// ---------------------------------------------------------------------------
// REC-29 (fix after architect, item A): a second early payment keeps the first
// ---------------------------------------------------------------------------
// ASSUMPTION: after two consecutive early payments the stored next window is
// ONE range from the end of the current period to the end of the second paid
// period; promotion then makes that whole range the current period.

describe("REC-29 paying the period after the next one early does not lose the first early payment", () => {
  it("REC-29 weekly: current week, next week paid, the week after paid early -> access in all three weeks, nothing lost", async () => {
    const today = jakartaToday();
    const curStart = addDays(today, -3);
    const curEnd = addDays(today, 4);
    const week2End = addDays(curEnd, 7);
    const week3End = addDays(week2End, 7);
    const fx = await seedFixture({
      status: "active",
      interval: "week",
      periodStart: curStart,
      periodEnd: curEnd,
    });

    const first = await createInvoice(fx, {
      periodStart: curEnd,
      periodEnd: week2End,
    });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId: first.invoiceId,
        periodStart: curEnd,
        periodEnd: week2End,
      }),
    );
    const second = await createInvoice(fx, {
      periodStart: week2End,
      periodEnd: week3End,
    });
    expect(second.row).toMatchObject({ status: "open", review_reason: null });
    await deliver(
      invoiceEvent("invoice.paid", fx, {
        invoiceId: second.invoiceId,
        periodStart: week2End,
        periodEnd: week3End,
      }),
    );

    expect((await invoiceRows(first.invoiceId))[0]!.status).toBe("paid");
    expect((await invoiceRows(second.invoiceId))[0]!.status).toBe("paid");
    // Current period untouched; the stored next window spans both paid weeks.
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: curStart,
      period_end: curEnd,
      next_start: curEnd,
      next_end: week3End,
    });
    const input = await accessInput(fx.subId);
    expect(subscriptionHasAccess(input, new Date(), 3)).toBe(true);
    expect(
      subscriptionHasAccess(input, noonJakarta(addDays(curEnd, 1)), 3),
    ).toBe(true);
    expect(
      subscriptionHasAccess(input, noonJakarta(addDays(week2End, 1)), 3),
    ).toBe(true);
    expect(subscriptionHasAccess(input, noonJakarta(week3End), 3)).toBe(false);

    // When the first early week starts, the whole paid range becomes current.
    await promoteDueSubscriptionPeriods(ctxW(), noonJakarta(curEnd));
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: curEnd,
      period_end: week3End,
      next_start: null,
      next_end: null,
    });
    const promoted = await accessInput(fx.subId);
    expect(
      subscriptionHasAccess(promoted, noonJakarta(addDays(week2End, 1)), 3),
    ).toBe(true);
    expect(subscriptionHasAccess(promoted, noonJakarta(week3End), 0)).toBe(
      false,
    );
  });

  it("REC-29 an early payment that skips a week is still a PERIOD_MISMATCH and changes no access", async () => {
    const today = jakartaToday();
    const curEnd = addDays(today, 4);
    const fx = await seedFixture({
      status: "active",
      interval: "week",
      periodStart: addDays(today, -3),
      periodEnd: curEnd,
      nextPeriodStart: curEnd,
      nextPeriodEnd: addDays(curEnd, 7),
    });
    const skipped = await createInvoice(fx, {
      periodStart: addDays(curEnd, 14),
      periodEnd: addDays(curEnd, 21),
    });
    expect(skipped.row).toMatchObject({
      status: "needs_review",
      review_reason: "PERIOD_MISMATCH",
    });
    expect(await subNext(fx.subId)).toMatchObject({
      next_start: curEnd,
      next_end: addDays(curEnd, 7),
    });
  });
});

// ---------------------------------------------------------------------------
// REC-30 / REC-31 (item B): start retries and unresolved intents
// ---------------------------------------------------------------------------
// ASSUMPTIONS
// - REC-30 drives the REAL client loader against a local HTTP stub (no
//   `clientFor`), because the purpose "stop" for an existing intent lives in the
//   loader. The stub answers any non-action request with the create-subscription
//   shape REC-22 uses ({ id, plan_id, status: "pending", first_invoice_url }).
//   If the real adapter needs other fields in the answer, that is a seam gap in
//   the stub, not a behavior failure.
// - The reference sent to DOIT is the local row id and appears in the request
//   body (REC-22 asserts the same on the client arguments).
// - The CONFLICT message wording is not pinned.

describe("REC-30 retrying an existing start intent reaches DOIT even when the integration is no longer active", () => {
  let server: http.Server;
  let baseUrl = "";
  let calls: { method: string; path: string; body: string }[] = [];
  let planForStub = "";
  let providerIdForStub = "";
  const sockets = new Set<import("node:net").Socket>();
  let profile: Awaited<ReturnType<typeof seedProfile>>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        calls.push({
          method: req.method ?? "GET",
          path: req.url ?? "/",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: providerIdForStub,
            plan_id: planForStub,
            status: "pending",
            first_invoice_url: null,
          }),
        );
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    profile = await seedProfile();
  });

  afterAll(async () => {
    await profile?.cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
  });

  const lostResponse = {
    clientFor: async () =>
      ({
        createSubscription: async () => {
          throw new Error("ETIMEDOUT");
        },
      }) as never,
  };

  it("REC-30 the same key after the integration was disabled re-sends the same reference to DOIT and resolves the intent", async () => {
    const integration = await seedIntegration(
      tenantW,
      `whsec-r4-${randomBytes(8).toString("hex")}`,
      await addOutlet("B1"),
      baseUrl,
    );
    const fx = await seedFixture({ gatewayIntegrationId: integration });
    const key = `idem-${unique()}`;
    const input = {
      planId: fx.planId,
      customerProfileId: profile.profileId,
      idempotencyKey: key,
    };
    expect(["SERVICE_UNAVAILABLE", "CONFLICT"]).toContain(
      await codeOf(startSubscription(ctxW(), input, lostResponse)),
    );
    const [pending] = await startedRows(fx.planId, fx.subId);
    expect(pending).toMatchObject({
      status: "needs_reconcile",
      provider_subscription_id: null,
    });

    await setIntegrationStatus(
      ctxW(),
      integration,
      { status: "disabled" },
      actor,
    );
    planForStub = fx.providerPlanId;
    providerIdForStub = `sub_${unique()}`;
    const result = await startSubscription(ctxW(), input);

    expect(result.subscription.status).toBe("pending_first_payment");
    const sent = calls.filter((c) => c.method === "POST");
    expect(sent, "the retry reaches DOIT").toHaveLength(1);
    expect(sent[0]!.body).toContain(pending!.id);
    const rows = await startedRows(fx.planId, fx.subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pending!.id,
      status: "pending_first_payment",
      provider_subscription_id: providerIdForStub,
    });
  });

  it("REC-30 a NEW key on a disabled integration is still refused and DOIT is not called", async () => {
    const integration = await seedIntegration(
      tenantW,
      `whsec-r4-${randomBytes(8).toString("hex")}`,
      await addOutlet("B1N"),
      baseUrl,
    );
    const fx = await seedFixture({ gatewayIntegrationId: integration });
    await setIntegrationStatus(
      ctxW(),
      integration,
      { status: "disabled" },
      actor,
    );
    const code = await codeOf(
      startSubscription(ctxW(), {
        planId: fx.planId,
        customerProfileId: profile.profileId,
        idempotencyKey: `idem-${unique()}`,
      }),
    );
    await startedRows(fx.planId, fx.subId);
    expect(code).toBe("SERVICE_UNAVAILABLE");
    expect(calls).toEqual([]);
  });
});

describe("REC-31 a new key while an unresolved start exists for the same plan and customer is a CONFLICT", () => {
  let profile: Awaited<ReturnType<typeof seedProfile>>;
  let otherProfile: Awaited<ReturnType<typeof seedProfile>>;
  beforeAll(async () => {
    profile = await seedProfile();
    otherProfile = await seedProfile();
  });
  afterAll(async () => {
    await profile?.cleanup();
    await otherProfile?.cleanup();
  });

  const created = (fx: Fx, subId = `sub_${unique()}`) => ({
    id: subId,
    plan_id: fx.providerPlanId,
    status: "pending",
    first_invoice_url: null,
  });
  const counting = (fx: Fx) => {
    const state = { calls: 0 };
    return {
      state,
      deps: {
        clientFor: async () =>
          ({
            createSubscription: async () => {
              state.calls += 1;
              return created(fx);
            },
          }) as never,
      },
    };
  };

  it("REC-31 after a needs_reconcile start: CONFLICT, still one row, no DOIT call; the original key still resolves it", async () => {
    const fx = await seedFixture();
    const first = `idem-${unique()}`;
    const base = { planId: fx.planId, customerProfileId: profile.profileId };
    await codeOf(
      startSubscription(
        ctxW(),
        { ...base, idempotencyKey: first },
        {
          clientFor: async () =>
            ({
              createSubscription: async () => {
                throw new Error("ETIMEDOUT");
              },
            }) as never,
        },
      ),
    );
    expect((await startedRows(fx.planId, fx.subId))[0]!.status).toBe(
      "needs_reconcile",
    );

    const { state, deps } = counting(fx);
    expect(
      await codeOf(
        startSubscription(
          ctxW(),
          { ...base, idempotencyKey: `idem-${unique()}` },
          deps,
        ),
      ),
    ).toBe("CONFLICT");
    expect(state.calls).toBe(0);
    expect(await startedRows(fx.planId, fx.subId)).toHaveLength(1);

    const result = await startSubscription(
      ctxW(),
      { ...base, idempotencyKey: first },
      deps,
    );
    expect(result.subscription.status).toBe("pending_first_payment");
    expect(state.calls).toBe(1);
    expect(await startedRows(fx.planId, fx.subId)).toHaveLength(1);
  });

  it("REC-31 while a provisioning row exists: CONFLICT, still one row, no DOIT call", async () => {
    const fx = await seedFixture();
    const rowId = randomUUID();
    await owner.query(
      `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status, gateway_integration_id, start_idempotency_key)
       VALUES ($1, $2, $3, $4, $5, NULL, 'provisioning', $6, $7)`,
      [
        rowId,
        tenantW,
        outletW,
        fx.planId,
        profile.profileId,
        integrationA,
        `idem-${unique()}`,
      ],
    );
    subIds.push(rowId);
    const { state, deps } = counting(fx);
    expect(
      await codeOf(
        startSubscription(
          ctxW(),
          {
            planId: fx.planId,
            customerProfileId: profile.profileId,
            idempotencyKey: `idem-${unique()}`,
          },
          deps,
        ),
      ),
    ).toBe("CONFLICT");
    expect(state.calls).toBe(0);
    expect(await startedRows(fx.planId, fx.subId)).toEqual([
      expect.objectContaining({ id: rowId, status: "provisioning" }),
    ]);
  });

  it("REC-31 another customer, or another plan, with a new key is not blocked", async () => {
    const fx = await seedFixture();
    const otherPlan = await seedFixture();
    const key = () => `idem-${unique()}`;
    const blocked = await codeOf(
      startSubscription(
        ctxW(),
        {
          planId: fx.planId,
          customerProfileId: profile.profileId,
          idempotencyKey: key(),
        },
        {
          clientFor: async () =>
            ({
              createSubscription: async () => {
                throw new Error("ETIMEDOUT");
              },
            }) as never,
        },
      ),
    );
    expect(blocked).not.toBeNull();
    const a = counting(fx);
    const otherCustomer = await startSubscription(
      ctxW(),
      {
        planId: fx.planId,
        customerProfileId: otherProfile.profileId,
        idempotencyKey: key(),
      },
      a.deps,
    );
    expect(otherCustomer.subscription.status).toBe("pending_first_payment");
    const b = counting(otherPlan);
    const samePlanOther = await startSubscription(
      ctxW(),
      {
        planId: otherPlan.planId,
        customerProfileId: profile.profileId,
        idempotencyKey: key(),
      },
      b.deps,
    );
    expect(samePlanOther.subscription.status).toBe("pending_first_payment");
    await startedRows(fx.planId, fx.subId);
    await startedRows(otherPlan.planId, otherPlan.subId);
  });
});

// ---------------------------------------------------------------------------
// REC-34 (item E): the worker job promotes due next periods
// ---------------------------------------------------------------------------
// ASSUMPTION: `runPaymentGatewayPollJob(context, now, { force: true })` is the
// worker job that runs once per tenant (the entry other suites call). The
// observable effect asserted is the promoted row; the job's result shape is not
// pinned. Kept last in the file so earlier promoteDue runs cannot touch the row.

describe("REC-34 the worker job promotes a due next period", () => {
  it("REC-34 a paid-ahead period whose start is today becomes the current one after one job run", async () => {
    const today = jakartaToday();
    const fx = await seedFixture({
      status: "active",
      interval: "week",
      periodStart: addDays(today, -7),
      periodEnd: today,
      nextPeriodStart: today,
      nextPeriodEnd: addDays(today, 7),
    });
    await runPaymentGatewayPollJob(ctxW(), new Date(), { force: true });
    expect(await subNext(fx.subId)).toMatchObject({
      status: "active",
      period_start: today,
      period_end: addDays(today, 7),
      next_start: null,
      next_end: null,
    });
    expect(
      subscriptionHasAccess(await accessInput(fx.subId), new Date(), 3),
    ).toBe(true);
  });

  it("REC-34 the job leaves a paused subscription's next period alone", async () => {
    const today = jakartaToday();
    const fx = await seedFixture({
      status: "paused",
      interval: "week",
      periodStart: addDays(today, -7),
      periodEnd: today,
      nextPeriodStart: today,
      nextPeriodEnd: addDays(today, 7),
    });
    await runPaymentGatewayPollJob(ctxW(), new Date(), { force: true });
    expect(await subNext(fx.subId)).toMatchObject({
      status: "paused",
      period_start: addDays(today, -7),
      next_start: today,
    });
  });
});
