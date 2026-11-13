// Shared fixtures for the ws/purchasing-apar acceptance tests (supplier invoice,
// three-way match, hold/release, tolerance policy). Not a test file: vitest only
// picks up `*.test.ts`. Written fail-first from docs/briefs/ws-purchasing-apar-
// design.md (§2, §3, §7, §9, §12) and the shared contract, not from the
// implementation.
//
// Every test file builds its OWN tenants (isolated tenant + Host header), so
// files running in parallel workers never share the tolerance policy, the chart
// mappings or the payable card. Tenant rows stay after the run (journals are
// append-only; names are random), like accounting-ap-fa and PRA tests.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

export const app = createApp();

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

/** Restricted login (RLS applies), as the running API uses. */
export const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

export const short = () => randomBytes(3).toString("hex");
export const key = () => `k-${randomUUID()}`;

// ---- dates -----------------------------------------------------------------

/** Today's business date in Jakarta, `YYYY-MM-DD`. */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(
    new Date(),
  );
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `YYYY-MM` of the month `shift` months from today (Jakarta). */
function monthOf(shift: number): string {
  const [y, m] = today().split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + shift, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- world -----------------------------------------------------------------

export type AccountRole =
  | "grni"
  | "inventory"
  | "ppn_input"
  | "service_expense"
  | "pph23_payable"
  | "purchase_price_variance"
  | "accounts_payable";

const CHART: [AccountRole, string, string, string, string][] = [
  ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
  ["ppn_input", "1401", "PPN Masukan", "asset", "current_asset"],
  ["accounts_payable", "2101", "Utang Usaha", "liability", "current_liability"],
  [
    "grni",
    "2102",
    "Barang Diterima Belum Ditagih",
    "liability",
    "current_liability",
  ],
  ["pph23_payable", "2201", "Utang PPh 23", "liability", "current_liability"],
  ["service_expense", "6301", "Beban Jasa", "expense", "operating_expense"],
  [
    "purchase_price_variance",
    "5105",
    "Selisih Harga Pembelian",
    "expense",
    "cogs",
  ],
];

export type RoleKey = "purchasing" | "finance" | "warehouse";
const ROLE_KEYS: RoleKey[] = ["purchasing", "finance", "warehouse"];

export type World = {
  tenantId: string;
  brandId: string;
  entityId: string;
  outletId: string;
  outletTwoId: string;
  hostname: string;
  accounts: Record<AccountRole, string>;
  roles: Record<RoleKey, string>;
  uomKg: string;
  creatorId: string;
  approverId: string;
};

export type Session = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `APAR ${label}`, `${id}@example.com`],
  );
  return id;
}

/**
 * A fresh tenant: brand, PKP legal entity, two outlets, verified hostname, the
 * `purchasing` / `finance` / `warehouse` role templates copied as custom roles
 * (same permission sets as the PRD role table), a chart of accounts with every
 * posting role of the supplier-invoice rule mapped, and open fiscal periods
 * around today.
 */
export async function createWorld(label: string): Promise<World> {
  const fixtures = cafeLegendPlatformFixtures;
  const suffix = `${label}-${short()}`;
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const entityId = randomUUID();
  const outletId = randomUUID();
  const outletTwoId = randomUUID();
  const hostname = `tenant-apar-${suffix}.legend.test`;
  const creatorId = await plainUser("creator");
  const approverId = await plainUser("approver");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, $6)`,
    [
      tenantId,
      `apar-${suffix}`,
      `Uji APAR ${suffix}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify(fixtures.tenant.limits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `brand-${suffix}`, `Brand ${suffix}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entityId, tenantId, `Entity ${suffix}`],
  );
  for (const [id, n] of [
    [outletId, 1],
    [outletTwoId, 2],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
      [
        id,
        tenantId,
        brandId,
        entityId,
        `AP${n}-${short()}`.toUpperCase(),
        `Outlet ${n} ${suffix}`,
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantId, brandId, hostname],
  );
  const roles = {} as Record<RoleKey, string>;
  for (const roleKey of ROLE_KEYS) {
    const template = ROLE_TEMPLATES.find((t) => t.key === roleKey)!;
    roles[roleKey] = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
      [
        roles[roleKey],
        tenantId,
        `Uji ${roleKey}`,
        JSON.stringify(template.permissions),
        JSON.stringify(["tenant", "brand", "outlet", "station"]),
      ],
    );
  }
  const accounts = {} as Record<AccountRole, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entityId, role, accounts[role]],
    );
  }
  for (const shift of [-1, 0, 1])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entityId, monthOf(shift)],
    );
  const { rows: uom } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantId, `kg${short()}`.slice(0, 10)],
  );
  return {
    tenantId,
    brandId,
    entityId,
    outletId,
    outletTwoId,
    hostname,
    accounts,
    roles,
    uomKg: uom[0]!.id,
    creatorId,
    approverId,
  };
}

/** A signed-in account holding `role` at an outlet (or tenant-wide when null). */
export async function addUser(
  world: World,
  label: string,
  grants: { role: RoleKey; outletId: string | null }[],
): Promise<Session> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  for (const grant of grants)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        world.tenantId,
        userId,
        world.roles[grant.role],
        grant.outletId === null ? "tenant" : "outlet",
        grant.outletId,
      ],
    );
  return { client, userId, email };
}

export function contextFor(
  world: World,
  outletId: string | null,
): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(world.tenantId),
    brandId: null,
    source: "domain",
  });
  return establishScopedTenantContext(
    tenant,
    outletId === null
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: [outletIdSchema.parse(outletId) as OutletId],
        },
  );
}

// ---- HTTP ------------------------------------------------------------------

export const api = {
  get: (world: World, who: Session, path: string) =>
    who.client
      .get(`/api/inventory${path}`)
      .set(originHeader)
      .set("Host", world.hostname),
  post: (world: World, who: Session, path: string, body: object) =>
    who.client
      .post(`/api/inventory${path}`)
      .set(originHeader)
      .set("Host", world.hostname)
      .send(body),
  put: (world: World, who: Session, path: string, body: object) =>
    who.client
      .put(`/api/inventory${path}`)
      .set(originHeader)
      .set("Host", world.hostname)
      .send(body),
};

/** Error code of a failed response (`{ error: { code } }`). */
export const codeOf = (res: { body: unknown }): string | undefined =>
  (res.body as { error?: { code?: string } }).error?.code;

// ---- purchase fixtures -----------------------------------------------------

export type Po = {
  supplierId: string;
  poId: string;
  poLineId: string;
  itemId: string;
  locationId: string;
  quantity: string;
  unitPrice: string;
  receiptId: string | null;
  receivedOn: string | null;
};

export async function insertSupplier(
  world: World,
  npwp: string | null = null,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by, npwp)
     VALUES ($1, $2, 30, true, $3, $4) RETURNING id`,
    [world.tenantId, `Pemasok APAR ${short()}`, world.creatorId, npwp],
  );
  return rows[0]!.id;
}

/**
 * A sent purchase order of ONE line (flour, `quantity` kg at `unitPrice`, base
 * unit kg, so base quantity = PO quantity) at `outletId`. Not received yet.
 */
export async function seedPo(
  world: World,
  options: {
    outletId?: string;
    supplierId?: string;
    quantity?: string;
    unitPrice?: string;
  } = {},
): Promise<Po> {
  const outletId = options.outletId ?? world.outletId;
  const quantity = options.quantity ?? "10.0000";
  const unitPrice = options.unitPrice ?? "10000.0000";
  const supplierId = options.supplierId ?? (await insertSupplier(world));
  const { rows: item } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [world.tenantId, `Tepung APAR ${short()}`, world.uomKg],
  );
  const { rows: location } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [world.tenantId, outletId, `Gudang APAR ${short()}`],
  );
  const total = Math.round(Number(quantity) * Number(unitPrice));
  const poId = randomUUID();
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', $6, 0, $6, 'user', $7, $8, now(), now())`,
    [
      poId,
      world.tenantId,
      outletId,
      supplierId,
      `PO/209912/${randomBytes(4).toString("hex")}`,
      total,
      world.creatorId,
      world.approverId,
    ],
  );
  const { rows: line } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING id`,
    [
      world.tenantId,
      outletId,
      poId,
      item[0]!.id,
      quantity,
      world.uomKg,
      unitPrice,
      total,
    ],
  );
  return {
    supplierId,
    poId,
    poLineId: line[0]!.id,
    itemId: item[0]!.id,
    locationId: location[0]!.id,
    quantity,
    unitPrice,
    receiptId: null,
    receivedOn: null,
  };
}

/**
 * Delivers the `goods_receipt.recorded` outbox event of a receipt to the
 * auto-journal consumer, as the outbox worker would (legend-29vw): the receipt
 * journal (Dr inventory / Cr GRNI) is what lets an invoice or a return of the
 * uninvoiced part be booked. A no-op (ignored) while the posting flag is off.
 */
export async function deliverGoodsReceiptJournal(
  world: World,
  receiptId: string,
): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'goods_receipt.recorded'`,
    [world.tenantId, receiptId],
  );
  const context = contextFor(world, null);
  for (const row of rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    await withTenant(db, context, (tx) =>
      deliverAutoJournalEvent(context, event, tx, new Date()),
    );
  }
}

/** Receives `received` (and `rejected`) kg of the PO line through the service. */
export async function receive(
  world: World,
  warehouse: Session,
  po: Po,
  received = po.quantity,
  rejected = "0.0000",
): Promise<Po> {
  const outletId = await outletOfPo(world, po.poId);
  const receipt = await createGoodsReceipt(
    contextFor(world, outletId),
    warehouse.userId,
    {
      outletId,
      purchaseOrderId: po.poId,
      lines: [
        {
          purchaseOrderLineId: po.poLineId,
          locationId: po.locationId,
          quantityReceived: received,
          quantityRejected: rejected,
        },
      ],
      idempotencyKey: key(),
    } as unknown as CreateGoodsReceiptInput,
  );
  await deliverGoodsReceiptJournal(world, receipt.receipt.id);
  return {
    ...po,
    receiptId: receipt.receipt.id,
    receivedOn: receipt.receipt.receivedOn,
  };
}

async function outletOfPo(world: World, poId: string): Promise<string> {
  const { rows } = await owner.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM purchase_orders WHERE tenant_id = $1 AND id = $2",
    [world.tenantId, poId],
  );
  return rows[0]!.outlet_id;
}

/** HTTP return of `quantity` kg from the received PO (warehouse role). */
export function returnGoods(
  world: World,
  warehouse: Session,
  po: Po,
  quantity: string,
) {
  return api.post(world, warehouse, "/purchase-returns", {
    outletId: world.outletId,
    supplierId: po.supplierId,
    purchaseOrderId: po.poId,
    goodsReceiptId: po.receiptId,
    returnedOn: po.receivedOn,
    reason: "damaged",
    lines: [
      {
        purchaseOrderLineId: po.poLineId,
        inventoryItemId: po.itemId,
        quantity,
        locationId: po.locationId,
      },
    ],
    idempotencyKey: key(),
  });
}

// ---- invoice request bodies ------------------------------------------------

export type InvoiceLineInput = {
  purchaseOrderLineId?: string | null;
  kind: "goods" | "service";
  description: string;
  quantity: string;
  unitPriceIdr: string;
};

export const goodsLine = (
  po: Po,
  quantity: string = po.quantity,
  unitPriceIdr: string = po.unitPrice,
): InvoiceLineInput => ({
  purchaseOrderLineId: po.poLineId,
  kind: "goods",
  description: "Tepung terigu",
  quantity,
  unitPriceIdr,
});

export const serviceLine = (amountIdr: number): InvoiceLineInput => ({
  purchaseOrderLineId: null,
  kind: "service",
  description: "Ongkos kirim",
  quantity: "1.0000",
  unitPriceIdr: `${amountIdr}.0000`,
});

/** Request of `POST /supplier-invoices`; defaults = one goods line, full PO. */
export function invoiceBody(
  world: World,
  po: Po,
  overrides: Record<string, unknown> = {},
) {
  const date = today();
  return {
    outletId: world.outletId,
    supplierId: po.supplierId,
    purchaseOrderId: po.poId,
    number: `INV-${short()}`.toUpperCase(),
    invoiceDate: date,
    dueDate: addDays(date, 30),
    lines: [goodsLine(po)],
    ppnIdr: 0,
    pph23Idr: 0,
    idempotencyKey: key(),
    ...overrides,
  };
}

export const createInvoice = (
  world: World,
  who: Session,
  body: Record<string, unknown>,
) => api.post(world, who, "/supplier-invoices", body);

export const decide = (
  world: World,
  who: Session,
  invoiceId: string,
  action: "release" | "reject",
  note = "Disetujui finance setelah konfirmasi pemasok",
  idempotencyKey = key(),
) =>
  api.post(world, who, `/supplier-invoices/${invoiceId}/${action}`, {
    note,
    idempotencyKey,
  });

export const rematch = (world: World, who: Session, invoiceId: string) =>
  api.post(world, who, `/supplier-invoices/${invoiceId}/match`, {
    idempotencyKey: key(),
  });

/** Invoice id from a create/match/release/reject response. */
export const invoiceIdOf = (res: { body: unknown }): string =>
  (res.body as { data: { invoice: { id: string } } }).data.invoice.id;

// ---- DB reads (migration owner, RLS bypassed) ------------------------------

/** Writes (or, with null, removes) the tenant's tolerance row directly. */
export async function setTolerance(
  world: World,
  bp: number | null,
  updatedBy: string,
): Promise<void> {
  if (bp === null) {
    await owner.query("DELETE FROM purchasing_policies WHERE tenant_id = $1", [
      world.tenantId,
    ]);
    return;
  }
  await owner.query(
    `INSERT INTO purchasing_policies (tenant_id, three_way_match_tolerance_bp, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET three_way_match_tolerance_bp = EXCLUDED.three_way_match_tolerance_bp, updated_at = now()`,
    [world.tenantId, bp, updatedBy],
  );
}

export type InvoiceRow = {
  id: string;
  status: string;
  number: string;
  journal_entry_id: string | null;
  decided_by: string | null;
  recorded_by: string;
  goods_idr: string;
  price_variance_idr: string;
  total_idr: string;
  payable_idr: string;
  tolerance_bp: number;
};

export async function invoiceRow(
  world: World,
  id: string,
): Promise<InvoiceRow | undefined> {
  const { rows } = await owner.query<InvoiceRow>(
    "SELECT * FROM purchase_invoices WHERE tenant_id = $1 AND id = $2",
    [world.tenantId, id],
  );
  return rows[0];
}

export async function invoiceRowsOfPo(
  world: World,
  poId: string,
): Promise<InvoiceRow[]> {
  const { rows } = await owner.query<InvoiceRow>(
    "SELECT * FROM purchase_invoices WHERE tenant_id = $1 AND purchase_order_id = $2 ORDER BY recorded_at",
    [world.tenantId, poId],
  );
  return rows;
}

/** Payable open item of the invoice (same id), or null. */
export async function openItemOf(
  world: World,
  id: string,
): Promise<{ original_idr: string; outstanding_idr?: string } | null> {
  const { rows } = await owner.query<{ original_idr: string }>(
    "SELECT original_idr FROM accounting_open_items WHERE tenant_id = $1 AND kind = 'payable' AND id = $2",
    [world.tenantId, id],
  );
  return rows[0] ?? null;
}

export async function taxRecordExists(
  world: World,
  id: string,
): Promise<boolean> {
  const { rowCount } = await owner.query(
    "SELECT 1 FROM supplier_invoices WHERE tenant_id = $1 AND id = $2",
    [world.tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

export async function journalOf(
  world: World,
  invoiceId: string,
): Promise<string | null> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND source_type = 'supplier_invoice' AND source_id = $2",
    [world.tenantId, invoiceId],
  );
  return rows[0]?.id ?? null;
}

/** Journal lines of one entry summed per account role. */
export async function journalLines(
  world: World,
  entryId: string,
): Promise<Partial<Record<AccountRole, { debit: number; credit: number }>>> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenantId, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [AccountRole, string][]).map(
      ([role, id]) => [id, role],
    ),
  );
  const result: Partial<
    Record<AccountRole, { debit: number; credit: number }>
  > = {};
  for (const row of rows)
    result[roleOf.get(row.account_id)!] = {
      debit: Number(row.debit),
      credit: Number(row.credit),
    };
  return result;
}

/** General ledger balance of accounts_payable (credit minus debit). */
export async function apLedger(world: World): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(credit_idr - debit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenantId, world.accounts.accounts_payable],
  );
  return Number(rows[0]!.balance);
}

/** Sum of the payable open items' original amounts (the supplier card). */
export async function apCard(world: World): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT coalesce(sum(original_idr), 0)::text AS total
       FROM accounting_open_items WHERE tenant_id = $1 AND kind = 'payable'`,
    [world.tenantId],
  );
  return Number(rows[0]!.total);
}

/** Row counts of everything a supplier invoice may write. */
export type Footprint = {
  invoices: number;
  lines: number;
  taxRecords: number;
  openItems: number;
  journals: number;
  outbox: number;
  claims: number;
};

export async function footprint(world: World): Promise<Footprint> {
  const count = async (sql: string) =>
    Number(
      (await owner.query<{ n: string }>(sql, [world.tenantId])).rows[0]!.n,
    );
  return {
    invoices: await count(
      "SELECT count(*)::text AS n FROM purchase_invoices WHERE tenant_id = $1",
    ),
    lines: await count(
      "SELECT count(*)::text AS n FROM purchase_invoice_lines WHERE tenant_id = $1",
    ),
    taxRecords: await count(
      "SELECT count(*)::text AS n FROM supplier_invoices WHERE tenant_id = $1",
    ),
    openItems: await count(
      "SELECT count(*)::text AS n FROM accounting_open_items WHERE tenant_id = $1 AND kind = 'payable'",
    ),
    journals: await count(
      "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND source_type = 'supplier_invoice'",
    ),
    outbox: await count(
      "SELECT count(*)::text AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' LIKE 'supplier_invoice.%'",
    ),
    // Assumption: the idempotency operation name contains "invoice".
    claims: await count(
      "SELECT count(*)::text AS n FROM purchasing_idempotency WHERE tenant_id = $1 AND operation LIKE '%invoice%'",
    ),
  };
}

/** Inserts a closed fiscal period 3 months back; returns a date inside it. */
export async function closedPastDate(world: World): Promise<string> {
  const period = monthOf(-3);
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
     VALUES ($1, $2, $3, 'closed', $4, now())
     ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
    [world.tenantId, world.entityId, period, world.creatorId],
  );
  return `${period}-15`;
}

/** Runs `run` as the restricted `legend_app` role scoped to `tenantId` (RLS on). */
export async function asApp<T>(
  tenantId: string,
  run: (
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>,
  ) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run(
      async (sql, params) => (await client.query(sql, params)).rows,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
