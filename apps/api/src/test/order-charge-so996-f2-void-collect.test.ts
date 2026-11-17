// legend-vl6bk (brief 1010, SO 996 finding F2, money, "Jangan sampai rugi"):
// an UNPAID swap charge (`order_issue_charges`, status `open`) of a POS sale
// whose sale was voided finally through the real route
// `POST /api/outlets/:outletId/pos/orders/:orderId/corrections/void`.
// That void keeps `orders.status = 'completed'` (proof lives in
// `pos_order_voids`), so the collect paths that only refuse `orders.status =
// 'voided'` still take the money. Written BEFORE the behavior exists (red
// first); expected behavior comes from docs/briefs/1010-charge-so996-f2-f3.md
// and the shared contracts, not from the services.
//
// Rules under test:
// - After the final void, collecting the open charge by cash, QRIS or EDC card
//   (`POST /api/order-issue-charges/:chargeId/collect-at-pos`) is refused with
//   409 and a clear code; no money/event comes in (no cash movement, no new
//   intent, no `order_issue.charge_paid`, charge stays unpaid).
// - A QRIS asked BEFORE the void and paid AFTER it never turns the charge
//   `paid`: the money is sent back in ONE full refund (outcome
//   `late_payment_on_closed_charge`, as order-charge-fix-982-a A4 for a voided
//   order) and the charge journal is not posted.
// - Race collect vs void (and webhook vs void): whichever wins, the charge is
//   never left paid on a voided sale without the money going back.
// - Another, un-voided sale keeps its charge collectable.
//
// Harness as order-charge-void-status-985.test.ts (Express app, Better Auth,
// RBAC, POS routes, PostgreSQL with RLS, isolated tenant).
//
// Assumptions (spec silent, repeated in the report):
// - The refusal is HTTP 409 and its `error.code` contains "VOID" (e.g.
//   ORDER_VOIDED, CHARGE_ORDER_VOIDED). The exact name is not specified.
// - The brief allows two designs: refuse the collect, or cancel the charge in
//   the void transaction. Both satisfy these tests: the void itself must
//   succeed (2xx), the collect must then be 409, the charge must not be paid.
// - Unpaid charges are SEEDED by SQL (with a real swap issue, as
//   order-charge-drawer-floor-985) on a really completed POS sale. A control collect on an un-voided sale
//   proves the setup is collectable, so a red test is never a setup error.
// - The late QRIS webhook is delivered by hand through
//   deliverOrderPaymentEvent, as production's outbox consumer does.
// - The race tests are best effort (no hook to force the interleaving): they
//   repeat several rounds; the sequential tests are the deterministic proof.

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentStatus,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import type { PaymentInstructions } from "@starter/shared/payment";
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
  device: randomUUID(),
  terminal: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let shiftId = "";
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;

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

// ---- Receipt numbering double (as pos-order-void-noncash.test.ts) ----------

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

// ---- QRIS gateway double (as order-recovery-helpers FakeGateway) -----------

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  private created = 0;
  private readonly payments = new Map<string, GatewayPaymentStatus>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const providerRef = `F2-${randomBytes(6).toString("hex")}-${this.created}`;
    this.payments.set(providerRef, {
      status: "pending",
      providerRef,
      amountIdr: input.amountIdr,
    });
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226F2QR",
      issuer: null,
    };
    return { providerRef, instructions, expiresAt: input.expiresAt };
  }
  async getStatus(input: { providerRef: string }) {
    return (
      this.payments.get(input.providerRef) ?? {
        status: "pending" as const,
        providerRef: input.providerRef,
        amountIdr: null,
      }
    );
  }
  async channels() {
    return [];
  }
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

function pos(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
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

function collect(chargeId: string, body: Record<string, unknown>) {
  return cashier.client
    .post(`/api/order-issue-charges/${chargeId}/collect-at-pos`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send(body);
}

const AMOUNT = CHARGE.amountIdr;
const cashBody = () => ({
  idempotencyKey: randomUUID(),
  method: "cash",
  receivedIdr: AMOUNT,
});
const qrisBody = () => ({ idempotencyKey: randomUUID(), method: "qris" });
const edcBody = (edcTransactionId: string) => ({
  idempotencyKey: randomUUID(),
  method: "edc_card",
  edcTransactionId,
});

async function pinApproval(input: {
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
      action: "void",
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPaymentGateway(new FakeGateway());
  tenant = await createIsolatedTenant(`f2-${randomUUID().slice(0, 6)}`);
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
  await openPosShift(
    contextOf(tenant.tenantId, "session"),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const { rows: openShifts } = await owner.query<{ id: string }>(
    "SELECT id FROM pos_shifts WHERE tenant_id = $1 AND status = 'open'",
    [tenant.tenantId],
  );
  shiftId = openShifts[0]!.id;
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
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-F2', 'MID-F2', 'Test EDC', 'lan',
               '10.0.0.9', ARRAY['card','qris'], 'active')`,
      [ids.terminal, tenant.tenantId, tenant.outletId],
    );
  });

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
  setPaymentGateway(null);
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

// ---- Sale + unpaid charge builders ----------------------------------------------

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

/**
 * A real completed POS sale with an UNPAID swap charge on it, routed to the
 * till (`routed_pos`, no payment link: the sealed link token cannot be forged).
 */
async function saleWithOpenCharge() {
  const sale = await completedCashSale();
  const chargeId = randomUUID();
  const issueId = randomUUID();
  // The collect resolves the charge through its REAL swap issue.
  await asOwnerTenant(
    tenant.tenantId,
    async (client) => {
      const { rows: items } = await client.query<{ id: string }>(
        `SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid LIMIT 1`,
        [tenant.tenantId, ulidToUuid(sale.orderId)],
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
          ulidToUuid(sale.orderId),
          items[0]!.id,
          cashier.userId,
          ids.kopi,
          randomUUID(),
          `f2-issue-${randomUUID()}`,
        ],
      );
      await client.query(
        `INSERT INTO order_issue_charges
           (id, tenant_id, outlet_id, order_issue_id, order_id, route, status, difference_idr,
            gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
         VALUES ($1, $2, $3, $4, $5, 'pos', 'routed_pos', $6, $7, $8, $9, $10)`,
        [
          chargeId,
          tenant.tenantId,
          tenant.outletId,
          issueId,
          ulidToUuid(sale.orderId),
          CHARGE.differenceIdr,
          CHARGE.grossSalesIdr,
          CHARGE.serviceChargeIdr,
          CHARGE.pbjtIdr,
          AMOUNT,
        ],
      );
    },
    { replica: true },
  );
  return { ...sale, chargeId };
}

async function ledgerSale(chargeId: string): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', 'approved', 'sale', 'ecr', $8,
               'APP123', $9, now())`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        ids.terminal,
        chargeId,
        randomUUID(),
        AMOUNT,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
      ],
    ),
  );
  return id;
}

// ---- Observers --------------------------------------------------------------------

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    payment_intent_id: string | null;
    cash_movement_id: string | null;
    paid_at: Date | null;
  }>(
    `SELECT status, payment_intent_id, cash_movement_id, paid_at
     FROM order_issue_charges WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

async function chargePaidEvents(chargeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'order_issue.charge_paid'
       AND event->'payload'->>'chargeId' = $2`,
    [tenant.tenantId, chargeId],
  );
  return Number(rows[0]!.n);
}

async function movementCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
    [tenant.tenantId, shiftId],
  );
  return Number(rows[0]!.n);
}

async function intentCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function drawerCash(): Promise<number> {
  return withTenant(db, contextOf(tenant.tenantId, "session"), async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return liveExpectedCashIdr(tx, shift!);
  });
}

async function voidRowCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_voids
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

async function liveRefundsOfIntent(intentId: string): Promise<number[]> {
  const { rows } = await owner.query<{ amount_idr: string }>(
    `SELECT amount_idr FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenant.tenantId, intentId],
  );
  return rows.map((row) => Number(row.amount_idr));
}

async function chargeJournalEntries(chargeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant.tenantId, `aj:order-charge:${chargeId}`],
  );
  return Number(rows[0]!.n);
}

async function voidChargeCashOut(chargeId: string): Promise<number[]> {
  const { rows } = await owner.query<{ amount_idr: number }>(
    `SELECT amount_idr::int AS amount_idr FROM cash_movements
     WHERE tenant_id = $1 AND type = 'cash_out' AND idempotency_key = $2`,
    [tenant.tenantId, `void-charge:${chargeId}`],
  );
  return rows.map((row) => row.amount_idr);
}

async function voidOrder(sale: Sale) {
  const approval = await pinApproval({
    orderId: sale.orderId,
    valueIdr: sale.totalIdr,
  });
  return pos().correctionVoid(sale.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...approval,
  });
}

/** The void of the sale itself must go through (2xx) before the collect is tried. */
async function voidFinal(sale: Sale) {
  const response = await voidOrder(sale);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  expect(await voidRowCount(sale.orderId)).toBe(1);
}

function expectAccepted(res: { status: number; body: unknown }) {
  expect([200, 201, 202], JSON.stringify(res.body)).toContain(res.status);
}

/** 409 with a clear code that names the void (not a validator/permission error). */
function expectRefusedAsVoided(res: {
  status: number;
  body: { error?: { code?: unknown } };
}) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(String(res.body.error?.code ?? ""), JSON.stringify(res.body)).toMatch(
    /VOID/i,
  );
}

async function paidEventOf(intentId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [tenant.tenantId, intentId],
  );
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** The verified QRIS webhook settles the intent, then the order-payment consumer runs. */
async function settleQris(intentId: string) {
  const context = contextOf(tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: AMOUNT,
    providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
  });
  const paid = await paidEventOf(intentId);
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, paid, tx),
  );
}

// ============================================================================

describe("legend-vl6bk (F2) unpaid charge after the POS sale was voided", () => {
  it.each([
    ["cash", async () => cashBody()],
    ["qris", async () => qrisBody()],
    ["edc", async (chargeId: string) => edcBody(await ledgerSale(chargeId))],
  ] as const)(
    "F2-control-%s: on a sale that is NOT voided the unpaid charge is collectable",
    async (_method, makeBody) => {
      const sale = await saleWithOpenCharge();
      const res = await collect(sale.chargeId, await makeBody(sale.chargeId));
      expectAccepted(res);
    },
  );

  it("F2-1 cash: after the void the collect is 409, no cash enters the drawer, no charge_paid", async () => {
    const sale = await saleWithOpenCharge();
    await voidFinal(sale);
    const cashBefore = await drawerCash();
    const moves = await movementCount();

    const res = await collect(sale.chargeId, cashBody());

    expectRefusedAsVoided(res);
    const row = await chargeRow(sale.chargeId);
    expect(row.status).not.toBe("paid");
    expect(row.paid_at).toBeNull();
    expect(row.cash_movement_id).toBeNull();
    expect(await chargePaidEvents(sale.chargeId)).toBe(0);
    expect(await movementCount()).toBe(moves);
    expect(await drawerCash()).toBe(cashBefore);
  });

  it("F2-2 qris: after the void the collect is 409, no new intent, no charge_paid", async () => {
    const sale = await saleWithOpenCharge();
    await voidFinal(sale);
    const intents = await intentCount();

    const res = await collect(sale.chargeId, qrisBody());

    expectRefusedAsVoided(res);
    const row = await chargeRow(sale.chargeId);
    expect(row.status).not.toBe("paid");
    expect(row.payment_intent_id).toBeNull();
    expect(await intentCount()).toBe(intents);
    expect(await chargePaidEvents(sale.chargeId)).toBe(0);
  });

  it("F2-3 edc card: after the void an approved EDC sale is still refused 409, charge not paid, no charge_paid", async () => {
    const sale = await saleWithOpenCharge();
    await voidFinal(sale);
    // The void refuses while an EDC sale is held on the charge (F2-9), so the
    // approved row lands after the void.
    const edcSale = await ledgerSale(sale.chargeId);
    const moves = await movementCount();

    const res = await collect(sale.chargeId, edcBody(edcSale));

    expectRefusedAsVoided(res);
    const row = await chargeRow(sale.chargeId);
    expect(row.status).not.toBe("paid");
    expect(row.paid_at).toBeNull();
    expect(await chargePaidEvents(sale.chargeId)).toBe(0);
    expect(await movementCount()).toBe(moves);
  });

  it("F2-4 qris asked BEFORE the void, paid AFTER: charge is not paid, no charge_paid, one full refund, no charge journal", async () => {
    const sale = await saleWithOpenCharge();
    expectAccepted(await collect(sale.chargeId, qrisBody()));
    const intentId = (await chargeRow(sale.chargeId)).payment_intent_id;
    expect(intentId).not.toBeNull();
    await voidFinal(sale);

    const routed = await settleQris(intentId!);

    expect(routed).toEqual({
      route: "issue_charge",
      outcome: "late_payment_on_closed_charge",
    });
    const row = await chargeRow(sale.chargeId);
    expect(row.status).not.toBe("paid");
    expect(row.paid_at).toBeNull();
    expect(await chargePaidEvents(sale.chargeId)).toBe(0);
    // The money that came in goes back in exactly one full refund.
    expect(await liveRefundsOfIntent(intentId!)).toEqual([AMOUNT]);
    expect(await chargeJournalEntries(sale.chargeId)).toBe(0);
  });

  it("F2-9 EDC card approved on an unpaid charge: the void is refused 409 edc_charge_pending, the sale stays not voided", async () => {
    const sale = await saleWithOpenCharge();
    await ledgerSale(sale.chargeId);

    const res = await voidOrder(sale);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
      "edc_charge_pending",
    );
    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect((await chargeRow(sale.chargeId)).status).not.toBe("paid");
  });

  it("F2-10 no EDC transaction on the unpaid charge: the void still goes through", async () => {
    const sale = await saleWithOpenCharge();

    await voidFinal(sale);
  });

  it("F2-5 the void of one sale leaves the charge of another (not voided) sale collectable", async () => {
    const voided = await saleWithOpenCharge();
    const other = await saleWithOpenCharge();
    await voidFinal(voided);

    expectRefusedAsVoided(await collect(voided.chargeId, cashBody()));
    const res = await collect(other.chargeId, cashBody());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await chargeRow(other.chargeId)).status).toBe("paid");
    expect((await chargeRow(voided.chargeId)).status).not.toBe("paid");
  });

  it("F2-6 race cash collect vs void: the charge is never left paid on a voided sale without the cash going back", async () => {
    for (let round = 0; round < 4; round += 1) {
      const sale = await saleWithOpenCharge();
      const approval = await pinApproval({
        orderId: sale.orderId,
        valueIdr: sale.totalIdr,
      });
      const [collected, voided] = await Promise.all([
        collect(sale.chargeId, cashBody()),
        pos().correctionVoid(sale.orderId, {
          reason: "customer_cancelled",
          reasonNote: "Pelanggan salah pesan",
          ...approval,
        }),
      ]);
      expect(collected.status, JSON.stringify(collected.body)).toBeLessThan(
        500,
      );
      expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(500);

      const voidedRows = await voidRowCount(sale.orderId);
      if (collected.status === 200) {
        // The collect won the lock: the cash is in. Either the void was
        // refused (409, nothing voided) or it gave the cash back.
        if (voidedRows === 1)
          expect(await voidChargeCashOut(sale.chargeId)).toEqual([AMOUNT]);
        else expect(voided.status).toBe(409);
      } else {
        // The void won: the collect is refused 409 and no money came in.
        expect(voidedRows).toBe(1);
        expectRefusedAsVoided(collected);
        const row = await chargeRow(sale.chargeId);
        expect(row.status).not.toBe("paid");
        expect(row.cash_movement_id).toBeNull();
        expect(await chargePaidEvents(sale.chargeId)).toBe(0);
        expect(await voidChargeCashOut(sale.chargeId)).toEqual([]);
      }
    }
  });

  it("F2-7 race late qris webhook vs void: whichever wins, the sale is voided and the intent money is refunded once in full", async () => {
    for (let round = 0; round < 4; round += 1) {
      const sale = await saleWithOpenCharge();
      expectAccepted(await collect(sale.chargeId, qrisBody()));
      const intentId = (await chargeRow(sale.chargeId)).payment_intent_id!;
      const approval = await pinApproval({
        orderId: sale.orderId,
        valueIdr: sale.totalIdr,
      });

      const [voided] = await Promise.all([
        pos().correctionVoid(sale.orderId, {
          reason: "customer_cancelled",
          reasonNote: "Pelanggan salah pesan",
          ...approval,
        }),
        settleQris(intentId),
      ]);
      expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);

      expect(await voidRowCount(sale.orderId)).toBe(1);
      // Never the sale voided with the QRIS money kept: it is refunded once,
      // in full (a charge the webhook paid first stays `paid` while its refund
      // is in flight, so its status is not asserted here).
      expect(await liveRefundsOfIntent(intentId)).toEqual([AMOUNT]);
    }
  });

  it("F2-8 customer pays the payment-link QRIS (open qr_link charge) AFTER the POS void: charge is not paid, no charge_paid, one full refund", async () => {
    const sale = await saleWithOpenCharge();
    const linkId = randomUUID();
    const intentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 0, 'seed')`,
      [
        linkId,
        tenant.tenantId,
        tenant.outletId,
        randomBytes(32).toString("hex"),
        `F2-${linkId.slice(0, 8)}`,
        AMOUNT,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key,
          status, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'pending',
               '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
      [
        intentId,
        tenant.tenantId,
        tenant.outletId,
        linkId,
        AMOUNT,
        `f2-${intentId}`,
      ],
    );
    // The charge was published to the guest as a payment link before the void.
    await asOwnerTenant(
      tenant.tenantId,
      (client) =>
        client.query(
          `UPDATE order_issue_charges
           SET route = 'qr_link', status = 'open', payment_link_id = $3,
               payment_link_token_sealed = 'sealed'
           WHERE tenant_id = $1 AND id = $2`,
          [tenant.tenantId, sale.chargeId, linkId],
        ),
      { replica: true },
    );
    await voidFinal(sale);

    await settleQris(intentId);

    const row = await chargeRow(sale.chargeId);
    expect(row.status).not.toBe("paid");
    expect(row.paid_at).toBeNull();
    expect(await chargePaidEvents(sale.chargeId)).toBe(0);
    expect(await liveRefundsOfIntent(intentId)).toEqual([AMOUNT]);
    expect(await chargeJournalEntries(sale.chargeId)).toBe(0);
  });
});
