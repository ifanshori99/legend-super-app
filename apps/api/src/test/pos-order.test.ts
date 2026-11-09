// POS order service (bead legend-kk7; PRD v1.7 §3 F8 "POS Kasir & Captain
// Order", §6 C orders/order_items/order_events). Acceptance: POS-01 (a
// standard sale is saved within 1 s on the edge node) and POS-04 (a final
// sale is never edited or deleted; corrections are linked void/refund
// records), plus TEN-01/TEN-03 isolation of the new POS tables and the
// wiring of the routes (/api/outlets/:outletId/pos), the EDGE_MODE route
// split and the edge credential gate (legend-2pi, legend-obh5).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in a fresh isolated tenant, so the price list and
// tax configuration are this file's own. The receipt numbering bead
// (legend-93a) is not built yet: a gapless, idempotent in-memory double is
// installed through its port. Supervisor approvals use the real per-staff
// PIN override service (main's `{ approverUserId, pin }` shape).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  createUlid,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { refundAllocation, type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { verifyEdgeNodeCredential } from "../services/edge-node.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { stillRefundableByMethod } from "../services/pos-order-corrections.ts";
import { getPosOrder } from "../services/pos-order.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  viewerRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
let viewer: Member;

// ---- Receipt numbering double (legend-93a port) ---------------------------------

/** Gapless per outlet, idempotent per order: like the allocator it stands for. */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

// ---- Fixtures ---------------------------------------------------------------------

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

async function member(roleId: string, label: string): Promise<Member> {
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

function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function pos(who: Member = cashier, outletId = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      // The till: cash goes into the drawer of the shift open on this device.
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt: Math.floor(Date.now() / 1000),
          tenantId: tenant.tenantId,
          brandId: null,
          deviceId: ids.device,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    base,
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    list: () => who.client.get(base).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

/** create → submit → cash → complete; each write timed (POS-01). */
async function completedSale(): Promise<{
  orderId: string;
  totalIdr: number;
  timings: number[];
}> {
  const timings: number[] = [];
  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await run();
    timings.push(performance.now() - start);
    return result;
  };
  const created = await timed(() => pos().create());
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await timed(() => pos().submit(orderId, status));
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await timed(() => pos().cash(orderId, status, totalIdr + 5_000));
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  expect(paid.body.data.remainingIdr).toBe(0);
  status = paid.body.data.order.status as string;
  const completed = await timed(() => pos().complete(orderId, status));
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe("completed");
  return { orderId, totalIdr, timings };
}

/** Main's per-staff PIN approval: the supervisor's own tile + PIN. */
async function pinApproval(input: {
  action: "void" | "refund";
  orderId: string;
  valueIdr: number;
  approver?: string;
}): Promise<{ approvedBy: string; overrideId: string }> {
  const approver = input.approver ?? supervisor.userId;
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: input.orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  // legend-0gy1: the POS names the exact override row it was approved by.
  return { approvedBy: approver, overrideId: override.id };
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`pos-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
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
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
    ],
    [ids.viewerRole, "Tanpa POS", ["floor.table.view"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "POS Supervisor");
  viewer = await member(ids.viewerRole, "POS Tamu");
  // Finding 2: cash tenders, refunds and voids of cash-paid orders need the
  // acting cashier's open shift (409 SHIFT_NOT_OPEN otherwise). The cashier is
  // the actor of every sale, refund and void here, so one shift opened on the
  // registered device covers them all.
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
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
       VALUES ($1, $2, $3, 'POS Uji', 0)`,
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
    // PBJT 10% on F&B, menu prices exclude tax, no service charge rule: a
    // Rp50.000 sale is billed Rp55.000.
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
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  // Final orders are immutable and audit rows append-only, so the isolated
  // tenant stays in the disposable database; give it a valid creator so the
  // platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("POS order service (legend-kk7)", () => {
  it("POS-01 a standard sale is saved on the local database within 1 s per write, with its order log", async () => {
    const { orderId, totalIdr, timings } = await completedSale();
    expect(totalIdr).toBe(55_000);
    // PRD POS-01: "Transaksi standar tersimpan ≤ 1 detik di edge node".
    for (const ms of timings) expect(ms).toBeLessThan(1_000);

    const read = await pos().get(orderId);
    expect(read.status).toBe(200);
    expect(read.headers.etag).toMatch(/^"\d+"$/);
    expect(read.body.data).toMatchObject({
      id: orderId,
      status: "completed",
      channel: "pos",
      totalIdr,
    });
    const { rows } = await owner.query<{ type: string }>(
      `SELECT e.type FROM order_events e
       WHERE e.tenant_id = $1 AND e.order_id = $2::uuid ORDER BY e.sequence`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The contract events go to the transactional outbox in the same commit.
    const outbox = await owner.query<{ name: string }>(
      `SELECT event->>'name' AS name FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->'payload'->>'orderId' = $2`,
      [tenant.tenantId, orderId],
    );
    expect(outbox.rows.map((row) => row.name)).toContain("order.paid");
  });

  it("POS-01 a retried create with the same idempotency key returns the same order, never a second one", async () => {
    const idempotencyKey = randomUUID();
    const first = await pos().create({ idempotencyKey });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await pos().create({ idempotencyKey });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pos_order_idempotency
       WHERE tenant_id = $1 AND key = $2`,
      [tenant.tenantId, idempotencyKey],
    );
    expect(rows[0]?.count).toBe("1");
    // The same key with another body is refused, never applied.
    const changed = await pos().create({
      idempotencyKey,
      items: [{ menuItemId: ids.kopi, quantity: 5, modifierIds: [] }],
    });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(changed.body.data?.id).toBeUndefined();
  });

  it("POS-01 the server prices the sale: an unknown menu item is refused and nothing is stored", async () => {
    const before = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    const refused = await pos().create({
      items: [{ menuItemId: randomUUID(), quantity: 1, modifierIds: [] }],
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const after = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  // legend-6u81: a reservation order is only for dining in.
  const RESERVATION_ONLY_DINE_IN =
    "Pesanan reservasi hanya untuk makan di tempat.";
  const orderCount = async (): Promise<string | undefined> =>
    (
      await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM orders WHERE tenant_id = $1",
        [tenant.tenantId],
      )
    ).rows[0]?.count;

  it.each(["takeaway", "delivery"])(
    "POS-01 a reservation order for %s is refused with a validation error and nothing is stored (legend-6u81)",
    async (serviceType) => {
      const before = await orderCount();
      const refused = await pos().create({
        channel: "reservation",
        serviceType,
      });
      expect(
        refused.status,
        JSON.stringify(refused.body),
      ).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(refused.body.error?.code ?? refused.body.code).toBe(
        "VALIDATION_ERROR",
      );
      expect(JSON.stringify(refused.body)).toContain(RESERVATION_ONLY_DINE_IN);
      expect(refused.body.data?.id).toBeUndefined();
      expect(await orderCount()).toBe(before);
    },
  );

  it("POS-01 a reservation order for dine in is not refused by the reservation guard (legend-6u81)", async () => {
    const created = await pos().create({
      channel: "reservation",
      serviceType: "dine_in",
    });
    // Assumption: dine_in may need a table session or price list this fixture
    // lacks, so only assert the reservation guard is not what refuses it.
    expect(JSON.stringify(created.body)).not.toContain(
      RESERVATION_ONLY_DINE_IN,
    );
  });

  it("POS-01 a pos takeaway sale is still accepted (legend-6u81)", async () => {
    const created = await pos().create({
      channel: "pos",
      serviceType: "takeaway",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.channel).toBe("pos");
  });

  it("POS-04 a completed sale cannot be edited or deleted, even by the database owner", async () => {
    const { orderId } = await completedSale();
    const uuid = ulidToUuid(orderId);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE orders SET total_idr = 1 WHERE tenant_id = $1 AND id = $2::uuid",
          [tenant.tenantId, uuid],
        ),
      ),
    ).rejects.toThrow(/POS-04/);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "DELETE FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
          [tenant.tenantId, uuid],
        ),
      ),
    ).rejects.toThrow(/POS-04/);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE order_items SET quantity = 9 WHERE tenant_id = $1 AND order_id = $2::uuid",
          [tenant.tenantId, uuid],
        ),
      ),
    ).rejects.toThrow(/POS-04/);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE order_events SET type = type WHERE tenant_id = $1 AND order_id = $2::uuid",
          [tenant.tenantId, uuid],
        ),
      ),
    ).rejects.toThrow(/append-only/);

    // The API refuses the non-final void path on a completed sale too.
    const voided = await pos().voidOrder(orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: supervisor.userId,
      overrideId: createUlid(),
      expectedStatus: "completed",
    });
    expect(voided.status).toBeGreaterThanOrEqual(400);
    expect((await pos().get(orderId)).body.data.status).toBe("completed");
  });

  it("POS-04 a completed sale is corrected by a linked void that keeps its receipt number and needs a verified supervisor PIN", async () => {
    const { orderId, totalIdr } = await completedSale();
    const body = {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
    };

    // No approval on record: fail closed.
    const unapproved = await pos().correctionVoid(orderId, {
      ...body,
      approvedBy: supervisor.userId,
      overrideId: createUlid(),
    });
    expect(unapproved.status).toBeGreaterThanOrEqual(400);
    expect(unapproved.body.error?.code ?? unapproved.body.code).toMatch(
      /APPROVAL_REQUIRED/,
    );

    // AUTH-06: the cashier cannot approve their own correction.
    const self = await pos().correctionVoid(orderId, {
      ...body,
      approvedBy: cashier.userId,
      overrideId: createUlid(),
    });
    expect(self.status).toBeGreaterThanOrEqual(400);

    // An approval worth less than the sale does not cover it.
    const small = await pinApproval({
      action: "void",
      orderId,
      valueIdr: totalIdr - 1,
    });
    const tooSmall = await pos().correctionVoid(orderId, { ...body, ...small });
    expect(tooSmall.status).toBeGreaterThanOrEqual(400);

    const approval = await pinApproval({
      action: "void",
      orderId,
      valueIdr: totalIdr,
    });
    const linked = await pos().correctionVoid(orderId, {
      ...body,
      ...approval,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBeLessThan(300);
    expect(linked.body.data).toMatchObject({
      orderId,
      amountIdr: totalIdr,
      approvedBy: supervisor.userId,
    });
    expect(linked.body.data.receiptNumber).toMatch(/^POS1-\d{6}$/);

    // The sale itself stays completed with its lines: history, not an edit.
    const after = await pos().get(orderId);
    expect(after.body.data.status).toBe("completed");
    expect(after.body.data.items.length).toBeGreaterThan(0);

    // One approval, one action; a second void of the same sale is refused.
    const again = await pos().correctionVoid(orderId, {
      ...body,
      ...approval,
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pos_order_voids
       WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows[0]?.count).toBe("1");
    // The linked record is append-only.
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "DELETE FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2::uuid",
          [tenant.tenantId, ulidToUuid(orderId)],
        ),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("POS-04 a linked refund is bounded by what was paid and leaves the sale completed", async () => {
    const { orderId, totalIdr } = await completedSale();
    const body = {
      reason: "quality_complaint",
      reasonNote: "Minuman tumpah",
    };
    const tooMuch = await pos().refund(orderId, {
      ...body,
      amountIdr: totalIdr + 1,
      ...(await pinApproval({
        action: "refund",
        orderId,
        valueIdr: totalIdr + 1,
      })),
    });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);

    const part = KOPI_IDR;
    const refunded = await pos().refund(orderId, {
      ...body,
      amountIdr: part,
      ...(await pinApproval({ action: "refund", orderId, valueIdr: part })),
    });
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    expect(refunded.body.data).toMatchObject({ orderId, amountIdr: part });
    expect((await pos().get(orderId)).body.data.status).toBe("completed");
  });
});

describe("POS money review fixes (legend-kk7)", () => {
  it("POS-04 partial refunds never return more through one method than it took in", () => {
    // Cash 1 + QRIS 2: three Rp1 refunds. A pro-rata split of each refund over
    // the original tenders sends all three to QRIS (Rp3 > Rp2 taken in).
    const tender = (method: string, amountIdr: number) =>
      ({ method, amountIdr: idr(amountIdr), status: "captured" }) as never;
    const tenders = [tender("cash", 1), tender("qris", 2)];
    const refunds: {
      lines: { method: string; amountIdr: number; reference: null }[];
    }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const lines = refundAllocation(
        stillRefundableByMethod(tenders, refunds),
        idr(1),
      ).map((line) => ({
        method: line.method,
        amountIdr: Number(line.amountIdr),
        reference: null,
      }));
      refunds.push({ lines });
    }
    const byMethod = (method: string) =>
      refunds
        .flatMap((row) => row.lines)
        .filter((line) => line.method === method)
        .reduce((sum, line) => sum + line.amountIdr, 0);
    expect(byMethod("cash")).toBe(1);
    expect(byMethod("qris")).toBe(2);
  });

  it("POS-02 the total cannot be changed by a discount while a QRIS tender waits for payment", async () => {
    const created = await pos().create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    const submitted = await pos().submit(orderId, "draft");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    // A pending WS-05 QRIS bill for the whole balance (what addPosTender
    // stores for method qris before payment.paid arrives).
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, payment_link_id,
            payment_link_token_sealed, payment_intent_id, amount_idr, status, requested_at)
         VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed', $5, $6, 'authorized', now())`,
        [
          tenant.tenantId,
          tenant.outletId,
          ulidToUuid(orderId),
          randomUUID(),
          randomUUID(),
          created.body.data.totalIdr,
        ],
      ),
    );
    const discounted = await cashier.client
      .post(`${pos().base}/${orderId}/discounts`)
      .set(headers)
      .set(originHeader)
      .send({
        idempotencyKey: randomUUID(),
        source: "manual",
        kind: "percent",
        percentBp: 1_000,
        reason: "manager_goodwill",
        reasonNote: "Pelanggan tetap",
      });
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(409);
    const after = await pos().get(orderId);
    expect(after.body.data.totalIdr).toBe(created.body.data.totalIdr);
  });
});

describe("POS tenant and outlet isolation (legend-kk7)", () => {
  it("TEN-01 another tenant never sees a POS order, through the service or under RLS", async () => {
    const created = await pos().create();
    expect(created.status).toBe(201);
    const orderId = created.body.data.id as string;
    await expect(
      getPosOrder(
        tenantContext(seededTenantId),
        outletIdSchema.parse(tenant.outletId),
        orderId,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });

    // The restricted app role under the seeded tenant sees none of the rows.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [seededTenantId],
      );
      for (const table of [
        "pos_orders",
        "pos_order_items",
        "order_events",
        "pos_order_idempotency",
      ]) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
          [tenant.tenantId],
        );
        expect(rows[0]?.count, table).toBe("0");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 the outlet RLS hides POS rows from a context scoped to another outlet", async () => {
    const created = await pos().create();
    expect(created.status).toBe(201);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenant.tenantId, JSON.stringify([randomUUID()])],
      );
      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pos_orders",
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 a staff member without POS permission on the outlet is refused; anonymous callers get 401", async () => {
    const anonymous = await agent(app)
      .get(pos().base)
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
    const denied = await pos(viewer).create();
    expect(denied.status).toBe(403);
    // An outlet of another tenant in the path is never served.
    const foreign = await pos(cashier, randomUUID()).list();
    expect([403, 404]).toContain(foreign.status);
  });
});

describe("Edge wiring (legend-2pi, legend-obh5)", () => {
  it("EDG-01 the cloud refuses the edge-only /api/edge prefix and an edge node refuses cloud-only routes", async () => {
    const cloud = await agent(app).get("/api/edge/status").set(headers);
    expect(cloud.status).toBe(404);
    expect(cloud.body.error?.code ?? cloud.body.code).toBe("EDGE_ONLY_ROUTE");

    const edge = createApp({ edgeMode: true });
    const platform = await agent(edge).get("/api/platform/tenants");
    expect(platform.status).toBe(404);
    expect(platform.body.error?.code ?? platform.body.code).toBe(
      "CLOUD_ONLY_ROUTE",
    );
    // The POS prefix is operational: served on the edge (401 = reached auth).
    const posOnEdge = await agent(edge).get(pos().base).set(headers);
    expect(posOnEdge.status).toBe(401);
    // The registry and the staff PIN down-sync are cloud only.
    for (const path of ["/api/edge-nodes", "/api/edge-sync/staff-pin-records"])
      expect((await agent(edge).get(path)).status).toBe(404);
  });

  it("legend-obh5 the staff PIN down-sync refuses a caller without a valid edge credential", async () => {
    // server.ts installs the cloud registry verifier; use the same one here.
    setEdgeCredentialVerifier(verifyEdgeNodeCredential);
    const missing = await agent(app)
      .get("/api/edge-sync/staff-pin-records")
      .set(headers);
    expect(missing.status).toBe(401);
    const forged = await agent(app)
      .get("/api/edge-sync/staff-pin-records")
      .set(headers)
      .set(
        "Authorization",
        `Bearer edg1.${tenant.tenantId}.${tenant.outletId}.${randomUUID()}.${"a".repeat(43)}`,
      );
    expect(forged.status).toBe(401);
  });
});
