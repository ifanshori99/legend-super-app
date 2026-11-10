// Two-tenant isolation of the gateway failover (bead legend-8vgid, tier K).
// An outage in tenant A must open no incident, bill marker or alert in tenant
// B; incident numbers count per outlet; alerts reach only the supervisors of
// the outlet that is down; and the scheduled probe works one tenant at a time.
// audit_logs is append-only, so every assertion counts rows of its own tenant.
import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { PaymentGatewayStatus } from "@starter/shared/payment";
import { createApp } from "../app";
import {
  setPaymentGateway,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import {
  createPaymentLink,
  getPaymentLinkView,
} from "../services/payment.service";
import {
  listOutletsWithOpenIncident,
  resetGatewayHealthCache,
  syncGatewayHealth,
} from "../services/payment-failover.service";
import { sweepGatewayHealth } from "../worker/payment-failover-probe.job";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers";
import { agent, signUp } from "./helpers";

const app = createApp();
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA1: string;
let outletA2: string;
let outletB1: string;
let supervisorA1: string;
let supervisorA2: string;
let supervisorB1: string;

/** Gateway whose health is set per outlet; it creates no payments. */
class PerOutletGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly status = new Map<string, PaymentGatewayStatus>();
  readonly probed: string[] = [];
  async health(_context?: unknown, outletId?: string) {
    if (outletId) this.probed.push(outletId);
    return { status: this.status.get(outletId ?? "") ?? "available" };
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

let gateway: PerOutletGateway;
let testNo = 0;
let base = 0;
/** 20 minutes per test, so one test's recovery is never "just recovered" for
 * the next (the 10 minute reopen window). */
const at = (minutes = 0) => new Date(base + minutes * 60_000);

function ctx(
  tenant: IsolatedTenant,
  outletIds: readonly string[],
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: outletIds as never },
  ) as ScopedTenantContext;
}

function tenantWide(tenant: IsolatedTenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  ) as ScopedTenantContext;
}

async function openBill(tenant: IsolatedTenant, outletId: string) {
  return createPaymentLink(
    ctx(tenant, [outletId]),
    {
      outletId: outletId as never,
      reference: `T-${randomBytes(4).toString("hex")}`,
      tableLabel: "A03",
      pax: 2,
      subtotalIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: 100_000,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
}

const supervisorRoles = new Map<string, string>();

/** The seeded supervisor template, copied once per tenant (names are unique). */
async function supervisorRoleOf(tenant: IsolatedTenant) {
  const known = supervisorRoles.get(tenant.tenantId);
  if (known) return known;
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'supervisor'`,
    [id, tenant.tenantId, fixtures.tenant.id],
  );
  supervisorRoles.set(tenant.tenantId, id);
  return id;
}

async function supervisorOf(tenant: IsolatedTenant, outletId: string) {
  const client = agent(app);
  await signUp(client, "Failover supervisor");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = await supervisorRoleOf(tenant);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, outletId],
  );
  return userId;
}

async function alertCount(tenant: IsolatedTenant, userId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 AND category = 'payment_failover'`,
    [tenant.tenantId, userId],
  );
  return rows[0]!.n;
}

async function auditCount(tenant: IsolatedTenant, action: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenant.tenantId, action],
  );
  return rows[0]!.n;
}

/** Highest incident number of the tenant's gateway markers (0 = none). */
async function maxIncident(tenant: IsolatedTenant) {
  const { rows } = await owner.query<{ n: number | null }>(
    `SELECT max((event->'maskedChanges'->'after'->>'incident')::int) AS n
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' LIKE 'payment.gateway_%'`,
    [tenant.tenantId],
  );
  return rows[0]!.n ?? 0;
}

async function markedLinks(tenant: IsolatedTenant) {
  const { rows } = await owner.query<{ object_id: string; incident: string }>(
    `SELECT event->>'objectId' AS object_id,
            event->'maskedChanges'->'after'->>'incident' AS incident
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'payment.link_failover_to_cashier'`,
    [tenant.tenantId],
  );
  return rows;
}

beforeAll(async () => {
  tenantA = await createIsolatedTenant(`fo-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`fo-b-${randomUUID().slice(0, 6)}`);
  outletA1 = tenantA.outletId;
  outletB1 = tenantB.outletId;
  outletA2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'FO-A2', 'Outlet A2', 'Jl. Uji 2', 'Asia/Jakarta', $5, 'active')`,
    [
      outletA2,
      tenantA.tenantId,
      tenantA.brandId,
      tenantA.legalEntityId,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  supervisorA1 = await supervisorOf(tenantA, outletA1);
  supervisorA2 = await supervisorOf(tenantA, outletA2);
  supervisorB1 = await supervisorOf(tenantB, outletB1);
});

beforeEach(async () => {
  testNo += 1;
  base = Date.now() + testNo * 20 * 60_000;
  gateway = new PerOutletGateway();
  setPaymentGateway(gateway);
  resetGatewayHealthCache();
  // Close whatever an earlier test left open.
  for (const [tenant, outletId] of [
    [tenantA, outletA1],
    [tenantA, outletA2],
    [tenantB, outletB1],
  ] as const)
    await syncGatewayHealth(
      ctx(tenant, [outletId]),
      outletId,
      { status: "available" },
      new Date(),
    );
  resetGatewayHealthCache();
});

afterEach(() => {
  setPaymentGateway(null);
  resetGatewayHealthCache();
});

afterAll(async () => {
  await owner.end();
});

describe("gateway failover across tenants", () => {
  it("an outage in tenant A opens no incident, marker or alert in tenant B", async () => {
    gateway.status.set(outletA1, "down");
    const billA = await openBill(tenantA, outletA1);
    const billB = await openBill(tenantB, outletB1);
    const startedB = await auditCount(
      tenantB,
      "payment.gateway_failover_started",
    );
    const alertsB = await alertCount(tenantB, supervisorB1);
    const markedB = (await markedLinks(tenantB)).length;

    const viewA = await getPaymentLinkView(
      ctx(tenantA, [outletA1]),
      billA.token,
      at(),
    );
    const viewB = await getPaymentLinkView(
      ctx(tenantB, [outletB1]),
      billB.token,
      at(),
    );

    expect(viewA.gateway.status).toBe("down");
    expect(viewB.gateway.status).toBe("available");
    for (const method of viewB.methods) expect(method.enabled).toBe(true);
    expect(await auditCount(tenantB, "payment.gateway_failover_started")).toBe(
      startedB,
    );
    expect((await markedLinks(tenantB)).length).toBe(markedB);
    expect(await alertCount(tenantB, supervisorB1)).toBe(alertsB);
  });

  it("only the supervisors of the outlet that is down are alerted", async () => {
    const a1 = await alertCount(tenantA, supervisorA1);
    const a2 = await alertCount(tenantA, supervisorA2);
    const b1 = await alertCount(tenantB, supervisorB1);
    await syncGatewayHealth(
      ctx(tenantA, [outletA1]),
      outletA1,
      { status: "down" },
      at(),
    );
    expect(await alertCount(tenantA, supervisorA1)).toBe(a1 + 1);
    // Same tenant, other outlet: not told. Other tenant: not told.
    expect(await alertCount(tenantA, supervisorA2)).toBe(a2);
    expect(await alertCount(tenantB, supervisorB1)).toBe(b1);
  });

  it("incident numbers and bill markers are per tenant: B's first incident is 1 while A is past it", async () => {
    // A has had incidents in the earlier tests, so its numbering is ahead.
    await syncGatewayHealth(
      ctx(tenantA, [outletA1]),
      outletA1,
      { status: "down" },
      at(),
    );
    expect(await maxIncident(tenantA)).toBeGreaterThanOrEqual(2);
    expect(await maxIncident(tenantB)).toBe(0);

    gateway.status.set(outletA1, "down");
    gateway.status.set(outletB1, "down");
    const billA = await openBill(tenantA, outletA1);
    const billB = await openBill(tenantB, outletB1);
    await getPaymentLinkView(ctx(tenantA, [outletA1]), billA.token, at(1));
    await getPaymentLinkView(ctx(tenantB, [outletB1]), billB.token, at(1));

    expect(await maxIncident(tenantB)).toBe(1);
    const alertsB = await alertCount(tenantB, supervisorB1);
    expect(alertsB).toBeGreaterThanOrEqual(1);
    // Each bill is marked once, under its own tenant and incident number.
    const marksB = await markedLinks(tenantB);
    expect(marksB.map((row) => row.object_id)).toEqual([billB.linkId]);
    expect(marksB[0]!.incident).toBe("1");
    const marksA = (await markedLinks(tenantA)).filter(
      (row) => row.object_id === billA.linkId,
    );
    expect(marksA).toHaveLength(1);
    expect(Number(marksA[0]!.incident)).toBeGreaterThanOrEqual(2);
  });

  it("the probe sweep sees and recovers one tenant at a time", async () => {
    await syncGatewayHealth(
      ctx(tenantA, [outletA1]),
      outletA1,
      { status: "down" },
      at(0),
    );
    await syncGatewayHealth(
      ctx(tenantB, [outletB1]),
      outletB1,
      { status: "down" },
      at(0),
    );
    expect(
      await listOutletsWithOpenIncident(tenantWide(tenantA), at(1)),
    ).toEqual([outletA1]);
    expect(
      await listOutletsWithOpenIncident(tenantWide(tenantB), at(1)),
    ).toEqual([outletB1]);

    const recoveredB = await auditCount(tenantB, "payment.gateway_recovered");
    const recoveredA = await auditCount(tenantA, "payment.gateway_recovered");
    // The gateway is healthy again everywhere; only A's tenant is swept.
    const result = await sweepGatewayHealth(tenantWide(tenantA), {
      force: true,
      now: at(5),
    });
    expect(result).toMatchObject({ outlets: 1, recovered: 1, failed: 0 });
    expect(gateway.probed).toEqual([outletA1]);
    expect(await auditCount(tenantA, "payment.gateway_recovered")).toBe(
      recoveredA + 1,
    );
    expect(await auditCount(tenantB, "payment.gateway_recovered")).toBe(
      recoveredB,
    );
    expect(
      await listOutletsWithOpenIncident(tenantWide(tenantB), at(6)),
    ).toEqual([outletB1]);

    await sweepGatewayHealth(tenantWide(tenantB), { force: true, now: at(7) });
    expect(await auditCount(tenantB, "payment.gateway_recovered")).toBe(
      recoveredB + 1,
    );
  });
});
