// Founder decision: the cashier discount approval threshold
// (pos_approval_policies.discount_threshold_bp) is capped at 5000 bp (50%).
// A stored value above 5000 (older rows can hold up to 10000) is clamped to
// 5000 when READ, so a cashier can never give more than half off without a
// supervisor. A stored value below 5000 is never raised by the cap.
//
// Written from the shared contract (packages/shared/src/pos: applyPosDiscount,
// getPosApprovalPolicy, DISCOUNT_APPROVAL_REQUIRED = 403, "above the threshold
// needs approval" is strict >), not from the service code. Fixtures follow
// pos-order-approval.test.ts (isolated tenant, real PIN override, real
// Express app and RLS database); the stored threshold is seeded by raw SQL
// like pos-order-deposit-lock.test.ts does.
//
// Money safety: with a stored 10000 the pre-cap behaviour let a cashier give
// 100% off alone. These tests prove 60% now needs approval while 50% (exactly
// the cap, not above it) does not.
//
// Assumptions where the contract is silent:
// - a refused discount answers 403 with error code DISCOUNT_APPROVAL_REQUIRED
//   (errors.ts maps that code to 403), and changes nothing on the order.
// - a percent discount of P bp on the order subtotal needs approval when
//   P > threshold (same strict comparison as requiresDiscountApproval).
// - GET /api/outlets/:outletId/pos/policy is readable by a cashier session.
// - an outlet-specific row wins over the tenant-wide row for that outlet (the
//   founder's "winning outlet row"), and the cap applies to the winner.
// - several manual discounts on one order stack: approval is judged on the
//   cumulative percent of the order subtotal (2000 + 2000 + 2000 bp = 60%).
// - the platform config export is GET /api/platform/tenants/:id/config-export
//   (platform admin with MFA, like tenant-config-api.test.ts) and a
//   pos_discount item reads { kind, outletKey, discountThresholdBp }. Export
//   clamps the value like every other read and never rewrites the stored row.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10% = Rp55.000. */
const ORDER_TOTAL_IDR = 55_000;
const CAP_BP = 5_000;

let app: Express;

type Member = { client: ReturnType<typeof agent>; userId: string };
type Fixture = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  kopi: string;
  cashier: Member;
  supervisor: Member;
};

// Two tenants, each with its own stored threshold row (seeded before any
// request so no read can be served from an older value).
let wide: Fixture; // stored 10000 (100%), above the cap
let narrow: Fixture; // stored 3000 (30%), below the cap
let layered: Fixture; // tenant row 3000, outlet row 10000 for its outlet
let platformAdminId: string | null = null;

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function memberOf(
  tenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

async function seedFixture(
  label: string,
  storedThresholdBp: number,
  outletThresholdBp?: number,
): Promise<Fixture> {
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
    cashierRole: randomUUID(),
    supervisorRole: randomUUID(),
  };
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      [
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "pos.discount.approve",
      ],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  const cashier = await memberOf(tenant, ids.cashierRole, "Cap Kasir");
  const supervisor = await memberOf(
    tenant,
    ids.supervisorRole,
    "Cap Supervisor",
  );
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Cap Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-CAP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    // Tenant-wide threshold row, exactly as the stored value under test.
    await client.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, $2)`,
      [tenant.tenantId, storedThresholdBp],
    );
    if (outletThresholdBp !== undefined)
      await client.query(
        `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
         VALUES ($1, $2, $3)`,
        [tenant.tenantId, tenant.outletId, outletThresholdBp],
      );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    kopi: ids.kopi,
    cashier,
    supervisor,
  };
}

function pos(fx: Fixture) {
  const base = `/api/outlets/${encodeURIComponent(fx.tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    fx.cashier.client
      .post(`${base}${path}`)
      .set(fx.headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: fx.kopi, quantity: 2, modifierIds: [] }],
      }),
    get: (orderId: string) =>
      fx.cashier.client
        .get(`${base}/${orderId}`)
        .set(fx.headers)
        .set(originHeader),
    /** A manual percent discount; `approval` is the supervisor's override. */
    discount: (
      orderId: string,
      percentBp: number,
      approval: Record<string, string> = {},
    ) =>
      send(`/${orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp,
        reason: "manager_goodwill",
        reasonNote: "Pelanggan tetap",
        ...approval,
      }),
    policy: () =>
      fx.cashier.client
        .get(
          `/api/outlets/${encodeURIComponent(fx.tenant.outletId)}/pos/policy`,
        )
        .set(fx.headers)
        .set(originHeader),
  };
}

async function openOrder(fx: Fixture): Promise<string> {
  const created = await pos(fx).create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  return created.body.data.id as string;
}

/** The supervisor's own tile + PIN, like production. */
async function pinApproval(
  fx: Fixture,
  orderId: string,
): Promise<{ approvedBy: string; overrideId: string }> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    fx.cashier.userId,
    {
      outletId: fx.tenant.outletId,
      action: "discount",
      valueIdr: 1_000_000,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(fx.supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: fx.supervisor.userId, overrideId: override.id };
}

async function discountRows(fx: Fixture, orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_discounts
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

async function expectApprovalRequired(
  fx: Fixture,
  orderId: string,
  percentBp: number,
): Promise<void> {
  const refused = await pos(fx).discount(orderId, percentBp);
  expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  expect(errorCode(refused.body)).toBe("DISCOUNT_APPROVAL_REQUIRED");
  // Refused means nothing changed: no discount row, total untouched.
  expect(await discountRows(fx, orderId)).toBe(0);
  const order = await pos(fx).get(orderId);
  expect(order.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
}

beforeAll(async () => {
  app = createApp();
  wide = await seedFixture("capw", 10_000);
  narrow = await seedFixture("capn", 3_000);
  layered = await seedFixture("capl", 3_000, 10_000);
});

afterAll(async () => {
  // Isolated tenants stay in the disposable database (audit is append-only);
  // give them a valid creator so the platform tenant list still parses them.
  for (const fx of [wide, narrow, layered])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      fx.tenant.tenantId,
      randomUUID(),
    ]);
  if (platformAdminId)
    await owner.query("DELETE FROM platform_admins WHERE user_id = $1", [
      platformAdminId,
    ]);
  await owner.end();
});

async function platformAdmin() {
  const client = agent(app);
  const email = await signUp(client, "Cap Platform Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  platformAdminId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [platformAdminId],
  );
  await verifySessionMfa(email);
  return client;
}

const storedRows = async (tenantId: string) =>
  (
    await owner.query<{ outlet_id: string | null; bp: number }>(
      `SELECT outlet_id, discount_threshold_bp::int AS bp FROM pos_approval_policies
        WHERE tenant_id = $1 ORDER BY outlet_id NULLS FIRST`,
      [tenantId],
    )
  ).rows;

describe("POS discount approval threshold is capped at 50% (legend-5cwrq cap)", () => {
  it("POS-02 discount-cap-5000 a stored threshold of 10000 never lets a cashier give 60% off without approval", async () => {
    const orderId = await openOrder(wide);
    await expectApprovalRequired(wide, orderId, 6_000);
    // Even a near-total discount needs a supervisor.
    const secondOrder = await openOrder(wide);
    await expectApprovalRequired(wide, secondOrder, 10_000);
  });

  it("POS-02 discount-cap-5000 a stored threshold of 10000 still lets a cashier give exactly 50% off alone", async () => {
    const orderId = await openOrder(wide);
    // 5000 bp is the cap itself; approval is only for strictly above it.
    const discounted = await pos(wide).discount(orderId, CAP_BP);
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);
    expect(await discountRows(wide, orderId)).toBe(1);
    const order = await pos(wide).get(orderId);
    expect(order.body.data.totalIdr).toBeLessThan(ORDER_TOTAL_IDR);
  });

  it("POS-02 discount-cap-5000 a 60% discount with a supervisor approval still goes through under a stored 10000", async () => {
    const orderId = await openOrder(wide);
    await expectApprovalRequired(wide, orderId, 6_000);
    const approval = await pinApproval(wide, orderId);
    const discounted = await pos(wide).discount(orderId, 6_000, approval);
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);
    expect(await discountRows(wide, orderId)).toBe(1);
  });

  it("POS-02 discount-cap-5000 a stored threshold of 3000 is not raised by the cap: 40% off needs approval", async () => {
    const orderId = await openOrder(narrow);
    await expectApprovalRequired(narrow, orderId, 4_000);
    // And 30% (exactly the stored threshold) is still allowed alone.
    const allowedOrder = await openOrder(narrow);
    const allowed = await pos(narrow).discount(allowedOrder, 3_000);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it("POS-02 discount-cap-5000 the approval policy shows 5000 when 10000 is stored", async () => {
    const policy = await pos(wide).policy();
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(policy.body.data.discountThresholdBp).toBe(CAP_BP);
  });

  it("POS-02 discount-cap-5000 the approval policy shows a stored 3000 unchanged", async () => {
    const policy = await pos(narrow).policy();
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(policy.body.data.discountThresholdBp).toBe(3_000);
  });

  it("POS-02 discount-cap-5000 an outlet row of 10000 over a tenant row of 3000 is capped to 5000: 60% needs approval, 50% passes alone", async () => {
    const orderId = await openOrder(layered);
    await expectApprovalRequired(layered, orderId, 6_000);
    const policy = await pos(layered).policy();
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(policy.body.data.discountThresholdBp).toBe(CAP_BP);
    // 50% is exactly the cap on the winning outlet row, so no approval.
    const halfOrder = await openOrder(layered);
    const half = await pos(layered).discount(halfOrder, CAP_BP);
    expect(half.status, JSON.stringify(half.body)).toBe(201);
    expect(await discountRows(layered, halfOrder)).toBe(1);
  });

  it("POS-02 discount-cap-5000 three 20% discounts under a stored 10000: the cumulative 60% on the third needs approval", async () => {
    const orderId = await openOrder(wide);
    for (const step of [1, 2]) {
      const allowed = await pos(wide).discount(orderId, 2_000);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
      expect(await discountRows(wide, orderId)).toBe(step);
    }
    const refused = await pos(wide).discount(orderId, 2_000);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused.body)).toBe("DISCOUNT_APPROVAL_REQUIRED");
    // The refused third discount changed nothing.
    expect(await discountRows(wide, orderId)).toBe(2);
  });

  it("POS-02 discount-cap-5000 exporting a tenant whose stored threshold is 10000 succeeds with 5000 and leaves the stored row at 10000", async () => {
    const admin = await platformAdmin();
    const exported = await admin
      .get(`/api/platform/tenants/${wide.tenant.tenantId}/config-export`)
      .set(originHeader);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const bundle = exported.body.data ?? exported.body;
    const items = (bundle.sections?.approval_policies?.items ?? []) as {
      kind: string;
      outletKey: string | null;
      discountThresholdBp?: number;
    }[];
    const posItems = items.filter((item) => item.kind === "pos_discount");
    expect(posItems).toHaveLength(1);
    expect(posItems[0]?.outletKey).toBeNull();
    expect(posItems[0]?.discountThresholdBp).toBe(CAP_BP);
    // No silent migration: the stored value is untouched by the export.
    expect(await storedRows(wide.tenant.tenantId)).toEqual([
      { outlet_id: null, bp: 10_000 },
    ]);
  });
});
