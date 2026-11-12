// Shared fixtures for the 538-G3 slice A tests (cards xa9bc and knfl6): a fresh
// tenant + legal entity + outlet with the posting roles mapped (including the new
// per-type tax payable roles), POS orders with their tax_snapshots per tax type,
// synthetic order.paid / order.refunded events and journal read helpers.
//
// Not a test file (no .test.ts suffix); imported by
// accounting-tax-split-journal.test.ts and accounting-refund-order-link.test.ts.
//
// Assumptions (the contract is the brief, not the implementation):
// - order.paid / order.refunded keep their payload shape; `pbjtIdr` is the order's
//   TOTAL tax (orders.tax_idr). The consumer splits it per tax type from the
//   order's tax_snapshots (type pbjt / ppn / other) into three payable accounts.
// - New posting roles: tax_payable_ppn and tax_payable_other.
// - journal_entries.order_id (nullable) holds the order id; compared here in
//   either its uuid or ULID text form.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { expect } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { postingAccountRoleSchema } from "@starter/shared/accounting";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverAutoJournalEvent,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

export { createUlid, ulidToUuid };

const short = () => randomUUID().slice(0, 6);
/** Fixed "now" of the consumer; every business instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
export const DAY = "2026-10-15T05:00:00.000Z";
export const BUSINESS_DATE = "2026-10-15";
export const PERIOD = "2026-10";

export type Role =
  | "cash_on_hand"
  | "sales_revenue"
  | "sales_discount"
  | "service_charge"
  | "rounding"
  | "customer_deposit"
  | "gateway_clearing"
  | "edc_clearing"
  | "loyalty_liability"
  | "tax_payable_pbjt"
  | "tax_payable_ppn"
  | "tax_payable_other"
  | "deposit_forfeit_income"
  | "cash_over_short"
  | "bank"
  | "gateway_fee_expense";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  ["gateway_clearing", "1201", "Kliring Gateway", "asset", "current_asset"],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  ["tax_payable_ppn", "2205", "Utang PPN", "liability", "current_liability"],
  [
    "tax_payable_other",
    "2206",
    "Utang Pajak Lainnya",
    "liability",
    "current_liability",
  ],
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

export type TaxType = "pbjt" | "ppn" | "other";

export type Tenant = { id: string; brandId: string };

export type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
  ruleIds: Record<TaxType, string>;
};

export function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

export async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Pajak Per Jenis', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-tx-${id.slice(0, 8)}`,
      JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, id],
  );
  return { id, brandId };
}

/** Owner connection with the tenant GUCs set, for RLS-protected tables. */
export async function asTenant<T>(
  tenant: Tenant,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

/** Entity + outlet + chart with every role mapped + open periods + one published
 *  tax rule per tax type (tax_snapshots reference a rule). Own tenant per world,
 *  so the rules never leak into other tests. */
export async function makeWorld(): Promise<World> {
  const tenant = await makeTenant();
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenant.id, `Entity TX ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet TX', 'Jl. TX', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `TX-${short()}`.toUpperCase(),
    ],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    // A role the shared contract does not know yet (tax_payable_ppn /
    // tax_payable_other before this slice) is left unmapped: mapping it would
    // make the consumer reject every posting, hiding the real failure. The
    // account itself exists, so journal reads still resolve its role.
    if (!postingAccountRoleSchema.safeParse(role).success) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.id, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.id, entity, period],
    );
  const publisher = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Tax split', $2)`,
    [publisher, `${publisher}@example.test`],
  );
  const ruleIds = {} as Record<TaxType, string>;
  for (const [taxType, rateBp] of [
    ["pbjt", 1000],
    ["ppn", 200],
    ["other", 100],
  ] as const) {
    const ruleId = randomUUID();
    ruleIds[taxType] = ruleId;
    await owner.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $7)`,
      [
        ruleId,
        tenant.id,
        `${taxType.toUpperCase()}-${randomBytes(4).toString("hex")}`.toUpperCase(),
        `${taxType} uji`,
        taxType,
        rateBp,
        publisher,
      ],
    );
  }
  return { tenant, entity, outletId, accounts, ruleIds };
}

// ---- orders -----------------------------------------------------------------

export type SnapshotInput = {
  baseIdr: number;
  taxIdr: number;
  rateBp?: number;
};
export type OrderSnapshots = Partial<Record<TaxType, SnapshotInput>>;

export type Sale = {
  grossSalesIdr: number;
  discountIdr?: number;
  /** Snapshots per tax type; the order's tax is their sum. */
  snapshots: OrderSnapshots;
};

export const totalTaxOf = (snapshots: OrderSnapshots): number =>
  Object.values(snapshots).reduce((sum, row) => sum + (row?.taxIdr ?? 0), 0);

export const totalOf = (sale: Sale): number =>
  sale.grossSalesIdr - (sale.discountIdr ?? 0) + totalTaxOf(sale.snapshots);

/** A completed cash-paid POS order and its tax_snapshots (one row per type). */
export async function seedPosOrder(
  world: World,
  orderUlid: string,
  sale: Sale,
): Promise<void> {
  const orderId = ulidToUuid(orderUlid);
  await asTenant(world.tenant, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, $6, 0, $7, 0, $8,
               'completed', $9, now(), 0, NULL)`,
      [
        orderId,
        world.tenant.id,
        world.outletId,
        `TX-${short()}`,
        sale.grossSalesIdr,
        sale.discountIdr ?? 0,
        totalTaxOf(sale.snapshots),
        totalOf(sale),
        BUSINESS_DATE,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderId, world.tenant.id, world.outletId],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
          received_idr, change_idr, points_used, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', NULL, $4, $4, 0, NULL, 'captured', now(), now())`,
      [world.tenant.id, world.outletId, orderId, totalOf(sale)],
    );
  });
  for (const taxType of ["pbjt", "ppn", "other"] as const) {
    const row = sale.snapshots[taxType];
    if (!row) continue;
    await owner.query(
      `INSERT INTO tax_snapshots
         (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id, tax_rule_code,
          tax_rule_version, tax_type, rate_bp, price_includes_tax, gross_idr, tax_base_idr,
          service_charge_idr, tax_idr)
       VALUES ($1, $2, $3, 'order', $4, $5, $6, $7, 1, $8, $9, false, $10, $11, 0, $12)`,
      [
        randomUUID(),
        world.tenant.id,
        world.outletId,
        orderId,
        BUSINESS_DATE,
        world.ruleIds[taxType],
        `${taxType.toUpperCase()}-SNAP`,
        taxType,
        row.rateBp ?? 1000,
        sale.grossSalesIdr,
        row.baseIdr,
        row.taxIdr,
      ],
    );
  }
}

// ---- synthetic events ---------------------------------------------------------

function envelope(
  world: World,
  input: {
    name: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: input.name,
    version: 1,
    aggregateType: "order",
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: DAY,
    actor: { type: "system" },
    idempotencyKey: `tx-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

export function orderPaid(
  world: World,
  orderUlid: string,
  sale: Sale,
): EventEnvelope {
  const total = totalOf(sale);
  return envelope(world, {
    name: "order.paid",
    aggregateId: orderUlid,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: BUSINESS_DATE,
      channel: "pos",
      serviceType: "takeaway",
      grossSalesIdr: sale.grossSalesIdr,
      discountIdr: sale.discountIdr ?? 0,
      serviceChargeIdr: 0,
      pbjtIdr: totalTaxOf(sale.snapshots),
      roundingIdr: 0,
      totalIdr: total,
      paidCashIdr: total,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: total }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: DAY,
    },
  });
}

/** Cash refund of `grossSalesIdr` revenue plus `taxIdr` TOTAL tax. */
export function orderRefunded(
  world: World,
  orderUlid: string,
  refundId: string,
  refund: { grossSalesIdr: number; taxIdr: number },
): EventEnvelope {
  const amount = refund.grossSalesIdr + refund.taxIdr;
  return envelope(world, {
    name: "order.refunded",
    aggregateId: orderUlid,
    payload: {
      orderId: orderUlid,
      outletId: world.outletId,
      businessDate: BUSINESS_DATE,
      refundId,
      amountIdr: amount,
      reason: "customer_request",
      reasonNote: "Pesanan salah",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: refund.grossSalesIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: refund.taxIdr,
      refundCashIdr: amount,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "cash", amountIdr: amount }],
      refundedAt: DAY,
    },
  });
}

export function deliver(
  world: World,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(world.tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

/** Delivers and asserts the posting happened; returns the posted journal id. */
export async function post(
  world: World,
  event: EventEnvelope,
): Promise<string> {
  const result = await deliver(world, event);
  if (result.status === "parked") {
    const parked = await asTenant(world.tenant, (client) =>
      client.query("SELECT * FROM auto_journal_parked WHERE tenant_id = $1", [
        world.tenant.id,
      ]),
    );
    throw new Error(
      `parked ${JSON.stringify(result)} ${JSON.stringify(parked.rows)}`,
    );
  }
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result.journalEntryId;
}

// ---- reads --------------------------------------------------------------------

export type Line = { role: Role; debit: number; credit: number };

/** Lines of one journal summed per role, sorted by role. */
export async function linesOf(world: World, entryId: string): Promise<Line[]> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenant.id, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
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

/** A posted journal always balances: total debit = total credit, and not empty. */
export async function expectBalanced(
  world: World,
  entryId: string,
): Promise<void> {
  const lines = await linesOf(world, entryId);
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

/** Debit minus credit over every journal of the world, per role. */
export async function balanceOf(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts[role]],
  );
  return Number(rows[0]!.balance ?? 0);
}

export async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

export async function sourceTypeOf(
  world: World,
  entryId: string,
): Promise<string> {
  const { rows } = await owner.query<{ source_type: string }>(
    "SELECT source_type FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, entryId],
  );
  return rows[0]!.source_type;
}

/** journal_entries.order_id as text (null when unset). */
export async function orderIdOf(
  world: World,
  entryId: string,
): Promise<string | null> {
  const { rows } = await owner.query<{ order_id: string | null }>(
    "SELECT order_id::text AS order_id FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [world.tenant.id, entryId],
  );
  return rows[0]!.order_id;
}

/** Either text form of an order id (the column may hold uuid or ULID). */
export const orderIdForms = (orderUlid: string): string[] => [
  ulidToUuid(orderUlid),
  orderUlid,
];

/** Role -> net credit (credit minus debit) of a posted journal, zero rows omitted. */
export async function netCreditByRole(
  world: World,
  entryId: string,
): Promise<Partial<Record<Role, number>>> {
  const out: Partial<Record<Role, number>> = {};
  for (const line of await linesOf(world, entryId))
    out[line.role] = line.credit - line.debit;
  return out;
}
