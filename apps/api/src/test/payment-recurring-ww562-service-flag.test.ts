// DOIT recurring billing, card legend-ww562 (architect 1102, P2 defense in
// depth): the DOIT_RECURRING_ENABLED kill switch must hold for callers that
// bypass the HTTP route (a job, an outbox consumer, an AI action). Written from
// docs/briefs/1164-payout-recurring-approval.md (Kartu B) and the route-level
// switch test payment-recurring-doit-off.test.ts, NOT from the implementation.
//
// Rule pinned: with the flag off, a service call WITHOUT injected deps (the
// shape every real caller uses) is refused with `code` SERVICE_UNAVAILABLE,
// DOIT receives no HTTP request, and nothing changes in the database.
//
// ASSUMPTIONS
// - "Refused" covers every service function that talks to DOIT: start, resume,
//   pause and cancel. The route switch answers 503 for cancel too, and the
//   brief says to restrict when in doubt, so the service does the same. (The
//   REC-19 rule "pause/cancel still reach DOIT after the provider was withdrawn
//   from the tenant plan" is about the plan, not this kill switch.)
// - The flag is `env.DOIT_RECURRING_ENABLED` (boolean, mutable like the route
//   test does). It is set through a cast so this file typechecks whether or not
//   the property is declared yet; the cast can go once the flag is on the base.
// - "No DOIT call" is observed on a real local HTTP stub the integration's
//   `baseUrl` points at (the same technique as REC-18), so the check does not
//   depend on any internal seam.
// - The control (flag on, same fixtures, reaches the stub) is what makes the
//   refusals meaningful: the tests fail only because the gate is missing.
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { env } from "../config/env";
import {
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  startSubscription,
} from "../services/payment-recurring.service";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness";

// Installs the audit writer the integration service needs.
createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const unique = () => randomBytes(4).toString("hex");
const PRICE = 150_000;

const flag = env as unknown as { DOIT_RECURRING_ENABLED?: boolean };
const wasEnabled = flag.DOIT_RECURRING_ENABLED;

function monthStart(offset: number): string {
  const now = new Date(Date.now() + 7 * 3_600_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 10);
}
const P_CUR = monthStart(0);
const P_NEXT = monthStart(1);

let dedicated: SecondTenant;
let tenantId = "";
let outletId = "";
let integrationId = "";
const planIds: string[] = [];
const subIds: string[] = [];
const profileCleanups: (() => Promise<void>)[] = [];

let server: http.Server;
let requests: { method: string; path: string }[] = [];
const sockets = new Set<import("node:net").Socket>();
const doitCalls = () => requests.filter((r) => r.path.includes("/recurring"));

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", path: req.url ?? "/" });
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const action = /subscriptions\/([^/]+)\/(pause|resume|cancel)$/.exec(
        req.url ?? "",
      );
      if (action) {
        const status = {
          pause: "paused",
          resume: "active",
          cancel: "cancelled",
        }[action[2] as "pause" | "resume" | "cancel"];
        res.end(
          JSON.stringify({
            id: decodeURIComponent(action[1]!),
            plan_id: "plan_stub",
            status,
          }),
        );
        return;
      }
      if (req.method === "POST" && /\/subscriptions$/.test(req.url ?? "")) {
        res.end(
          JSON.stringify({
            id: `sub_${unique()}`,
            plan_id: lastPlanProviderId,
            status: "pending",
            first_invoice_url: null,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dedicated = await createSecondTenant(owner, "ww562");
  tenantId = dedicated.tenantId;
  outletId = dedicated.outletId;
  await owner.query(
    `UPDATE tenants SET feature_flags = '{"modules":[],"integrationProviders":["doit"]}' WHERE id = $1`,
    [tenantId],
  );
  const created = await upsertIntegration(
    context(),
    {
      outletId: outletId as OutletId,
      provider: "doit",
      config: { baseUrl },
      credentials: {
        apiKey: `doit-key-${unique()}`,
        webhookSecret: `whsec-ww-${randomBytes(12).toString("hex")}`,
      },
    },
    actor,
  );
  await setIntegrationStatus(
    context(),
    created.id,
    { status: "active" },
    actor,
  );
  integrationId = created.id;
});

afterEach(() => {
  flag.DOIT_RECURRING_ENABLED = wasEnabled;
  requests = [];
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
  await step(async () => {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM payment_recurring_subscriptions WHERE plan_id = ANY($1::uuid[])",
      [planIds],
    );
    for (const row of rows) subIds.push(row.id);
  });
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
  for (const cleanup of profileCleanups) await step(cleanup);
  await step(
    query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationId || randomUUID(),
    ]),
  );
  await step(() => sweepTenantRows(tenantId));
  await step(() => removeSecondTenant(owner, dedicated));
  await step(() => owner.end());
  for (const socket of sockets) socket.destroy();
  await step(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let lastPlanProviderId = "";

async function seedPlan(): Promise<{ planId: string; providerPlanId: string }> {
  const plan = { planId: randomUUID(), providerPlanId: `plan_${unique()}` };
  lastPlanProviderId = plan.providerPlanId;
  await owner.query(
    `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
     VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', $5, 'month', 'active', $6)`,
    [
      plan.planId,
      tenantId,
      outletId,
      plan.providerPlanId,
      PRICE,
      integrationId,
    ],
  );
  planIds.push(plan.planId);
  return plan;
}

async function seedProfile(): Promise<string> {
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan uji', $2, true)`,
    [userId, `${userId}@example.test`],
  );
  const profileId = randomUUID();
  await owner.query(
    `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, 'Pelanggan uji', 'active', now())`,
    [profileId, tenantId, userId],
  );
  profileCleanups.push(async () => {
    await owner.query("DELETE FROM customer_profiles WHERE id = $1", [
      profileId,
    ]);
    await owner.query('DELETE FROM "user" WHERE id = $1', [userId]);
  });
  return profileId;
}

async function seedSubscription(status: "active" | "paused") {
  const plan = await seedPlan();
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            current_period_start, current_period_end, activated_at, paused_at, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, now() - interval '40 days',
             CASE WHEN $7::varchar = 'paused' THEN now() END, $10)`,
    [
      id,
      tenantId,
      outletId,
      plan.planId,
      randomUUID(),
      `sub_${unique()}`,
      status,
      P_CUR,
      P_NEXT,
      integrationId,
    ],
  );
  subIds.push(id);
  return id;
}

async function statusOf(subId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
    [subId],
  );
  return rows[0]!.status;
}

async function rowCountOfPlan(planId: string): Promise<number> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_recurring_subscriptions WHERE plan_id = $1",
    [planId],
  );
  for (const row of rows) subIds.push(row.id);
  return rows.length;
}

function codeOf(run: Promise<unknown>): Promise<string | null> {
  return run.then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? "NO_CODE",
  );
}

const startInput = (planId: string, customerProfileId: string) => ({
  planId,
  customerProfileId,
  idempotencyKey: `idem-${unique()}`,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ww562 the service refuses DOIT recurring work when DOIT_RECURRING_ENABLED is off", () => {
  it("ww562 control: flag on, resume without injected deps reaches DOIT", async () => {
    flag.DOIT_RECURRING_ENABLED = true;
    const subId = await seedSubscription("paused");
    const result = await resumeSubscription(context(), subId, new Date());
    expect(result.status).toBe("active");
    expect(
      doitCalls().map((r) => `${r.method} ${r.path.split("/").pop()}`),
    ).toEqual(["POST resume"]);
  });

  it("ww562 control: flag on, start without injected deps reaches DOIT and stores one row", async () => {
    flag.DOIT_RECURRING_ENABLED = true;
    const plan = await seedPlan();
    const profileId = await seedProfile();
    const result = await startSubscription(
      context(),
      startInput(plan.planId, profileId),
    );
    expect(result.subscription.status).toBe("pending_first_payment");
    expect(doitCalls()).toHaveLength(1);
    expect(await rowCountOfPlan(plan.planId)).toBe(1);
  });

  it("ww562 flag off: start is SERVICE_UNAVAILABLE, DOIT is not called, no row is written", async () => {
    flag.DOIT_RECURRING_ENABLED = false;
    const plan = await seedPlan();
    const profileId = await seedProfile();
    expect(
      await codeOf(
        startSubscription(context(), startInput(plan.planId, profileId)),
      ),
    ).toBe("SERVICE_UNAVAILABLE");
    expect(doitCalls()).toEqual([]);
    expect(await rowCountOfPlan(plan.planId)).toBe(0);
  });

  it("ww562 flag off: resume is SERVICE_UNAVAILABLE, DOIT is not called, the subscription stays paused", async () => {
    flag.DOIT_RECURRING_ENABLED = false;
    const subId = await seedSubscription("paused");
    expect(await codeOf(resumeSubscription(context(), subId, new Date()))).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(doitCalls()).toEqual([]);
    expect(await statusOf(subId)).toBe("paused");
  });

  it("ww562 flag off: pause is SERVICE_UNAVAILABLE, DOIT is not called, the subscription stays active", async () => {
    flag.DOIT_RECURRING_ENABLED = false;
    const subId = await seedSubscription("active");
    expect(await codeOf(pauseSubscription(context(), subId, new Date()))).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(doitCalls()).toEqual([]);
    expect(await statusOf(subId)).toBe("active");
  });

  it("ww562 flag off: cancel is SERVICE_UNAVAILABLE, DOIT is not called, the subscription stays active", async () => {
    flag.DOIT_RECURRING_ENABLED = false;
    const subId = await seedSubscription("active");
    expect(await codeOf(cancelSubscription(context(), subId, new Date()))).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(doitCalls()).toEqual([]);
    expect(await statusOf(subId)).toBe("active");
  });
});
