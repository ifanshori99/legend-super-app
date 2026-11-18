// legend-mrwtp + legend-v5z4h (brief 985, PUTARAN 2, money, "Jangan sampai rugi"):
// the findings of the architect review, written BEFORE the fixes exist (red
// first). Expected behavior comes from the "PUTARAN 2" decisions of the brief
// and the shared event contracts, not from the services.
//
//  HIGH-1  partial void after a manual cash refund: the cash returned by the
//          void is `charge - completed manual refunds`; the journal of the
//          charge is reversed IN FULL (revenue/service/tax/cash net 0), every
//          entry balanced, nothing parked.
//  HIGH-2  void of a GATEWAY charge: it is marked `voided` only when COMPLETED
//          refunds equal the charge value. A refund still pending/approved
//          (not completed, not failed) blocks the void with 409 (charge stays
//          paid, nothing changes). If that refund then fails, the charge can
//          still be refunded.
//  MEDIUM  approving a manual CASH refund: the shift (chosen by the approver,
//          who holds pos.refund.approve and is audited) must be open, belong to
//          the charge's outlet and hold enough cash: else 409, nothing paid.
//  LOW     approve needs the menu permission pos.refund.approve (not
//          order.recovery.handle); reject: the requester or a holder of
//          pos.refund.approve; anyone else 403.
//
// Fixtures follow order-charge-manual-refund-void-985 (real POS cash sale, real
// void route, paid charge seeded with its cash_in) and order-charge-void-status-985
// (accounting chart, events delivered to the auto-journal consumer by hand).
//
// ASSUMPTIONS (brief silent; repeated in the report):
//  - Endpoints as in the design card: request POST
//    /api/order-issue-charges/:chargeId/manual-refund {amountIdr, reason, method},
//    approve POST /api/order-issue-charge-manual-refunds/:id/approve {shiftId},
//    reject .../reject {reason}. Success is any 2xx.
//  - "Pending" and "approved" gateway refunds are the payment_refunds statuses
//    of the shared payment contract (pending | approved | completed | failed);
//    "rejected/failed afterwards" = status failed (there is no `rejected`).
//  - Refunding the gateway charge again goes through POST
//    /api/order-issue-charges/:chargeId/refund {amountIdr, reason} by a user
//    with order.recovery.handle (as order-charge-refund-982-nsvu0).
//  - Journal checks are RELATIVE: balances before the test's sale are compared
//    with balances after all its events were delivered (earlier tests of this
//    file do not disturb them).
//  - A user with order.recovery.handle only gets 403 on approve (permission
//    check precedes the "approver is requester" 409).

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { qrOrderEvents } from "@starter/shared/qr-order";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
} from "../services/accounting-auto-journal-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const REASON = "Tamu minta uang selisih swap dikembalikan";
const POOR_FLOAT = 5_000;
const OTHER_OUTLET_FLOAT = 50_000;

const CHARGE = {
  differenceIdr: 20_000,
  grossSalesIdr: 20_000,
  serviceChargeIdr: 2_000,
  pbjtIdr: 2_200,
  amountIdr: 24_200,
} as const;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  requesterRole: randomUUID(),
  approverRole: randomUUID(),
  approveOnlyRole: randomUUID(),
  viewerRole: randomUUID(),
  device: randomUUID(),
  poorDevice: randomUUID(),
  otherDevice: randomUUID(),
  otherOutlet: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let shiftId = "";
let poorShiftId = "";
let otherOutletShiftId = "";
let businessDate = "";
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
let requester: Member; // order.recovery.handle only
let bystander: Member; // order.recovery.handle only, a different person
let approver: Member; // order.recovery.handle + pos.refund.approve
let approveOnly: Member; // pos.refund.approve only (no order.recovery.handle)
let viewer: Member; // order.view only
let poorCashier: Member;
let otherCashier: Member;

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "service_charge";
const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas Outlet", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
];
const accounts = {} as Record<Role, string>;

// ---- Receipt numbering double (as s61sg) ---------------------------------------

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

// ---- Fixtures ----------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

function contextOf(
  tenantId: string,
  source: "session" | "domain" = "domain",
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "tenant" },
  );
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

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: ids.device,
  });

function pos(who: Member = cashier, outletId = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
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
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
  };
}

async function pinApproval(input: {
  action: "void";
  orderId: string;
  valueIdr: number;
}): Promise<{ approvedBy: string; overrideId: string }> {
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
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

function periodsAroundNow(): string[] {
  const now = new Date();
  return [-1, 0, 1].map((shift) => {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

async function insertShift(input: {
  cashierId: string;
  deviceId: string;
  outletId: string;
  floatIdr: number;
}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', $7, $8, $9)`,
    [
      id,
      tenant.tenantId,
      input.outletId,
      input.deviceId,
      input.cashierId,
      businessDate,
      input.floatIdr,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`rv985-${randomUUID().slice(0, 6)}`);
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
    [
      ids.requesterRole,
      "Peminta Refund Uji",
      ["order.view", "order.recovery.handle"],
    ],
    [
      ids.approverRole,
      "Penyetuju Refund Uji",
      ["order.view", "order.recovery.handle", "pos.refund.approve"],
    ],
    [
      ids.approveOnlyRole,
      "Penyetuju Saja Uji",
      ["order.view", "pos.refund.approve"],
    ],
    [ids.viewerRole, "Pengamat Uji", ["order.view"]],
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
  requester = await member(ids.requesterRole, "Peminta Refund");
  bystander = await member(ids.requesterRole, "Peminta Lain");
  approver = await member(ids.approverRole, "Penyetuju Refund");
  approveOnly = await member(ids.approveOnlyRole, "Penyetuju Saja");
  viewer = await member(ids.viewerRole, "Pengamat");
  poorCashier = await member(ids.cashierRole, "Kasir Laci Kecil");
  otherCashier = await member(ids.cashierRole, "Kasir Outlet Lain");
  await openPosShift(
    contextOf(tenant.tenantId, "session"),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const { rows: openShifts } = await owner.query<{
    id: string;
    business_date: string;
  }>(
    "SELECT id, business_date::text AS business_date FROM pos_shifts WHERE tenant_id = $1 AND status = 'open'",
    [tenant.tenantId],
  );
  shiftId = openShifts[0]!.id;
  businessDate = openShifts[0]!.business_date;
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

  // A second outlet (as order-recovery-helpers) with an open shift, and a small
  // drawer (float 5.000) in the main outlet.
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Kedua Uji', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE id = $3 AND tenant_id = $4`,
    [
      ids.otherOutlet,
      `O2-${randomUUID().slice(0, 6)}`.toUpperCase(),
      tenant.outletId,
      tenant.tenantId,
    ],
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.poorDevice,
  });
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: ids.otherOutlet,
    deviceId: ids.otherDevice,
  });
  poorShiftId = await insertShift({
    cashierId: poorCashier.userId,
    deviceId: ids.poorDevice,
    outletId: tenant.outletId,
    floatIdr: POOR_FLOAT,
  });
  otherOutletShiftId = await insertShift({
    cashierId: otherCashier.userId,
    deviceId: ids.otherDevice,
    outletId: ids.otherOutlet,
    floatIdr: OTHER_OUTLET_FLOAT,
  });

  // Accounting: module on, chart + mappings + open periods.
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "accounting"],
      integrationProviders: [],
    }),
  ]);
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.tenantId, tenant.legalEntityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, tenant.legalEntityId, role, accounts[role]],
    );
  }
  for (const period of periodsAroundNow())
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.tenantId, tenant.legalEntityId, period],
    );
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Sale + charge builders ------------------------------------------------------

type Sale = { orderId: string; totalIdr: number };

async function completedCashSale(): Promise<Sale> {
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

async function seedLink(totalIdr: number): Promise<string> {
  const linkId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      tenant.tenantId,
      tenant.outletId,
      randomBytes(32).toString("hex"),
      `R9-${linkId.slice(0, 8)}`,
      totalIdr,
    ],
  );
  return linkId;
}

/** The cash_in movement of the open shift that collected the charge. */
async function seedCashIn(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO cash_movements
       (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
        recorded_at, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 'cash_in', $5, 'Selisih swap pesanan', $6, now(), $7, $8)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      shiftId,
      CHARGE.amountIdr,
      cashier.userId,
      `r9-cash-${id}`,
      randomBytes(32).toString("hex"),
    ],
  );
  return id;
}

/** issue id of every seeded charge (the charge events are keyed by the issue). */
const issueOfCharge = new Map<string, string>();

/**
 * A paid charge with its own REAL swap issue: the manual-refund request and the
 * intent refund resolve the charge through its issue, so a dangling
 * order_issue_id would be "not found".
 */
async function seedPaidCharge(
  orderId: string,
  input: { intentId: string | null; cashMovementId?: string; linkId: string },
): Promise<string> {
  const chargeId = randomUUID();
  const issueId = randomUUID();
  issueOfCharge.set(chargeId, issueId);
  await asOwnerTenant(
    tenant.tenantId,
    async (client) => {
      const { rows: items } = await client.query<{ id: string }>(
        `SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid LIMIT 1`,
        [tenant.tenantId, ulidToUuid(orderId)],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
           replacement_unit_price_idr, cost_idr, idempotency_key, status, resolved_at)
         VALUES ($1, $2, $3, $4::uuid, $5, 'unfulfillable', 'out_of_stock', 'Bahan habis, diganti menu lain',
           $6, 'swap', $7, $8, 45000, 0, $9, 'resolved', now())`,
        [
          issueId,
          tenant.tenantId,
          tenant.outletId,
          ulidToUuid(orderId),
          items[0]!.id,
          cashier.userId,
          ids.kopi,
          randomUUID(),
          `rv985-issue-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  const cash = input.cashMovementId !== undefined;
  await asOwnerTenant(
    tenant.tenantId,
    (client) =>
      client.query(
        `INSERT INTO order_issue_charges
           (id, tenant_id, outlet_id, order_issue_id, order_id, route, status, difference_idr,
            gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id,
            payment_link_token_sealed, payment_intent_id, paid_at${cash ? ", cash_movement_id, paid_by" : ""})
         VALUES ($1, $2, $3, $4, $5, 'qr_link', 'paid', $6, $7, $8, $9, $10, $11, 'sealed', $12, now()${cash ? ", $13, $14" : ""})`,
        [
          chargeId,
          tenant.tenantId,
          tenant.outletId,
          issueId,
          ulidToUuid(orderId),
          CHARGE.differenceIdr,
          CHARGE.grossSalesIdr,
          CHARGE.serviceChargeIdr,
          CHARGE.pbjtIdr,
          CHARGE.amountIdr,
          input.linkId,
          cash ? null : input.intentId,
          ...(cash ? [input.cashMovementId, cashier.userId] : []),
        ],
      ),
    { replica: true },
  );
  return chargeId;
}

async function saleWithCashCharge() {
  const sale = await completedCashSale();
  const cashMovementId = await seedCashIn();
  const linkId = await seedLink(CHARGE.amountIdr);
  const chargeId = await seedPaidCharge(sale.orderId, {
    intentId: null,
    cashMovementId,
    linkId,
  });
  return { ...sale, chargeId, cashMovementId };
}

/** A paid gateway intent on the link, with its evidence. */
async function seedPaidIntent(linkId: string): Promise<string> {
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
        status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(),
             '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      tenant.tenantId,
      tenant.outletId,
      linkId,
      CHARGE.amountIdr,
      `r9-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      tenant.tenantId,
      tenant.outletId,
      intentId,
      `r9-ref-${intentId}`,
      CHARGE.amountIdr,
    ],
  );
  return intentId;
}

type GatewayRefundStatus = "pending" | "approved" | "completed" | "failed";

/** A refund of the intent in the given status (payment contract statuses). */
async function seedGatewayRefund(
  intentId: string,
  status: GatewayRefundStatus,
  amountIdr: number = CHARGE.amountIdr,
): Promise<string> {
  const id = randomUUID();
  const decided = status === "approved" || status === "completed";
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', $6, 'requester', $7,
             $8::timestamptz, $9::timestamptz, NULL)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      intentId,
      amountIdr,
      status,
      decided ? "approver" : null,
      decided ? new Date().toISOString() : null,
      status === "completed" ? new Date().toISOString() : null,
    ],
  );
  return id;
}

async function setGatewayRefundStatus(
  refundId: string,
  status: GatewayRefundStatus,
): Promise<void> {
  await owner.query(
    `UPDATE payment_refunds
        SET status = $3::text,
            approved_by = CASE WHEN $3::text IN ('approved','completed') THEN 'approver' ELSE approved_by END,
            decided_at = CASE WHEN $3::text IN ('approved','completed') THEN now() ELSE decided_at END,
            completed_at = CASE WHEN $3::text = 'completed' THEN now() ELSE completed_at END
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, refundId, status],
  );
}

/** A sale whose swap charge was paid by gateway; optionally with one refund already. */
async function saleWithGatewayCharge(refund: GatewayRefundStatus | null) {
  const sale = await completedCashSale();
  const linkId = await seedLink(CHARGE.amountIdr);
  const intentId = await seedPaidIntent(linkId);
  const refundId = refund ? await seedGatewayRefund(intentId, refund) : null;
  const chargeId = await seedPaidCharge(sale.orderId, { intentId, linkId });
  return { ...sale, chargeId, intentId, refundId };
}

// ---- Events + journal observers ----------------------------------------------------

function chargeEvent(
  name: "order_issue.charge_paid",
  chargeId: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  const definition = qrOrderEvents[name];
  const issueId = issueOfCharge.get(chargeId) ?? randomUUID();
  const id = createUlid();
  return definition.envelopeSchema.parse({
    id,
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: issueId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `r9-${name}-${id}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: { orderIssueId: issueId, chargeId, ...payload },
  }) as EventEnvelope;
}

/** The charge paid at the till in cash (pos_cash: cash_in id, no intent). */
function cashPaidEvent(
  orderId: string,
  chargeId: string,
  cashMovementId: string,
): EventEnvelope {
  return chargeEvent("order_issue.charge_paid", chargeId, {
    orderId,
    method: "pos_cash",
    paymentIntentId: null,
    cashMovementId,
    differenceIdr: CHARGE.differenceIdr,
    grossSalesIdr: CHARGE.grossSalesIdr,
    serviceChargeIdr: CHARGE.serviceChargeIdr,
    pbjtIdr: CHARGE.pbjtIdr,
    amountIdr: CHARGE.amountIdr,
    paidAt: new Date().toISOString(),
  });
}

async function deliver(event: EventEnvelope) {
  const context = contextOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

/** Every outbox event about the sale or its charge, in order, through the consumer. */
async function deliverOutboxOf(
  orderId: string,
  chargeId: string,
): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1
       AND (event->>'name' LIKE 'order%' OR event->>'name' = 'payment.refunded')
       AND (event::text LIKE $2 OR event::text LIKE $3)
     ORDER BY created_at, id`,
    [tenant.tenantId, `%${orderId}%`, `%${chargeId}%`],
  );
  for (const row of rows) await deliver(eventEnvelopeSchema.parse(row.event));
}

async function postSale(orderId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'order.paid' AND event::text LIKE $2
     ORDER BY created_at, id`,
    [tenant.tenantId, `%${orderId}%`],
  );
  expect(rows, "order.paid of the sale is in the outbox").toHaveLength(1);
  const result = await deliver(eventEnvelopeSchema.parse(rows[0]!.event));
  expect(result.status, JSON.stringify(result)).toBe("posted");
}

async function sweep() {
  return retryParkedAutoJournals(
    contextOf(tenant.tenantId),
    new Date(Date.now() + 2 * 60 * 60 * 1000),
  );
}

async function balances(): Promise<Record<Role, number>> {
  const out = {} as Record<Role, number>;
  for (const role of Object.keys(accounts) as Role[]) {
    const { rows } = await owner.query<{ balance: string | null }>(
      `SELECT sum(debit_idr - credit_idr)::text AS balance
         FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
      [tenant.tenantId, accounts[role]],
    );
    out[role] = Number(rows[0]!.balance ?? 0);
  }
  return out;
}

async function unbalancedEntries(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT entry_id FROM journal_lines WHERE tenant_id = $1
       GROUP BY entry_id HAVING sum(debit_idr) <> sum(credit_idr)) t`,
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function parkedCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM auto_journal_parked WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function entryCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

// ---- Other observers ----------------------------------------------------------------

async function expectedCashOf(shift: string): Promise<number> {
  return withTenant(db, contextOf(tenant.tenantId, "session"), async (tx) => {
    const [row] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shift));
    return liveExpectedCashIdr(tx, row!);
  });
}
const drawerCash = () => expectedCashOf(shiftId);

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    closed_at: Date | null;
  }>(
    "SELECT status, closed_at FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

async function movementAmounts(key: string): Promise<number[]> {
  const { rows } = await owner.query<{ amount_idr: number; type: string }>(
    `SELECT amount_idr::int AS amount_idr, type FROM cash_movements
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant.tenantId, key],
  );
  for (const row of rows) expect(row.type).toBe("cash_out");
  return rows.map((row) => row.amount_idr);
}

async function movementCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_movements WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
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

async function refundRowsOfIntent(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

/** Refunds of the intent that are not failed (reserved or paid back money). */
async function liveRefundTotal(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS total FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenant.tenantId, intentId],
  );
  return rows[0]!.total;
}

type ManualRow = {
  id: string;
  status: string;
  amount_idr: number;
  decided_by: string | null;
  reject_reason: string | null;
};

async function manualRows(chargeId: string): Promise<ManualRow[]> {
  const { rows } = await owner.query<ManualRow>(
    `SELECT id, status, amount_idr::int AS amount_idr, decided_by, reject_reason
     FROM order_issue_charge_manual_refunds
     WHERE tenant_id = $1 AND charge_id = $2 ORDER BY requested_at, id`,
    [tenant.tenantId, chargeId],
  );
  return rows;
}

async function voidOrder(sale: Sale) {
  const approval = await pinApproval({
    action: "void",
    orderId: sale.orderId,
    valueIdr: sale.totalIdr,
  });
  const response = await pos().correctionVoid(sale.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...approval,
  });
  return { response, approval };
}

/** What a void of a plain cash sale does to the drawer (control). */
async function controlVoidDelta(): Promise<number> {
  const before = await drawerCash();
  const sale = await completedCashSale();
  const { response } = await voidOrder(sale);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return (await drawerCash()) - before;
}

// ---- Manual refund endpoints -------------------------------------------------------

function requestRefund(
  chargeId: string,
  amountIdr: number,
  who: Member = requester,
) {
  return who.client
    .post(
      `/api/order-issue-charges/${encodeURIComponent(chargeId)}/manual-refund`,
    )
    .set(headers)
    .set(originHeader)
    .send({ amountIdr, reason: REASON, method: "cash" });
}

function approveRefund(
  id: string,
  who: Member = approver,
  body: Record<string, unknown> = { shiftId },
) {
  return who.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/approve`,
    )
    .set(headers)
    .set(originHeader)
    .send(body);
}

function rejectRefund(
  id: string,
  who: Member = approver,
  reason = "Tamu batal minta uang kembali",
) {
  return who.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/reject`,
    )
    .set(headers)
    .set(originHeader)
    .send({ reason });
}

function refundViaIntent(chargeId: string, amountIdr: number, who = requester) {
  return who.client
    .post(`/api/order-issue-charges/${encodeURIComponent(chargeId)}/refund`)
    .set(headers)
    .set(originHeader)
    .send({ amountIdr, reason: REASON });
}

function expectOk(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** Requests a manual cash refund and returns its row id (request must succeed). */
async function requested(chargeId: string, amountIdr: number): Promise<string> {
  const before = new Set((await manualRows(chargeId)).map((row) => row.id));
  expectOk(await requestRefund(chargeId, amountIdr));
  const fresh = (await manualRows(chargeId)).filter(
    (row) => !before.has(row.id),
  );
  expect(fresh).toHaveLength(1);
  return fresh[0]!.id;
}

async function completedManual(chargeId: string, amountIdr: number) {
  const id = await requested(chargeId, amountIdr);
  expectOk(await approveRefund(id));
  expect((await manualRows(chargeId)).find((r) => r.id === id)!.status).toBe(
    "completed",
  );
  return id;
}

async function expectVoidBlocked(
  sale: Sale,
  chargeId: string,
  { drawerBefore }: { drawerBefore: number },
) {
  const { response, approval } = await voidOrder(sale);
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(await voidRowCount(sale.orderId)).toBe(0);
  expect(await approvalUses(approval.overrideId)).toBe(0);
  expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
  expect((await chargeRow(chargeId)).status).toBe("paid");
  expect(await movementAmounts(`void-charge:${chargeId}`)).toEqual([]);
  expect(await drawerCash()).toBe(drawerBefore);
}

// ============================================================================

describe("HIGH-1 partial void after manual cash refunds: the journal of the charge is reversed in full", () => {
  const cases: [string, number[]][] = [
    ["one manual refund of 10.000", [10_000]],
    ["two manual refunds of 3.000 and 4.000", [3_000, 4_000]],
    ["a manual refund of all but 1 rupiah", [CHARGE.amountIdr - 1]],
  ];

  it.each(cases)(
    "R2-H1 %s, then void: the void returns exactly the rest in cash, and revenue/tax/cash of the charge net to 0, every entry balanced, nothing parked",
    async (_label, manualAmounts) => {
      const manualTotal = manualAmounts.reduce((a, b) => a + b, 0);
      const control = await controlVoidDelta();
      const beforeSale = await drawerCash();
      const beforeBalances = await balances();
      const parkedBefore = await parkedCount();

      const sale = await saleWithCashCharge();
      await postSale(sale.orderId);
      const paid = await deliver(
        cashPaidEvent(sale.orderId, sale.chargeId, sale.cashMovementId),
      );
      expect(paid.status, JSON.stringify(paid)).toBe("posted");
      for (const amount of manualAmounts)
        await completedManual(sale.chargeId, amount);

      const { response } = await voidOrder(sale);
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      expect(await movementAmounts(`void-charge:${sale.chargeId}`)).toEqual([
        CHARGE.amountIdr - manualTotal,
      ]);
      expect((await chargeRow(sale.chargeId)).status).toBe("voided");
      // Manual + void return exactly the charge: drawer like a charge-less void.
      expect((await drawerCash()) - beforeSale).toBe(control);

      await deliverOutboxOf(sale.orderId, sale.chargeId);
      await sweep();
      // The whole charge (and the sale) is reversed: nothing is left in revenue,
      // service charge, PBJT or cash, and no event was refused as a mismatch.
      expect(await balances()).toEqual(beforeBalances);
      expect(await unbalancedEntries()).toBe(0);
      expect(await parkedCount()).toBeLessThanOrEqual(parkedBefore);

      // Replaying every event adds no entry and changes no balance.
      const entries = await entryCount();
      await deliverOutboxOf(sale.orderId, sale.chargeId);
      expect(await entryCount()).toBe(entries);
      expect(await balances()).toEqual(beforeBalances);
    },
  );
});

describe("HIGH-2 void of a gateway charge: voided only when COMPLETED refunds equal the charge", () => {
  it.each<GatewayRefundStatus>(["pending", "approved"])(
    "R2-H2a a %s refund of the full charge blocks the void: 409, order stays completed, charge stays paid, nothing changes; once the refund completes the void goes through and the charge is voided",
    async (status) => {
      const sale = await saleWithGatewayCharge(status);
      const drawer = await drawerCash();
      const refunds = await refundRowsOfIntent(sale.intentId);

      await expectVoidBlocked(sale, sale.chargeId, { drawerBefore: drawer });
      expect(await refundRowsOfIntent(sale.intentId)).toBe(refunds);
      expect((await chargeRow(sale.chargeId)).closed_at).toBeNull();

      await setGatewayRefundStatus(sale.refundId!, "completed");
      const { response } = await voidOrder(sale);
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      const charge = await chargeRow(sale.chargeId);
      expect(charge.status).toBe("voided");
      expect(charge.closed_at).not.toBeNull();
      // No new money: the one refund stays one, no cash leaves the drawer for it.
      expect(await refundRowsOfIntent(sale.intentId)).toBe(refunds);
      expect(await movementAmounts(`void-charge:${sale.chargeId}`)).toEqual([]);
    },
  );

  it("R2-H2b a refund of the full charge already COMPLETED, then void: charge voided (closed), no new refund, no cash_out", async () => {
    const control = await controlVoidDelta();
    const beforeSale = await drawerCash();
    const sale = await saleWithGatewayCharge("completed");

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);

    const charge = await chargeRow(sale.chargeId);
    expect(charge.status).toBe("voided");
    expect(charge.closed_at).not.toBeNull();
    expect(await refundRowsOfIntent(sale.intentId)).toBe(1);
    expect(await movementAmounts(`void-charge:${sale.chargeId}`)).toEqual([]);
    expect((await drawerCash()) - beforeSale).toBe(control);
  });

  it("R2-H2c part completed and the rest still pending (together the whole charge): the void is 409, the charge stays paid", async () => {
    const sale = await saleWithGatewayCharge(null);
    await seedGatewayRefund(sale.intentId, "completed", 10_000);
    await seedGatewayRefund(
      sale.intentId,
      "pending",
      CHARGE.amountIdr - 10_000,
    );
    const drawer = await drawerCash();

    await expectVoidBlocked(sale, sale.chargeId, { drawerBefore: drawer });
    expect(await refundRowsOfIntent(sale.intentId)).toBe(2);
    expect(await liveRefundTotal(sale.intentId)).toBe(CHARGE.amountIdr);
  });

  it("R2-H2d a pending refund of the full charge: the void is 409; the refund then FAILS (rejected): the guest got nothing, the charge is still paid and can be refunded again, never over the charge value", async () => {
    const sale = await saleWithGatewayCharge("pending");
    const drawer = await drawerCash();
    await expectVoidBlocked(sale, sale.chargeId, { drawerBefore: drawer });

    await setGatewayRefundStatus(sale.refundId!, "failed");
    expect((await chargeRow(sale.chargeId)).status).toBe("paid");
    expect(await liveRefundTotal(sale.intentId)).toBe(0);

    // The charge can be refunded again, in full, through the intent.
    expectOk(await refundViaIntent(sale.chargeId, CHARGE.amountIdr));
    expect(await liveRefundTotal(sale.intentId)).toBe(CHARGE.amountIdr);
    // ... and not beyond its value.
    const more = await refundViaIntent(sale.chargeId, 1);
    expect([409, 422], JSON.stringify(more.body)).toContain(more.status);
    expect(await liveRefundTotal(sale.intentId)).toBe(CHARGE.amountIdr);
  });
});

describe("MEDIUM approving a manual cash refund: the shift must be open, of this outlet, and hold the cash", () => {
  it("R2-M1 a small drawer (5.000): 5.001 is 409, nothing paid, still requested; exactly 5.000 pays the drawer down to 0; one more rupiah is refused", async () => {
    const sale = await saleWithCashCharge();
    const mainDrawer = await drawerCash();
    const movements = await movementCount();

    const tooMuch = await requested(sale.chargeId, POOR_FLOAT + 1);
    const refused = await approveRefund(tooMuch, approver, {
      shiftId: poorShiftId,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(
      (await manualRows(sale.chargeId)).find((r) => r.id === tooMuch)!.status,
    ).toBe("requested");
    expect(await movementAmounts(`manual-charge-refund:${tooMuch}`)).toEqual(
      [],
    );
    expect(await movementCount()).toBe(movements);
    expect(await expectedCashOf(poorShiftId)).toBe(POOR_FLOAT);
    expect(await drawerCash()).toBe(mainDrawer);

    // Release the over-sized request, then pay exactly what the drawer holds.
    expectOk(await rejectRefund(tooMuch));
    const exact = await requested(sale.chargeId, POOR_FLOAT);
    expectOk(await approveRefund(exact, approver, { shiftId: poorShiftId }));
    expect(await movementAmounts(`manual-charge-refund:${exact}`)).toEqual([
      POOR_FLOAT,
    ]);
    expect(await expectedCashOf(poorShiftId)).toBe(0);

    const one = await requested(sale.chargeId, 1);
    const empty = await approveRefund(one, approver, { shiftId: poorShiftId });
    expect(empty.status, JSON.stringify(empty.body)).toBe(409);
    expect(await expectedCashOf(poorShiftId)).toBe(0);
    expect(await movementAmounts(`manual-charge-refund:${one}`)).toEqual([]);

    // The main drawer still pays it: the approver may pick the shift.
    expectOk(await approveRefund(one));
    expect(await movementAmounts(`manual-charge-refund:${one}`)).toEqual([1]);
  });

  it("R2-M2 the shift of ANOTHER outlet is refused: 409, nothing paid, that drawer untouched, the refund still requested and payable from the right shift", async () => {
    const sale = await saleWithCashCharge();
    const id = await requested(sale.chargeId, 2_000);
    const movements = await movementCount();

    const res = await approveRefund(id, approver, {
      shiftId: otherOutletShiftId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);

    expect((await manualRows(sale.chargeId))[0]!.status).toBe("requested");
    expect(await movementCount()).toBe(movements);
    expect(await movementAmounts(`manual-charge-refund:${id}`)).toEqual([]);
    expect(await expectedCashOf(otherOutletShiftId)).toBe(OTHER_OUTLET_FLOAT);

    expectOk(await approveRefund(id));
    expect(await movementAmounts(`manual-charge-refund:${id}`)).toEqual([
      2_000,
    ]);
    expect(await expectedCashOf(otherOutletShiftId)).toBe(OTHER_OUTLET_FLOAT);
  });
});

describe("LOW permissions of approve and reject of a manual refund", () => {
  it("R2-L1 a holder of pos.refund.approve ONLY (no order.recovery.handle) can approve: cash is paid out once, decided_by is that person", async () => {
    const sale = await saleWithCashCharge();
    const id = await requested(sale.chargeId, 3_000);

    expectOk(await approveRefund(id, approveOnly));
    const row = (await manualRows(sale.chargeId))[0]!;
    expect(row.status).toBe("completed");
    expect(row.decided_by).toBe(approveOnly.userId);
    expect(await movementAmounts(`manual-charge-refund:${id}`)).toEqual([
      3_000,
    ]);
  });

  it("R2-L2 without pos.refund.approve nobody approves, not even with order.recovery.handle: 403, nothing paid, the refund stays requested; the requester gets 403 too", async () => {
    const sale = await saleWithCashCharge();
    const id = await requested(sale.chargeId, 3_000);
    const movements = await movementCount();
    const drawer = await drawerCash();

    for (const who of [bystander, requester, viewer, cashier]) {
      const res = await approveRefund(id, who);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    expect((await manualRows(sale.chargeId))[0]!.status).toBe("requested");
    expect(await movementCount()).toBe(movements);
    expect(await drawerCash()).toBe(drawer);

    // The rightful approver still pays it.
    expectOk(await approveRefund(id));
    expect(await movementAmounts(`manual-charge-refund:${id}`)).toEqual([
      3_000,
    ]);
  });

  it("R2-L3 the requester (order.recovery.handle only) can reject their own request: the reason is kept, the amount is free again", async () => {
    const sale = await saleWithCashCharge();
    const id = await requested(sale.chargeId, CHARGE.amountIdr);

    const res = await rejectRefund(
      id,
      requester,
      "Salah input, tamu tidak jadi",
    );
    expectOk(res);
    const row = (await manualRows(sale.chargeId))[0]!;
    expect(row.status).toBe("rejected");
    expect(row.reject_reason).toBe("Salah input, tamu tidak jadi");
    expect(await movementAmounts(`manual-charge-refund:${id}`)).toEqual([]);
    // The whole value is free for a new request.
    expectOk(await requestRefund(sale.chargeId, CHARGE.amountIdr));
  });

  it("R2-L4 a holder of pos.refund.approve only can reject someone else's request; a person who is neither requester nor approver gets 403 and the refund stays requested", async () => {
    const sale = await saleWithCashCharge();
    const first = await requested(sale.chargeId, 2_000);
    const stranger = await rejectRefund(first, bystander);
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(403);
    const viewing = await rejectRefund(first, viewer);
    expect(viewing.status, JSON.stringify(viewing.body)).toBe(403);
    expect(
      (await manualRows(sale.chargeId)).find((r) => r.id === first)!.status,
    ).toBe("requested");

    expectOk(await rejectRefund(first, approveOnly));
    expect(
      (await manualRows(sale.chargeId)).find((r) => r.id === first)!.status,
    ).toBe("rejected");
    expect(await movementAmounts(`manual-charge-refund:${first}`)).toEqual([]);

    // Only a requested refund can still be decided.
    const again = await approveRefund(first);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
  });
});
