// Automatic "pay at the cashier" failover from gateway health (bead
// legend-8vgid; PRD v1.7 §3.13 Failover). A down gateway opens ONE incident per
// outlet: one audit row, one alert per supervisor, one marker per bill, and no
// money movement. A healthy reading closes it, and the next outage is a new
// incident. State lives in the audit log (no table), so every assertion counts
// rows as a delta from a known-closed starting point.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { PaymentGatewayStatus } from "@starter/shared/payment";
import { createApp } from "../app";
import {
  setPaymentGateway,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import {
  createPaymentLink,
  getPaymentLinkView,
  requestPayAtCashier,
  type CreatePaymentLinkInput,
} from "../services/payment.service";
import {
  listOutletsWithOpenIncident,
  probeGatewayHealth,
  resetGatewayHealthCache,
  syncGatewayHealth,
} from "../services/payment-failover.service";
import {
  GATEWAY_PROBE_INTERVAL_MS,
  startGatewayProbeSweep,
  sweepGatewayHealth,
} from "../worker/payment-failover-probe.job";
import { agent, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdLinkIds: string[] = [];
const createdUserIds: string[] = [];

function contextFor(outletIds: readonly OutletId[] = [outletA]) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [...outletIds] },
  ) as ScopedTenantContext;
}

const unique = () => randomBytes(4).toString("hex");

async function openBill(
  outletId: OutletId = outletA,
  overrides: Partial<CreatePaymentLinkInput> = {},
) {
  const opened = await createPaymentLink(
    contextFor([outletId]),
    {
      outletId,
      reference: `F-${unique()}`,
      tableLabel: "A03",
      pax: 2,
      subtotalIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: 100_000,
      returnPath: "/t/v1.abc",
      ...overrides,
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  return opened;
}

/** Gateway whose health the test sets; it creates no payments. */
class HealthGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  healthValue: PaymentGatewayStatus = "available";
  /** Outlets the gateway was asked about, in order. */
  readonly probed: Array<string | undefined> = [];
  /** Outlets whose health call throws (a gateway that hangs or errors). */
  readonly throwFor = new Set<string>();
  async health(_context?: unknown, outletId?: string) {
    this.probed.push(outletId);
    if (outletId && this.throwFor.has(outletId))
      throw new Error("gateway timed out");
    return { status: this.healthValue };
  }
  async createIntent(): Promise<never> {
    throw new Error("failover tests never reach the gateway");
  }
  async getStatus(): Promise<never> {
    throw new Error("failover tests never poll the gateway");
  }
  async channels() {
    return [{ code: "bca", name: "BCA" }];
  }
}

let gateway: HealthGateway;
/** Each test lives 20 minutes after the previous one, so a recovery recorded
 * by one never counts as "just recovered" for the next (REOPEN_MS is 10). */
let testNo = 0;
let base = 0;
const at = (minutes = 0) => new Date(base + minutes * 60_000);
let supervisorId: string;
let otherOutletSupervisorId: string;

async function signedInSupervisor(scopeOutlet: OutletId) {
  const client = agent(app);
  await signUp(client, "Failover supervisor");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'supervisor'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No supervisor role");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id, scopeOutlet],
  );
  return userId;
}

async function auditCount(action: string, outletId: OutletId = outletA) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND outlet_id = $2 AND event->>'action' = $3`,
    [tenantId, outletId, action],
  );
  return rows[0]!.n;
}

async function linkAuditCount(action: string, linkId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenantId, action, linkId],
  );
  return rows[0]!.n;
}

async function alertCount(userId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 AND category = 'payment_failover'`,
    [tenantId, userId],
  );
  return rows[0]!.n;
}

async function paidAndIntents(linkId: string) {
  const { rows } = await owner.query<{ paid: string; intents: number }>(
    `SELECT l.paid_idr::text AS paid,
            (SELECT count(*)::int FROM payment_intents i
              WHERE i.tenant_id = l.tenant_id AND i.payment_link_id = l.id) AS intents
       FROM payment_links l WHERE l.tenant_id = $1 AND l.id = $2`,
    [tenantId, linkId],
  );
  return rows[0]!;
}

beforeEach(async () => {
  testNo += 1;
  base = Date.now() + testNo * 20 * 60_000;
  gateway = new HealthGateway();
  setPaymentGateway(gateway);
  resetGatewayHealthCache();
  // Start every test from a closed incident, whatever an earlier test left.
  for (const outlet of [outletA, outletB])
    await syncGatewayHealth(
      contextFor([outlet]),
      outlet,
      { status: "available" },
      new Date(),
    );
  resetGatewayHealthCache();
  supervisorId ??= await signedInSupervisor(outletA);
  otherOutletSupervisorId ??= await signedInSupervisor(outletB);
});

afterEach(() => {
  setPaymentGateway(null);
  resetGatewayHealthCache();
});

afterAll(async () => {
  if (createdLinkIds.length > 0) {
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdLinkIds],
    );
  }
  if (createdUserIds.length > 0) {
    await owner.query(
      `DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN
         (SELECT id FROM notifications WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]))`,
      [tenantId, createdUserIds],
    );
    await owner.query(
      "DELETE FROM notifications WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])",
      [tenantId, createdUserIds],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
  }
  await owner.end();
});

describe("gateway failover to the cashier", () => {
  it("a healthy gateway keeps the normal path and records nothing", async () => {
    const started = await auditCount("payment.gateway_failover_started");
    const alerts = await alertCount(supervisorId);
    const { token, linkId } = await openBill();
    const view = await getPaymentLinkView(contextFor(), token, at());
    expect(view.gateway.status).toBe("available");
    for (const method of view.methods) expect(method.enabled).toBe(true);
    expect(await auditCount("payment.gateway_failover_started")).toBe(started);
    expect(
      await linkAuditCount("payment.link_failover_to_cashier", linkId),
    ).toBe(0);
    expect(await alertCount(supervisorId)).toBe(alerts);
  });

  it("a down gateway moves the bill to the cashier once, with no money change", async () => {
    gateway.healthValue = "down";
    const started = await auditCount("payment.gateway_failover_started");
    const { token, linkId } = await openBill();
    const before = await paidAndIntents(linkId);
    for (let i = 0; i < 3; i += 1) {
      const view = await getPaymentLinkView(contextFor(), token, at());
      expect(view.gateway.status).toBe("down");
      for (const method of view.methods)
        expect(method).toMatchObject({
          enabled: false,
          unavailableReason: "gateway_down",
        });
    }
    const first = await requestPayAtCashier(contextFor(), token, at());
    const second = await requestPayAtCashier(contextFor(), token, at());
    expect(second.requestedAt).toBe(first.requestedAt);

    expect(await auditCount("payment.gateway_failover_started")).toBe(
      started + 1,
    );
    expect(
      await linkAuditCount("payment.link_failover_to_cashier", linkId),
    ).toBe(1);
    expect(
      await linkAuditCount("payment.pay_at_cashier_requested", linkId),
    ).toBe(1);
    expect(await paidAndIntents(linkId)).toEqual(before);
  });

  it("supervisors of the outlet get exactly one alert per incident, across bills and requests", async () => {
    gateway.healthValue = "down";
    const alerts = await alertCount(supervisorId);
    const elsewhere = await alertCount(otherOutletSupervisorId);
    const one = await openBill();
    const two = await openBill();
    await getPaymentLinkView(contextFor(), one.token, at());
    await getPaymentLinkView(contextFor(), two.token, at());
    await requestPayAtCashier(contextFor(), one.token, at());
    expect(await alertCount(supervisorId)).toBe(alerts + 1);
    // The other outlet's supervisor is not told about this outlet's gateway.
    expect(await alertCount(otherOutletSupervisorId)).toBe(elsewhere);
  });

  it("five concurrent readings raise one incident and one alert", async () => {
    const started = await auditCount("payment.gateway_failover_started");
    const alerts = await alertCount(supervisorId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        syncGatewayHealth(contextFor(), outletA, { status: "down" }, at()),
      ),
    );
    expect(
      results.filter((result) => result.transition === "failover_started"),
    ).toHaveLength(1);
    expect(await auditCount("payment.gateway_failover_started")).toBe(
      started + 1,
    );
    expect(await alertCount(supervisorId)).toBe(alerts + 1);
  });

  it("a recovered gateway returns to normal, and a much later outage is a new incident", async () => {
    gateway.healthValue = "down";
    const alerts = await alertCount(supervisorId);
    const recovered = await auditCount("payment.gateway_recovered");
    const { token } = await openBill();
    await getPaymentLinkView(contextFor(), token, at());
    expect(await alertCount(supervisorId)).toBe(alerts + 1);

    gateway.healthValue = "available";
    const normal = await getPaymentLinkView(contextFor(), token, at(1));
    expect(normal.gateway.status).toBe("available");
    for (const method of normal.methods) expect(method.enabled).toBe(true);
    expect(await auditCount("payment.gateway_recovered")).toBe(recovered + 1);
    // Reading "up" again changes nothing.
    await getPaymentLinkView(contextFor(), token, at(2));
    expect(await auditCount("payment.gateway_recovered")).toBe(recovered + 1);

    gateway.healthValue = "down";
    await getPaymentLinkView(contextFor(), token, at(30));
    expect(await alertCount(supervisorId)).toBe(alerts + 2);
  });

  it("a gateway that flaps within ten minutes alerts once, not at every dip", async () => {
    const alerts = await alertCount(supervisorId);
    const started = await auditCount("payment.gateway_failover_started");
    const { token, linkId } = await openBill();
    for (const [minute, status] of [
      [0, "down"],
      [1, "available"],
      [2, "down"],
      [3, "available"],
      [4, "down"],
    ] as const) {
      gateway.healthValue = status;
      await getPaymentLinkView(contextFor(), token, at(minute));
    }
    expect(await alertCount(supervisorId)).toBe(alerts + 1);
    // Reopened rows are not "started" alerts of a new incident, and the bill
    // stays marked once: same incident number.
    expect(
      await linkAuditCount("payment.link_failover_to_cashier", linkId),
    ).toBe(1);
    expect(await auditCount("payment.gateway_failover_started")).toBe(
      started + 3,
    );
  });

  it("an incident nobody saw end does not silence the next outage", async () => {
    const alerts = await alertCount(supervisorId);
    const down = { status: "down" } as const;
    await syncGatewayHealth(contextFor(), outletA, down, at(0));
    await syncGatewayHealth(contextFor(), outletA, down, at(60));
    expect(await alertCount(supervisorId)).toBe(alerts + 1);
    // Seven hours on, with no recovery ever recorded: a fresh alert.
    await syncGatewayHealth(contextFor(), outletA, down, at(7 * 60));
    expect(await alertCount(supervisorId)).toBe(alerts + 2);
  });

  it("an outlet with no gateway account is not an outage", async () => {
    const started = await auditCount("payment.gateway_failover_started");
    const alerts = await alertCount(supervisorId);
    const result = await syncGatewayHealth(
      contextFor(),
      outletA,
      { status: "down", reason: "unconfigured" },
      at(),
    );
    expect(result).toEqual({ transition: "none", openIncident: null });
    expect(await auditCount("payment.gateway_failover_started")).toBe(started);
    expect(await alertCount(supervisorId)).toBe(alerts);
  });

  it("pay at the cashier answers even when the gateway health call hangs or throws", async () => {
    const { token } = await openBill();
    gateway.health = async () => {
      throw new Error("gateway timed out");
    };
    const ack = await requestPayAtCashier(contextFor(), token, at());
    expect(Date.parse(ack.requestedAt)).not.toBeNaN();
  });

  it("a bill that is already paid is not marked as moved to the cashier", async () => {
    gateway.healthValue = "down";
    const { token, linkId } = await openBill();
    await owner.query(
      "UPDATE payment_links SET paid_idr = total_idr WHERE tenant_id = $1 AND id = $2",
      [tenantId, linkId],
    );
    await getPaymentLinkView(contextFor(), token, at());
    expect(
      await linkAuditCount("payment.link_failover_to_cashier", linkId),
    ).toBe(0);
  });

  it("a degraded gateway still takes payments and opens no incident", async () => {
    gateway.healthValue = "degraded";
    const started = await auditCount("payment.gateway_failover_started");
    const { token } = await openBill();
    const view = await getPaymentLinkView(contextFor(), token, at());
    for (const method of view.methods) expect(method.enabled).toBe(true);
    expect(await auditCount("payment.gateway_failover_started")).toBe(started);
  });

  it("an outage at one outlet does not mark another outlet down", async () => {
    gateway.healthValue = "down";
    const startedB = await auditCount(
      "payment.gateway_failover_started",
      outletB,
    );
    const { token } = await openBill(outletA);
    await getPaymentLinkView(contextFor(), token, at());
    expect(await auditCount("payment.gateway_failover_started", outletB)).toBe(
      startedB,
    );
  });

  it("a scheduled probe records the same incident as a request would", async () => {
    gateway.healthValue = "down";
    const started = await auditCount("payment.gateway_failover_started");
    const probed = await probeGatewayHealth(contextFor(), outletA, at());
    expect(probed).toMatchObject({
      status: "down",
      transition: "failover_started",
    });
    const again = await probeGatewayHealth(contextFor(), outletA, at());
    expect(again.transition).toBe("none");
    expect(await auditCount("payment.gateway_failover_started")).toBe(
      started + 1,
    );
    gateway.healthValue = "available";
    expect(
      (await probeGatewayHealth(contextFor(), outletA, at())).transition,
    ).toBe("recovered");
  });
});

describe("scheduled gateway probe (legend-5ffks)", () => {
  const tenantWide = () =>
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "tenant" },
    ) as ScopedTenantContext;
  const down = { status: "down" } as const;

  it("records the recovery with no guest traffic", async () => {
    await syncGatewayHealth(contextFor(), outletA, down, at(0));
    const recovered = await auditCount("payment.gateway_recovered");
    gateway.healthValue = "available";
    const result = await sweepGatewayHealth(tenantWide(), {
      force: true,
      now: at(5),
    });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(await auditCount("payment.gateway_recovered")).toBe(recovered + 1);
    // Closed: a second sweep probes nothing for this outlet.
    gateway.probed.length = 0;
    await sweepGatewayHealth(tenantWide(), { force: true, now: at(6) });
    expect(gateway.probed).not.toContain(outletA);
  });

  it("probes only outlets with an open incident", async () => {
    await syncGatewayHealth(contextFor(), outletA, down, at(0));
    gateway.healthValue = "down";
    await sweepGatewayHealth(tenantWide(), { force: true, now: at(5) });
    expect(gateway.probed).toContain(outletA);
    expect(gateway.probed).not.toContain(outletB);
  });

  it("a long outage alerts once: the sweep keeps the incident alive past six hours", async () => {
    const alerts = await alertCount(supervisorId);
    const beats = await auditCount("payment.gateway_still_down");
    gateway.healthValue = "down";
    await syncGatewayHealth(contextFor(), outletA, down, at(0));
    for (const hour of [2, 4, 6, 8, 10, 12])
      await sweepGatewayHealth(tenantWide(), {
        force: true,
        now: at(hour * 60),
      });
    expect(await alertCount(supervisorId)).toBe(alerts + 1);
    // A heartbeat only every few hours, not at every sweep.
    const written = (await auditCount("payment.gateway_still_down")) - beats;
    expect(written).toBeGreaterThanOrEqual(3);
    expect(written).toBeLessThanOrEqual(5);
  });

  it("one failing outlet does not stop the others", async () => {
    await syncGatewayHealth(contextFor(), outletA, down, at(0));
    await syncGatewayHealth(contextFor([outletB]), outletB, down, at(0));
    const recoveredB = await auditCount("payment.gateway_recovered", outletB);
    gateway.throwFor.add(outletA);
    gateway.healthValue = "available";
    const result = await sweepGatewayHealth(tenantWide(), {
      force: true,
      now: at(5),
    });
    expect(result).toMatchObject({ failed: 1, recovered: 1 });
    expect(await auditCount("payment.gateway_recovered", outletB)).toBe(
      recoveredB + 1,
    );
  });

  it("is throttled per tenant", async () => {
    await sweepGatewayHealth(tenantWide(), { force: true, now: at(0) });
    expect(await sweepGatewayHealth(tenantWide(), { now: at(1) })).toBeNull();
    expect(
      await sweepGatewayHealth(tenantWide(), {
        now: new Date(at(0).getTime() + GATEWAY_PROBE_INTERVAL_MS + 1000),
      }),
    ).not.toBeNull();
  });

  it("does not spend a probe slot on an incident that went stale", async () => {
    await syncGatewayHealth(contextFor(), outletA, down, at(0));
    expect(
      await listOutletsWithOpenIncident(tenantWide(), at(5 * 60)),
    ).toContain(outletA);
    expect(
      await listOutletsWithOpenIncident(tenantWide(), at(7 * 60)),
    ).not.toContain(outletA);
  });

  it("the relay entry runs one sweep per tenant and never blocks or rejects", async () => {
    await syncGatewayHealth(contextFor(), outletA, down, new Date());
    gateway.healthValue = "down";
    const first = startGatewayProbeSweep(tenantWide());
    const second = startGatewayProbeSweep(tenantWide());
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first;
    // Free again once the first one finished (throttle may skip the work).
    const third = startGatewayProbeSweep(tenantWide());
    expect(third).not.toBeNull();
    await third;
  });
});
