// legend-uctlr: an `order.paid` / `order.voided` ingested from an edge node
// must leave the same accounting trail as a cloud sale: a balanced sales
// journal (exactly once), PBJT rows in tax_snapshots, loyalty points for the
// order's customer, a single reversal on void. Written from
// docs/briefs/656-edge-sales-gl-design.md ("Test gagal-dulu" + design items
// 1-5), never from the implementation.
//
// Assumptions where the brief is silent (also reported):
//  - the sales journal is read through `journal_entries` / `journal_lines`
//    (source_type 'sale', key `aj:sale:<orderId>`; a void is a 'reversal'
//    entry whose `reversal_of` is the sale entry). Money is asserted per
//    posting role as a NET (debit - credit) so the test does not depend on how
//    a discount is laid out (contra debit vs net revenue).
//  - a payload with missing `taxes`, or `taxes` whose sum differs from
//    `pbjtIdr`, is still ingested (no snapshots, all tax to PBJT, warn log).
//  - a void arriving before its paid event is `order_not_ingested` and writes
//    nothing; a NEW void event (next sequence) after the paid event is applied.
//  - voids with EDC/points money are not journaled by the cloud consumer, so
//    the void tests use cash-only sales (the sale-void rule of the cloud).
//  - a training sale (`isTraining`) posts no journal, like a cloud one.
//  - no redemption happens offline: a points tender writes no `redeem` row.
//  - `customerProfileId` of another tenant is never stored on the order and
//    earns nothing in either tenant.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
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
import { postingAccountRoleSchema } from "@starter/shared/accounting";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
import { isTransientReason } from "../edge/order-ingest.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  NOW,
  contextOf,
  deliver as deliverLoyaltyDirect,
  orderPaidEvent as loyaltyPaidEvent,
  seedMember,
  seedOrder as seedLoyaltyOrder,
  seedProgram,
} from "./member-loyalty-helpers";

const T = 60_000;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const outletA = randomUUID();
const brandId = randomUUID();
const entityId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const deviceId = randomUUID();
let node: AuthenticatedEdgeNode;
let member: { id: string; userId: string };
let otherMember: { id: string; userId: string };
const rules = { pbjt: randomUUID(), ppn: randomUUID() };

const scopeOf = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

/** Owner query under the tenant's RLS scope. */
async function q<T extends object>(
  text: string,
  params: unknown[] = [],
  tenant: string = tenantId,
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await client.query<T>(text, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function n(
  text: string,
  params: unknown[] = [],
  tenant: string = tenantId,
): Promise<number> {
  const rows = await q<{ n: number }>(text, params, tenant);
  return rows[0]!.n;
}

// ---- accounting fixture (chart of accounts, mappings, periods, tax rules) ----

type Role =
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
const accounts = {} as Record<Role, string>;

async function createFixture() {
  for (const [id, name] of [
    [tenantId, "Tenant Edge GL"],
    [otherTenantId, "Tenant Edge GL Lain"],
  ] as const)
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, $5, plan, 'active', deployment_mode, feature_flags, limits, $3
         FROM tenants WHERE id = $4`,
      [
        id,
        `edge-gl-${randomBytes(4).toString("hex")}`,
        actor,
        cafeLegendPlatformFixtures.tenant.id,
        name,
      ],
    );
  // The consumers read the tenant's modules: make sure accounting and loyalty are on.
  await owner.query(
    `UPDATE tenants
        SET feature_flags = jsonb_set(
              feature_flags, '{modules}',
              (SELECT coalesce(jsonb_agg(DISTINCT m), '[]'::jsonb)
                 FROM jsonb_array_elements_text(
                        coalesce(feature_flags->'modules', '[]'::jsonb) || '["accounting","loyalty"]'::jsonb) m),
              true)
      WHERE id = ANY($1::uuid[])`,
    [[tenantId, otherTenantId]],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `edge-gl-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji GL', false)`,
    [entityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'GL-01', 'GL-01', 'Jl. Uji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletA, tenantId, brandId, entityId],
  );
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    if (!postingAccountRoleSchema.safeParse(role).success) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entityId, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entityId, period],
    );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Kasir GL', $2)`,
    [cashierId, `${cashierId}@example.test`],
  );
  for (const [taxType, rateBp] of [
    ["pbjt", 1000],
    ["ppn", 200],
  ] as const)
    await owner.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $7)`,
      [
        rules[taxType],
        tenantId,
        `${taxType.toUpperCase()}-EDGE`,
        `${taxType} edge`,
        taxType,
        rateBp,
        cashierId,
      ],
    );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Edge GL', 0)`,
    [categoryId, tenantId, brandId],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
    [menuItemId, tenantId, brandId, categoryId, randomUUID()],
  );
  // Loyalty: one program per tenant, one active member each.
  await seedProgram(tenantId, { earnSpendIdr: 1000, earnPoints: 1 });
  await seedProgram(otherTenantId, { earnSpendIdr: 1000, earnPoints: 1 });
  member = await seedMember(tenantId);
  otherMember = await seedMember(otherTenantId);
}

// ---- events ------------------------------------------------------------------

let clock = Date.parse("2026-11-14T09:00:00.000Z");
let numberSeq = 0;
const nextNumber = () => `GL-${String(++numberSeq).padStart(5, "0")}`;

type Payload = Record<string, unknown>;

function envelope(
  name: string,
  aggregateId: string,
  sequence: number,
  payload: Payload,
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  };
}

// A business date in the past, inside the open fiscal periods above.
const BUSINESS_DATE = "2026-10-15";
const PAID_AT = "2026-10-15T05:00:00.000Z";
const VOIDED_AT = "2026-10-15T07:00:00.000Z";

function lines(): Payload[] {
  const base = {
    menuItemId,
    fireStatus: "fired",
    reservedBusinessDate: BUSINESS_DATE,
  };
  return [
    {
      ...base,
      name: "Kopi Susu",
      quantity: 2,
      unitPriceIdr: 25000,
      modifiersTotalIdr: 0,
      lineTotalIdr: 50000,
      status: "served",
    },
    {
      ...base,
      name: "Roti Bakar",
      quantity: 1,
      unitPriceIdr: 20000,
      modifiersTotalIdr: 5000,
      lineTotalIdr: 25000,
      status: "served",
    },
  ];
}

type TaxRow = {
  taxRuleId: string;
  code: string;
  version: number;
  taxType: "pbjt" | "ppn";
  rateBp: number;
  priceIncludesTax: boolean;
  grossIdr: number;
  taxBaseIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
};

const pbjtRow = (over: Partial<TaxRow> = {}): TaxRow => ({
  taxRuleId: rules.pbjt,
  code: "PBJT-EDGE",
  version: 1,
  taxType: "pbjt",
  rateBp: 1000,
  priceIncludesTax: false,
  grossIdr: 75000,
  taxBaseIdr: 70000,
  serviceChargeIdr: 0,
  taxIdr: 7000,
  ...over,
});

const ppnRow = (over: Partial<TaxRow> = {}): TaxRow => ({
  taxRuleId: rules.ppn,
  code: "PPN-EDGE",
  version: 1,
  taxType: "ppn",
  rateBp: 200,
  priceIncludesTax: false,
  grossIdr: 75000,
  taxBaseIdr: 70000,
  serviceChargeIdr: 0,
  taxIdr: 2000,
  ...over,
});

/**
 * Subtotal 75000, discount 5000, PBJT 7000 on top, total 77000 =
 * cash 50000 + EDC 20000 + points 7000. `taxes` carries the PBJT row.
 */
function paidPayload(orderId: string, over: Payload = {}): Payload {
  return {
    orderId,
    outletId: outletA,
    businessDate: BUSINESS_DATE,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: nextNumber(),
    subtotalIdr: 75000,
    pricesIncludeTax: false,
    paymentMode: "pay_first",
    isTraining: false,
    grossSalesIdr: 75000,
    discountIdr: 5000,
    serviceChargeIdr: 0,
    pbjtIdr: 7000,
    roundingIdr: 0,
    totalIdr: 77000,
    paidCashIdr: 50000,
    paidGatewayIdr: 0,
    paidEdcIdr: 20000,
    paidPointsIdr: 7000,
    paidDepositIdr: 0,
    tenders: [
      { method: "cash", amountIdr: 50000, receivedIdr: 100000 },
      { method: "edc_card", amountIdr: 20000 },
      { method: "points", amountIdr: 7000, pointsUsed: 70 },
    ],
    shiftId: null,
    cashierId,
    deviceId,
    paidAt: PAID_AT,
    lines: lines(),
    taxes: [pbjtRow()],
    ...over,
  };
}

/** The same sale paid in cash only (what a void can journal back). */
function cashSale(orderId: string, over: Payload = {}): Payload {
  return paidPayload(orderId, {
    paidCashIdr: 77000,
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    tenders: [{ method: "cash", amountIdr: 77000, receivedIdr: 100000 }],
    ...over,
  });
}

/** Cash + EDC sale without any tax: total 70000. No `taxes` key. */
function noTaxSale(orderId: string, over: Payload = {}): Payload {
  const rest = paidPayload(orderId, {
    pbjtIdr: 0,
    totalIdr: 70000,
    paidCashIdr: 50000,
    paidEdcIdr: 20000,
    paidPointsIdr: 0,
    tenders: [
      { method: "cash", amountIdr: 50000, receivedIdr: 50000 },
      { method: "edc_card", amountIdr: 20000 },
    ],
  });
  delete rest.taxes;
  return { ...rest, ...over };
}

function paidEvent(
  orderId: string,
  payload: Payload = paidPayload(orderId),
  sequence = 1,
): EventEnvelope {
  return envelope("order.paid", orderId, sequence, payload);
}

function voidedEvent(
  orderId: string,
  sequence: number,
  over: Payload = {},
  amountIdr = 77000,
): EventEnvelope {
  return envelope("order.voided", orderId, sequence, {
    orderId,
    outletId: outletA,
    businessDate: BUSINESS_DATE,
    amountIdr,
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    requestedBy: cashierId,
    approvedBy: supervisorId,
    overrideId: createUlid(++clock),
    approvalRequestId: null,
    voidedFinalOrder: true,
    voidId: randomUUID(),
    receiptNumber: "POS1-000042",
    voidedAt: VOIDED_AT,
    ...over,
  });
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

/** One receive batch through the real link (the apply transaction). */
async function deliver(events: EventEnvelope[]) {
  const link = store();
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

/**
 * The edge resends an event the cloud already holds (ack lost): drop the
 * cloud's receipt of it, then deliver it again. Parked row stays.
 */
async function redeliver(event: EventEnvelope) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND event_id = $2::uuid`,
        [tenantId, ulidToUuid(event.id)],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await deliver([event]);
}

// ---- reads -------------------------------------------------------------------

const dbId = (orderId: string) => ulidToUuid(orderId);

async function cloudOrders(orderId: string) {
  return n(
    "SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, dbId(orderId)],
  );
}

type IngestRow = { state: string; reason: string | null };
async function ingestOf(orderId: string): Promise<IngestRow | undefined> {
  const rows = await q<IngestRow>(
    `SELECT state, reason FROM edge_order_ingests
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
  return rows[0];
}

async function parkedRowsOf(event: EventEnvelope) {
  return n(
    `SELECT count(*)::int AS n FROM edge_deferred_events
      WHERE tenant_id = $1 AND event_name = $2 AND aggregate_id = $3`,
    [tenantId, event.name, event.aggregateId],
  );
}

async function voidRowCount(orderId: string) {
  return n(
    "SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2::uuid",
    [tenantId, dbId(orderId)],
  );
}

async function orderCustomer(
  orderId: string,
  tenant = tenantId,
): Promise<string | null | undefined> {
  const rows = await q<{ customer: string | null }>(
    "SELECT customer_profile_id::text AS customer FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant, dbId(orderId)],
    tenant,
  );
  return rows[0] ? rows[0].customer : undefined;
}

/** Sale journal entries of an order (key `aj:sale:<orderId>`, ULID or UUID form). */
async function saleEntries(orderId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT id::text AS id FROM journal_entries
      WHERE tenant_id = $1 AND source_type = 'sale'
        AND (idempotency_key = ANY($2::text[]) OR order_id::text = ANY($3::text[]))`,
    [
      tenantId,
      [`aj:sale:${orderId}`, `aj:sale:${dbId(orderId)}`],
      [orderId, dbId(orderId)],
    ],
  );
  return rows.map((row) => row.id);
}

/** Reversal entries that reverse the given sale entries. */
async function reversalEntries(saleIds: string[]): Promise<string[]> {
  if (saleIds.length === 0) return [];
  const rows = await q<{ id: string }>(
    `SELECT id::text AS id FROM journal_entries
      WHERE tenant_id = $1 AND source_type = 'reversal' AND reversal_of = ANY($2::uuid[])`,
    [tenantId, saleIds],
  );
  return rows.map((row) => row.id);
}

type Net = Partial<Record<Role, { debit: number; credit: number }>>;

/** Debit and credit per posting role over the given entries. */
async function linesOf(entryIds: string[]): Promise<Net> {
  const rows = await q<{ account_id: string; debit: string; credit: string }>(
    `SELECT account_id::text AS account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])
      GROUP BY account_id`,
    [tenantId, entryIds],
  );
  const roleOf = new Map(
    (Object.entries(accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  const out: Net = {};
  for (const row of rows)
    out[roleOf.get(row.account_id)!] = {
      debit: Number(row.debit),
      credit: Number(row.credit),
    };
  return out;
}

const debitOf = (net: Net, role: Role) => net[role]?.debit ?? 0;
const creditOf = (net: Net, role: Role) => net[role]?.credit ?? 0;
const netDebit = (net: Net, role: Role) =>
  debitOf(net, role) - creditOf(net, role);
const sumNetDebit = (net: Net, roles: Role[]) =>
  roles.reduce((sum, role) => sum + netDebit(net, role), 0);
const totalDebit = (net: Net) =>
  Object.values(net).reduce((sum, line) => sum + line!.debit, 0);
const totalCredit = (net: Net) =>
  Object.values(net).reduce((sum, line) => sum + line!.credit, 0);

const REVENUE_ROLES: Role[] = [
  "sales_revenue",
  "sales_discount",
  "service_charge",
  "rounding",
];
const SETTLEMENT_ROLES: Role[] = [
  "cash_on_hand",
  "edc_clearing",
  "gateway_clearing",
  "loyalty_liability",
  "customer_deposit",
];

async function journalCount(tenant = tenantId) {
  return n(
    "SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1",
    [tenant],
    tenant,
  );
}

async function parkedJournals(tenant = tenantId) {
  return n(
    "SELECT count(*)::int AS n FROM auto_journal_parked WHERE tenant_id = $1",
    [tenant],
    tenant,
  );
}

type SnapshotRow = {
  outlet_id: string;
  business_date: string;
  tax_rule_id: string;
  tax_rule_code: string;
  tax_rule_version: number;
  tax_type: string;
  rate_bp: number;
  price_includes_tax: boolean;
  gross: number;
  base: number;
  service: number;
  tax: number;
};

async function snapshotsOf(orderId: string, tenant = tenantId) {
  return q<SnapshotRow>(
    `SELECT outlet_id::text AS outlet_id, business_date::text AS business_date,
            tax_rule_id::text AS tax_rule_id, tax_rule_code, tax_rule_version, tax_type,
            rate_bp, price_includes_tax, gross_idr::int AS gross, tax_base_idr::int AS base,
            service_charge_idr::int AS service, tax_idr::int AS tax
       FROM tax_snapshots
      WHERE tenant_id = $1 AND source_type = 'order' AND source_id = $2::uuid
      ORDER BY tax_type`,
    [tenant, dbId(orderId)],
    tenant,
  );
}

const snapshotOfRow = (row: TaxRow): SnapshotRow => ({
  outlet_id: outletA,
  business_date: BUSINESS_DATE,
  tax_rule_id: row.taxRuleId,
  tax_rule_code: row.code,
  tax_rule_version: row.version,
  tax_type: row.taxType,
  rate_bp: row.rateBp,
  price_includes_tax: row.priceIncludesTax,
  gross: row.grossIdr,
  base: row.taxBaseIdr,
  service: row.serviceChargeIdr,
  tax: row.taxIdr,
});

async function snapshotCount(tenant = tenantId) {
  return n(
    "SELECT count(*)::int AS n FROM tax_snapshots WHERE tenant_id = $1",
    [tenant],
    tenant,
  );
}

type EarnRow = { state: string; booked: number; reversed: number };
async function earnOf(orderId: string, tenant = tenantId) {
  const rows = await q<EarnRow>(
    `SELECT state, booked_points::int AS booked, reversed_points::int AS reversed
       FROM point_earn_records WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant, dbId(orderId)],
    tenant,
  );
  return rows;
}

async function ledgerCount(
  profileId: string,
  type?: string,
  tenant = tenantId,
) {
  return n(
    `SELECT count(*)::int AS n FROM point_ledger
      WHERE tenant_id = $1 AND customer_profile_id = $2::uuid AND ($3::text IS NULL OR type = $3)`,
    [tenant, profileId, type ?? null],
    tenant,
  );
}

async function balanceOf(profileId: string, tenant = tenantId) {
  return n(
    "SELECT points_balance::int AS n FROM customer_profiles WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant, profileId],
    tenant,
  );
}

async function earnCount(tenant = tenantId) {
  return n(
    "SELECT count(*)::int AS n FROM point_earn_records WHERE tenant_id = $1",
    [tenant],
    tenant,
  );
}

// ---- lifecycle ---------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Edge GL",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerOrderEdgeApplier(); // after the POS registration, as runtime.ts does
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "edge_order_ingests",
      "pos_order_voids",
      "pos_order_tenders",
      "pos_order_items",
      "order_items",
      "order_events",
      "pos_orders",
      "orders",
      "menu_items",
      "menu_categories",
      "edge_deferred_events",
      "domain_event_outbox",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      [tenantId, otherTenantId],
    ]);
    await client.query('DELETE FROM "user" WHERE id = $1', [cashierId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

// ---- fixture sanity (these two must PASS on the current code) -----------------

describe("legend-uctlr fixture sanity: the cloud consumers work in this fixture", () => {
  it(
    "legend-uctlr sanity: the auto-journal consumer posts a balanced sale for a seeded cloud order",
    async () => {
      const orderUlid = createUlid(++clock);
      const id = dbId(orderUlid);
      await q(
        `INSERT INTO orders
           (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
            subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
            status, business_date, placed_at, deposit_applied_idr)
         VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 70000, 0, 0, 0, 0, 70000,
                 'completed', $5, now(), 0)`,
        [
          id,
          tenantId,
          outletA,
          `SAN-${randomBytes(3).toString("hex")}`,
          BUSINESS_DATE,
        ],
      );
      await q(
        `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
         VALUES ($1, $2, $3, 'pos', now(), now())`,
        [id, tenantId, outletA],
      );
      await q(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, payment_intent_id, amount_idr,
            received_idr, change_idr, points_used, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'cash', 'manual', NULL, 70000, 70000, 0, NULL, 'captured', now(), now())`,
        [tenantId, outletA, id],
      );
      const event = eventEnvelopeSchema.parse({
        id: createUlid(++clock),
        tenantId,
        outletId: outletA,
        name: "order.paid",
        version: 1,
        aggregateType: "order",
        aggregateId: orderUlid,
        sequence: 1,
        occurredAt: PAID_AT,
        actor: { type: "system" },
        idempotencyKey: `san-${orderUlid}`,
        payloadSchemaRef: "order.paid.v1",
        payload: {
          orderId: orderUlid,
          outletId: outletA,
          businessDate: BUSINESS_DATE,
          channel: "pos",
          serviceType: "takeaway",
          grossSalesIdr: 70000,
          discountIdr: 0,
          serviceChargeIdr: 0,
          pbjtIdr: 0,
          roundingIdr: 0,
          totalIdr: 70000,
          paidCashIdr: 70000,
          paidGatewayIdr: 0,
          paidEdcIdr: 0,
          paidPointsIdr: 0,
          tenders: [{ method: "cash", amountIdr: 70000 }],
          shiftId: null,
          cashierId: null,
          deviceId: null,
          paidAt: PAID_AT,
        },
      });
      const context = contextOf(tenantId);
      const result = await withTenant(db, context, (tx) =>
        deliverAutoJournalEvent(context, event, tx, NOW),
      );
      expect(result.status).toBe("posted");
      const entries = await saleEntries(orderUlid);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(totalDebit(net)).toBeGreaterThan(0);
      expect(totalDebit(net)).toBe(totalCredit(net));
      expect(netDebit(net, "cash_on_hand")).toBe(70000);
    },
    T,
  );

  it(
    "legend-uctlr sanity: the loyalty consumer earns points for a seeded order with a member",
    async () => {
      const orderUlid = await seedLoyaltyOrder(tenantId, {
        outletId: outletA,
        profileId: member.id,
        cashierId,
        grossSalesIdr: 70000,
        businessDate: BUSINESS_DATE,
      });
      const world = { tenantId, context: contextOf(tenantId) };
      await deliverLoyaltyDirect(
        world,
        loyaltyPaidEvent(world, {
          orderUlid,
          outletId: outletA,
          grossSalesIdr: 70000,
          cashierId,
          paidAt: PAID_AT,
          businessDate: BUSINESS_DATE,
        }),
      );
      const rows = await earnOf(orderUlid);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("booked");
      expect(rows[0]!.booked).toBeGreaterThan(0);
    },
    T,
  );
});

// ---- paid: journal + PBJT ------------------------------------------------------

describe("legend-uctlr order.paid posts the sales journal", () => {
  it(
    "legend-uctlr a sale without tax posts one balanced journal that equals the order total",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([paidEvent(orderId, noTaxSale(orderId))]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      const entries = await saleEntries(orderId);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(totalDebit(net)).toBe(totalCredit(net));
      // Money in = order total (70000), per tender bucket.
      expect(netDebit(net, "cash_on_hand")).toBe(50000);
      expect(netDebit(net, "edc_clearing")).toBe(20000);
      expect(sumNetDebit(net, SETTLEMENT_ROLES)).toBe(70000);
      // Revenue side (net of discount) = total, no tax.
      expect(-sumNetDebit(net, REVENUE_ROLES)).toBe(70000);
      expect(creditOf(net, "tax_payable_pbjt")).toBe(0);
      expect(await snapshotsOf(orderId)).toEqual([]);
      expect(await parkedJournals()).toBe(0);
    },
    T,
  );

  it(
    "legend-uctlr a taxed sale with cash, EDC and points: journal total = order total, PBJT payable = pbjtIdr, tax_snapshots = payload taxes",
    async () => {
      const orderId = createUlid(++clock);
      const payload = paidPayload(orderId);
      await deliver([paidEvent(orderId, payload)]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      const entries = await saleEntries(orderId);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(totalDebit(net)).toBe(totalCredit(net));
      expect(netDebit(net, "cash_on_hand")).toBe(50000);
      expect(netDebit(net, "edc_clearing")).toBe(20000);
      expect(netDebit(net, "loyalty_liability")).toBe(7000);
      expect(sumNetDebit(net, SETTLEMENT_ROLES)).toBe(77000);
      expect(-netDebit(net, "tax_payable_pbjt")).toBe(7000);
      // Revenue net of discount = total - tax.
      expect(-sumNetDebit(net, REVENUE_ROLES)).toBe(70000);
      // Nothing is parked silently.
      expect(await parkedJournals()).toBe(0);

      // The rows the cloud would have written for the same order.
      expect(await snapshotsOf(orderId)).toEqual([snapshotOfRow(pbjtRow())]);
      // The journal belongs to the order's outlet and entity.
      const entry = await q<{ outlet_id: string; legal_entity_id: string }>(
        "SELECT outlet_id::text AS outlet_id, legal_entity_id::text AS legal_entity_id FROM journal_entries WHERE tenant_id = $1 AND id = $2::uuid",
        [tenantId, entries[0]],
      );
      expect(entry).toEqual([
        { outlet_id: outletA, legal_entity_id: entityId },
      ]);
    },
    T,
  );

  it(
    "legend-uctlr a sale with PBJT and PPN splits the tax payable per type and keeps one snapshot per rule",
    async () => {
      const orderId = createUlid(++clock);
      const taxes = [pbjtRow({ taxIdr: 5000 }), ppnRow({ taxIdr: 2000 })];
      await deliver([paidEvent(orderId, paidPayload(orderId, { taxes }))]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      const entries = await saleEntries(orderId);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(totalDebit(net)).toBe(totalCredit(net));
      expect(-netDebit(net, "tax_payable_pbjt")).toBe(5000);
      expect(-netDebit(net, "tax_payable_ppn")).toBe(2000);
      expect(await snapshotsOf(orderId)).toEqual(
        taxes
          .map(snapshotOfRow)
          .sort((a, b) => a.tax_type.localeCompare(b.tax_type)),
      );
    },
    T,
  );

  it(
    "legend-uctlr a training sale posts no journal, like a cloud training sale",
    async () => {
      const orderId = createUlid(++clock);
      const before = await journalCount();
      await deliver([
        paidEvent(orderId, noTaxSale(orderId, { isTraining: true })),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await saleEntries(orderId)).toEqual([]);
      expect(await journalCount()).toBe(before);
      expect(await parkedJournals()).toBe(0);
    },
    T,
  );
});

describe("legend-uctlr bad tax rows never lose the sale", () => {
  it(
    "legend-uctlr PBJT without tax rows is ingested without snapshots and the journal books all tax to PBJT",
    async () => {
      const orderId = createUlid(++clock);
      const withoutTaxes = paidPayload(orderId);
      delete withoutTaxes.taxes;
      const event = paidEvent(orderId, withoutTaxes);
      const before = await snapshotCount();

      await deliver([event]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await cloudOrders(orderId)).toBe(1);
      expect(await snapshotsOf(orderId)).toEqual([]);
      expect(await snapshotCount()).toBe(before);
      const entries = await saleEntries(orderId);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(totalDebit(net)).toBe(totalCredit(net));
      expect(-netDebit(net, "tax_payable_pbjt")).toBe(7000);
      expect(await parkedJournals()).toBe(0);
    },
    T,
  );

  it(
    "legend-uctlr tax rows that do not add up to pbjtIdr are skipped (tax_mismatch), not refused: ingested, all tax to PBJT",
    async () => {
      const controlId = createUlid(++clock);
      await deliver([paidEvent(controlId)]);
      // Control: the same sale with consistent taxes is journaled and snapshotted.
      expect(await ingestOf(controlId)).toMatchObject({ state: "ingested" });
      expect(await saleEntries(controlId)).toHaveLength(1);
      expect(await snapshotsOf(controlId)).toHaveLength(1);

      const badId = createUlid(++clock);
      const bad = paidEvent(
        badId,
        paidPayload(badId, { taxes: [pbjtRow({ taxIdr: 6000 })] }),
      );
      await deliver([bad]);

      expect(await ingestOf(badId)).toMatchObject({ state: "ingested" });
      expect(await cloudOrders(badId)).toBe(1);
      expect(await snapshotsOf(badId)).toEqual([]);
      const entries = await saleEntries(badId);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(totalDebit(net)).toBe(totalCredit(net));
      expect(-netDebit(net, "tax_payable_pbjt")).toBe(7000);
    },
    T,
  );
});

// ---- replay and random order ---------------------------------------------------

describe("legend-uctlr replay and random order never double-count", () => {
  it(
    "legend-uctlr replaying a paid event (same batch, later batches, redelivery) keeps one journal, one snapshot set and one earn",
    async () => {
      const orderId = createUlid(++clock);
      const earnsBefore = await ledgerCount(member.id, "earn");
      const event = paidEvent(
        orderId,
        cashSale(orderId, { customerProfileId: member.id }),
      );
      await deliver([event, event]);
      expect(await saleEntries(orderId)).toHaveLength(1);
      expect(await earnOf(orderId)).toHaveLength(1);

      await deliver([event]);
      await deliver([event, event]);
      await redeliver(event);
      await redeliver(event);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      const entries = await saleEntries(orderId);
      expect(entries).toHaveLength(1);
      const net = await linesOf(entries);
      expect(netDebit(net, "cash_on_hand")).toBe(77000);
      expect(await snapshotsOf(orderId)).toHaveLength(1);
      expect(await earnOf(orderId)).toHaveLength(1);
      expect(await ledgerCount(member.id, "earn")).toBe(earnsBefore + 1);
      expect(await parkedJournals()).toBe(0);
    },
    T,
  );

  it(
    "legend-uctlr a void that arrives before its paid event writes nothing; paid and a new void then apply once, in any later replay order",
    async () => {
      const orderId = createUlid(++clock);
      const early = voidedEvent(orderId, 2);
      const before = await journalCount();

      await deliver([early]).catch(() => undefined);
      expect(await cloudOrders(orderId)).toBe(0);
      expect(await voidRowCount(orderId)).toBe(0);
      expect(await saleEntries(orderId)).toEqual([]);
      expect(await journalCount()).toBe(before);

      const paid = paidEvent(
        orderId,
        cashSale(orderId, { customerProfileId: member.id }),
        1,
      );
      await deliver([paid]);
      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      const sale = await saleEntries(orderId);
      expect(sale).toHaveLength(1);
      expect(await reversalEntries(sale)).toEqual([]);

      // The link applies an aggregate's events in sequence: the early void (2)
      // was a gap and never applied, so the paid event is 1 and the void 2.
      const lateVoid = voidedEvent(orderId, 2);
      await deliver([lateVoid]);
      await deliver([lateVoid, lateVoid]);
      await redeliver(lateVoid);
      await redeliver(paid);

      expect(await saleEntries(orderId)).toEqual(sale);
      expect(await reversalEntries(sale)).toHaveLength(1);
      expect(await voidRowCount(orderId)).toBe(1);
      const earn = await earnOf(orderId);
      expect(earn).toHaveLength(1);
      expect(earn[0]!.reversed).toBe(earn[0]!.booked);
      expect(await parkedJournals()).toBe(0);
    },
    T,
  );
});

// ---- void ---------------------------------------------------------------------

describe("legend-uctlr order.voided reverses the journal exactly once", () => {
  it(
    "legend-uctlr a void of a paid cash sale posts one reversal that cancels the sale; replays add nothing",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([paidEvent(orderId, cashSale(orderId))]);
      const sale = await saleEntries(orderId);
      expect(sale).toHaveLength(1);

      const event = voidedEvent(orderId, 2);
      await deliver([event]);
      await deliver([event]);
      await deliver([event, event]);
      await redeliver(event);

      expect(await ingestOf(orderId)).toMatchObject({ state: "voided" });
      expect(await voidRowCount(orderId)).toBe(1);
      expect(await saleEntries(orderId)).toEqual(sale);
      const reversals = await reversalEntries(sale);
      expect(reversals).toHaveLength(1);
      // Sale + reversal net to zero on every account.
      const net = await linesOf([...sale, ...reversals]);
      for (const [role, line] of Object.entries(net))
        expect(line!.debit - line!.credit, role).toBe(0);
      const reversalOnly = await linesOf(reversals);
      expect(totalDebit(reversalOnly)).toBe(totalCredit(reversalOnly));
      expect(creditOf(reversalOnly, "cash_on_hand")).toBe(77000);
      expect(await parkedJournals()).toBe(0);
    },
    T,
  );

  it(
    "legend-uctlr a void without an approver or with a wrong amount leaves the sale journal untouched",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([paidEvent(orderId, cashSale(orderId))]);
      const sale = await saleEntries(orderId);
      expect(sale).toHaveLength(1);

      await deliver([
        voidedEvent(orderId, 2, {
          approvedBy: null,
          overrideId: null,
          approvalRequestId: null,
        }),
      ]);
      expect(await ingestOf(orderId)).toMatchObject({
        reason: expect.stringMatching(/(^|:)void_actor_missing$/),
      });
      await deliver([voidedEvent(orderId, 3, {}, 50000)]);
      expect(await ingestOf(orderId)).toMatchObject({
        reason: expect.stringMatching(/(^|:)void_amount_mismatch$/),
      });

      expect(await voidRowCount(orderId)).toBe(0);
      expect(await saleEntries(orderId)).toEqual(sale);
      expect(await reversalEntries(sale)).toEqual([]);
    },
    T,
  );
});

// ---- customer points -----------------------------------------------------------

describe("legend-uctlr loyalty points of the edge sale's customer", () => {
  it(
    "legend-uctlr a paid sale with a customer stores the customer on the order and earns points once",
    async () => {
      const orderId = createUlid(++clock);
      const balanceBefore = await balanceOf(member.id);
      const earnsBefore = await ledgerCount(member.id, "earn");
      await deliver([
        paidEvent(orderId, cashSale(orderId, { customerProfileId: member.id })),
      ]);

      expect(await orderCustomer(orderId)).toBe(member.id);
      const earn = await earnOf(orderId);
      expect(earn).toHaveLength(1);
      expect(earn[0]!.state).toBe("booked");
      expect(earn[0]!.booked).toBeGreaterThan(0);
      expect(await ledgerCount(member.id, "earn")).toBe(earnsBefore + 1);
      expect(await balanceOf(member.id)).toBe(balanceBefore + earn[0]!.booked);
    },
    T,
  );

  it(
    "legend-uctlr a walk-in sale (no customer) earns nothing",
    async () => {
      const orderId = createUlid(++clock);
      const before = await earnCount();
      await deliver([
        paidEvent(orderId, cashSale(orderId, { customerProfileId: null })),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await orderCustomer(orderId)).toBeNull();
      expect(await earnOf(orderId)).toEqual([]);
      expect(await earnCount()).toBe(before);
      // The sales journal is still posted.
      expect(await saleEntries(orderId)).toHaveLength(1);
    },
    T,
  );

  it(
    "legend-uctlr a points tender is never redeemed offline: no redeem row, the balance only grows by the earn",
    async () => {
      const orderId = createUlid(++clock);
      const balanceBefore = await balanceOf(member.id);
      const redeemsBefore = await ledgerCount(member.id, "redeem");
      await deliver([
        paidEvent(
          orderId,
          paidPayload(orderId, { customerProfileId: member.id }),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await ledgerCount(member.id, "redeem")).toBe(redeemsBefore);
      const earn = await earnOf(orderId);
      expect(earn).toHaveLength(1);
      expect(await balanceOf(member.id)).toBe(balanceBefore + earn[0]!.booked);
    },
    T,
  );

  it(
    "legend-uctlr a void takes the earned points back once and the balance returns to where it was",
    async () => {
      const orderId = createUlid(++clock);
      const balanceBefore = await balanceOf(member.id);
      await deliver([
        paidEvent(orderId, cashSale(orderId, { customerProfileId: member.id })),
      ]);
      const earned = (await earnOf(orderId))[0]!;
      expect(earned.booked).toBeGreaterThan(0);

      const event = voidedEvent(orderId, 2);
      await deliver([event]);
      await deliver([event]);
      await redeliver(event);

      const after = (await earnOf(orderId))[0]!;
      expect(after.booked).toBe(earned.booked);
      expect(after.reversed).toBe(earned.booked);
      expect(await balanceOf(member.id)).toBe(balanceBefore);
      expect(await ledgerCount(member.id, "reverse")).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  it(
    "legend-uctlr a busy loyalty entity lock is a transient refusal (not a lost sale); the sale is ingested once the lock is free",
    async () => {
      const orderId = createUlid(++clock);
      const event = paidEvent(
        orderId,
        cashSale(orderId, { customerProfileId: member.id }),
      );
      const earnsBefore = await ledgerCount(member.id, "earn");
      const holder = await owner.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`loyalty-entity:${tenantId}`],
        );
        await deliver([event]);

        const refused = await ingestOf(orderId);
        expect(refused).toMatchObject({ state: "refused" });
        expect(isTransientReason(refused?.reason ?? null)).toBe(true);
        expect(await cloudOrders(orderId)).toBe(0);
        expect(await saleEntries(orderId)).toEqual([]);
        // The parked event is kept for the re-drive.
        expect(await parkedRowsOf(event)).toBe(1);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }

      await redeliver(event);
      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await saleEntries(orderId)).toHaveLength(1);
      expect(await earnOf(orderId)).toHaveLength(1);
      expect(await ledgerCount(member.id, "earn")).toBe(earnsBefore + 1);
    },
    T,
  );
});

// ---- tenant isolation ---------------------------------------------------------

describe("legend-uctlr tenant isolation", () => {
  const foreign = async () => ({
    journals: await journalCount(otherTenantId),
    snapshots: await snapshotCount(otherTenantId),
    earns: await earnCount(otherTenantId),
    ledger: await ledgerCount(otherMember.id, undefined, otherTenantId),
    balance: await balanceOf(otherMember.id, otherTenantId),
  });

  it(
    "legend-uctlr paid and void of an edge sale leave another tenant's journals, tax rows and points untouched",
    async () => {
      const before = await foreign();
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(orderId, cashSale(orderId, { customerProfileId: member.id })),
      ]);
      await deliver([voidedEvent(orderId, 2)]);

      // Own side did post (fail-first anchor) ...
      const sale = await saleEntries(orderId);
      expect(sale).toHaveLength(1);
      expect(await reversalEntries(sale)).toHaveLength(1);
      expect(await snapshotsOf(orderId)).toHaveLength(1);
      expect(await earnOf(orderId)).toHaveLength(1);
      // ... and the other tenant saw nothing.
      expect(await foreign()).toEqual(before);
    },
    T,
  );

  it(
    "legend-uctlr a customer of another tenant on the payload is never stored or credited, in either tenant",
    async () => {
      const before = await foreign();
      const ownBefore = await earnCount();
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(
          orderId,
          cashSale(orderId, { customerProfileId: otherMember.id }),
        ),
      ]);

      expect(await orderCustomer(orderId)).not.toBe(otherMember.id);
      expect(await earnOf(orderId)).toEqual([]);
      expect(await earnOf(orderId, otherTenantId)).toEqual([]);
      expect(await earnCount()).toBe(ownBefore);
      expect(await foreign()).toEqual(before);
    },
    T,
  );

  it(
    "legend-uctlr a customer unknown to the tenant never loses the sale: ingested, journaled, no points, no refusal",
    async () => {
      const ownBefore = await earnCount();
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(
          orderId,
          cashSale(orderId, { customerProfileId: randomUUID() }),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await cloudOrders(orderId)).toBe(1);
      expect(await orderCustomer(orderId)).toBeNull();
      expect(await saleEntries(orderId)).toHaveLength(1);
      expect(await earnOf(orderId)).toEqual([]);
      expect(await earnCount()).toBe(ownBefore);
    },
    T,
  );

  it(
    "legend-uctlr an event stamped for another tenant creates no journal, tax row or points in either tenant",
    async () => {
      const own = {
        journals: await journalCount(),
        snaps: await snapshotCount(),
        earns: await earnCount(),
      };
      const before = await foreign();
      const orderId = createUlid(++clock);
      const stray = envelope(
        "order.paid",
        orderId,
        1,
        cashSale(orderId, { customerProfileId: member.id }),
      );
      await deliver([
        { ...stray, tenantId: otherTenantId as EventEnvelope["tenantId"] },
      ]).catch(() => undefined);

      expect(await journalCount()).toBe(own.journals);
      expect(await snapshotCount()).toBe(own.snaps);
      expect(await earnCount()).toBe(own.earns);
      expect(await foreign()).toEqual(before);
    },
    T,
  );
});
