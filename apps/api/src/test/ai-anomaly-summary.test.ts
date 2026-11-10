// WS-12 wave 3 part A against PostgreSQL (bead legend-lely; PRD AI-09, AI-10,
// AIG-01, TEN-01..03): anomaly alerts and the daily summary, their worker
// jobs, notifications and tenant/outlet isolation. Services run with the
// restricted app role (RLS enforced). Every tenant is created here, so the
// numbers never depend on other suites' rows. POS event rows are inserted with
// `session_replication_role = replica` (no order parents needed, as in
// ai-tools-read-b.test.ts). Test data is left behind on purpose: the test
// PostgreSQL is disposable.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { roleAssignmentSchema } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  addBusinessDays,
  businessDayRange,
  type BusinessDate,
  type OutletId,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAiProviderForTests } from "../lib/ai/provider-factory.ts";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from "../lib/ai/types.ts";
import {
  acknowledgeAnomalyAlert,
  decideAnomaly,
  detectAnomalies,
  listAnomalyAlerts,
} from "../services/ai-anomaly.service.ts";
import {
  DAILY_SUMMARY_SETTLE_MS,
  DAILY_SUMMARY_SYSTEM_PROMPT,
  generateDailySummary,
  listDailySummaries,
} from "../services/ai-daily-summary.service.ts";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";
import { runAiAnomalyJob } from "../worker/ai-anomaly.job.ts";
import { runAiDailySummaryJob } from "../worker/ai-daily-summary.job.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const D = "2031-03-29";
const NOW = new Date("2031-03-30T05:00:00.000Z"); // 12:00 WIB, business day D+1
const OPS = "report.operational.view";
const SALES = "report.sales.view";

function daysBefore(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
const noonWib = (date: string) => `${date}T05:00:00.000Z`;

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  replica = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

type TestTenant = { id: string; brandId: string; outlets: string[] };

const platformTenantId = cafeLegendPlatformFixtures.tenant.id;

async function createTenant(label: string, outletCount: number) {
  const tenant: TestTenant = {
    id: randomUUID(),
    brandId: randomUUID(),
    outlets: Array.from({ length: outletCount }, () => randomUUID()),
  };
  const entityId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenant.id,
      `ai-anom-${tenant.id.slice(0, 8)}`,
      platformTenantId,
      `AI anomaly ${label}`,
    ],
  );
  await asOwner(tenant.id, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [tenant.brandId, tenant.id],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Test', false)`,
      [entityId, tenant.id],
    );
    for (const [index, outletId] of tenant.outlets.entries())
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Test', 'Asia/Jakarta',
                 '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
        [
          outletId,
          tenant.id,
          tenant.brandId,
          entityId,
          `N${index + 1}-${tenant.id.slice(0, 6).toUpperCase()}`,
          `${label} Outlet ${index + 1}`,
        ],
      );
  });
  return tenant;
}

// ---- users, roles, snapshots -------------------------------------------------

type Scope = { type: "tenant" } | { type: "outlet"; id: string };

/** A real user with a custom role holding exactly `permissions` at `scope`. */
async function holder(
  tenant: TestTenant,
  permissions: string[],
  scope: Scope,
): Promise<string> {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'AI Insight', $2, true, now(), now())`,
    [userId, `ai-insight-${userId}@example.test`],
  );
  const roleId = randomUUID();
  await asOwner(tenant.id, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `AI insight ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant.id,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
  return userId;
}

/** In-memory snapshot (same shape as ai-tools-read-a.test.ts). */
/** `userId`: a real user when the service writes it (acknowledged_by FK). */
function snapshot(
  tenant: TestTenant,
  permissions: string[],
  scope: Scope,
  userId: string = randomUUID(),
) {
  const roleId = randomUUID();
  return resolveAccessSnapshot({
    tenant: establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    userId,
    assignments: [
      roleAssignmentSchema.parse({
        id: randomUUID(),
        tenantId: tenant.id,
        userId,
        roleId,
        scope:
          scope.type === "tenant"
            ? { type: "tenant", id: null }
            : { type: "outlet", id: scope.id },
        validFrom: "2030-01-01T00:00:00.000Z",
        validUntil: null,
        assignedBy: randomUUID(),
        assignedAt: "2030-01-01T00:00:00.000Z",
      }),
    ],
    roles: [
      {
        id: roleId,
        permissions,
        mfaRequired: false,
        templateKey: null,
        allowedScopeTypes: [scope.type],
      },
    ] as never,
    org: {
      brands: [{ id: tenant.brandId }],
      outlets: tenant.outlets.map((id) => ({ id, brandId: tenant.brandId })),
      stations: [],
    } as never,
    mfaVerified: false,
    now: NOW,
  });
}

function systemContext(tenant: TestTenant) {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

// ---- seeding -------------------------------------------------------------------

async function seedVoid(
  tenant: TestTenant,
  outletId: string,
  at: string,
  amount: number,
) {
  await asOwner(
    tenant.id,
    (client) =>
      client.query(
        `INSERT INTO pos_order_voids (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason,
                                      reason_note, requested_by, approved_by, approval_request_id, voided_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'wrong_item', 'salah input', 'kasir-a', 'spv-b', $7, $8)`,
        [
          randomUUID(),
          tenant.id,
          outletId,
          randomUUID(),
          `AN-${randomUUID().slice(0, 8)}`,
          amount,
          randomUUID(),
          at,
        ],
      ),
    true,
  );
}

async function seedWaste(
  tenant: TestTenant,
  outletId: string,
  at: string,
  value: number,
  by: string,
) {
  await asOwner(
    tenant.id,
    (client) =>
      client.query(
        `INSERT INTO waste_logs (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity,
                                 reason, value_idr, logged_by, occurred_at)
         VALUES ($1, $2, $3, $4, 'inventory_item', $5, 1, 'spoiled', $6, $7, $8)`,
        [
          randomUUID(),
          tenant.id,
          outletId,
          randomUUID(),
          randomUUID(),
          value,
          by,
          at,
        ],
      ),
    true,
  );
}

async function seedDiscount(
  tenant: TestTenant,
  outletId: string,
  at: string,
  amount: number,
) {
  await asOwner(
    tenant.id,
    (client) =>
      client.query(
        `INSERT INTO pos_order_discounts (id, tenant_id, outlet_id, order_id, source, kind, amount_idr, reason,
                                          reason_note, applied_by, created_at)
         VALUES ($1, $2, $3, $4, 'manual', 'amount', $5, 'loyal', 'pelanggan setia', 'kasir-a', $6)`,
        [randomUUID(), tenant.id, outletId, randomUUID(), amount, at],
      ),
    true,
  );
}

async function seedOrder(
  tenant: TestTenant,
  outletId: string,
  number: string,
  total: number,
  status: string,
) {
  await asOwner(tenant.id, (client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5, $6, $7, $8)`,
      [randomUUID(), tenant.id, outletId, number, total, status, D, noonWib(D)],
    ),
  );
}

/** `ai_insight.*` outbox events of the tenant routed to notifications. */
async function insightEvents(tenant: TestTenant, name: string) {
  return asOwner(tenant.id, async (client) => {
    const result = await client.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'notification' AND event ->> 'name' = $2
        ORDER BY aggregate_id, sequence, id`,
      [tenant.id, name],
    );
    return result.rows.map((row) => row.event);
  });
}

/** Runs the worker's notification consumer (real recipient rules) over every
 * insight event of the tenant; a replay is a no-op (notification_outbox key). */
async function deliverInsightEvents(tenant: TestTenant) {
  const context = systemContext(tenant);
  const deliver = createNotificationConsumer(
    context,
    createNotificationRecipientResolver({ email: false, push: true }),
  );
  for (const name of [
    "ai_insight.anomaly_detected",
    "ai_insight.daily_summary_ready",
  ])
    for (const event of await insightEvents(tenant, name))
      await withTenant(db, context, (tx) =>
        deliver(event as never, String(event.idempotencyKey), tx as never),
      );
}

async function notificationCount(
  tenant: TestTenant,
  userId: string,
  category: string,
) {
  await deliverInsightEvents(tenant);
  return asOwner(tenant.id, async (client) => {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE tenant_id = $1 AND user_id = $2::uuid AND category = $3`,
      [tenant.id, userId, category],
    );
    return result.rows[0]?.n ?? 0;
  });
}

class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: AiCompletionRequest[] = [];
  constructor(private readonly text: string) {}
  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.requests.push(structuredClone(request));
    return {
      content: [{ type: "text", text: this.text }],
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 10 },
      model: "scripted-model",
    };
  }
}

// ---- fixtures --------------------------------------------------------------------

let tx: TestTenant; // two outlets
let ty: TestTenant; // other tenant, one outlet
let x1: OutletId;
let x2: OutletId;
let y1: OutletId;
let opsX1: string;
let opsX2: string;
let salesX1: string;
let salesX2: string;
let opsY: string;

beforeAll(async () => {
  tx = await createTenant("X", 2);
  ty = await createTenant("Y", 1);
  [x1, x2] = tx.outlets as [OutletId, OutletId];
  [y1] = ty.outlets as [OutletId];
  opsX1 = await holder(tx, [OPS], { type: "outlet", id: x1 });
  opsX2 = await holder(tx, [OPS], { type: "outlet", id: x2 });
  // Billing for the model call needs ai.ask; salesX2 has the report only.
  salesX1 = await holder(tx, [SALES, "ai.ask"], { type: "outlet", id: x1 });
  salesX2 = await holder(tx, [SALES], { type: "outlet", id: x2 });
  opsY = await holder(ty, [OPS, SALES], { type: "tenant" });

  // X1: void baseline Rp10.000/day for 28 days, Rp75.000 on D (ratio 7.5).
  for (let k = 1; k <= 28; k += 1)
    await seedVoid(tx, x1, noonWib(daysBefore(D, k)), 10_000);
  for (let i = 0; i < 3; i += 1) await seedVoid(tx, x1, noonWib(D), 25_000);
  // X1: discount with zero baseline below Rp100.000 -> no alert.
  await seedDiscount(tx, x1, noonWib(D), 50_000);
  // X1: waste with zero baseline at Rp150.000 -> high alert.
  await seedWaste(tx, x1, noonWib(D), 150_000, opsX1);
  // X1 orders of D (only completed ones count).
  await seedOrder(tx, x1, "S1", 100_000, "completed");
  await seedOrder(tx, x1, "S2", 50_000, "completed");
  await seedOrder(tx, x1, "S3", 999_000, "awaiting_payment");
  // Y1: one waste spike of its own.
  await seedWaste(ty, y1, noonWib(D), 200_000, opsY);
  // X: an AI budget so the summary may call the model.
  await asOwner(tx.id, (client) =>
    client.query(
      `INSERT INTO ai_settings (tenant_id, monthly_budget_idr, updated_by) VALUES ($1, 100000000000, $2)`,
      [tx.id, salesX1],
    ),
  );
});

afterEach(() => setAiProviderForTests(undefined));

afterAll(async () => {
  await owner.end();
});

// ---- rule ------------------------------------------------------------------------

describe("decideAnomaly (rule-v1)", () => {
  it("applies the warn/high ratios and the zero-baseline floor", () => {
    expect(decideAnomaly("void", 19_000, 280_000)).toBeNull(); // 1.9x
    expect(decideAnomaly("void", 20_000, 280_000)?.severity).toBe("warn");
    expect(decideAnomaly("void", 30_000, 280_000)?.severity).toBe("high");
    expect(decideAnomaly("refund", 99_999, 0)).toBeNull();
    expect(decideAnomaly("refund", 100_000, 0)?.severity).toBe("high");
    expect(decideAnomaly("waste", 0, 0)).toBeNull();
  });
});

// ---- AI-09 -----------------------------------------------------------------------

describe("AI-09 anomaly alerts", () => {
  it("raises void + waste alerts once and notifies only holders at the outlet", async () => {
    const first = await detectAnomalies(
      systemContext(tx),
      { outletId: x1, businessDate: D },
      NOW,
    );
    expect(first.created).toBe(2);
    const byKind = Object.fromEntries(first.alerts.map((a) => [a.kind, a]));
    expect(byKind.void).toMatchObject({
      observedIdr: 75_000,
      baselineIdr: 10_000,
      ratio: 7.5,
      severity: "high",
      status: "open",
    });
    expect(byKind.waste).toMatchObject({
      observedIdr: 150_000,
      baselineIdr: 0,
      severity: "high",
    });
    expect(byKind.discount).toBeUndefined();
    expect(byKind.refund).toBeUndefined();
    expect(await notificationCount(tx, opsX1, "operational_anomaly")).toBe(2);
    expect(await notificationCount(tx, opsX2, "operational_anomaly")).toBe(0);
    expect(await notificationCount(tx, salesX1, "operational_anomaly")).toBe(0);

    const again = await detectAnomalies(
      systemContext(tx),
      { outletId: x1, businessDate: D },
      NOW,
    );
    expect(again.created).toBe(0);
    expect(again.alerts).toHaveLength(2);
    const events = await insightEvents(tx, "ai_insight.anomaly_detected");
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(opsX1);
    expect(await notificationCount(tx, opsX1, "operational_anomaly")).toBe(2);
  });

  it("the worker job evaluates the previous business date of each outlet", async () => {
    const result = await runAiAnomalyJob(systemContext(ty), NOW, {
      force: true,
    });
    expect(result).toMatchObject({ outlets: 1, failedOutlets: 0, created: 1 });
    const rerun = await runAiAnomalyJob(systemContext(ty), NOW, {
      force: true,
    });
    expect(rerun?.created).toBe(0);
    expect(await notificationCount(ty, opsY, "operational_anomaly")).toBe(1);
  });

  it("lists only reachable outlets and never another tenant's alerts", async () => {
    const x1Caller = snapshot(tx, [OPS], { type: "outlet", id: x1 });
    const listed = await listAnomalyAlerts(x1Caller, {});
    expect(listed.map((a) => a.outletId)).toEqual([x1, x1]);
    await expect(
      listAnomalyAlerts(x1Caller, { outletId: x2 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listAnomalyAlerts(x1Caller, { outletId: y1 }),
    ).rejects.toMatchObject({ status: 403 });
    const noPermission = snapshot(tx, [SALES], { type: "tenant" });
    await expect(listAnomalyAlerts(noPermission, {})).rejects.toMatchObject({
      status: 403,
    });

    const yCaller = snapshot(ty, [OPS], { type: "tenant" });
    const yListed = await listAnomalyAlerts(yCaller, {});
    expect(yListed).toHaveLength(1);
    expect(yListed[0]).toMatchObject({ outletId: y1, kind: "waste" });
    expect(
      await listAnomalyAlerts(x1Caller, { status: "open", from: D, to: D }),
    ).toHaveLength(2);
  });

  it("acknowledges inside the caller's reach only", async () => {
    const x1Caller = snapshot(tx, [OPS], { type: "outlet", id: x1 }, opsX1);
    const [alert] = await listAnomalyAlerts(x1Caller, { outletId: x1 });
    const x2Caller = snapshot(tx, [OPS], { type: "outlet", id: x2 });
    await expect(
      acknowledgeAnomalyAlert(x2Caller, alert!.id, NOW),
    ).rejects.toMatchObject({ status: 404 });
    const yCaller = snapshot(ty, [OPS], { type: "tenant" });
    await expect(
      acknowledgeAnomalyAlert(yCaller, alert!.id, NOW),
    ).rejects.toMatchObject({ status: 404 });

    const acked = await acknowledgeAnomalyAlert(x1Caller, alert!.id, NOW);
    expect(acked.status).toBe("acknowledged");
    const twice = await acknowledgeAnomalyAlert(x1Caller, alert!.id, NOW);
    expect(twice.status).toBe("acknowledged");
    // A re-detection keeps the acknowledged status.
    await detectAnomalies(
      systemContext(tx),
      { outletId: x1, businessDate: D },
      NOW,
    );
    const after = await listAnomalyAlerts(x1Caller, {
      outletId: x1,
      status: "acknowledged",
    });
    expect(after.map((a) => a.id)).toEqual([alert!.id]);
  });

  it("notifies once more when an alert rises from warn to high", async () => {
    for (let k = 1; k <= 28; k += 1)
      await seedVoid(tx, x2, noonWib(daysBefore(D, k)), 10_000);
    await seedVoid(tx, x2, noonWib(D), 25_000); // 2.5x -> warn
    const input = { outletId: x2, businessDate: D };
    const warn = await detectAnomalies(systemContext(tx), input, NOW);
    expect(warn.created).toBe(1);
    expect(warn.alerts[0]).toMatchObject({ kind: "void", severity: "warn" });
    await seedVoid(tx, x2, noonWib(D), 10_000); // 3.5x -> high
    const high = await detectAnomalies(systemContext(tx), input, NOW);
    expect(high.created).toBe(0);
    expect(high.alerts[0]).toMatchObject({ kind: "void", severity: "high" });
    await detectAnomalies(systemContext(tx), input, NOW); // no third event
    const alertId = high.alerts[0]!.id;
    const events = (
      await insightEvents(tx, "ai_insight.anomaly_detected")
    ).filter((event) => event.aggregateId === alertId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(await notificationCount(tx, opsX2, "operational_anomaly")).toBe(2);
  });
});

// ---- AI-10 -----------------------------------------------------------------------

describe("AI-10 daily summary", () => {
  it("sends only the metrics to the model and stores an AI-assisted text", async () => {
    const provider = new ScriptedProvider(
      "Penjualan hari ini Rp150.000 dari 2 pesanan.",
    );
    setAiProviderForTests(provider);
    const first = await generateDailySummary(
      systemContext(tx),
      { tenantId: tx.id, outletId: x1, businessDate: D },
      NOW,
    );
    expect(first.status).toBe("created");
    expect(first.summary).toMatchObject({
      outletId: x1,
      businessDate: D,
      aiAssisted: true,
      text: "Penjualan hari ini Rp150.000 dari 2 pesanan.",
      metrics: {
        salesIdr: 150_000,
        orders: 2,
        voidIdr: 75_000,
        discountIdr: 50_000,
        refundIdr: 0,
        wasteIdr: 150_000,
      },
    });
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.system).toBe(DAILY_SUMMARY_SYSTEM_PROMPT);
    expect(request.tools).toEqual([]);
    const sent = JSON.stringify(request.messages);
    for (const secret of [x1, tx.id, "S1", "S3", "kasir-a", opsX1, salesX1])
      expect(sent).not.toContain(secret);
    expect(await notificationCount(tx, salesX1, "daily_summary")).toBe(1);
    expect(await notificationCount(tx, opsX1, "daily_summary")).toBe(0);

    const again = await generateDailySummary(
      systemContext(tx),
      { tenantId: tx.id, outletId: x1, businessDate: D },
      NOW,
    );
    expect(again.status).toBe("unchanged");
    expect(again.summary?.id).toBe(first.summary?.id);
    expect(provider.requests).toHaveLength(1);
    expect(await notificationCount(tx, salesX1, "daily_summary")).toBe(1);
  });

  it("refreshes a recent day when late orders arrive, without a new notification", async () => {
    const provider = new ScriptedProvider("Ringkasan diperbarui.");
    setAiProviderForTests(provider);
    const input = { tenantId: tx.id, outletId: x1, businessDate: D };
    const before = await generateDailySummary(systemContext(tx), input, NOW);
    await seedOrder(tx, x1, "S4", 20_000, "completed"); // late / offline sync
    const updated = await generateDailySummary(systemContext(tx), input, NOW);
    expect(updated.status).toBe("updated");
    expect(updated.summary?.id).toBe(before.summary?.id);
    expect(updated.summary?.metrics).toMatchObject({
      salesIdr: 170_000,
      orders: 3,
    });
    expect(updated.summary?.text).toBe("Ringkasan diperbarui.");
    expect(provider.requests).toHaveLength(1);
    const same = await generateDailySummary(systemContext(tx), input, NOW);
    expect(same.status).toBe("unchanged");
    expect(provider.requests).toHaveLength(1);
    expect(await notificationCount(tx, salesX1, "daily_summary")).toBe(1);

    // Outside the refresh window the row is final.
    await seedOrder(tx, x1, "S5", 30_000, "completed");
    const late = new Date(NOW.getTime() + 5 * 86_400_000);
    const final = await generateDailySummary(systemContext(tx), input, late);
    expect(final.status).toBe("unchanged");
    expect(final.summary?.metrics.salesIdr).toBe(170_000);
    expect(provider.requests).toHaveLength(1);
  });

  it("bills only a recipient with ai.ask, else the template without a model call", async () => {
    const provider = new ScriptedProvider("tidak dipakai");
    setAiProviderForTests(provider);
    const result = await generateDailySummary(
      systemContext(tx),
      { tenantId: tx.id, outletId: x2, businessDate: D },
      NOW,
    );
    expect(result.status).toBe("created");
    expect(result.summary?.aiAssisted).toBe(false);
    expect(result.summary?.text).toContain(`Ringkasan ${D}`);
    expect(result.summary?.metrics.orders).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(await notificationCount(tx, salesX2, "daily_summary")).toBe(1);
  });

  it("a second worker skips while the day's lock is held, so only one pays", async () => {
    const provider = new ScriptedProvider("Satu kali saja.");
    setAiProviderForTests(provider);
    const date = daysBefore(D, 1);
    const input = { tenantId: tx.id, outletId: x1, businessDate: date };
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `ai-daily-summary:${tx.id}:${x1}:${date}`,
      ]);
      const busy = await generateDailySummary(systemContext(tx), input, NOW);
      expect(busy).toEqual({ status: "busy", summary: null });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const done = await generateDailySummary(systemContext(tx), input, NOW);
    expect(done.status).toBe("created");
    expect(provider.requests).toHaveLength(1);
  });

  it("the worker job waits for the settle delay and writes each day once", async () => {
    const provider = new ScriptedProvider("tidak dipakai");
    setAiProviderForTests(provider);
    const cutoff = await asOwner(ty.id, async (client) => {
      const result = await client.query<{ cutoff: string }>(
        "SELECT business_day_cutoff AS cutoff FROM outlets WHERE id = $1",
        [y1],
      );
      return result.rows[0]!.cutoff;
    });
    const clock = { timeZone: "Asia/Jakarta", cutoff };
    const dayStart = businessDayRange(
      addBusinessDays(D as BusinessDate, 1),
      clock,
    ).start;
    // One hour after D's cutoff: D has not settled, D-1 has.
    const early = new Date(dayStart.getTime() + 60 * 60_000);
    const first = await runAiDailySummaryJob(systemContext(ty), early, {
      force: true,
    });
    expect(first).toMatchObject({ failedOutlets: 0, created: 1 });
    const yCaller = snapshot(ty, [SALES], { type: "tenant" });
    expect(
      (await listDailySummaries(yCaller, { outletId: y1 })).map(
        (row) => row.businessDate,
      ),
    ).toEqual([daysBefore(D, 1)]);
    const settled = new Date(
      dayStart.getTime() + DAILY_SUMMARY_SETTLE_MS + 60_000,
    );
    const second = await runAiDailySummaryJob(systemContext(ty), settled, {
      force: true,
    });
    expect(second).toMatchObject({ failedOutlets: 0, created: 1 });
    const third = await runAiDailySummaryJob(systemContext(ty), settled, {
      force: true,
    });
    expect(third?.created).toBe(0);
    // Tenant Y has no AI budget: the gateway is stopped, so no model call.
    expect(provider.requests).toHaveLength(0);
    expect(await notificationCount(ty, opsY, "daily_summary")).toBe(2);
  });

  it("lists per permitted outlet and isolates tenants", async () => {
    const salesCaller = snapshot(tx, [SALES], { type: "outlet", id: x1 });
    const rows = await listDailySummaries(salesCaller, { outletId: x1 });
    expect(rows.map((r) => r.businessDate)).toEqual([D, daysBefore(D, 1)]);
    expect(rows.every((r) => r.outletId === x1)).toBe(true);
    await expect(
      listDailySummaries(salesCaller, { outletId: x2 }),
    ).rejects.toMatchObject({ status: 403 });
    const opsOnly = snapshot(tx, [OPS], { type: "tenant" });
    await expect(
      listDailySummaries(opsOnly, { outletId: x1 }),
    ).rejects.toMatchObject({ status: 403 });
    const yCaller = snapshot(ty, [SALES], { type: "tenant" });
    await expect(
      listDailySummaries(yCaller, { outletId: x1 }),
    ).rejects.toMatchObject({ status: 403 });
    const yRows = await listDailySummaries(yCaller, { outletId: y1 });
    expect(yRows).toHaveLength(2);
    expect(yRows.every((row) => row.outletId === y1)).toBe(true);
  });
});
