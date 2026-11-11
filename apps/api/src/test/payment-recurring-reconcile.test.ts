// DOIT recurring billing, round 3 webhook-side fixes (docs/briefs/
// 469-doit-recurring-fixes.md items 3, 7, 9; contract in 469-design.md).
// Written from the design contract, not from the implementation.
//
// - REC-26 (item 3): an invoice event signed with the secret of a DISABLED
//   integration the subscription is bound to still verifies (current secret or
//   in-grace previous secret); an unrelated secret is still 401.
// - REC-27 (item 7): the integrations that verified a recurring invoice event
//   are stored at receipt (`verified_integration_ids`), and the worker accepts
//   the event from that binding even after the secrets were rotated.
// - REC-28 (item 9): an event for an unknown subscription stays `failed` with
//   UNKNOWN_SUBSCRIPTION forever and is processed once the subscription exists
//   (`reprocessParkedRecurringEvents`).
//
// ASSUMPTIONS
// - `verified_integration_ids` holds exactly the tenant integrations whose
//   (current or in-grace previous) secret equals the verifying secret.
// - A rotated secret's grace is taken from `gatewaySecretGraceMs`, mocked here
//   (like payment-doit-webhook-rotation.test.ts) so "rotated" can mean "the old
//   secret no longer verifies" (0) or "still in grace" (72 h).
// - HTTP status codes for parked events are not pinned.
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

const platform = vi.hoisted(() => ({ graceMs: 72 * 3_600_000 }));
vi.mock("../services/platform-payment-gateway.service", async (original) => ({
  ...(await original<
    typeof import("../services/platform-payment-gateway.service")
  >()),
  gatewaySecretGraceMs: async () => platform.graceMs,
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
  dedicated = await createSecondTenant(owner, "reconcile");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
});

afterAll(async () => {
  // Same robust cleanup as payment-recurring.test.ts: every step isolated, the
  // first error rethrown at the end. Everything here lives on our own tenant.
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
  platform.graceMs = 72 * 3_600_000;
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Integration = { id: string; outletId: string; secret: string };

/** An active DOIT integration on a fresh outlet, with its own (or a shared) secret. */
async function makeIntegration(secret?: string): Promise<Integration> {
  const outlet = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, $5, 'Outlet R3', 'Jl. R3', '{}')`,
    [
      outlet,
      tenantId,
      dedicated.brandId,
      dedicated.legalEntityId,
      `RC-${unique()}`.toUpperCase(),
    ],
  );
  const webhookSecret = secret ?? `whsec-rc-${randomBytes(12).toString("hex")}`;
  const created = await upsertIntegration(
    context(),
    {
      outletId: outlet as OutletId,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: { apiKey: `doit-key-${unique()}`, webhookSecret },
    },
    actor,
  );
  await setIntegrationStatus(
    context(),
    created.id,
    { status: "active" },
    actor,
  );
  integrationIds.push(created.id);
  clearDoitWebhookSecretCache();
  return { id: created.id, outletId: outlet, secret: webhookSecret };
}

async function rotate(integration: Integration): Promise<void> {
  integration.secret = `whsec-rc-new-${randomBytes(12).toString("hex")}`;
  await upsertIntegration(
    context(),
    {
      outletId: integration.outletId as OutletId,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: {
        apiKey: `doit-key-${unique()}`,
        webhookSecret: integration.secret,
      },
    },
    actor,
  );
  clearDoitWebhookSecretCache();
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

function newIds(): Pick<Sub, "providerPlanId" | "providerSubId"> {
  return {
    providerPlanId: `plan_${unique()}`,
    providerSubId: `sub_${unique()}`,
  };
}

/** Inserts a plan and a pending_first_payment subscription bound to `integrationId`. */
async function seedSub(
  integrationId: string,
  ids: Pick<Sub, "providerPlanId" | "providerSubId"> = newIds(),
): Promise<Sub> {
  const sub: Sub = { ...ids, planId: randomUUID(), subId: randomUUID() };
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

function invoiceCreated(
  ids: Pick<Sub, "providerPlanId" | "providerSubId">,
  invoiceId = `inv_${unique()}`,
) {
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "invoice.created",
    created_at: new Date().toISOString(),
    data: {
      invoice: {
        id: invoiceId,
        subscription_id: ids.providerSubId,
        plan_id: ids.providerPlanId,
        amount: PRICE,
        currency: "IDR",
        period_start: P_CUR,
        period_end: P_NEXT,
        hosted_url: `https://pay.doit.example/invoices/${invoiceId}`,
        status: "open",
      },
    },
  };
}

function signatureHeader(raw: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${mac}`;
}

function deliver(body: object, secret: string) {
  const raw = JSON.stringify(body);
  return request(app)
    .post(`/api/webhooks/payments/doit/${tenantId}`)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw, secret))
    .send(raw);
}

async function invoiceRows(providerInvoiceId: string) {
  const { rows } = await owner.query<{
    status: string;
    review_reason: string | null;
  }>(
    `SELECT status, review_reason FROM subscription_invoices WHERE provider_invoice_id = $1`,
    [providerInvoiceId],
  );
  return rows;
}

async function eventRow(eventId: string) {
  const { rows } = await owner.query<{
    status: string;
    last_error_code: string | null;
    verified_integration_ids: string[] | null;
  }>(
    `SELECT status, last_error_code, verified_integration_ids::text[] AS verified_integration_ids
     FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2`,
    [tenantId, eventId],
  );
  return rows[0];
}

/** Moves a stored event into the past (received and last touched). */
const backdate = (eventId: string, minutes: number) =>
  owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - make_interval(mins => $2),
            updated_at = now() - make_interval(mins => $2)
      WHERE tenant_id = $1 AND event_id = $3`,
    [tenantId, minutes, eventId],
  );

// ---------------------------------------------------------------------------
// REC-26 (item 3): the signature fallback finds the subscription's own integration
// ---------------------------------------------------------------------------

describe("REC-26 an invoice event signed with the secret of a disabled bound integration verifies", () => {
  it("REC-26 the current secret of the disabled integration the subscription is bound to is accepted", async () => {
    const bound = await makeIntegration();
    const sub = await seedSub(bound.id);
    await disable(bound);
    const body = invoiceCreated(sub);
    const response = await deliver(body, bound.secret);
    expect(response.status).toBe(200);
    expect(await invoiceRows(body.data.invoice.id)).toEqual([
      expect.objectContaining({ status: "open", review_reason: null }),
    ]);
  });

  it("REC-26 the in-grace previous secret of the disabled bound integration is accepted", async () => {
    const bound = await makeIntegration();
    const sub = await seedSub(bound.id);
    const oldSecret = bound.secret;
    await rotate(bound);
    await disable(bound);
    const body = invoiceCreated(sub);
    expect((await deliver(body, oldSecret)).status).toBe(200);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(1);
  });

  it("REC-26 an unrelated secret is still 401 and stores nothing", async () => {
    const bound = await makeIntegration();
    const sub = await seedSub(bound.id);
    await disable(bound);
    const body = invoiceCreated(sub);
    const response = await deliver(body, `whsec-unrelated-${unique()}`);
    expect(response.status).toBe(401);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
  });

  it("REC-26 the secret of a disabled integration the subscription is NOT bound to is still 401", async () => {
    const bound = await makeIntegration();
    const other = await makeIntegration();
    const sub = await seedSub(bound.id);
    await disable(other);
    const body = invoiceCreated(sub);
    const response = await deliver(body, other.secret);
    expect(response.status).toBe(401);
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REC-27 (items 5, 7): the verification binding is stored and the worker trusts it
// ---------------------------------------------------------------------------

describe("REC-27 the integrations that verified a recurring invoice event are stored and used by the worker", () => {
  it("REC-27 receipt stores every integration whose secret verified the event, and none with another secret", async () => {
    const shared = `whsec-shared-${randomBytes(12).toString("hex")}`;
    const x = await makeIntegration(shared);
    const y = await makeIntegration(shared);
    const z = await makeIntegration();
    const sub = await seedSub(y.id);
    const body = invoiceCreated(sub);
    expect((await deliver(body, shared)).status).toBe(200);
    const row = await eventRow(body.id);
    expect([...(row?.verified_integration_ids ?? [])].sort()).toEqual(
      [x.id, y.id].sort(),
    );
    expect(row?.verified_integration_ids).not.toContain(z.id);
    // The shared secret is accepted for the bound integration (item 5).
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(1);
  });

  it("REC-27 events that are not recurring invoice events carry no binding", async () => {
    const x = await makeIntegration();
    const body = {
      id: `evt_${randomBytes(8).toString("hex")}`,
      type: "webhook.test",
      created_at: new Date().toISOString(),
      data: {},
    };
    expect((await deliver(body, x.secret)).status).toBe(200);
    expect((await eventRow(body.id))?.verified_integration_ids).toBeNull();
  });

  it("REC-27 a parked event is accepted by the worker after both integrations rotated their secrets", async () => {
    platform.graceMs = 0; // the old secret stops verifying the moment it is replaced
    const shared = `whsec-shared-${randomBytes(12).toString("hex")}`;
    const x = await makeIntegration(shared);
    const y = await makeIntegration(shared);
    const ids = newIds();
    const body = invoiceCreated(ids);
    // Received before the local subscription exists: parked.
    await deliver(body, shared);
    expect((await eventRow(body.id))?.status).toBe("failed");
    const sub = await seedSub(y.id, ids);
    void sub;

    await rotate(x);
    await rotate(y);
    // The old secret no longer verifies a fresh delivery (guards the premise).
    expect((await deliver(invoiceCreated(ids), shared)).status).toBe(401);

    const result = await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 20 * MIN),
    );
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(body.data.invoice.id)).toEqual([
      expect.objectContaining({ status: "open", review_reason: null }),
    ]);
  });

  it("REC-27 an event that failed earlier is accepted by the regular worker retry after rotation", async () => {
    platform.graceMs = 0;
    const shared = `whsec-shared-${randomBytes(12).toString("hex")}`;
    const x = await makeIntegration(shared);
    const y = await makeIntegration(shared);
    const sub = await seedSub(y.id);
    const body = invoiceCreated(sub);
    expect((await deliver(body, shared)).status).toBe(200);
    // Replay the failure: invoice gone, event failed an hour ago.
    await owner.query(
      "DELETE FROM subscription_invoices WHERE provider_invoice_id = $1",
      [body.data.invoice.id],
    );
    await owner.query(
      `UPDATE gateway_webhook_events SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1
       WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, body.id],
    );
    await backdate(body.id, 60);

    await rotate(x);
    await rotate(y);
    await reprocessStoredWebhookEvents(context(), new Date(), 100);

    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REC-28 (item 9): unknown subscriptions are parked, never ignored
// ---------------------------------------------------------------------------

describe("REC-28 an event for an unknown subscription is kept and processed when the subscription appears", () => {
  async function park() {
    const x = await makeIntegration();
    const ids = newIds();
    const body = invoiceCreated(ids);
    await deliver(body, x.secret);
    const row = await eventRow(body.id);
    expect(row).toMatchObject({
      status: "failed",
      last_error_code: "UNKNOWN_SUBSCRIPTION",
    });
    return { x, ids, body };
  }

  it("REC-28 the regular worker retry never turns it into ignored, not after 20 minutes and not after 48 hours", async () => {
    const { body } = await park();
    for (const minutes of [20, 48 * 60]) {
      await backdate(body.id, minutes);
      await reprocessStoredWebhookEvents(context(), new Date(), 100);
      expect(await eventRow(body.id)).toMatchObject({
        status: "failed",
        last_error_code: "UNKNOWN_SUBSCRIPTION",
      });
    }
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(0);
  });

  it("REC-28 a subscription that appears 20 minutes later gets the invoice from the parked event", async () => {
    const { x, ids, body } = await park();
    // Nothing to process yet: still parked after a run.
    await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 10 * MIN),
    );
    expect((await eventRow(body.id))?.status).toBe("failed");

    await seedSub(x.id, ids);
    const result = await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 20 * MIN),
    );
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(body.data.invoice.id)).toEqual([
      expect.objectContaining({ status: "open", review_reason: null }),
    ]);
  });

  it("REC-28 there is no 24 hour window: an event parked for 30 hours is still processed", async () => {
    const { x, ids, body } = await park();
    await backdate(body.id, 30 * 60);
    await seedSub(x.id, ids);
    await reprocessParkedRecurringEvents(context(), new Date());
    expect((await eventRow(body.id))?.status).toBe("processed");
    expect(await invoiceRows(body.data.invoice.id)).toHaveLength(1);
  });

  it("REC-28 a provider subscription id narrows the run to that subscription and skips the back-off", async () => {
    const first = await park();
    const second = await park();
    await seedSub(first.x.id, first.ids);
    await seedSub(second.x.id, second.ids);

    // Just parked: the back-off has not elapsed, but a narrowed run ignores it.
    await reprocessParkedRecurringEvents(context(), new Date(), {
      providerSubscriptionId: first.ids.providerSubId,
    });
    expect((await eventRow(first.body.id))?.status).toBe("processed");
    expect(await invoiceRows(first.body.data.invoice.id)).toHaveLength(1);
    expect((await eventRow(second.body.id))?.status).toBe("failed");
    expect(await invoiceRows(second.body.data.invoice.id)).toHaveLength(0);

    // An unnarrowed run honors the back-off: nothing is due yet.
    await reprocessParkedRecurringEvents(context(), new Date());
    expect((await eventRow(second.body.id))?.status).toBe("failed");

    // Once the back-off has elapsed it is processed.
    await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 3 * 3_600_000),
    );
    expect((await eventRow(second.body.id))?.status).toBe("processed");
  });

  it("REC-28 an event whose subscription still does not exist stays failed UNKNOWN_SUBSCRIPTION after a parked run", async () => {
    const { body } = await park();
    const result = await reprocessParkedRecurringEvents(
      context(),
      new Date(Date.now() + 20 * MIN),
    );
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(await eventRow(body.id)).toMatchObject({
      status: "failed",
      last_error_code: "UNKNOWN_SUBSCRIPTION",
    });
  });
});
