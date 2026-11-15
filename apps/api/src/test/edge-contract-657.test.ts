// legend-cqehx + legend-yu8z0: follow-ups of the edge order contract. Written
// from the brief and docs/design/edge-order-ingest.md + packages/shared
// (contract), never from the implementation.
//
// legend-cqehx: `order.paid` may carry `customerAttachedBy` (the staff user who
// attached the customer; optional, nullable). The ingest stores it in
// `orders.customer_attached_by`, so the LOY-02 guard (staff never earn points on
// their own sale) sees who attached the customer, not only the cashier.
// legend-yu8z0: a tender line may carry `provider`. A gateway tender (card, va,
// ewallet, qris) is ingested only with a valid gateway provider ("doit" or
// "duitku", the platform's gateway adapters); without one it stays
// `tender_unsupported`; with an unknown one it is never ingested.
//
// Assumptions where the brief is silent (also reported):
//  - "valid provider" for a gateway method = a gateway adapter code
//    (`PAYMENT_GATEWAY_PROVIDERS`: doit, duitku). Unknown / empty / wrong-case
//    codes are refused. How (schema refusal or ingest ledger row) is not pinned:
//    the test asserts only that nothing is ingested, no money row, no journal.
//  - a staff self-attach keeps the customer on the order (the member is who the
//    sale belongs to) but books no points: `point_earn_records` state `blocked`,
//    outcome `blocked_self_serve` (same as the cloud LOY-02 tests).
//  - a malformed `customerAttachedBy` (not a UUID) never yields points and is
//    never silently turned into null-with-points.
//  - the sale journal of a gateway sale debits `gateway_clearing` for the gateway bucket.
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
import type { EventEnvelope } from "@starter/shared/events";
import { postingAccountRoleSchema } from "@starter/shared/accounting";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { seedMember, seedProgram } from "./member-loyalty-helpers";

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
const deviceId = randomUUID();
let node: AuthenticatedEdgeNode;
let member: { id: string; userId: string };
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

function paidEvent(
  orderId: string,
  payload: Payload = paidPayload(orderId),
  sequence = 1,
): EventEnvelope {
  return envelope("order.paid", orderId, sequence, payload);
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

const netDebit = (net: Net, role: Role) =>
  (net[role]?.debit ?? 0) - (net[role]?.credit ?? 0);
const totalDebit = (net: Net) =>
  Object.values(net).reduce((sum, line) => sum + line.debit, 0);
const totalCredit = (net: Net) =>
  Object.values(net).reduce((sum, line) => sum + line.credit, 0);

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

// ---- helpers of this file ------------------------------------------------------

/** The sale paid in cash only: total 77000 (subtotal 75000 - 5000 + PBJT 7000). */
function cashSale(orderId: string, over: Payload = {}): Payload {
  return paidPayload(orderId, {
    paidCashIdr: 77000,
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    tenders: [{ method: "cash", amountIdr: 77000, receivedIdr: 100000 }],
    ...over,
  });
}

/** The same sale paid by the given tenders (gateway money in `paidGatewayIdr`). */
function gatewaySale(
  orderId: string,
  tenders: Payload[],
  over: Payload = {},
): Payload {
  const sum = (bucket: (method: string) => boolean) =>
    tenders
      .filter((tender) => bucket(String(tender.method)))
      .reduce((total, tender) => total + Number(tender.amountIdr), 0);
  return paidPayload(orderId, {
    paidCashIdr: sum((method) => method === "cash"),
    paidGatewayIdr: sum((method) =>
      ["card", "va", "ewallet", "qris"].includes(method),
    ),
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    tenders,
    ...over,
  });
}

type OrderRow = {
  customer: string | null;
  attached_by: string | null;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};
async function orderRow(orderId: string): Promise<OrderRow | undefined> {
  const rows = await q<OrderRow>(
    `SELECT customer_profile_id::text AS customer, customer_attached_by AS attached_by, status,
            subtotal_idr::int AS subtotal, discount_idr::int AS discount,
            tax_idr::int AS tax, total_idr::int AS total
       FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
  return rows[0];
}

type TenderRow = {
  method: string;
  provider: string;
  amount: number;
  status: string;
};
async function tendersOf(orderId: string): Promise<TenderRow[]> {
  return q<TenderRow>(
    `SELECT method, provider, amount_idr::int AS amount, status
       FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2::uuid
      ORDER BY method`,
    [tenantId, dbId(orderId)],
  );
}

async function earnRecord(orderId: string) {
  return q<{ state: string; outcome_reason: string | null }>(
    `SELECT state, outcome_reason FROM point_earn_records
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
}

/** What a user cares about on an ingested sale: figures equal the payload, tenders settle the total. */
async function expectSaleFigures(orderId: string) {
  expect(await orderRow(orderId)).toMatchObject({
    status: "completed",
    subtotal: 75000,
    discount: 5000,
    tax: 7000,
    total: 77000,
  });
  const tenders = await tendersOf(orderId);
  expect(tenders.reduce((sum, tender) => sum + tender.amount, 0)).toBe(77000);
}

// ---- legend-cqehx: who attached the customer ------------------------------------

describe("legend-cqehx staff attaching themselves as the customer earn no points", () => {
  it(
    "legend-cqehx a staff user who attached their own member profile gets no points, but the sale is ingested, journaled and keeps its totals",
    async () => {
      const orderId = createUlid(++clock);
      const balanceBefore = await balanceOf(member.id);
      const earnsBefore = await ledgerCount(member.id, "earn");

      await deliver([
        paidEvent(
          orderId,
          cashSale(orderId, {
            customerProfileId: member.id,
            customerAttachedBy: member.userId,
          }),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await orderRow(orderId)).toMatchObject({
        customer: member.id,
        attached_by: member.userId,
      });
      await expectSaleFigures(orderId);
      expect(await saleEntries(orderId)).toHaveLength(1);
      // No points: blocked as self-serve (LOY-02), nothing in the ledger.
      expect(await earnRecord(orderId)).toEqual([
        { state: "blocked", outcome_reason: "blocked_self_serve" },
      ]);
      expect(await ledgerCount(member.id, "earn")).toBe(earnsBefore);
      expect(await balanceOf(member.id)).toBe(balanceBefore);
    },
    T,
  );

  it(
    "legend-cqehx the staff who attached the customer is stored on the order and a customer attached by another user earns points",
    async () => {
      const orderId = createUlid(++clock);
      const balanceBefore = await balanceOf(member.id);

      await deliver([
        paidEvent(
          orderId,
          cashSale(orderId, {
            customerProfileId: member.id,
            customerAttachedBy: cashierId,
          }),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await orderRow(orderId)).toMatchObject({
        customer: member.id,
        attached_by: cashierId,
      });
      await expectSaleFigures(orderId);
      const earn = await earnRecord(orderId);
      expect(earn).toEqual([{ state: "booked", outcome_reason: null }]);
      expect(await balanceOf(member.id)).toBeGreaterThan(balanceBefore);
    },
    T,
  );

  it(
    "legend-cqehx customerAttachedBy null is accepted (a customer who attached themselves) and earns points",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(
          orderId,
          cashSale(orderId, {
            customerProfileId: member.id,
            customerAttachedBy: null,
          }),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      expect(await orderRow(orderId)).toMatchObject({
        customer: member.id,
        attached_by: null,
      });
      expect(await earnRecord(orderId)).toEqual([
        { state: "booked", outcome_reason: null },
      ]);
    },
    T,
  );

  it(
    "legend-cqehx a sale without customerAttachedBy (older edge) still earns, and a cashier who is the member still blocks",
    async () => {
      const earned = createUlid(++clock);
      const blocked = createUlid(++clock);
      await deliver([
        paidEvent(earned, cashSale(earned, { customerProfileId: member.id })),
        paidEvent(
          blocked,
          cashSale(blocked, {
            customerProfileId: member.id,
            cashierId: member.userId,
          }),
        ),
      ]);

      expect(await earnRecord(earned)).toEqual([
        { state: "booked", outcome_reason: null },
      ]);
      expect(await orderRow(earned)).toMatchObject({ attached_by: null });
      expect(await earnRecord(blocked)).toEqual([
        { state: "blocked", outcome_reason: "blocked_self_serve" },
      ]);
    },
    T,
  );

  it(
    "legend-cqehx a malformed customerAttachedBy never yields points",
    async () => {
      const orderId = createUlid(++clock);
      const balanceBefore = await balanceOf(member.id);

      await deliver([
        paidEvent(
          orderId,
          cashSale(orderId, {
            customerProfileId: member.id,
            customerAttachedBy: "not-a-user-id",
          }),
        ),
      ]);

      expect(await earnRecord(orderId)).not.toContainEqual(
        expect.objectContaining({ state: "booked" }),
      );
      expect(await balanceOf(member.id)).toBe(balanceBefore);
    },
    T,
  );

  it(
    "legend-cqehx replaying a self-attached sale stays without points",
    async () => {
      const orderId = createUlid(++clock);
      const event = paidEvent(
        orderId,
        cashSale(orderId, {
          customerProfileId: member.id,
          customerAttachedBy: member.userId,
        }),
      );
      const balanceBefore = await balanceOf(member.id);

      await deliver([event]);
      await redeliver(event);

      expect(await cloudOrders(orderId)).toBe(1);
      expect(await earnRecord(orderId)).toEqual([
        { state: "blocked", outcome_reason: "blocked_self_serve" },
      ]);
      expect(await balanceOf(member.id)).toBe(balanceBefore);
    },
    T,
  );
});

// ---- legend-yu8z0: gateway tenders carry their provider --------------------------

describe("legend-yu8z0 a gateway tender with a valid provider is ingested", () => {
  const cases: [string, string][] = [
    ["qris", "duitku"],
    ["qris", "doit"],
    ["card", "doit"],
    ["va", "duitku"],
    ["ewallet", "doit"],
  ];
  for (const [method, provider] of cases)
    it(
      `legend-yu8z0 a ${method} tender via ${provider} becomes one cloud order, the tender keeps its provider and the figures are unchanged`,
      async () => {
        const orderId = createUlid(++clock);
        await deliver([
          paidEvent(
            orderId,
            gatewaySale(orderId, [{ method, provider, amountIdr: 77000 }]),
          ),
        ]);

        expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
        expect(await cloudOrders(orderId)).toBe(1);
        await expectSaleFigures(orderId);
        expect(await tendersOf(orderId)).toEqual([
          { method, provider, amount: 77000, status: "captured" },
        ]);
        // The sale journal settles the gateway money in the clearing account.
        const entries = await saleEntries(orderId);
        expect(entries).toHaveLength(1);
        const net = await linesOf(entries);
        expect(totalDebit(net)).toBe(totalCredit(net));
        expect(netDebit(net, "gateway_clearing")).toBe(77000);
      },
      T,
    );

  it(
    "legend-yu8z0 cash plus a gateway tender with a provider: both tenders are stored and add up to the total",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(
          orderId,
          gatewaySale(orderId, [
            { method: "cash", amountIdr: 50000, receivedIdr: 50000 },
            { method: "qris", provider: "duitku", amountIdr: 27000 },
          ]),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      await expectSaleFigures(orderId);
      const tenders = await tendersOf(orderId);
      expect(tenders.map((tender) => [tender.method, tender.amount])).toEqual([
        ["cash", 50000],
        ["qris", 27000],
      ]);
      expect(tenders.find((tender) => tender.method === "qris")).toMatchObject({
        provider: "duitku",
        status: "captured",
      });
      const net = await linesOf(await saleEntries(orderId));
      expect(netDebit(net, "cash_on_hand")).toBe(50000);
      expect(netDebit(net, "gateway_clearing")).toBe(27000);
    },
    T,
  );

  it(
    "legend-yu8z0 replaying a gateway sale adds no second order, tender or journal",
    async () => {
      const orderId = createUlid(++clock);
      const event = paidEvent(
        orderId,
        gatewaySale(orderId, [
          { method: "qris", provider: "duitku", amountIdr: 77000 },
        ]),
      );

      await deliver([event]);
      await redeliver(event);

      expect(await cloudOrders(orderId)).toBe(1);
      expect(await tendersOf(orderId)).toHaveLength(1);
      expect(await saleEntries(orderId)).toHaveLength(1);
    },
    T,
  );
});

describe("legend-yu8z0 a gateway tender without a valid provider is never ingested", () => {
  for (const method of ["qris", "card", "va", "ewallet"])
    it(
      `legend-yu8z0 a ${method} tender without provider is still refused as tender_unsupported`,
      async () => {
        const orderId = createUlid(++clock);
        const event = paidEvent(
          orderId,
          gatewaySale(orderId, [{ method, amountIdr: 77000 }]),
        );

        await deliver([event]);

        expect(await parkedRowsOf(event)).toBe(1);
        expect(await cloudOrders(orderId)).toBe(0);
        expect(await tendersOf(orderId)).toEqual([]);
        expect(await ingestOf(orderId)).toMatchObject({
          state: "refused",
          reason: "tender_unsupported",
        });
        expect(await saleEntries(orderId)).toEqual([]);
      },
      T,
    );

  for (const provider of ["stripe", "", "DUITKU", "edc_bank"])
    it(
      `legend-yu8z0 a qris tender with the unknown provider "${provider}" creates no order, tender or journal`,
      async () => {
        const orderId = createUlid(++clock);
        const event = paidEvent(
          orderId,
          gatewaySale(orderId, [
            { method: "qris", provider, amountIdr: 77000 },
          ]),
        );

        await deliver([event]);

        expect(await cloudOrders(orderId)).toBe(0);
        expect(await tendersOf(orderId)).toEqual([]);
        expect(await saleEntries(orderId)).toEqual([]);
        const ledger = await ingestOf(orderId);
        if (ledger) expect(ledger.state).toBe("refused");
      },
      T,
    );

  it(
    "legend-yu8z0 one gateway tender without provider among cash tenders refuses the whole order",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(
          orderId,
          gatewaySale(orderId, [
            { method: "cash", amountIdr: 50000, receivedIdr: 50000 },
            { method: "qris", amountIdr: 27000 },
          ]),
        ),
      ]);

      expect(await cloudOrders(orderId)).toBe(0);
      expect(await tendersOf(orderId)).toEqual([]);
      expect(await ingestOf(orderId)).toMatchObject({
        state: "refused",
        reason: "tender_unsupported",
      });
    },
    T,
  );

  it(
    "legend-yu8z0 EDC tenders keep being ingested without a provider",
    async () => {
      const orderId = createUlid(++clock);
      await deliver([
        paidEvent(
          orderId,
          paidPayload(orderId, {
            paidCashIdr: 0,
            paidEdcIdr: 77000,
            paidPointsIdr: 0,
            tenders: [{ method: "edc_qris", amountIdr: 77000 }],
          }),
        ),
      ]);

      expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
      await expectSaleFigures(orderId);
      expect(await tendersOf(orderId)).toMatchObject([
        { method: "edc_qris", amount: 77000, status: "captured" },
      ]);
    },
    T,
  );
});
