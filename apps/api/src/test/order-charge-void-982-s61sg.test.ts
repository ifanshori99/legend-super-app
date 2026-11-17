// legend-s61sg (brief 982, money, "Jangan sampai rugi"): voiding an order whose
// swap charge (`order_issue_charges`) is already `paid`.
//
// Today the void only returns the sale. The paid charge keeps its money (the
// drawer is over, the guest is not repaid) and, when `order_issue.charge_paid`
// is journaled after the void, `aj:order-charge:<chargeId>` parks
// SALE_MISSING for good (docs/DECISIONS.md, "Terbuka" item 6).
//
// Rule (card): voiding an order with a paid charge must, in the SAME
// transaction, refund the charge (the nsvu0 refund path) or reverse it
// (counter-journal). If that cannot be done the void is refused 409 and
// nothing changes (block, never release the money). Void + refund never
// return the charge twice.
//
// Real path: Express app, Better Auth, RBAC, the POS void route
// (`POST /api/outlets/:outletId/pos/orders/:orderId/corrections/void`) and
// PostgreSQL with RLS in a fresh isolated tenant, as pos-order-void-noncash
// .test.ts. Accounting is seeded like accounting-auto-journal-order-charge
// .test.ts; events are delivered to the auto-journal consumer by hand (the
// consumer is not on a timer in tests).
//
// Assumptions (spec silent, repeated in the report):
// - The paid charge is a swap charge collected in cash at the till
//   (cash_movement_id, `order_issue.charge_paid` method pos_cash), on a cash
//   POS sale: the only kind of completed order the POS can void at all.
// - "The money came back" is measured on the drawer: after void the expected
//   cash of the shift moves by the same delta as the void of an identical
//   sale WITHOUT a charge (control), so the test does not depend on how the
//   implementation books the cash return (cash_out, void row, ...).
// - After the void the charge is no longer `paid` (the engineer picks the new
//   status: refunded/reversed/...). Only "not paid" is asserted.
// - "The charge cannot be reversed": the charge was paid by a gateway intent
//   whose money is already fully refunded (completed payment_refunds row), so
//   no refund of the charge is possible. The void must be blocked 409
//   (uang: bila ragu, blok). The order stays completed, no void row, the
//   approval is not consumed.
// - Journal checks: every revenue/tax/cash role nets to 0 after sale + charge
//   + void, no parked row remains for the tenant, every entry is balanced.
// - Isolation: another outlet's path or another tenant's host never voids or
//   touches the order or its charge.

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

function pos(
  who: Member = cashier,
  outletId = tenant.outletId,
  host: { Host: string } = headers,
) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(host)
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
      who.client.get(`${base}/${orderId}`).set(host).set(originHeader),
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
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

async function pinApproval(input: {
  action: "void" | "refund";
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`v982-${randomUUID().slice(0, 6)}`);
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
  });

  // Accounting: module on, chart + mappings + open periods for the outlet's
  // legal entity (same chart as accounting-auto-journal-order-charge).
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
      `V9-${linkId.slice(0, 8)}`,
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
      `v9-cash-${id}`,
      randomBytes(32).toString("hex"),
    ],
  );
  return id;
}

/** The issue foreign key is skipped: the consumers read the charge, not the issue. */
const issueOfCharge = new Map<string, string>();

async function seedPaidCharge(
  orderId: string,
  input: { intentId: string | null; cashMovementId?: string; linkId: string },
): Promise<string> {
  const chargeId = randomUUID();
  const issueId = randomUUID();
  issueOfCharge.set(chargeId, issueId);
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

/** A sale whose swap charge was paid in cash at the till. */
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

function chargePaidEvent(
  orderId: string,
  chargeId: string,
  cashMovementId: string,
): EventEnvelope {
  const definition = qrOrderEvents["order_issue.charge_paid"];
  const issueId = issueOfCharge.get(chargeId) ?? randomUUID();
  const id = createUlid();
  const at = new Date().toISOString();
  return definition.envelopeSchema.parse({
    id,
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: issueId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `v9-charge-${id}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      orderId,
      orderIssueId: issueId,
      chargeId,
      paymentIntentId: null,
      ...CHARGE,
      paidAt: at,
      method: "pos_cash",
      cashMovementId,
    },
  }) as EventEnvelope;
}

// ---- Observers -----------------------------------------------------------------

async function deliver(event: EventEnvelope) {
  const context = contextOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

/** Every outbox event about the order, in order, through the auto-journal consumer. */
async function deliverOutboxOf(orderId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1
       AND (event->>'name' LIKE 'order%' OR event->>'name' = 'payment.refunded')
       AND event::text LIKE $2
     ORDER BY created_at, id`,
    [tenant.tenantId, `%${orderId}%`],
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

async function drawerCash(): Promise<number> {
  const context = contextOf(tenant.tenantId, "session");
  return withTenant(db, context, async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return liveExpectedCashIdr(tx, shift!);
  });
}

async function balanceOf(role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenant.tenantId, accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
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

async function parkedCodesOfCharge(chargeId: string): Promise<string[]> {
  const { rows } = await owner.query<{ error_code: string }>(
    `SELECT error_code FROM auto_journal_parked
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant.tenantId, `aj:order-charge:${chargeId}`],
  );
  return rows.map((row) => row.error_code);
}

async function chargeStatus(chargeId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, chargeId],
  );
  return rows[0]!.status;
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

/**
 * What a void of a plain cash sale does to the drawer: the control for "the
 * charge money came back too".
 */
async function controlVoidDelta(): Promise<number> {
  const before = await drawerCash();
  const sale = await completedCashSale();
  const { response } = await voidOrder(sale);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return (await drawerCash()) - before;
}

async function expectRolesNetZero(): Promise<void> {
  for (const role of [
    "cash_on_hand",
    "sales_revenue",
    "service_charge",
    "tax_payable_pbjt",
  ] as const)
    expect(await balanceOf(role), `net of ${role}`).toBe(0);
}

// ============================================================================

describe("legend-s61sg void of an order whose swap charge is paid", () => {
  it("VOID-CHG-1 void with a paid cash charge: 200, the charge is no longer paid, the drawer returns sale AND charge, the charge journal is reversed, nothing is parked", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();
    await postSale(sale.orderId);
    const paidEvent = chargePaidEvent(
      sale.orderId,
      sale.chargeId,
      sale.cashMovementId,
    );
    const posted = await deliver(paidEvent);
    expect(posted.status, JSON.stringify(posted)).toBe("posted");
    expect(await drawerCash()).toBe(before + sale.totalIdr + CHARGE.amountIdr);

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await voidRowCount(sale.orderId)).toBe(1);
    expect(await approvalUses(approval.overrideId)).toBe(1);

    // Same transaction as the void: the charge is already closed when the
    // void answers (no event delivery in between).
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");
    expect((await drawerCash()) - before).toBe(control);

    await deliverOutboxOf(sale.orderId);
    await sweep();
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
    expect(await parkedCount()).toBe(0);
    // Replay of the same event posts nothing new and stays reversed.
    await deliver(paidEvent);
    await sweep();
    await expectRolesNetZero();
    expect(await parkedCount()).toBe(0);
  });

  it("VOID-CHG-2 charge_paid reaches the journal AFTER the void: it never parks SALE_MISSING, revenue nets to 0", async () => {
    const sale = await saleWithCashCharge();
    await postSale(sale.orderId);

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    await deliverOutboxOf(sale.orderId);

    // The late charge event (the very case DECISIONS.md lists as open).
    await deliver(
      chargePaidEvent(sale.orderId, sale.chargeId, sale.cashMovementId),
    );
    await sweep();
    expect(await parkedCodesOfCharge(sale.chargeId)).toEqual([]);
    expect(await parkedCount()).toBe(0);
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
  });

  it("VOID-CHG-3 void then replay and POS refund of the same order: the charge is returned once, the drawer is never over- or under-returned", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();
    await postSale(sale.orderId);
    await deliver(
      chargePaidEvent(sale.orderId, sale.chargeId, sale.cashMovementId),
    );

    const first = await voidOrder(sale);
    expect(
      first.response.status,
      JSON.stringify(first.response.body),
    ).toBeLessThan(300);
    expect((await drawerCash()) - before).toBe(control);

    // A second void and a refund of the already voided order are refused.
    const again = await voidOrder(sale);
    expect(again.response.status).toBeGreaterThanOrEqual(400);
    const refundApproval = await pinApproval({
      action: "refund",
      orderId: sale.orderId,
      valueIdr: KOPI_IDR,
    });
    const refund = await pos().refund(sale.orderId, {
      reason: "quality_complaint",
      reasonNote: "Minuman tumpah",
      amountIdr: KOPI_IDR,
      ...refundApproval,
    });
    expect(refund.status).toBeGreaterThanOrEqual(400);
    expect(refund.status).toBeLessThan(500);

    expect((await drawerCash()) - before).toBe(control);
    expect(await voidRowCount(sale.orderId)).toBe(1);
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");

    await deliverOutboxOf(sale.orderId);
    await sweep();
    await expectRolesNetZero();
    expect(await unbalancedEntries()).toBe(0);
  });

  it("VOID-CHG-4 a charge that cannot be reversed blocks the void: 409, order stays completed, no void row, approval unused, charge and drawer untouched", async () => {
    const sale = await completedCashSale();
    const linkId = await seedLink(CHARGE.amountIdr);
    // Paid by EDC card: no payment intent and no drawer cash, so the till can
    // return it neither as a refund nor as cash. (A gateway charge whose intent
    // is already fully refunded is skipped instead: order-charge-fix-982-B.)
    const chargeId = await seedPaidCharge(sale.orderId, {
      intentId: null,
      linkId,
    });
    const before = await drawerCash();

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBe(409);

    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await approvalUses(approval.overrideId)).toBe(0);
    expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
    expect(await chargeStatus(chargeId)).toBe("paid");
    expect(await drawerCash()).toBe(before);
  });

  it("VOID-CHG-5 isolation: voiding one order closes only its own charge; another order's paid charge, cash and journal stay", async () => {
    const mine = await saleWithCashCharge();
    const other = await saleWithCashCharge();
    await postSale(mine.orderId);
    await postSale(other.orderId);
    await deliver(
      chargePaidEvent(mine.orderId, mine.chargeId, mine.cashMovementId),
    );
    await deliver(
      chargePaidEvent(other.orderId, other.chargeId, other.cashMovementId),
    );
    const cashBefore = await balanceOf("cash_on_hand");

    const { response } = await voidOrder(mine);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    await deliverOutboxOf(mine.orderId);
    await sweep();

    expect(await chargeStatus(mine.chargeId)).not.toBe("paid");
    expect(await chargeStatus(other.chargeId)).toBe("paid");
    expect(
      (await pos().get(other.orderId)).body.data.status,
      "the other order is untouched",
    ).toBe("completed");
    // The cash ledger gave back exactly my sale + my charge, not the other's.
    expect(await balanceOf("cash_on_hand")).toBe(
      cashBefore - mine.totalIdr - CHARGE.amountIdr,
    );
  });

  it("VOID-CHG-6 isolation: another outlet's path and another tenant's host cannot void the order; then the right void closes the charge", async () => {
    const control = await controlVoidDelta();
    const beforeSale = await drawerCash();
    const sale = await saleWithCashCharge();
    await postSale(sale.orderId);
    await deliver(
      chargePaidEvent(sale.orderId, sale.chargeId, sale.cashMovementId),
    );
    const before = await drawerCash();
    expect(before).toBe(beforeSale + sale.totalIdr + CHARGE.amountIdr);

    const otherOutlet = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Kedua Uji', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE id = $3 AND tenant_id = $4`,
      [
        otherOutlet,
        `V2-${randomUUID().slice(0, 6)}`.toUpperCase(),
        tenant.outletId,
        tenant.tenantId,
      ],
    );
    const stranger = await createIsolatedTenant(
      `v982x-${randomUUID().slice(0, 6)}`,
    );

    const approval = await pinApproval({
      action: "void",
      orderId: sale.orderId,
      valueIdr: sale.totalIdr,
    });
    const body = {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      ...approval,
    };
    const wrongOutlet = await pos(cashier, otherOutlet).correctionVoid(
      sale.orderId,
      body,
    );
    expect(wrongOutlet.status).toBeGreaterThanOrEqual(400);
    expect(wrongOutlet.status).toBeLessThan(500);
    const wrongTenant = await pos(cashier, tenant.outletId, {
      Host: stranger.hostname,
    }).correctionVoid(sale.orderId, body);
    expect(wrongTenant.status).toBeGreaterThanOrEqual(400);
    expect(wrongTenant.status).toBeLessThan(500);

    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await chargeStatus(sale.chargeId)).toBe("paid");
    expect(await drawerCash()).toBe(before);

    // The legitimate void still works and now returns the charge as well.
    const right = await pos().correctionVoid(sale.orderId, body);
    expect(right.status, JSON.stringify(right.body)).toBeLessThan(300);
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");
    expect((await drawerCash()) - beforeSale).toBe(control);
  });
});
