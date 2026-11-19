// POS void of a completed sale paid with non-cash tenders (bead legend-ioyg,
// sub-brief 172 section C). A void only knows how to return cash, so a sale
// settled by gateway (QRIS/VA/e-wallet/card), EDC or loyalty points is refused
// with 409 CONFLICT before the approval is consumed; the cashier uses refund,
// which splits per method. A pure cash sale keeps voiding (regression).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant. Non-cash tenders are seeded as `captured` rows (what
// payment.paid / EDC / points capture leave behind) because the gateways are
// not part of this file. Fixtures follow pos-order.test.ts.
//
// Assumption: "struk tidak di-void" is observed through the receipt port
// double, whose voidForOrder must not be called for a refused void.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
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
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;

/** Orders whose receipt the port was asked to void. */
const receiptVoidCalls: string[] = [];

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
      receiptVoidCalls.push(input.orderId);
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
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
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
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant"]')`,
      [
        id,
        tenant.tenantId,
        name,
        JSON.stringify(permissions),
        id === ids.supervisorRole ? "supervisor" : null,
      ],
    );
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "POS Supervisor");
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

// ---- Sale builders ------------------------------------------------------------------

type SeedTender = {
  method: string;
  amountIdr: number;
};

/** create -> submit -> seed captured tenders -> complete. */
/**
 * A really paid gateway payment (link, paid intent, evidence) for a POS tender to name.
 * legend-1116: a tender naming an intent that does not exist (or is not paid) is not
 * proof of money received, so the fixture must pay for real.
 */
async function seedPaidIntent(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  tenantId: string,
  outletId: string,
  amountIdr: number,
): Promise<string> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await client.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, '1116-fixture')`,
    [
      linkId,
      tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `F1116-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
        idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
             '{"method":"qris","qrPayload":"00020101021226FIX","issuer":null}',
             now() + interval '1 hour', now(), $7)`,
    [
      intentId,
      tenantId,
      outletId,
      linkId,
      amountIdr,
      `f1116-${intentId}`,
      `FIX-${intentId.slice(0, 12)}`,
    ],
  );
  await client.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method,
        source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletId, intentId, `FIXEV-${intentId.slice(0, 12)}`, amountIdr],
  );
  return intentId;
}

async function completedSaleWith(
  seed: (totalIdr: number) => SeedTender[],
): Promise<{ orderId: string; totalIdr: number }> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    for (const tender of seed(totalIdr)) {
      const cash = tender.method === "cash";
      const provider = cash
        ? "manual"
        : tender.method.startsWith("edc_")
          ? "edc"
          : tender.method === "points"
            ? "manual"
            : "doit";
      const intentId =
        provider === "doit"
          ? await seedPaidIntent(
              client,
              tenant.tenantId,
              tenant.outletId,
              tender.amountIdr,
            )
          : null;
      await client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, amount_idr,
            received_idr, change_idr, points_used, payment_intent_id, reference, status,
            requested_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'captured', now(), now())`,
        [
          tenant.tenantId,
          tenant.outletId,
          ulidToUuid(orderId),
          tender.method,
          provider,
          tender.amountIdr,
          cash ? tender.amountIdr : null,
          cash ? 0 : null,
          tender.method === "points" ? tender.amountIdr / 100 : null,
          intentId,
          provider === "edc" ? `BANKREF-${randomUUID().slice(0, 8)}` : null,
        ],
      );
    }
  });
  const completed = await pos().complete(orderId, status);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe("completed");
  return { orderId, totalIdr };
}

/** The sale a cashier takes with cash only (the regression path). */
async function completedCashSale(): Promise<{
  orderId: string;
  totalIdr: number;
}> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await pos().cash(orderId, status, totalIdr);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos().complete(
    orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return { orderId, totalIdr };
}

async function voidRowCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_voids
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

async function approvalUses(overrideId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_approval_uses
     WHERE override_id = $1::uuid`,
    [ulidToUuid(overrideId)],
  );
  return Number(rows[0]?.count);
}

/**
 * Try to void the completed sale; assert it is refused as 409 CONFLICT and
 * that nothing happened: no void record, receipt untouched, order still
 * completed, approval not consumed (it could still approve another action).
 */
async function expectVoidRefusedAsNonCash(
  orderId: string,
  totalIdr: number,
): Promise<void> {
  const approval = await pinApproval({
    action: "void",
    orderId,
    valueIdr: totalIdr,
  });
  const response = await pos().correctionVoid(orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...approval,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error?.code ?? response.body.code).toBe("CONFLICT");
  expect(response.body.error?.message ?? response.body.message ?? "").toMatch(
    /refund/i,
  );

  expect(await voidRowCount(orderId)).toBe(0);
  expect(receiptVoidCalls).not.toContain(orderId);
  expect((await pos().get(orderId)).body.data.status).toBe("completed");
  expect(await approvalUses(approval.overrideId)).toBe(0);
}

describe("POS void of a completed non-cash sale (legend-ioyg)", () => {
  it("C1 a completed sale paid through a gateway (QRIS, VA, e-wallet, card) cannot be voided: 409 CONFLICT, no void record, receipt kept, approval unused", async () => {
    for (const method of ["qris", "va", "ewallet", "card"]) {
      const { orderId, totalIdr } = await completedSaleWith((total) => [
        { method, amountIdr: total },
      ]);
      await expectVoidRefusedAsNonCash(orderId, totalIdr);
    }
  });

  it("C1 a sale split between cash and QRIS cannot be voided either", async () => {
    const { orderId, totalIdr } = await completedSaleWith((total) => [
      { method: "cash", amountIdr: 5_000 },
      { method: "qris", amountIdr: total - 5_000 },
    ]);
    await expectVoidRefusedAsNonCash(orderId, totalIdr);
  });

  it("C2 a completed sale paid by EDC (card or QRIS) or loyalty points cannot be voided", async () => {
    for (const method of ["edc_card", "edc_qris", "points"]) {
      const { orderId, totalIdr } = await completedSaleWith((total) => [
        { method, amountIdr: total },
      ]);
      await expectVoidRefusedAsNonCash(orderId, totalIdr);
    }
  });

  it("C3 a completed cash-only sale is still voided by a linked void, receipt voided, approval used once", async () => {
    const { orderId, totalIdr } = await completedCashSale();
    const approval = await pinApproval({
      action: "void",
      orderId,
      valueIdr: totalIdr,
    });
    const voided = await pos().correctionVoid(orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      ...approval,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
    expect(voided.body.data).toMatchObject({ orderId, amountIdr: totalIdr });
    expect(await voidRowCount(orderId)).toBe(1);
    expect(await approvalUses(approval.overrideId)).toBe(1);
  });
});
