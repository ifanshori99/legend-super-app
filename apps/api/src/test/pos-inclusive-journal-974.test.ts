// Brief 974 card B (legend-npnh), proof 4 through the real auto-journal
// consumer: an inclusive POS sale is paid, its emitted `order.paid` is delivered
// to the accounting consumer, and the journal must balance with revenue = net,
// tax payable = tax collected (never smaller), service correct, posted once.
// A full refund (`order.refunded`) then reverses exactly that sale.
//
// Written from docs/briefs/974-pos-laci-inklusif.md, the shared contract
// (orderPaidPayloadSchema, orderNetSubtotalIdr) and the journal pattern of
// accounting-auto-journal*.test.ts; never from the consumer implementation.
// Fixture: pos-inclusive-bill-974.test.ts (Nasi Goreng Rp30.000 gross, PBJT 10%
// inclusive item rule: tax 2.727, net 27.273).
//
// Flow: the sale is created, paid in cash and completed through the real POS
// routes (device token + open shift, as pos-order-ingest-keys.test.ts); the
// `order.paid` / `order.refunded` envelopes are read back from
// domain_event_outbox (what the POS emitted) and delivered with
// deliverAutoJournalEvent. Nothing about the payload is hand built.
//
// Assumptions (brief silent, also reported):
//  - Journal shape per the existing consumer tests: Dr cash_on_hand = total;
//    Cr sales_revenue, service_charge, tax_payable_pbjt, rounding; a zero part
//    posts no line. Refund mirrors it with Cr cash_on_hand / Dr revenue, tax.
//  - Service charge: the cashier fixture has no service charge rule, so service
//    is 0 here. "Service correct" is asserted as: the journal service line equals
//    the stored order's serviceChargeIdr (no line when 0) and
//    net + service + tax = total. A non-zero service needs a seeded
//    service_charge_rules row whose shape the brief does not give.
//  - The refund is paid out in cash (cash tender), approved by a supervisor PIN
//    override, for the full order total.
//  - "No double": replaying the same envelope, or a re-sent envelope of the same
//    sale with a new event id, posts nothing more.
import { randomUUID } from "node:crypto";
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
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { orderPaidPayloadSchema, type PosReceipt } from "@starter/shared/pos";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  deliverAutoJournalEvent,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

const MEAL_GROSS = 30_000;
const SUPERVISOR_PIN = "582914";

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "edc_clearing"
  | "loyalty_liability"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "sales_discount"
  | "service_charge"
  | "rounding"
  | "deposit_forfeit_income"
  | "cash_over_short"
  | "bank"
  | "gateway_fee_expense";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
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
  ["sales_discount", "4102", "Diskon Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
  [
    "deposit_forfeit_income",
    "4201",
    "Pendapatan DP Hangus",
    "revenue",
    "other_income",
  ],
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
  ["bank", "1103", "Bank Operasional", "asset", "current_asset"],
  [
    "gateway_fee_expense",
    "6109",
    "Biaya Gateway (MDR)",
    "expense",
    "operating_expense",
  ],
];

type World = {
  fx: CashierFixture;
  deviceId: string;
  accounts: Record<Role, string>;
};

const worlds: World[] = [];
/** tenantId:deviceId -> outlet, read by the device resolver. */
const deviceOutlets = new Map<string, string>();

/** Gapless per outlet, idempotent per order (the receipt numbering double). */
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
        deviceId: input.deviceId ?? randomUUID(),
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

beforeAll(() => {
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      deviceOutlets.get(`${tenantId}:${deviceId}`) ?? null,
  );
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  for (const { fx } of worlds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      fx.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

function contextOf(fx: CashierFixture): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

/** An inclusive PBJT 10% item rule for Nasi Goreng (tenant-wide). */
async function addInclusiveMealRule(fx: CashierFixture): Promise<void> {
  await asCashierTenant(fx.tenant.tenantId, (client: PoolClient) =>
    client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $3, 'PB1 10% nett', 'pbjt', 1000, NULL, '[]', $4,
               true, true, true, 1, '2026-01-01', 'published', now(), $5)`,
      [
        randomUUID(),
        fx.tenant.tenantId,
        `PBJT-NETT-${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify({
          itemClasses: [],
          categoryIds: [],
          itemIds: [fx.ids.meal],
        }),
        fx.staff.userId,
      ],
    ),
  );
}

/**
 * A cashier-ready, accounting-ready tenant: till device and open shift for cash,
 * the accounting module with chart, mappings and open fiscal periods.
 */
async function world(
  label: string,
  { inclusive }: { inclusive: boolean },
): Promise<World> {
  const fx = await cashierFixture(label);
  if (inclusive) await addInclusiveMealRule(fx);

  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [
      fx.tenant.roleId,
      JSON.stringify(["shift.cash.operate", "pos.refund.request"]),
    ],
  );
  const deviceId = randomUUID();
  deviceOutlets.set(`${fx.tenant.tenantId}:${deviceId}`, fx.tenant.outletId);
  await registerTestDevice(owner, {
    tenantId: fx.tenant.tenantId,
    outletId: fx.tenant.outletId,
    deviceId,
  });
  await openPosShift(
    contextOf(fx),
    { userId: userIdSchema.parse(fx.staff.userId), deviceId },
    outletIdSchema.parse(fx.tenant.outletId),
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
  );

  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(feature_flags, '{modules}',
              (feature_flags->'modules') || '["accounting"]'::jsonb)
      WHERE id = $1`,
    [fx.tenant.tenantId],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [fx.tenant.tenantId, fx.tenant.legalEntityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [fx.tenant.tenantId, fx.tenant.legalEntityId, role, accounts[role]],
    );
  }
  // The sale is dated now (Jakarta business date): open the months around it.
  const now = new Date();
  for (const offset of [-1, 0, 1]) {
    const month = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
    );
    const period = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [fx.tenant.tenantId, fx.tenant.legalEntityId, period],
    );
  }
  const created: World = { fx, deviceId, accounts };
  worlds.push(created);
  return created;
}

// ---- POS routes (with the till's device token) -----------------------------

function send(w: World, path: string, body: Record<string, unknown>) {
  return w.fx.staff.client
    .post(`${w.fx.base}${path}`)
    .set(w.fx.headers)
    .set(originHeader)
    .set(
      DEVICE_TOKEN_HEADER,
      signDeviceToken({
        version: 1,
        issuedAt: Math.floor(Date.now() / 1000),
        tenantId: w.fx.tenant.tenantId,
        brandId: null,
        deviceId: w.deviceId,
      }),
    )
    .send({ idempotencyKey: randomUUID(), ...body });
}

type StoredOrder = {
  inclusive: boolean;
  subtotalIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
};

async function storedOrder(w: World, orderId: string): Promise<StoredOrder> {
  const { rows } = await owner.query<Record<string, string | boolean>>(
    `SELECT prices_include_tax, subtotal_idr::text, service_charge_idr::text,
            tax_idr::text, rounding_idr::text, total_idr::text
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  const row = rows[0];
  if (!row) throw new Error("order row missing");
  return {
    inclusive: row.prices_include_tax as boolean,
    subtotalIdr: Number(row.subtotal_idr),
    serviceChargeIdr: Number(row.service_charge_idr),
    taxIdr: Number(row.tax_idr),
    roundingIdr: Number(row.rounding_idr),
    totalIdr: Number(row.total_idr),
  };
}

/** Creates, pays in cash and completes a takeaway sale of `quantity` meals. */
async function paidSale(w: World, quantity = 1): Promise<string> {
  const created = await w.fx.post(w.fx.base, {
    channel: "pos",
    serviceType: "takeaway",
    items: [w.fx.line({ quantity })],
    idempotencyKey: randomUUID(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await send(w, `/${orderId}/submit`, {
      expectedStatus: status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await send(w, `/${orderId}/tenders`, {
    method: "cash",
    receivedIdr: totalIdr + 5_000,
    expectedStatus: status,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  status = paid.body.data.order.status as string;
  const completed = await send(w, `/${orderId}/complete`, {
    expectedStatus: status,
  });
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe("completed");
  return orderId;
}

/** A supervisor with a PIN, and the approval of a refund of `valueIdr`. */
async function refundApproval(w: World, orderId: string, valueIdr: number) {
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(w.fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  const client = agent(w.fx.app);
  await signUp(client, "Refund Jurnal Supervisor");
  const session = await client.get("/api/auth/get-session");
  const supervisorUserId = session.body.user.id as string;
  const roleId = randomUUID();
  // The refund ceiling of an approver comes from the named supervisor role
  // (template_key 'supervisor', Rp200.000 per bill, outlet scoped), as in
  // pos-refund-ceilings.test.ts; a custom role without the template key has no
  // authority (REFUND_APPROVAL_LIMIT_EXCEEDED). Every sale here is far below it.
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Refund Uji', true, 'supervisor', $3, false, '["tenant","outlet"]')`,
    [
      roleId,
      w.fx.tenant.tenantId,
      JSON.stringify(["order.view", "pos.refund.approve"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.fx.tenant.tenantId, supervisorUserId, roleId, w.fx.tenant.outletId],
  );
  await setStaffPin(
    context,
    supervisorUserId,
    { outletId: w.fx.tenant.outletId, userId: supervisorUserId },
    { pin: SUPERVISOR_PIN },
  );
  const { override } = await createPosOverride(
    context,
    w.fx.staff.userId,
    {
      outletId: w.fx.tenant.outletId,
      action: "refund",
      valueIdr,
      reason: "Pelanggan komplain",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisorUserId),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisorUserId, overrideId: override.id as string };
}

async function fullRefund(w: World, orderId: string, totalIdr: number) {
  const refunded = await send(w, `/${orderId}/corrections/refund`, {
    reason: "quality_complaint",
    reasonNote: "Makanan salah",
    amountIdr: totalIdr,
    ...(await refundApproval(w, orderId, totalIdr)),
  });
  expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
}

// ---- the emitted events and the consumer -----------------------------------

/** The envelope the POS wrote to the outbox for `name` of this order. */
async function emitted(
  w: World,
  name: "order.paid" | "order.refunded",
  orderId: string,
): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND event->'payload'->>'orderId' = $3`,
    [w.fx.tenant.tenantId, name, orderId],
  );
  expect(rows.length, `${name} emitted`).toBeGreaterThan(0);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

function deliver(w: World, event: EventEnvelope): Promise<AutoJournalResult> {
  const context = contextOf(w.fx);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

async function post(w: World, event: EventEnvelope) {
  const result = await deliver(w, event);
  expect(result, JSON.stringify(result)).toMatchObject({ status: "posted" });
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

type Line = { role: Role; debit: number; credit: number };

async function linesOf(w: World, entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [w.fx.tenant.tenantId, entryId],
  );
  const roleOf = new Map(
    (Object.entries(w.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows
    .map((row) => ({
      role: roleOf.get(row.account_id)!,
      debit: Number(row.debit),
      credit: Number(row.credit),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

const sorted = (lines: Line[]) =>
  [...lines].sort((a, b) => a.role.localeCompare(b.role));

async function expectBalanced(w: World, entryId: string): Promise<void> {
  const lines = await linesOf(w, entryId);
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

/** Debit minus credit over every journal of the tenant, per role. */
async function balanceOf(w: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [w.fx.tenant.tenantId, w.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function journalCount(w: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [w.fx.tenant.tenantId, w.fx.tenant.legalEntityId],
  );
  return Number(rows[0]!.n);
}

const netOf = (order: StoredOrder) =>
  orderNetSubtotalIdr({
    subtotalIdr: order.subtotalIdr,
    serviceChargeIdr: order.serviceChargeIdr,
    taxIdr: order.taxIdr,
    pricesIncludeTax: order.inclusive,
  });

/** The sale journal of a stored cash-paid order: no zero lines. */
function saleLines(order: StoredOrder): Line[] {
  const credits: [Role, number][] = [
    ["sales_revenue", netOf(order)],
    ["service_charge", order.serviceChargeIdr],
    ["tax_payable_pbjt", order.taxIdr],
    ["rounding", order.roundingIdr],
  ];
  return sorted([
    { role: "cash_on_hand", debit: order.totalIdr, credit: 0 },
    ...credits
      .filter(([, amount]) => amount > 0)
      .map(([role, amount]): Line => ({ role, debit: 0, credit: amount })),
  ]);
}

describe("legend-npnh bukti 4: jurnal penjualan inklusif lewat konsumen order.paid", () => {
  it("aj974-a one inclusive meal: Dr cash 30.000 / Cr sales 27.273, tax payable 2.727; balanced; the sale is not taxed again", async () => {
    const w = await world("inc-jrn-a", { inclusive: true });
    const orderId = await paidSale(w);
    const order = await storedOrder(w, orderId);
    expect(order).toMatchObject({
      inclusive: true,
      subtotalIdr: MEAL_GROSS,
      totalIdr: MEAL_GROSS,
      taxIdr: 2_727,
    });

    const result = await post(w, await emitted(w, "order.paid", orderId));
    expect(await linesOf(w, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 30_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 27_273 },
      { role: "tax_payable_pbjt", debit: 0, credit: 2_727 },
    ]);
    await expectBalanced(w, result.journalEntryId);
    // Not 30.000 revenue + 3.000 tax: the 10% is inside the guest price.
    expect(await balanceOf(w, "sales_revenue")).toBe(-27_273);
    expect(await balanceOf(w, "tax_payable_pbjt")).toBe(-2_727);
  });

  it("aj974-b any quantity: revenue = net, tax payable = tax collected (never smaller), service = stored service, balanced", async () => {
    const w = await world("inc-jrn-b", { inclusive: true });
    for (const quantity of [2, 3, 5, 7]) {
      const orderId = await paidSale(w, quantity);
      const order = await storedOrder(w, orderId);
      expect(order.inclusive).toBe(true);
      expect(order.totalIdr).toBe(MEAL_GROSS * quantity);
      // The identity of the bill the journal has to carry.
      expect(netOf(order) + order.serviceChargeIdr + order.taxIdr).toBe(
        order.totalIdr,
      );

      const result = await post(w, await emitted(w, "order.paid", orderId));
      const lines = await linesOf(w, result.journalEntryId);
      expect(lines).toEqual(saleLines(order));
      await expectBalanced(w, result.journalEntryId);

      const credit = (role: Role) =>
        lines.find((line) => line.role === role)?.credit ?? 0;
      expect(credit("sales_revenue")).toBe(netOf(order));
      expect(credit("service_charge")).toBe(order.serviceChargeIdr);
      // Tax payable is at least the exact backed-out share, and not smaller
      // than the tax collected in the price.
      expect(credit("tax_payable_pbjt")).toBeGreaterThanOrEqual(order.taxIdr);
      expect(credit("tax_payable_pbjt")).toBeGreaterThanOrEqual(
        Math.floor((order.totalIdr * 1000) / 11_000),
      );
    }
  });

  it("aj974-c the emitted order.paid is a valid payload with the net as gross sales, the tax and the guest total", async () => {
    const w = await world("inc-jrn-c", { inclusive: true });
    const orderId = await paidSale(w, 3);
    const order = await storedOrder(w, orderId);

    const event = await emitted(w, "order.paid", orderId);
    const parsed = orderPaidPayloadSchema.safeParse(event.payload);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(event.payload).toMatchObject({
      pricesIncludeTax: true,
      grossSalesIdr: netOf(order),
      serviceChargeIdr: order.serviceChargeIdr,
      pbjtIdr: order.taxIdr,
      roundingIdr: order.roundingIdr,
      totalIdr: order.totalIdr,
      paidCashIdr: order.totalIdr,
    });
  });

  it("aj974-d replaying order.paid, or re-sending it with a new event id, posts nothing more", async () => {
    const w = await world("inc-jrn-d", { inclusive: true });
    const orderId = await paidSale(w, 2);
    const event = await emitted(w, "order.paid", orderId);

    const first = await post(w, event);
    expect(await deliver(w, event)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    const resent = eventEnvelopeSchema.parse({
      ...event,
      id: createUlid(),
      idempotencyKey: `resend-${randomUUID()}`,
    });
    expect(await deliver(w, resent)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(w)).toBe(1);
    expect(await balanceOf(w, "sales_revenue")).toBe(
      -netOf(await storedOrder(w, orderId)),
    );
  });

  it("aj974-e regression: an exclusive sale keeps revenue = subtotal and the tax on top (Dr cash 33.000 / Cr 30.000 + 3.000)", async () => {
    const w = await world("inc-jrn-e", { inclusive: false });
    const orderId = await paidSale(w);
    const order = await storedOrder(w, orderId);
    expect(order).toMatchObject({
      inclusive: false,
      subtotalIdr: 30_000,
      taxIdr: 3_000,
      totalIdr: 33_000,
    });

    const result = await post(w, await emitted(w, "order.paid", orderId));
    expect(await linesOf(w, result.journalEntryId)).toEqual([
      { role: "cash_on_hand", debit: 33_000, credit: 0 },
      { role: "sales_revenue", debit: 0, credit: 30_000 },
      { role: "tax_payable_pbjt", debit: 0, credit: 3_000 },
    ]);
    await expectBalanced(w, result.journalEntryId);
  });
});

describe("legend-npnh bukti 4: refund penuh pesanan inklusif", () => {
  it("aj974-f a full refund reverses exactly the sale: Cr cash / Dr net revenue, tax; sale + refund net every role to zero; replay is a no-op", async () => {
    const w = await world("inc-jrn-f", { inclusive: true });
    const orderId = await paidSale(w, 3);
    const order = await storedOrder(w, orderId);
    const sale = await post(w, await emitted(w, "order.paid", orderId));
    await fullRefund(w, orderId, order.totalIdr);

    const refundEvent = await emitted(w, "order.refunded", orderId);
    expect(refundEvent.payload).toMatchObject({
      amountIdr: order.totalIdr,
      grossSalesIdr: netOf(order),
      serviceChargeIdr: order.serviceChargeIdr,
      pbjtIdr: order.taxIdr,
      refundCashIdr: order.totalIdr,
    });

    const refund = await post(w, refundEvent);
    expect(refund.journalEntryId).not.toBe(sale.journalEntryId);
    const reversal = sorted(
      saleLines(order).map((line): Line => ({
        role: line.role,
        debit: line.credit,
        credit: line.debit,
      })),
    );
    expect(await linesOf(w, refund.journalEntryId)).toEqual(reversal);
    await expectBalanced(w, refund.journalEntryId);

    // Tax payable and revenue are fully reversed, never over- or under-stated.
    for (const role of [
      "cash_on_hand",
      "sales_revenue",
      "tax_payable_pbjt",
      "service_charge",
      "rounding",
    ] as const)
      expect(await balanceOf(w, role), role).toBe(0);

    expect(await deliver(w, refundEvent)).toEqual({
      status: "already_posted",
      journalEntryId: refund.journalEntryId,
    });
    // sale + refund
    expect(await journalCount(w)).toBe(2);
  });
});
