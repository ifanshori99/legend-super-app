// DOIT recurring billing, card legend-x2jzq (second opinion 1173, P1): a failed
// stop leaves the subscription parked as needs_reconcile / CANCEL_PENDING, and
// that marker must SURVIVE until DOIT confirms `cancelled`. Written from
// docs/briefs/sub-1179-payout-so1173.md (Kartu 2) and the fixtures of
// payment-recurring-ww562-service-flag.test.ts, NOT from the implementation.
//
// Rules pinned (CTO decision on the card; money rule: when in doubt the
// subscription stays parked and billing is not continued):
// - A stop answered by DOIT with HTTP 200 but a status that is not `cancelled`
//   (still `active`) is an unconfirmed stop: the row keeps CANCEL_PENDING, it
//   does not become RESPONSE_MISMATCH.
// - resolve (DOIT still bills) and resume never remove the marker and never
//   send a resume call to DOIT.
// - A pause that was already in flight (it read `active` before the park) must
//   not overwrite the marker when its answer arrives after a cancel failed.
// - Only a DOIT-confirmed `cancelled` closes the row.
//
// ASSUMPTIONS
// - The marker is status `needs_reconcile` with reconcile_reason
//   'CANCEL_PENDING' (the value pinned by ww562-service-flag).
// - Whether a service call throws or returns on an unconfirmed stop is not
//   pinned; calls are wrapped so only the stored state and the DOIT traffic are
//   asserted.
// - The in-flight pause is held by the local DOIT stub (it does not answer until
//   the test releases it), so the interleaving is deterministic, not timing
//   based. Should the pause hold the row lock across the HTTP call and so block
//   the failing cancel, the test releases the pause after a safety wait; the
//   final assertions are the same.
// - "No resume call" is observed on the stub (POST .../resume).
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
  resolveNeedsReconcileSubscription,
  resumeSubscription,
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

let server: http.Server;
let requests: { method: string; path: string }[] = [];
// What GET (reconcile read) reports for the subscription.
let providerStatus = "active";
// How the stub answers a cancel call: a 500, a 200 that still says `active`
// (unconfirmed), or a normal 200 `cancelled`.
let cancelMode: "ok" | "fail" | "active200" = "ok";
// When set, the next call of that kind (pause, resume, or the reconcile read
// `read`) is held until `releaseHeld()`; `heldSeen` resolves once the stub has
// received it.
let heldKind: "pause" | "resume" | "read" | null = null;
let heldGate: Promise<void> = Promise.resolve();
let releaseHeld: () => void = () => undefined;
let heldSeen: Promise<void> = Promise.resolve();
let markHeldSeen: () => void = () => undefined;
const sockets = new Set<import("node:net").Socket>();
const doitCalls = () => requests.filter((r) => r.path.includes("/recurring"));
const resumeCalls = () => requests.filter((r) => /\/resume$/.test(r.path));

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

function holdNext(kind: "pause" | "resume" | "read"): void {
  heldKind = kind;
  heldGate = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  heldSeen = new Promise<void>((resolve) => {
    markHeldSeen = resolve;
  });
}

async function holdIfRequested(kind: "pause" | "resume" | "read") {
  if (heldKind !== kind) return;
  heldKind = null;
  markHeldSeen();
  await heldGate;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", path: req.url ?? "/" });
    req.resume();
    req.on("end", () => {
      void (async () => {
        res.setHeader("content-type", "application/json");
        const action = /subscriptions\/([^/]+)\/(pause|resume|cancel)$/.exec(
          req.url ?? "",
        );
        if (action) {
          const kind = action[2] as "pause" | "resume" | "cancel";
          const id = decodeURIComponent(action[1]!);
          if (kind !== "cancel") await holdIfRequested(kind);
          if (kind === "cancel" && cancelMode === "fail") {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "boom" }));
            return;
          }
          const status =
            kind === "pause"
              ? "paused"
              : kind === "resume"
                ? "active"
                : cancelMode === "active200"
                  ? "active"
                  : "cancelled";
          res.end(JSON.stringify({ id, plan_id: lastPlanProviderId, status }));
          return;
        }
        const one = /subscriptions\/([^/]+)$/.exec(req.url ?? "");
        if (req.method === "GET" && one) {
          await holdIfRequested("read");
          res.end(
            JSON.stringify({
              id: decodeURIComponent(one[1]!),
              plan_id: lastPlanProviderId,
              status: providerStatus,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      })();
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

  dedicated = await createSecondTenant(owner, "x2jzq");
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
        webhookSecret: `whsec-x2-${randomBytes(12).toString("hex")}`,
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
  releaseHeld();
  heldKind = null;
  flag.DOIT_RECURRING_ENABLED = wasEnabled;
  requests = [];
  cancelMode = "ok";
  providerStatus = "active";
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

async function seedSubscription(
  status: "active" | "paused" | "needs_reconcile" = "active",
  reason: string | null = null,
): Promise<string> {
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
  const id = randomUUID();
  await owner.query(
    `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
            current_period_start, current_period_end, activated_at, paused_at, reconcile_reason, gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, now() - interval '40 days',
             CASE WHEN $7::varchar = 'paused' THEN now() END, $10, $11)`,
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
      reason,
      integrationId,
    ],
  );
  subIds.push(id);
  return id;
}

async function stateOf(
  subId: string,
): Promise<{ status: string; reason: string | null }> {
  const { rows } = await owner.query<{
    status: string;
    reconcile_reason: string | null;
  }>(
    "SELECT status, reconcile_reason FROM payment_recurring_subscriptions WHERE id = $1",
    [subId],
  );
  return { status: rows[0]!.status, reason: rows[0]!.reconcile_reason };
}

const swallow = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    () => undefined,
  );

// Cancel fails with a 500: the row is parked as CANCEL_PENDING.
async function parkByFailedCancel(): Promise<string> {
  flag.DOIT_RECURRING_ENABLED = true;
  const subId = await seedSubscription();
  cancelMode = "fail";
  await swallow(cancelSubscription(context(), subId, new Date()));
  cancelMode = "ok";
  return subId;
}

const PARKED = { status: "needs_reconcile", reason: "CANCEL_PENDING" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("x2jzq CANCEL_PENDING survives until DOIT confirms cancelled", () => {
  it("x2jzq control: a failed cancel parks the row, and a confirmed cancel retry closes it", async () => {
    const subId = await parkByFailedCancel();
    expect(await stateOf(subId)).toEqual(PARKED);

    await swallow(cancelSubscription(context(), subId, new Date()));
    expect((await stateOf(subId)).status).toBe("cancelled");
  });

  it("x2jzq a cancel retry answered 200 but still active keeps CANCEL_PENDING (not RESPONSE_MISMATCH)", async () => {
    const subId = await parkByFailedCancel();

    cancelMode = "active200";
    await swallow(cancelSubscription(context(), subId, new Date()));

    expect(await stateOf(subId)).toEqual(PARKED);
  });

  it("x2jzq after an unconfirmed cancel retry, resolve (DOIT still active) keeps the park", async () => {
    const subId = await parkByFailedCancel();
    cancelMode = "active200";
    await swallow(cancelSubscription(context(), subId, new Date()));

    providerStatus = "active";
    requests = [];
    await swallow(
      resolveNeedsReconcileSubscription(context(), subId, new Date()),
    );

    expect(await stateOf(subId)).toEqual(PARKED);
    expect(resumeCalls()).toEqual([]);
  });

  it("x2jzq after an unconfirmed cancel retry, resume is refused and DOIT gets no resume call", async () => {
    const subId = await parkByFailedCancel();
    cancelMode = "active200";
    await swallow(cancelSubscription(context(), subId, new Date()));

    requests = [];
    const resumed = await resumeSubscription(context(), subId, new Date()).then(
      () => "resolved",
      () => "rejected",
    );

    expect(resumed).toBe("rejected");
    expect(resumeCalls()).toEqual([]);
    expect(await stateOf(subId)).toEqual(PARKED);
  });

  it("x2jzq after the unconfirmed retry only a DOIT-confirmed cancelled closes the row", async () => {
    const subId = await parkByFailedCancel();
    cancelMode = "active200";
    await swallow(cancelSubscription(context(), subId, new Date()));
    expect(await stateOf(subId)).toEqual(PARKED);

    providerStatus = "cancelled";
    await swallow(
      resolveNeedsReconcileSubscription(context(), subId, new Date()),
    );
    expect((await stateOf(subId)).status).toBe("cancelled");
  });

  it("x2jzq a pause already in flight does not erase CANCEL_PENDING when its answer arrives after a failed cancel", async () => {
    flag.DOIT_RECURRING_ENABLED = true;
    const subId = await seedSubscription();

    // The pause read `active` and now waits for DOIT (held by the stub).
    holdNext("pause");
    const pause = swallow(pauseSubscription(context(), subId, new Date()));
    await heldSeen;

    // Meanwhile a cancel fails and parks the row. Safety: if the pause holds
    // the row lock across its HTTP call the cancel cannot finish, so release
    // the pause after a bounded wait instead of hanging.
    cancelMode = "fail";
    const cancel = swallow(cancelSubscription(context(), subId, new Date()));
    await Promise.race([
      cancel,
      new Promise<void>((resolve) => setTimeout(resolve, 4000)),
    ]);
    cancelMode = "ok";

    // Now DOIT answers the pause: `paused`, confirmed.
    releaseHeld();
    await pause;
    await cancel;

    // The park must hold: still needs_reconcile / CANCEL_PENDING, not paused.
    expect(await stateOf(subId)).toEqual(PARKED);

    // And the parked row cannot be resumed into billing.
    requests = [];
    const resumed = await resumeSubscription(context(), subId, new Date()).then(
      () => "resolved",
      () => "rejected",
    );
    expect(resumed).toBe("rejected");
    expect(resumeCalls()).toEqual([]);

    // Only a confirmed cancelled closes it.
    providerStatus = "cancelled";
    await swallow(
      resolveNeedsReconcileSubscription(context(), subId, new Date()),
    );
    expect((await stateOf(subId)).status).toBe("cancelled");
  });
  it("x2jzq pause on a parked row is refused: the marker stays and the row is never paused", async () => {
    const subId = await parkByFailedCancel();

    requests = [];
    await swallow(pauseSubscription(context(), subId, new Date()));

    expect(await stateOf(subId)).toEqual(PARKED);
    // Parked, then a resume must still be refused with no DOIT resume call.
    await swallow(resumeSubscription(context(), subId, new Date()));
    expect(resumeCalls()).toEqual([]);
    expect(await stateOf(subId)).toEqual(PARKED);
  });

  it("x2jzq a resume already in flight does not erase CANCEL_PENDING when its answer arrives after a failed cancel", async () => {
    flag.DOIT_RECURRING_ENABLED = true;
    const subId = await seedSubscription("paused");

    holdNext("resume");
    const resume = swallow(resumeSubscription(context(), subId, new Date()));
    await heldSeen;

    cancelMode = "fail";
    const cancel = swallow(cancelSubscription(context(), subId, new Date()));
    await Promise.race([
      cancel,
      new Promise<void>((resolve) => setTimeout(resolve, 4000)),
    ]);
    cancelMode = "ok";

    releaseHeld();
    await resume;
    await cancel;

    expect(await stateOf(subId)).toEqual(PARKED);
  });

  it("x2jzq a resolve already in flight does not erase CANCEL_PENDING when its DOIT read arrives after a failed cancel", async () => {
    flag.DOIT_RECURRING_ENABLED = true;
    // Another reconcile reason, with a DOIT id: resolve is allowed here.
    const subId = await seedSubscription(
      "needs_reconcile",
      "RESPONSE_MISMATCH",
    );

    providerStatus = "active";
    holdNext("read");
    const resolve = swallow(
      resolveNeedsReconcileSubscription(context(), subId, new Date()),
    );
    await heldSeen;

    cancelMode = "fail";
    const cancel = swallow(cancelSubscription(context(), subId, new Date()));
    await Promise.race([
      cancel,
      new Promise<void>((done) => setTimeout(done, 4000)),
    ]);
    cancelMode = "ok";

    releaseHeld();
    await resolve;
    await cancel;

    // DOIT said `active` to the (older) resolve; the park must still hold.
    expect(await stateOf(subId)).toEqual(PARKED);
  });
});
