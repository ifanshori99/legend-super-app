// A purchase return that was already invoiced (a debit note) must reduce the
// supplier's accounts payable card (kartu utang) exactly once (card
// legend-179bw, finding legend-1xbs; PRD v1.7 §3.18 Retur Pembelian, §3.19
// Utang & Piutang and Jurnal Otomatis; DECISIONS "WS-07 purchase return
// journals": "a debit note reduces AP in the ledger but creates no AP open
// item"). Written fail-first from the contract, not from the implementation.
//
// Money rules under test (founder):
// - A debit note reduces the supplier's debt exactly once; a retry or a
//   redelivery never reduces it again (no one is credited twice).
// - The supplier card (aging report, kind "payable") equals the general
//   ledger balance of the accounts_payable account.
// - Another tenant is refused: it neither changes nor reads this card.
//
// Assumptions (the contract does not pin these down):
// - The debit note enters through the same event that posts the ledger:
//   `purchase_return.recorded` with `invoicedValueIdr` and `ppnIdr`,
//   delivered to `deliverAutoJournalEvent` (the HTTP return emits only
//   `uninvoicedValueIdr` until supplier invoices exist, so this event is the
//   only way to produce an invoiced return today). Card and ledger must move
//   together, in the same transaction.
// - The debit note amount is `invoicedValueIdr + ppnIdr` (decided in
//   DECISIONS, same as the ledger's Dr accounts_payable).
// - "Saldo utang supplier" is read through the public aging report
//   (`getAgingReport`, kind "payable"): the row of the supplier and the report
//   total. Which open item absorbs the credit (oldest first or a separate
//   item) is not asserted, only the supplier's net outstanding.
// - A return with no invoiced part (only Dr grni) touches no AP card.
// - A return larger than the supplier's outstanding is not covered: the
//   contract does not say whether it is refused or leaves a debit balance.
//   Both open-item amounts must stay >= 0 (openItemSchema), so this test does
//   not guess.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { recordSupplierInvoicePayableInTransaction } from "../services/accounting-ap.service.ts";
import { getAgingReport } from "../services/accounting-open-items.service.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomBytes(3).toString("hex");
/** Fixed "now" of the consumer; every business instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
const AS_OF = "2026-11-08";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

const creator = randomUUID();
const actor: UserId = userIdSchema.parse(creator);

type Role = "grni" | "accounts_payable" | "inventory" | "ppn_input";
const CHART: [Role, string, string, string, string][] = [
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
];

type Tenant = { id: string; brandId: string };
type World = {
  tenant: Tenant;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
};

function contextOf(tenant: Tenant): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Nota Debit AP', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-pra-${id.slice(0, 8)}`,
      FLAGS_ON,
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

/** A legal entity + outlet + CoA with every posting role mapped + open periods. */
async function makeWorld(tenant: Tenant): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entity, tenant.id, `Entity PRA ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PRA', 'Jl. PRA', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `PRA-${short()}`.toUpperCase(),
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
  return { tenant, entity, outletId, accounts };
}

async function makeSupplier(world: World): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by)
     VALUES ($1, $2, $3, 30, $4)`,
    [id, world.tenant.id, `Pemasok ${short()}`, creator],
  );
  return id;
}

/** The supplier invoice journal: Dr inventory + ppn_input / Cr accounts_payable. */
async function postInvoiceJournal(
  world: World,
  dppIdr: number,
  ppnIdr: number,
): Promise<string> {
  const { rows: period } = await owner.query<{ id: string }>(
    "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'",
    [world.tenant.id, world.entity],
  );
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, NULL, '2026-10-01', $3, 'supplier_invoice', $4, 'Faktur pemasok uji', $5, $6)
       RETURNING id`,
      [
        world.tenant.id,
        world.entity,
        period[0]!.id,
        randomUUID(),
        `pra-inv-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    // A journal line has exactly one positive side: no line for a zero PPN.
    const lines: [string, number, number][] = [
      [world.accounts.inventory, dppIdr, 0],
      ...(ppnIdr > 0
        ? [[world.accounts.ppn_input, ppnIdr, 0] as [string, number, number]]
        : []),
      [world.accounts.accounts_payable, 0, dppIdr + ppnIdr],
    ];
    for (const [index, [accountId, debit, credit]] of lines.entries())
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [world.tenant.id, entryId, accountId, index + 1, debit, credit],
      );
    await client.query("COMMIT");
    return entryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Books a supplier invoice: ledger credit + AP open item (the supplier card). */
async function invoice(
  world: World,
  supplierId: string,
  dppIdr: number,
  ppnIdr = 0,
  invoiceDate = "2026-10-01",
  dueOn = "2026-10-31",
): Promise<void> {
  const journalEntryId = await postInvoiceJournal(world, dppIdr, ppnIdr);
  const context = contextOf(world.tenant);
  await withTenant(db, context, (tx) =>
    recordSupplierInvoicePayableInTransaction(
      tx,
      context,
      {
        supplierInvoiceId: randomUUID(),
        legalEntityId: world.entity,
        outletId: world.outletId,
        supplierId,
        supplierName: "Pemasok Uji",
        invoiceNumber: `INV-${short()}`,
        invoiceDate,
        dueOn,
        dppIdr,
        ppnIdr,
        pph23Idr: 0,
        payableIdr: dppIdr + ppnIdr,
        journalEntryId,
        idempotencyKey: `pra-ap-${randomUUID()}`,
      },
      actor,
    ),
  );
}

// ---- synthetic return events ------------------------------------------------

type ReturnAmounts = {
  uninvoicedValueIdr: number;
  invoicedValueIdr: number;
  ppnIdr: number;
};

function purchaseReturnRecorded(
  world: World,
  returnId: string,
  supplierId: string,
  amounts: ReturnAmounts,
  eventId: string = createUlid(),
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: eventId,
    tenantId: world.tenant.id,
    outletId: world.outletId,
    name: "purchase_return.recorded",
    version: 1,
    aggregateType: "purchase_return",
    aggregateId: returnId,
    sequence: 1,
    occurredAt: DAY,
    actor: { type: "system" },
    idempotencyKey: `pra-test-${eventId}`,
    payloadSchemaRef: "purchase_return.recorded.v1",
    payload: {
      purchaseReturnId: returnId,
      supplierId,
      outletId: world.outletId,
      number: `KN/2026/10/${short()}`,
      valueIdr: amounts.uninvoicedValueIdr + amounts.invoicedValueIdr,
      returnedBy: randomUUID(),
      returnedAt: DAY,
      ...amounts,
    },
  });
}

/** Delivers one event inside the tenant's context, like the outbox consumer. */
async function deliver(tenant: Tenant, event: EventEnvelope) {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

async function post(world: World, event: EventEnvelope): Promise<void> {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
}

// ---- reads ------------------------------------------------------------------

/** Supplier card: the supplier's row of the payable aging report (0 if none). */
async function cardOf(world: World, supplierId: string): Promise<number> {
  const report = await getAgingReport(contextOf(world.tenant), {
    legalEntityId: world.entity,
    kind: "payable",
    asOf: AS_OF,
  });
  return (
    report.rows.find((row) => row.counterpartyId === supplierId)?.totalIdr ?? 0
  );
}

/** Whole payable card of the legal entity. */
async function cardTotal(world: World): Promise<number> {
  const report = await getAgingReport(contextOf(world.tenant), {
    legalEntityId: world.entity,
    kind: "payable",
    asOf: AS_OF,
  });
  return report.totalIdr;
}

/** General ledger balance of accounts_payable (credit minus debit). */
async function apLedger(world: World): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(credit_idr - debit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenant.id, world.accounts.accounts_payable],
  );
  return Number(rows[0]!.balance);
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [creator, "Purchase return AP test", `${creator}@example.com`],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  // Journals and tenants stay (append-only, random names).
  await owner.end();
});

// ============================================================================

describe("legend-179bw an invoiced purchase return reduces the supplier's AP card", () => {
  it("PRA-01 a debit note (invoiced value + PPN) lowers the supplier card and equals the ledger", async () => {
    const world = await makeWorld(await makeTenant());
    const supplier = await makeSupplier(world);
    await invoice(world, supplier, 1_000_000, 110_000); // payable 1.110.000
    expect(await cardOf(world, supplier)).toBe(1_110_000);
    expect(await apLedger(world)).toBe(1_110_000);

    // Return 200.000 invoiced + 22.000 PPN: Dr accounts_payable 222.000.
    await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), supplier, {
        uninvoicedValueIdr: 0,
        invoicedValueIdr: 200_000,
        ppnIdr: 22_000,
      }),
    );

    expect(await apLedger(world)).toBe(888_000);
    expect(await cardOf(world, supplier)).toBe(888_000);
    // The card ties to the general ledger.
    expect(await cardTotal(world)).toBe(await apLedger(world));
  });

  it("PRA-02 a retry or a redelivery of the same return never reduces the debt again", async () => {
    const world = await makeWorld(await makeTenant());
    const supplier = await makeSupplier(world);
    await invoice(world, supplier, 1_000_000, 110_000);
    const returnId = randomUUID();
    const amounts = {
      uninvoicedValueIdr: 0,
      invoicedValueIdr: 300_000,
      ppnIdr: 33_000,
    };
    const first = purchaseReturnRecorded(world, returnId, supplier, amounts);
    await post(world, first);
    const journals = await journalCount(world);
    expect(await cardOf(world, supplier)).toBe(777_000);

    // The very same envelope again (outbox retry), then the same return
    // announced by a new envelope (redelivery after a replay).
    await deliver(world.tenant, first);
    await deliver(
      world.tenant,
      purchaseReturnRecorded(world, returnId, supplier, amounts),
    );

    expect(await journalCount(world)).toBe(journals);
    expect(await apLedger(world)).toBe(777_000);
    expect(await cardOf(world, supplier)).toBe(777_000);
    expect(await cardTotal(world)).toBe(await apLedger(world));
  });

  it("PRA-03 two different returns each reduce the card once", async () => {
    const world = await makeWorld(await makeTenant());
    const supplier = await makeSupplier(world);
    await invoice(world, supplier, 1_000_000, 110_000);
    for (const invoicedValueIdr of [100_000, 50_000])
      await post(
        world,
        purchaseReturnRecorded(world, randomUUID(), supplier, {
          uninvoicedValueIdr: 0,
          invoicedValueIdr,
          ppnIdr: 0,
        }),
      );

    expect(await apLedger(world)).toBe(960_000);
    expect(await cardOf(world, supplier)).toBe(960_000);
  });

  it("PRA-04 a mixed return only reduces the card by its invoiced part plus PPN", async () => {
    const world = await makeWorld(await makeTenant());
    const supplier = await makeSupplier(world);
    await invoice(world, supplier, 1_000_000);

    // 60.000 not invoiced yet (Dr grni) + 40.000 invoiced + 4.400 PPN.
    await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), supplier, {
        uninvoicedValueIdr: 60_000,
        invoicedValueIdr: 40_000,
        ppnIdr: 4_400,
      }),
    );

    expect(await apLedger(world)).toBe(955_600);
    expect(await cardOf(world, supplier)).toBe(955_600);
  });

  it("PRA-05 the credit only reaches the returning supplier, across several invoices", async () => {
    const world = await makeWorld(await makeTenant());
    const returning = await makeSupplier(world);
    const other = await makeSupplier(world);
    await invoice(world, returning, 400_000, 0, "2026-09-01", "2026-09-30");
    await invoice(world, returning, 600_000, 0, "2026-10-01", "2026-10-31");
    await invoice(world, other, 500_000);

    await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), returning, {
        uninvoicedValueIdr: 0,
        invoicedValueIdr: 150_000,
        ppnIdr: 0,
      }),
    );

    expect(await cardOf(world, returning)).toBe(850_000);
    expect(await cardOf(world, other)).toBe(500_000);
    expect(await cardTotal(world)).toBe(1_350_000);
    expect(await apLedger(world)).toBe(1_350_000);
  });

  it("PRA-06 a return before invoicing (Dr grni only) leaves the card untouched", async () => {
    const world = await makeWorld(await makeTenant());
    const supplier = await makeSupplier(world);
    await invoice(world, supplier, 1_000_000);

    await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), supplier, {
        uninvoicedValueIdr: 185_000,
        invoicedValueIdr: 0,
        ppnIdr: 0,
      }),
    );

    expect(await apLedger(world)).toBe(1_000_000);
    expect(await cardOf(world, supplier)).toBe(1_000_000);
  });
});

describe("legend-179bw tenant isolation of the debit note card", () => {
  it("PRA-07 another tenant's return event is refused and moves neither card nor ledger", async () => {
    const a = await makeWorld(await makeTenant());
    const b = await makeWorld(await makeTenant());
    const supplierA = await makeSupplier(a);
    const supplierB = await makeSupplier(b);
    await invoice(a, supplierA, 1_000_000);
    await invoice(b, supplierB, 1_000_000);

    // A return of tenant B delivered in tenant A's context: ignored.
    const foreign = purchaseReturnRecorded(b, randomUUID(), supplierA, {
      uninvoicedValueIdr: 0,
      invoicedValueIdr: 400_000,
      ppnIdr: 0,
    });
    expect(await deliver(a.tenant, foreign)).toMatchObject({
      status: "ignored",
    });

    expect(await cardOf(a, supplierA)).toBe(1_000_000);
    expect(await apLedger(a)).toBe(1_000_000);
    expect(await cardOf(b, supplierB)).toBe(1_000_000);
    expect(await apLedger(b)).toBe(1_000_000);
  });

  it("PRA-08 a tenant's own return reduces only its own card; another tenant cannot read it", async () => {
    const a = await makeWorld(await makeTenant());
    const b = await makeWorld(await makeTenant());
    const supplierA = await makeSupplier(a);
    const supplierB = await makeSupplier(b);
    await invoice(a, supplierA, 1_000_000);
    await invoice(b, supplierB, 1_000_000);

    await post(
      b,
      purchaseReturnRecorded(b, randomUUID(), supplierB, {
        uninvoicedValueIdr: 0,
        invoicedValueIdr: 250_000,
        ppnIdr: 0,
      }),
    );

    expect(await cardOf(b, supplierB)).toBe(750_000);
    expect(await apLedger(b)).toBe(750_000);
    expect(await cardOf(a, supplierA)).toBe(1_000_000);
    expect(await apLedger(a)).toBe(1_000_000);
    // Tenant B asking for tenant A's legal entity: not found, nothing leaks.
    await expect(
      getAgingReport(contextOf(b.tenant), {
        legalEntityId: a.entity,
        kind: "payable",
        asOf: AS_OF,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
