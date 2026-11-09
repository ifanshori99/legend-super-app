// Auto-journals of a purchase return and a petty purchase (brief
// docs/briefs/298a-sub-purchase-return-posting-design.md, Potongan B and C;
// cards legend-1xbs, legend-v3lh; PRD v1.7 §3.18 Retur Pembelian and
// Pembelian Sederhana, §3.19 Jurnal Otomatis; ACC-01 balanced journals).
//
// `purchase_return.recorded` and `petty_purchase.recorded` become GL journals
// through `deliverAutoJournalEvent`, the same consumer as the money journals of
// `accounting-auto-journal.test.ts`. Runs against the disposable PostgreSQL
// test database; events are synthetic envelopes (the emitters are the
// purchasing module). Every test owns a fresh legal entity + outlet + chart.
//
// Assumptions (the brief fixes the contract, a few details are open):
// - The journal's entry date is the outlet business date of the event instant
//   (`returnedAt` of a return, `businessDate` of a petty purchase). Test events
//   keep `occurredAt` equal to that instant so both readings agree.
// - The return journal's source type is `purchase_return` and the petty one
//   `petty_purchase`; idempotency keys are `aj:purchase-return:<id>` and
//   `aj:petty-purchase:<id>` (brief Potongan B.3).
// - Journal lines are compared per role with each side summed. A zero amount
//   makes no line (brief Potongan A.5), so a role with no line is absent.
// - An event of another tenant, an accounting module that is off and a return
//   of value 0 all answer `{ status: "ignored" }` and write nothing.
// - A purchase return is not an order: "Pesanan latihan" (training orders)
//   does not apply to these events.
// - A `stock.moved` row of a purchase return (movementType `return`, source
//   `purchase_return`) is the inventory bridge's to ignore: the return journal
//   comes from `purchase_return.recorded` alone, never twice.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  isoDateTimeSchema,
  tenantIdSchema,
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  deliverAutoJournalEvent,
  type AutoJournalResult,
} from "../services/accounting-auto-journal-consumer.ts";
import { deliverInventoryGlEvent } from "../services/inventory-gl-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
/** Fixed "now" of the consumer; every business instant below is in the past. */
const NOW = new Date("2026-11-08T03:00:00Z");
/** 2026-10-15 12:00 in Jakarta: business date 2026-10-15. */
const DAY = "2026-10-15T05:00:00.000Z";
/** 2026-11-02 12:00 in Jakarta: business date 2026-11-02. */
const PETTY_DAY = "2026-11-02T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});
const FLAGS_OFF = JSON.stringify({ modules: [], integrationProviders: [] });

type Role =
  | "grni"
  | "accounts_payable"
  | "inventory"
  | "ppn_input"
  | "petty_cash"
  | "petty_purchase_expense"
  | "cogs";

const CHART: [Role, string, string, string, string][] = [
  ["petty_cash", "1102", "Kas Kecil", "asset", "cash_and_equivalents"],
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
  ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  [
    "petty_purchase_expense",
    "5104",
    "Pembelian Langsung (Kas Kecil)",
    "expense",
    "cogs",
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

async function makeTenant(flags: string = FLAGS_ON): Promise<Tenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Retur Pembelian', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `uji-prj-${id.slice(0, 8)}`,
      flags,
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

async function setModules(tenant: Tenant, flags: string): Promise<void> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenant.id, flags],
  );
}

/** A legal entity + outlet + CoA with every posting role mapped + open periods. */
async function makeWorld(tenant: Tenant): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entity, tenant.id, `Entity PR ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PR', 'Jl. PR', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      tenant.id,
      tenant.brandId,
      entity,
      `PR-${short()}`.toUpperCase(),
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

/** A second outlet of the same legal entity (for envelope/payload mismatches). */
async function makeOutlet(world: World): Promise<string> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PR 2', 'Jl. PR 2', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletId,
      world.tenant.id,
      world.tenant.brandId,
      world.entity,
      `PR-${short()}`.toUpperCase(),
    ],
  );
  return outletId;
}

// ---- synthetic events -------------------------------------------------------

function envelope(
  world: World,
  input: {
    id?: string;
    /** Envelope outlet; defaults to the world's outlet. */
    outletId?: string;
    name: string;
    aggregateType: string;
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  },
): EventEnvelope {
  const id = input.id ?? createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId: world.tenant.id,
    outletId: input.outletId ?? world.outletId,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: input.occurredAt,
    actor: { type: "system" },
    idempotencyKey: `prj-test-${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

type ReturnAmounts = {
  uninvoicedValueIdr: number;
  invoicedValueIdr: number;
  ppnIdr: number;
};

function purchaseReturnRecorded(
  world: World,
  returnId: string,
  amounts: ReturnAmounts,
  id?: string,
  overrides: {
    envelopeOutletId?: string;
    payload?: Record<string, unknown>;
    omit?: string[];
  } = {},
): EventEnvelope {
  const payload: Record<string, unknown> = {
    purchaseReturnId: returnId,
    supplierId: randomUUID(),
    outletId: world.outletId,
    number: `KN/2026/10/${short()}`,
    valueIdr: amounts.uninvoicedValueIdr + amounts.invoicedValueIdr,
    uninvoicedValueIdr: amounts.uninvoicedValueIdr,
    invoicedValueIdr: amounts.invoicedValueIdr,
    ppnIdr: amounts.ppnIdr,
    returnedBy: randomUUID(),
    returnedAt: DAY,
    ...overrides.payload,
  };
  for (const key of overrides.omit ?? []) delete payload[key];
  return envelope(world, {
    ...(id === undefined ? {} : { id }),
    ...(overrides.envelopeOutletId === undefined
      ? {}
      : { outletId: overrides.envelopeOutletId }),
    name: "purchase_return.recorded",
    aggregateType: "purchase_return",
    aggregateId: returnId,
    occurredAt: DAY,
    payload,
  });
}

function pettyPurchaseRecorded(
  world: World,
  pettyId: string,
  amountIdr: number,
  id?: string,
  overrides: {
    envelopeOutletId?: string;
    payload?: Record<string, unknown>;
  } = {},
): EventEnvelope {
  return envelope(world, {
    ...(id === undefined ? {} : { id }),
    ...(overrides.envelopeOutletId === undefined
      ? {}
      : { outletId: overrides.envelopeOutletId }),
    name: "petty_purchase.recorded",
    aggregateType: "petty_purchase",
    aggregateId: pettyId,
    occurredAt: PETTY_DAY,
    payload: {
      pettyPurchaseId: pettyId,
      outletId: world.outletId,
      amountIdr,
      businessDate: "2026-11-02",
      paidBy: randomUUID(),
      paidAt: PETTY_DAY,
      ...overrides.payload,
    },
  });
}

function deliver(
  tenant: Tenant,
  event: EventEnvelope,
): Promise<AutoJournalResult> {
  const context = contextOf(tenant);
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, NOW),
  );
}

/** Delivers and asserts the posting happened; returns the posted result. */
async function post(world: World, event: EventEnvelope) {
  const result = await deliver(world.tenant, event);
  expect(result.status).toBe("posted");
  if (result.status !== "posted") throw new Error("not posted");
  return result;
}

// ---- reads ------------------------------------------------------------------

type Entry = {
  id: string;
  entry_date: string;
  source_type: string;
  outlet_id: string | null;
};

async function entryOf(world: World, entryId: string): Promise<Entry> {
  const { rows } = await owner.query<Entry>(
    `SELECT id, entry_date::text AS entry_date, source_type, outlet_id
       FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND id = $3`,
    [world.tenant.id, world.entity, entryId],
  );
  expect(rows, `journal ${entryId}`).toHaveLength(1);
  return rows[0]!;
}

async function journalCount(world: World): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [world.tenant.id, world.entity],
  );
  return Number(rows[0]!.n);
}

async function journalIdOf(world: World, key: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
    [world.tenant.id, key],
  );
  expect(rows, key).toHaveLength(1);
  return rows[0]!.id;
}

type Line = { role: Role; debit: number; credit: number };

/** Lines of one journal summed per role, sorted by role. */
async function linesOf(world: World, entryId: string): Promise<Line[]> {
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

/** Total debits and credits of a journal: a posted journal always balances. */
async function expectBalanced(world: World, entryId: string): Promise<void> {
  const lines = await linesOf(world, entryId);
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
  // Each line carries exactly one positive side, never a negative amount.
  for (const line of lines) {
    expect(line.debit).toBeGreaterThanOrEqual(0);
    expect(line.credit).toBeGreaterThanOrEqual(0);
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  // Journals and tenants stay (append-only, random names).
  await owner.end();
});

// ============================================================================

describe("purchase_return.recorded posts the return of goods", () => {
  it("PRP-JOURNAL-01 a return before invoicing posts Dr grni / Cr inventory, balanced", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const returnId = randomUUID();
    const result = await post(
      world,
      purchaseReturnRecorded(world, returnId, {
        uninvoicedValueIdr: 185_000,
        invoicedValueIdr: 0,
        ppnIdr: 0,
      }),
    );

    expect(result.entryDate).toBe("2026-10-15");
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.source_type).toBe("purchase_return");
    expect(entry.outlet_id).toBe(world.outletId);
    expect(await journalIdOf(world, `aj:purchase-return:${returnId}`)).toBe(
      result.journalEntryId,
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "grni", debit: 185_000, credit: 0 },
      { role: "inventory", debit: 0, credit: 185_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("PRP-JOURNAL-02 a return after invoicing posts Dr accounts_payable (value + PPN) / Cr inventory, Cr ppn_input, balanced", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const result = await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), {
        uninvoicedValueIdr: 0,
        invoicedValueIdr: 100_000,
        ppnIdr: 11_000,
      }),
    );

    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "accounts_payable", debit: 111_000, credit: 0 },
      { role: "inventory", debit: 0, credit: 100_000 },
      { role: "ppn_input", debit: 0, credit: 11_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("PRP-JOURNAL-03 an invoiced return without PPN posts no ppn_input line", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const result = await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), {
        uninvoicedValueIdr: 0,
        invoicedValueIdr: 100_000,
        ppnIdr: 0,
      }),
    );

    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "accounts_payable", debit: 100_000, credit: 0 },
      { role: "inventory", debit: 0, credit: 100_000 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });

  it("PRP-JOURNAL-04 a mixed return splits Dr grni and Dr accounts_payable, one balanced journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const result = await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), {
        uninvoicedValueIdr: 60_000,
        invoicedValueIdr: 40_000,
        ppnIdr: 4_400,
      }),
    );

    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "accounts_payable", debit: 44_400, credit: 0 },
      { role: "grni", debit: 60_000, credit: 0 },
      { role: "inventory", debit: 0, credit: 100_000 },
      { role: "ppn_input", debit: 0, credit: 4_400 },
    ]);
    await expectBalanced(world, result.journalEntryId);
    expect(await journalCount(world)).toBe(1);
  });
});

describe("petty_purchase.recorded posts the petty purchase", () => {
  it("PRP-PETTY-01 posts Dr petty_purchase_expense (5104) / Cr petty_cash on the business date, balanced", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const pettyId = randomUUID();
    const result = await post(
      world,
      pettyPurchaseRecorded(world, pettyId, 285_000),
    );

    expect(result.entryDate).toBe("2026-11-02");
    const entry = await entryOf(world, result.journalEntryId);
    expect(entry.source_type).toBe("petty_purchase");
    expect(entry.outlet_id).toBe(world.outletId);
    expect(await journalIdOf(world, `aj:petty-purchase:${pettyId}`)).toBe(
      result.journalEntryId,
    );
    expect(await linesOf(world, result.journalEntryId)).toEqual([
      { role: "petty_cash", debit: 0, credit: 285_000 },
      { role: "petty_purchase_expense", debit: 285_000, credit: 0 },
    ]);
    await expectBalanced(world, result.journalEntryId);
  });
});

describe("delivery is idempotent", () => {
  it("PRP-REPLAY-01 the same return twice posts one journal, the second answer is already_posted", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const returnId = randomUUID();
    const amounts = {
      uninvoicedValueIdr: 60_000,
      invoicedValueIdr: 40_000,
      ppnIdr: 4_400,
    };
    const event = purchaseReturnRecorded(world, returnId, amounts);

    const first = await post(world, event);
    expect(await deliver(tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    // A re-sent envelope of the same return (new event id) is the same fact.
    expect(
      await deliver(tenant, purchaseReturnRecorded(world, returnId, amounts)),
    ).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);
  });

  it("PRP-REPLAY-02 the same petty purchase twice posts one journal, the second answer is already_posted", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const pettyId = randomUUID();
    const event = pettyPurchaseRecorded(world, pettyId, 285_000);

    const first = await post(world, event);
    expect(await deliver(tenant, event)).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(
      await deliver(tenant, pettyPurchaseRecorded(world, pettyId, 285_000)),
    ).toEqual({
      status: "already_posted",
      journalEntryId: first.journalEntryId,
    });
    expect(await journalCount(world)).toBe(1);
  });

  it("PRP-CONCURRENT-01 the same return delivered twice at once posts exactly one journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const returnId = randomUUID();
    const amounts = {
      uninvoicedValueIdr: 60_000,
      invoicedValueIdr: 40_000,
      ppnIdr: 4_400,
    };
    const event = purchaseReturnRecorded(world, returnId, amounts);

    const results = await Promise.all([
      deliver(tenant, event),
      deliver(tenant, event),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "already_posted",
      "posted",
    ]);
    expect(await journalCount(world)).toBe(1);
    const journalId = await journalIdOf(
      world,
      `aj:purchase-return:${returnId}`,
    );
    for (const result of results) {
      if (result.status !== "posted" && result.status !== "already_posted")
        throw new Error(`unexpected status ${result.status}`);
      expect(result.journalEntryId).toBe(journalId);
    }
  });

  it("PRP-CONCURRENT-02 the same petty purchase delivered twice at once posts exactly one journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const pettyId = randomUUID();

    const results = await Promise.all([
      deliver(tenant, pettyPurchaseRecorded(world, pettyId, 285_000)),
      deliver(tenant, pettyPurchaseRecorded(world, pettyId, 285_000)),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "already_posted",
      "posted",
    ]);
    expect(await journalCount(world)).toBe(1);
  });

  it("PRP-REPLAY-03 two different returns post two journals", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const amounts = {
      uninvoicedValueIdr: 50_000,
      invoicedValueIdr: 0,
      ppnIdr: 0,
    };
    const first = await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), amounts),
    );
    const second = await post(
      world,
      purchaseReturnRecorded(world, randomUUID(), amounts),
    );
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
    expect(await journalCount(world)).toBe(2);
  });
});

describe("events that must not post", () => {
  it("PRP-TENANT-01 an event of another tenant is ignored and writes nothing in either tenant", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const worldA = await makeWorld(tenantA);
    const worldB = await makeWorld(tenantB);
    const foreignReturn = purchaseReturnRecorded(worldB, randomUUID(), {
      uninvoicedValueIdr: 185_000,
      invoicedValueIdr: 0,
      ppnIdr: 0,
    });
    const foreignPetty = pettyPurchaseRecorded(worldB, randomUUID(), 285_000);

    // Delivered under tenant A's context, but the envelope names tenant B.
    expect(await deliver(tenantA, foreignReturn)).toEqual({
      status: "ignored",
    });
    expect(await deliver(tenantA, foreignPetty)).toEqual({
      status: "ignored",
    });
    expect(await journalCount(worldA)).toBe(0);
    expect(await journalCount(worldB)).toBe(0);

    // Positive control: the same envelopes post under their own tenant, so the
    // ignore above is the tenant check and not a broken fixture.
    expect((await deliver(tenantB, foreignReturn)).status).toBe("posted");
    expect((await deliver(tenantB, foreignPetty)).status).toBe("posted");
    expect(await journalCount(worldB)).toBe(2);
    expect(await journalCount(worldA)).toBe(0);
  });

  it("PRP-MODULE-01 with accounting off both events are ignored and write nothing; switched on again they post", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const returnEvent = purchaseReturnRecorded(world, randomUUID(), {
      uninvoicedValueIdr: 185_000,
      invoicedValueIdr: 0,
      ppnIdr: 0,
    });
    const pettyEvent = pettyPurchaseRecorded(world, randomUUID(), 285_000);

    await setModules(tenant, FLAGS_OFF);
    try {
      expect(await deliver(tenant, returnEvent)).toEqual({
        status: "ignored",
      });
      expect(await deliver(tenant, pettyEvent)).toEqual({
        status: "ignored",
      });
      expect(await journalCount(world)).toBe(0);
    } finally {
      await setModules(tenant, FLAGS_ON);
    }

    expect((await deliver(tenant, returnEvent)).status).toBe("posted");
    expect((await deliver(tenant, pettyEvent)).status).toBe("posted");
    expect(await journalCount(world)).toBe(2);
  });

  it("PRP-ZERO-01 a return of value 0 is ignored and writes no journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    expect(
      await deliver(
        tenant,
        purchaseReturnRecorded(world, randomUUID(), {
          uninvoicedValueIdr: 0,
          invoicedValueIdr: 0,
          ppnIdr: 0,
        }),
      ),
    ).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);

    // Positive control: the same shape with a nonzero value posts.
    expect(
      (
        await deliver(
          tenant,
          purchaseReturnRecorded(world, randomUUID(), {
            uninvoicedValueIdr: 1_000,
            invoicedValueIdr: 0,
            ppnIdr: 0,
          }),
        )
      ).status,
    ).toBe("posted");
    expect(await journalCount(world)).toBe(1);
  });
});

describe("envelope and payload that disagree or are malformed", () => {
  // Assumption (spec silent): an envelope whose outlet differs from the payload
  // outlet, and a payload that fails its schema, are not-posted, never a crash:
  // the consumer answers a non-retryable `parked` result with code
  // AUTO_JOURNAL_PAYLOAD_INVALID (a dead-letter, not a silent ignore, so ops
  // can see it). Each case asserts no journal, then a well-formed control posts.
  const PARKED_INVALID = {
    status: "parked",
    code: "AUTO_JOURNAL_PAYLOAD_INVALID",
    retryable: false,
  };
  const returnAmounts = {
    uninvoicedValueIdr: 185_000,
    invoicedValueIdr: 0,
    ppnIdr: 0,
  };

  it("PRP-ENVELOPE-01 a return whose envelope outlet differs from the payload outlet, is parked and posts nothing", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const otherOutlet = await makeOutlet(world);
    const returnId = randomUUID();

    expect(
      await deliver(
        tenant,
        purchaseReturnRecorded(world, returnId, returnAmounts, undefined, {
          envelopeOutletId: otherOutlet,
        }),
      ),
    ).toEqual(PARKED_INVALID);
    expect(await journalCount(world)).toBe(0);

    // Positive control: matching outlets post.
    expect(
      (
        await deliver(
          tenant,
          purchaseReturnRecorded(world, returnId, returnAmounts),
        )
      ).status,
    ).toBe("posted");
    expect(await journalCount(world)).toBe(1);
  });

  it("PRP-ENVELOPE-02 a petty purchase whose envelope outlet differs from the payload outlet, is parked and posts nothing", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const otherOutlet = await makeOutlet(world);
    const pettyId = randomUUID();

    expect(
      await deliver(
        tenant,
        pettyPurchaseRecorded(world, pettyId, 285_000, undefined, {
          envelopeOutletId: otherOutlet,
        }),
      ),
    ).toEqual(PARKED_INVALID);
    expect(await journalCount(world)).toBe(0);

    expect(
      (await deliver(tenant, pettyPurchaseRecorded(world, pettyId, 285_000)))
        .status,
    ).toBe("posted");
    expect(await journalCount(world)).toBe(1);
  });

  it("PRP-LEGACY-01 a legacy return payload without outletId and split is parked (no crash), no journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const legacy = purchaseReturnRecorded(
      world,
      randomUUID(),
      returnAmounts,
      undefined,
      {
        omit: ["outletId", "uninvoicedValueIdr", "invoicedValueIdr", "ppnIdr"],
      },
    );

    expect(await deliver(tenant, legacy)).toEqual(PARKED_INVALID);
    expect(await journalCount(world)).toBe(0);
  });

  it("PRP-INVALID-01 a return with a negative ppnIdr is parked and writes no journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);

    expect(
      await deliver(
        tenant,
        purchaseReturnRecorded(world, randomUUID(), {
          uninvoicedValueIdr: 0,
          invoicedValueIdr: 100_000,
          ppnIdr: -11_000,
        }),
      ),
    ).toEqual(PARKED_INVALID);
    expect(await journalCount(world)).toBe(0);
  });

  it("PRP-INVALID-02 a petty purchase with a bad pettyPurchaseId uuid is parked and writes no journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);

    expect(
      await deliver(
        tenant,
        pettyPurchaseRecorded(world, randomUUID(), 285_000, undefined, {
          payload: { pettyPurchaseId: "not-a-uuid" },
        }),
      ),
    ).toEqual(PARKED_INVALID);
    expect(await journalCount(world)).toBe(0);
  });

  it("PRP-INVALID-03 a petty purchase with an impossible businessDate (2026-13-45) is parked and writes no journal", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);

    expect(
      await deliver(
        tenant,
        pettyPurchaseRecorded(world, randomUUID(), 285_000, undefined, {
          payload: { businessDate: "2026-13-45" },
        }),
      ),
    ).toEqual(PARKED_INVALID);
    expect(await journalCount(world)).toBe(0);
  });
});

describe("the inventory bridge leaves the purchase return to purchase_return.recorded", () => {
  it("PRP-BRIDGE-01 the stock.moved row of a purchase return is ignored: no journal, no second posting", async () => {
    const tenant = await makeTenant();
    const world = await makeWorld(tenant);
    const context = contextOf(tenant);
    const uom = await owner.query<{ id: string }>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'g', 'g') RETURNING id",
      [tenant.id],
    );
    const location = await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
      [tenant.id, world.outletId, `Gudang PR ${short()}`],
    );
    const item = await owner.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
      [tenant.id, `Kopi ${short()}`, uom.rows[0]!.id],
    );
    const base = {
      outletId: world.outletId,
      locationId: location.rows[0]!.id,
      inventoryItemId: item.rows[0]!.id,
      actor: { type: "system" as const },
    };
    await recordStockMovement(context, {
      ...base,
      movementType: "receipt",
      quantity: decimal4("5.0000"),
      unitCostIdr: decimal4("1000.0000"),
      batchId: null,
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      occurredAt: isoDateTimeSchema.parse("2026-10-01T05:00:00.000Z"),
    });
    const returned = await recordStockMovement(context, {
      ...base,
      movementType: "return",
      quantity: decimal4("-1.0000"),
      unitCostIdr: decimal4("1000.0000"),
      batchId: null,
      sourceType: "purchase_return",
      sourceId: randomUUID(),
      occurredAt: isoDateTimeSchema.parse(DAY),
    });
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
          AND event->'payload'->>'ledgerEntryId' = $2`,
      [tenant.id, returned.id],
    );
    expect(rows, "stock.moved outbox row of the return").toHaveLength(1);
    const event = eventEnvelopeSchema.parse(rows[0]!.event);

    const result = await withTenant(db, context, (tx) =>
      deliverInventoryGlEvent(context, event, tx, NOW),
    );
    expect(result).toEqual({ status: "ignored" });
    expect(await journalCount(world)).toBe(0);
  });
});
