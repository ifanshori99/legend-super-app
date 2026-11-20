// Payroll -> GL bridge (bead legend-4n3r; PRD v1.7 §3 D.30 "Jurnal Payroll",
// PAYR-04, PAYR-05): `payroll.locked`, `payroll.paid`, `payroll.reversed`,
// `employee_loan.disbursed` and `reimbursement.paid` become GL journals
// through `deliverPayrollGlEvent`.
//
// Runs the real services against the disposable PostgreSQL test database in a
// fresh isolated tenant. Every test owns a fresh legal entity with the
// standard F&B chart provisioned by `provisionStandardChart` (journals are
// append-only, so nothing leaks between tests). Events are built with the
// shared payroll event schemas and delivered inside `withTenant` like the
// worker does.
//
// Follow-ups (brief docs/briefs/sub-payroll-journal-followups.md):
// - legend-75kr: custom deductions credit the entity's payroll_custom_deduction
//   account (a liability when the tenant remaps it), LATE still credits 6101;
//   totals written before `customDeductionsIdr` post as before.
// - legend-k8sz: a service charge mapped to revenue is paid out from 6101, never
//   from the revenue account; a legacy expense / asset / equity mapping keeps the
//   base rule (the mapped account is debited, as POS credited it). The reversal
//   mirrors the entry.
// - legend-1coh: a kasbon disbursed via bank credits 1103, via cash 1102,
//   without `disbursedVia` (old events) 1102.
//
// Decisions pinned here:
// - A replay of an event posts nothing new (the idempotency key returns the
//   entry already posted).
// - A second reversal of the same entry under ANOTHER key is refused with
//   JOURNAL_ALREADY_REVERSED (unique `journal_entries_reversal_once_key`).
// - A reversal whose totals differ from the locked entry throws and posts
//   nothing.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  employeeLoanDisbursed,
  payrollLocked,
  payrollPaid,
  payrollReversed,
  payrollRunTotalsSchema,
  reimbursementPaid,
  type PayrollRunTotals,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import {
  reverseJournal,
  reverseJournalInTransaction,
} from "../services/accounting-journal.service.ts";
import {
  deliverPayrollGlEvent,
  type PayrollGlResult,
} from "../services/payroll-gl-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
/** Fixed "now" for the consumer; every instant below is in the past. */
const NOW = new Date("2026-11-30T03:00:00Z");
const PERIOD_START = "2026-09-26";
const PERIOD_END = "2026-10-25";
const PAY_DATE = "2026-10-27";
const LOCKED_AT = "2026-10-26T05:00:00.000Z";
/** 2026-11-27 12:00 in Jakarta. */
const PAID_AT = "2026-11-27T05:00:00.000Z";
/** 2026-11-09 12:00 in Jakarta. */
const REVERSED_AT = "2026-11-09T05:00:00.000Z";

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});
const FLAGS_OFF = JSON.stringify({ modules: [], integrationProviders: [] });

let tenantId: string;
let brandId: string;

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

type World = { entity: string; outletId: string; employeeId: string };

async function makeWorld(): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  const employeeId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity Payroll ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Payroll', 'Jl. Gaji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `PR-${short()}`.toUpperCase()],
  );
  await owner.query(
    `INSERT INTO employees (id, tenant_id, legal_entity_id, employee_no, full_name, home_outlet_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Payroll', $5, 'pkwt', '2026-01-01', 'active')`,
    [employeeId, tenantId, entity, `E-${short().toUpperCase()}`, outletId],
  );
  await withTenant(db, context(), (tx) =>
    provisionStandardChart(tx, context(), entity, null),
  );
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entity, period],
    );
  return { entity, outletId, employeeId };
}

async function setModules(flags: string): Promise<void> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId, flags],
  );
}

/** Run totals; gross 10.000.000, BPJS 300.000 / 400.000, PPh 21 250.000. */
function totalsOf(
  over: {
    gross?: number;
    employerRefund?: number;
    employerAllowanceRefund?: number;
    /** LATE (other deductions that are not custom). */
    late?: number;
    /** Custom deductions (koperasi dues); part of otherDeductionsIdr. */
    custom?: number;
    /** Service charge inside gross. */
    serviceCharge?: number;
    /** Kasbon installments deducted by the run (legend-8tfvr). */
    loan?: number;
  } = {},
): PayrollRunTotals {
  const gross = over.gross ?? 10_000_000;
  const bpjsEmp = 300_000;
  const withheld = 250_000;
  const erf = over.employerRefund ?? 0;
  const late = over.late ?? 0;
  const custom = over.custom ?? 0;
  const loan = over.loan ?? 0;
  const deductions = bpjsEmp + withheld + late + custom + loan;
  const net = gross - deductions;
  return payrollRunTotalsSchema.parse({
    employeeCount: 1,
    grossIdr: gross,
    deductionsIdr: deductions,
    netIdr: net,
    bpjsEmployeeIdr: bpjsEmp,
    bpjsCompanyIdr: 400_000,
    pph21Idr: withheld - erf,
    pph21WithheldIdr: withheld,
    pph21EmployerBorneIdr: 0,
    pph21RefundIdr: 0,
    pph21EmployerRefundIdr: erf,
    pph21EmployerAllowanceRefundIdr: over.employerAllowanceRefund ?? 0,
    loanRepaymentIdr: loan,
    pph21ReceivableIdr: 0,
    pph21ReceivableCollectedIdr: 0,
    otherDeductionsIdr: late + custom,
    customDeductionsIdr: custom,
    serviceChargeIdr: over.serviceCharge ?? 0,
    reimbursementIdr: 0,
    // A split payout: most by bank transfer, the rest in cash.
    bankTransferIdr: net - 450_000,
    cashIdr: 450_000,
  });
}

const actor = () => ({ type: "user" as const, id: randomUUID() });

function envelope<Name extends string>(
  name: Name,
  aggregateType: string,
  aggregateId: string,
  occurredAt: string,
  payloadSchemaRef: string,
  payload: unknown,
) {
  return {
    id: createUlid(),
    tenantId,
    outletId: null,
    name,
    version: 1,
    aggregateType,
    aggregateId,
    sequence: 1,
    occurredAt,
    actor: actor(),
    deviceId: null,
    idempotencyKey: `${name}-${aggregateId}-${randomUUID()}`,
    payloadSchemaRef,
    payload,
  };
}

const runRef = (world: World, runId: string) => ({
  payrollRunId: runId,
  legalEntityId: world.entity,
  runType: "regular",
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  payDate: PAY_DATE,
});

const lockedEvent = (world: World, runId: string, totals: PayrollRunTotals) =>
  payrollLocked.envelopeSchema.parse(
    envelope(
      "payroll.locked",
      "payroll",
      runId,
      LOCKED_AT,
      "payroll.locked.v1",
      {
        ...runRef(world, runId),
        totals,
        lockedBy: randomUUID(),
        lockedAt: LOCKED_AT,
      },
    ),
  );

const paidEvent = (world: World, runId: string, totals: PayrollRunTotals) =>
  payrollPaid.envelopeSchema.parse(
    envelope("payroll.paid", "payroll", runId, PAID_AT, "payroll.paid.v1", {
      ...runRef(world, runId),
      netIdr: totals.netIdr,
      bankTransferIdr: totals.bankTransferIdr,
      cashIdr: totals.cashIdr,
      bankTransferFileId: null,
      paidBy: randomUUID(),
      paidAt: PAID_AT,
    }),
  );

const reversedEvent = (
  world: World,
  runId: string,
  totals: PayrollRunTotals,
) => {
  const requestedBy = randomUUID();
  return payrollReversed.envelopeSchema.parse(
    envelope(
      "payroll.reversed",
      "payroll",
      runId,
      REVERSED_AT,
      "payroll.reversed.v1",
      {
        ...runRef(world, runId),
        totals,
        requestedBy,
        approvedBy: randomUUID(),
        reversedAt: REVERSED_AT,
      },
    ),
  );
};

type AnyEvent = Parameters<typeof deliverPayrollGlEvent>[1];

function deliver(event: unknown): Promise<PayrollGlResult> {
  return withTenant(db, context(), (tx) =>
    deliverPayrollGlEvent(context(), event as AnyEvent, tx, NOW),
  );
}

type Entry = {
  id: string;
  entry_date: string;
  source_type: string;
  source_id: string | null;
  reversal_of: string | null;
  idempotency_key: string;
};

async function entriesOf(
  world: World,
  where = "TRUE",
  args: unknown[] = [],
): Promise<Entry[]> {
  const { rows } = await owner.query<Entry>(
    `SELECT id, entry_date::text AS entry_date, source_type, source_id, reversal_of, idempotency_key
       FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND ${where}
      ORDER BY created_at, id`,
    [tenantId, world.entity, ...args],
  );
  return rows;
}

const bySource = (world: World, sourceId: string) =>
  entriesOf(world, "source_id = $3", [sourceId]);
const byKey = (world: World, key: string) =>
  entriesOf(world, "idempotency_key = $3", [key]);

/** Lines of an entry by GL code. */
async function linesOf(entryId: string) {
  const { rows } = await owner.query<{
    code: string;
    debit_idr: string;
    credit_idr: string;
  }>(
    `SELECT a.code, l.debit_idr::text AS debit_idr, l.credit_idr::text AS credit_idr
       FROM journal_lines l
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND l.entry_id = $2
      ORDER BY l.line_no`,
    [tenantId, entryId],
  );
  return rows.map((r) => ({
    code: r.code,
    debit: Number(r.debit_idr),
    credit: Number(r.credit_idr),
  }));
}

type ByCode = Record<string, { debit: number; credit: number }>;
function byCode(lines: { code: string; debit: number; credit: number }[]) {
  const out: ByCode = {};
  for (const l of lines) {
    const row = (out[l.code] ??= { debit: 0, credit: 0 });
    row.debit += l.debit;
    row.credit += l.credit;
  }
  return out;
}
const sumOf = (
  lines: { debit: number; credit: number }[],
  side: "debit" | "credit",
) => lines.reduce((s, l) => s + l[side], 0);

type AccountKind = {
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  reportGroup: string;
};
const KINDS = {
  asset: { type: "asset", reportGroup: "current_asset" },
  liability: { type: "liability", reportGroup: "current_liability" },
  equity: { type: "equity", reportGroup: "equity" },
  revenue: { type: "revenue", reportGroup: "revenue" },
  expense: { type: "expense", reportGroup: "operating_expense" },
} as const satisfies Record<string, AccountKind>;

/** A new postable leaf account in the entity's chart; returns its id. */
async function addAccount(
  world: World,
  code: string,
  kind: keyof typeof KINDS,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, true)`,
    [
      id,
      tenantId,
      world.entity,
      code,
      `Akun uji ${code}`,
      KINDS[kind].type,
      KINDS[kind].reportGroup,
    ],
  );
  return id;
}

/**
 * Points a role at another account of the entity, straight in the database
 * (the way a mapping saved before a type guard exists).
 */
async function remap(world: World, role: string, accountId: string) {
  const result = await owner.query(
    `UPDATE account_mappings SET account_id = $4
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
    [tenantId, world.entity, role, accountId],
  );
  expect(result.rowCount).toBe(1);
}

async function unmap(world: World, role: string) {
  const result = await owner.query(
    "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
    [tenantId, world.entity, role],
  );
  expect(result.rowCount).toBe(1);
}

const mappedAccountCode = async (world: World, role: string) =>
  (
    await owner.query<{ code: string }>(
      `SELECT a.code FROM account_mappings m
         JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
        WHERE m.tenant_id = $1 AND m.legal_entity_id = $2 AND m.role = $3`,
      [tenantId, world.entity, role],
    )
  ).rows[0]?.code;

/** Lines of the run's locked entry and of its reversal (when there is one) by code. */
async function lockedAndReversed(world: World, runId: string) {
  const [locked] = await byKey(world, `payroll-gl:locked:${runId}`);
  const [reversal] = await byKey(world, `payroll-gl:reversed:${runId}`);
  return {
    locked: byCode(await linesOf(locked!.id)),
    reversed: reversal ? byCode(await linesOf(reversal.id)) : undefined,
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Payroll GL', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-payroll-gl-${tenantId.slice(0, 8)}`,
      FLAGS_ON,
      JSON.stringify({
        maxOutlets: 50,
        maxActiveEmployees: 10,
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
    [brandId, tenantId],
  );
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  // Journals and the tenant stay (append-only, random names).
  await owner.end();
});

describe("payroll.locked", () => {
  it("posts one balanced entry on the period end, source payroll, sourceId = run", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    const result = await deliver(lockedEvent(world, runId, totals));
    expect(result.status).toBe("posted");

    const entries = await bySource(world, runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source_type: "payroll",
      source_id: runId,
      entry_date: PERIOD_END,
      idempotency_key: `payroll-gl:locked:${runId}`,
      reversal_of: null,
    });
    if (result.status === "posted")
      expect(result.journalEntryId).toBe(entries[0]!.id);
    const lines = await linesOf(entries[0]!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    // gross - refund + employer BPJS + borne + receivable
    expect(sumOf(lines, "debit")).toBe(10_400_000);
    const codes = byCode(lines);
    expect(codes["2103"]).toEqual({ debit: 0, credit: totals.netIdr });
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 0 });
  });

  it("posts the allowance part of an employer refund to 6101 and the rest to 6111", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    await deliver(
      lockedEvent(
        world,
        runId,
        totalsOf({ employerRefund: 40_000, employerAllowanceRefund: 30_000 }),
      ),
    );
    const [entry] = await bySource(world, runId);
    const codes = byCode(await linesOf(entry!.id));
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 30_000 });
    expect(codes["6111"]).toEqual({ debit: 0, credit: 10_000 });
  });

  it("[gl-unchanged] a run that deducted kasbon credits employee_receivable (1204) by loanRepaymentIdr, balanced (legend-8tfvr)", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({ loan: 150_000 });
    expect(totals.loanRepaymentIdr).toBe(150_000);
    const result = await deliver(lockedEvent(world, runId, totals));
    expect(result.status).toBe("posted");

    const [entry] = await bySource(world, runId);
    const lines = await linesOf(entry!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    const codes = byCode(lines);
    expect(codes["1204"]).toEqual({ debit: 0, credit: 150_000 });
    expect(codes["2103"]).toEqual({ debit: 0, credit: totals.netIdr });
  });

  it("replaying the same event posts nothing new", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const event = lockedEvent(world, runId, totalsOf());
    const first = await deliver(event);
    const second = await deliver(event);
    expect(second).toEqual(first);
    expect(await entriesOf(world)).toHaveLength(1);
  });
});

describe("payroll.paid", () => {
  it("posts Dr 2103 = net, Cr 1103 / 1102 on the payment date; 2103 nets to zero after lock + paid", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    const result = await deliver(paidEvent(world, runId, totals));
    expect(result.status).toBe("posted");

    const paid = await byKey(world, `payroll-gl:paid:${runId}`);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      source_type: "payroll",
      source_id: runId,
      entry_date: "2026-11-27",
    });
    const lines = await linesOf(paid[0]!.id);
    expect(byCode(lines)).toEqual({
      "2103": { debit: totals.netIdr, credit: 0 },
      "1103": { debit: 0, credit: totals.bankTransferIdr },
      "1102": { debit: 0, credit: 450_000 },
    });
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));

    const all = byCode(
      (
        await Promise.all((await entriesOf(world)).map((e) => linesOf(e.id)))
      ).flat(),
    );
    expect(all["2103"]).toEqual({
      debit: totals.netIdr,
      credit: totals.netIdr,
    });
  });

  it("replay posts nothing new", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    const event = paidEvent(world, runId, totals);
    await deliver(event);
    await deliver(event);
    expect(await entriesOf(world)).toHaveLength(2);
  });

  it("is skipped when the run has no locked entry", async () => {
    const world = await makeWorld();
    const result = await deliver(paidEvent(world, randomUUID(), totalsOf()));
    expect(result).toEqual({ status: "skipped" });
    expect(await entriesOf(world)).toHaveLength(0);
  });
});

describe("payroll.reversed", () => {
  it("reverses the locked entry: one entry, reversal_of = locked id, mirrored lines", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({
      employerRefund: 40_000,
      employerAllowanceRefund: 30_000,
    });
    await deliver(lockedEvent(world, runId, totals));
    const [locked] = await bySource(world, runId);

    const result = await deliver(reversedEvent(world, runId, totals));
    expect(result.status).toBe("posted");
    const reversals = await entriesOf(world, "reversal_of = $3", [locked!.id]);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      source_type: "reversal",
      entry_date: "2026-11-09",
      idempotency_key: `payroll-gl:reversed:${runId}`,
    });
    if (result.status === "posted")
      expect(result.journalEntryId).toBe(reversals[0]!.id);

    const lockedLines = byCode(await linesOf(locked!.id));
    const reversedLines = byCode(await linesOf(reversals[0]!.id));
    expect(Object.keys(reversedLines).sort()).toEqual(
      Object.keys(lockedLines).sort(),
    );
    for (const [code, row] of Object.entries(lockedLines))
      expect(reversedLines[code]).toEqual({
        debit: row.credit,
        credit: row.debit,
      });
  });

  it("replaying the event returns the same reversal; another key is refused (JOURNAL_ALREADY_REVERSED)", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    const [locked] = await bySource(world, runId);
    const event = reversedEvent(world, runId, totals);
    const first = await deliver(event);
    const second = await deliver(event);
    expect(second).toEqual(first);
    expect(
      await entriesOf(world, "reversal_of = $3", [locked!.id]),
    ).toHaveLength(1);

    await expect(
      withTenant(db, context(), (tx) =>
        reverseJournalInTransaction(
          tx,
          context(),
          locked!.id,
          {
            entryDate: "2026-11-10",
            reason: "Payroll dibatalkan (PAYR-05)",
            idempotencyKey: `payroll-gl:reversed:${randomUUID()}`,
            postedBy: null,
          },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "JOURNAL_ALREADY_REVERSED" });
    expect(
      await entriesOf(world, "reversal_of = $3", [locked!.id]),
    ).toHaveLength(1);
  });

  it("throws and posts nothing when the totals differ from the locked entry", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    await deliver(lockedEvent(world, runId, totalsOf()));
    await expect(
      deliver(reversedEvent(world, runId, totalsOf({ gross: 10_500_000 }))),
    ).rejects.toThrow(/differ from the locked entry/);
    expect(await entriesOf(world)).toHaveLength(1);
  });

  it("is skipped when the run has no locked entry", async () => {
    const world = await makeWorld();
    const result = await deliver(
      reversedEvent(world, randomUUID(), totalsOf()),
    );
    expect(result).toEqual({ status: "skipped" });
    expect(await entriesOf(world)).toHaveLength(0);
  });
});

type Envelope = { payload: Record<string, unknown> };
const withPayload = <E extends Envelope>(
  event: E,
  over: Record<string, unknown>,
) => ({ ...event, payload: { ...event.payload, ...over } }) as E;

describe("payroll GL guards (architect review)", () => {
  it("dates a payment by the Jakarta calendar day: 01:30 WIB on 1 Nov is November", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    await deliver(
      withPayload(paidEvent(world, runId, totals), {
        paidAt: "2026-10-31T18:30:00.000Z",
      }),
    );
    const [paid] = await byKey(world, `payroll-gl:paid:${runId}`);
    expect(paid).toMatchObject({ entry_date: "2026-11-01" });
  });

  it("dates the run journal at the lock day when it locks before the period end", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    await deliver(
      withPayload(lockedEvent(world, runId, totalsOf()), {
        lockedAt: "2026-10-20T05:00:00.000Z",
      }),
    );
    const [locked] = await byKey(world, `payroll-gl:locked:${runId}`);
    expect(locked).toMatchObject({ entry_date: "2026-10-20" });
  });

  it("never dates a reversal before the entry it reverses", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    await deliver(
      withPayload(reversedEvent(world, runId, totals), {
        reversedAt: "2026-10-24T05:00:00.000Z",
      }),
    );
    const [reversal] = await byKey(world, `payroll-gl:reversed:${runId}`);
    expect(reversal).toMatchObject({ entry_date: PERIOD_END });
  });

  it("refuses to reverse a paid run and posts nothing", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    await deliver(paidEvent(world, runId, totals));
    await expect(deliver(reversedEvent(world, runId, totals))).rejects.toThrow(
      /already paid/,
    );
    expect(await entriesOf(world)).toHaveLength(2);
  });

  // Card 1218 (SO 1216 F-P1b): the manual endpoint refuses the run-lock
  // accrual; mirroring it removes the salary expense and raises the profit
  // share. The correction is cancelling the run (payroll.reversed).
  it("[1218-PAYROLL-LOCK] a locked run's accrual cannot be reversed by hand: 409 AUTO_JOURNAL_LOCKED, nothing posted", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    expect((await deliver(lockedEvent(world, runId, totals))).status).toBe(
      "posted",
    );
    const [locked] = await byKey(world, `payroll-gl:locked:${runId}`);
    await expect(
      reverseJournal(
        context(),
        locked!.id,
        {
          entryDate: "2026-11-10",
          reason: "Dibalik manual (1218)",
          idempotencyKey: `manual:${randomUUID()}`,
        },
        userIdSchema.parse(randomUUID()),
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409, code: "AUTO_JOURNAL_LOCKED" });
    expect(
      await entriesOf(world, "reversal_of = $3", [locked!.id]),
    ).toHaveLength(0);
  });

  it("skips when the locked entry was already reversed by hand", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    const [locked] = await bySource(world, runId);
    await withTenant(db, context(), (tx) =>
      reverseJournalInTransaction(
        tx,
        context(),
        locked!.id,
        {
          entryDate: "2026-11-10",
          reason: "Dibalik manual",
          idempotencyKey: `manual:${randomUUID()}`,
          postedBy: null,
        },
        NOW,
      ),
    );
    const result = await deliver(reversedEvent(world, runId, totals));
    expect(result).toEqual({ status: "skipped" });
    expect(
      await entriesOf(world, "reversal_of = $3", [locked!.id]),
    ).toHaveLength(1);
  });

  it("throws when the totals match but an amount moved between lines", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, runId, totals));
    // Same gross and net, but 100.000 of 6101 moved to service charge.
    const moved = payrollRunTotalsSchema.parse({
      ...totals,
      serviceChargeIdr: 100_000,
    });
    await expect(deliver(reversedEvent(world, runId, moved))).rejects.toThrow(
      /differ from the locked entry/,
    );
    expect(await entriesOf(world)).toHaveLength(1);
  });
});

describe("custom deductions (legend-75kr)", () => {
  it("provisioning maps payroll_custom_deduction to 6101 like salary_expense", async () => {
    const world = await makeWorld();
    expect(await mappedAccountCode(world, "payroll_custom_deduction")).toBe(
      "6101",
    );
    expect(await mappedAccountCode(world, "salary_expense")).toBe("6101");
  });

  it("default mapping: LATE 75.000 and custom 60.000 both credit 6101 (today's posting)", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    await deliver(
      lockedEvent(world, runId, totalsOf({ late: 75_000, custom: 60_000 })),
    );
    const [entry] = await bySource(world, runId);
    const lines = await linesOf(entry!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    const codes = byCode(lines);
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 135_000 });
    expect(codes["2103"]).toEqual({ debit: 0, credit: 9_315_000 });
  });

  it("remapped to a liability: custom credits it, LATE still credits 6101, reversal nets to zero", async () => {
    const world = await makeWorld();
    const koperasi = await addAccount(world, "2190", "liability");
    await remap(world, "payroll_custom_deduction", koperasi);
    const runId = randomUUID();
    const totals = totalsOf({ late: 75_000, custom: 60_000 });

    await deliver(lockedEvent(world, runId, totals));
    const [entry] = await bySource(world, runId);
    const lines = await linesOf(entry!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    expect(byCode(lines)).toEqual({
      "6101": { debit: 10_000_000, credit: 75_000 },
      "2190": { debit: 0, credit: 60_000 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: 9_315_000 },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    });

    const result = await deliver(reversedEvent(world, runId, totals));
    expect(result.status).toBe("posted");
    const { locked, reversed } = await lockedAndReversed(world, runId);
    expect(reversed).toBeDefined();
    for (const [code, row] of Object.entries(locked))
      expect(reversed![code]).toEqual({ debit: row.credit, credit: row.debit });
    expect(reversed!["2190"]).toEqual({ debit: 60_000, credit: 0 });
  });

  it("totals written before customDeductionsIdr post as before, even with the role remapped", async () => {
    const world = await makeWorld();
    const koperasi = await addAccount(world, "2190", "liability");
    await remap(world, "payroll_custom_deduction", koperasi);
    const runId = randomUUID();
    const { customDeductionsIdr, ...legacy } = totalsOf({ late: 75_000 });
    void customDeductionsIdr;
    const parsed = payrollRunTotalsSchema.parse(legacy);
    expect(parsed.customDeductionsIdr).toBe(0);

    await deliver(lockedEvent(world, runId, legacy as PayrollRunTotals));
    const [entry] = await bySource(world, runId);
    const codes = byCode(await linesOf(entry!.id));
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 75_000 });
    expect(codes["2190"]).toBeUndefined();

    // The reversal, built from the same legacy totals, passes the cross-check.
    const reversal = await deliver(reversedEvent(world, runId, parsed));
    expect(reversal.status).toBe("posted");
  });

  it("a reversal whose custom part moved to LATE differs from the locked entry", async () => {
    const world = await makeWorld();
    const koperasi = await addAccount(world, "2190", "liability");
    await remap(world, "payroll_custom_deduction", koperasi);
    const runId = randomUUID();
    await deliver(
      lockedEvent(world, runId, totalsOf({ late: 10_000, custom: 60_000 })),
    );
    // Same net and same other-deductions total (70.000), but all of it is LATE
    // now. LATE is non-zero on both sides: the cross-check compares sorted
    // amounts, so a zero LATE would hide the move.
    await expect(
      deliver(
        reversedEvent(world, runId, totalsOf({ late: 70_000, custom: 0 })),
      ),
    ).rejects.toThrow(/differ from the locked entry/);
    expect(await entriesOf(world)).toHaveLength(1);
  });

  // Assumption: the pre-legend-75kr shape is what the consumer posted before the
  // split, i.e. one salary_expense (6101) credit = late + custom. It is built here
  // by locking with totals that have no customDeductionsIdr (all 135.000 in
  // otherDeductionsIdr), which yields exactly that single credit. The tenant then
  // remaps payroll_custom_deduction to a liability and the run is reversed with
  // totals from the current code, which carry custom 60.000 + LATE 75.000.
  describe("run locked in the pre-legend-75kr shape", () => {
    const LATE = 75_000;
    const CUSTOM = 60_000;

    async function lockedLegacy() {
      const world = await makeWorld();
      const runId = randomUUID();
      await deliver(
        lockedEvent(world, runId, totalsOf({ late: LATE + CUSTOM })),
      );
      const [entry] = await bySource(world, runId);
      const lines = await linesOf(entry!.id);
      const salary = lines.filter((l) => l.code === "6101" && l.credit > 0);
      // The legacy shape: a single 6101 credit that holds late + custom.
      expect(salary).toEqual([
        { code: "6101", debit: 0, credit: LATE + CUSTOM },
      ]);
      const koperasi = await addAccount(world, "2190", "liability");
      await remap(world, "payroll_custom_deduction", koperasi);
      return { world, runId };
    }

    it("payroll.reversed with customDeductionsIdr > 0 succeeds and nets to zero per account", async () => {
      const { world, runId } = await lockedLegacy();
      const totals = totalsOf({ late: LATE, custom: CUSTOM });
      expect(totals.customDeductionsIdr).toBeGreaterThan(0);

      const result = await deliver(reversedEvent(world, runId, totals));
      expect(result.status).toBe("posted");

      const { locked, reversed } = await lockedAndReversed(world, runId);
      expect(reversed).toBeDefined();
      expect(Object.keys(reversed!).sort()).toEqual(Object.keys(locked).sort());
      for (const code of Object.keys(locked)) {
        const debit = locked[code]!.debit + reversed![code]!.debit;
        const credit = locked[code]!.credit + reversed![code]!.credit;
        expect(debit - credit, `account ${code}`).toBe(0);
      }
      // Nothing was ever posted to the remapped liability.
      expect(locked["2190"]).toBeUndefined();
      expect(reversed!["2190"]).toBeUndefined();
    });

    it("a reversal whose totals differ in amount still throws and posts nothing", async () => {
      const { world, runId } = await lockedLegacy();
      // Custom 70.000 instead of 60.000: other deductions and net differ.
      await expect(
        deliver(
          reversedEvent(
            world,
            runId,
            totalsOf({ late: LATE, custom: CUSTOM + 10_000 }),
          ),
        ),
      ).rejects.toThrow(/differ from the locked entry/);
      expect(await entriesOf(world)).toHaveLength(1);
    });
  });
});

describe("service charge payout never debits revenue (legend-k8sz)", () => {
  const SC = 1_000_000;

  it("liability mapping (standard 2106): Dr 2106 1.000.000, Dr 6101 9.000.000", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    await deliver(lockedEvent(world, runId, totalsOf({ serviceCharge: SC })));
    const [entry] = await bySource(world, runId);
    const lines = await linesOf(entry!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    const codes = byCode(lines);
    expect(codes["2106"]).toEqual({ debit: SC, credit: 0 });
    expect(codes["6101"]).toEqual({ debit: 9_000_000, credit: 0 });
  });

  it("revenue mapping: the payout is debited to 6101, the revenue account gets no line, the reversal works", async () => {
    const world = await makeWorld();
    const revenue = await addAccount(world, "4190", "revenue");
    await remap(world, "service_charge", revenue);
    const runId = randomUUID();
    const totals = totalsOf({ serviceCharge: SC });

    const result = await deliver(lockedEvent(world, runId, totals));
    expect(result.status).toBe("posted");
    const [entry] = await bySource(world, runId);
    const lines = await linesOf(entry!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    expect(byCode(lines)).toEqual({
      "6101": { debit: 10_000_000, credit: 0 },
      "6102": { debit: 400_000, credit: 0 },
      "2103": { debit: 0, credit: totals.netIdr },
      "2104": { debit: 0, credit: 700_000 },
      "2202": { debit: 0, credit: 250_000 },
    });

    expect((await deliver(reversedEvent(world, runId, totals))).status).toBe(
      "posted",
    );
    const { locked, reversed } = await lockedAndReversed(world, runId);
    expect(reversed).toBeDefined();
    expect(reversed!["4190"]).toBeUndefined();
    for (const [code, row] of Object.entries(locked))
      expect(reversed![code]).toEqual({ debit: row.credit, credit: row.debit });
  });

  it.each(["expense", "asset", "equity"] as const)(
    "legacy %s mapping written straight into the DB: the payout debits the mapped account, not 6101",
    async (kind) => {
      const world = await makeWorld();
      const legacy = await addAccount(world, "9190", kind);
      await remap(world, "service_charge", legacy);
      const runId = randomUUID();
      const totals = totalsOf({ serviceCharge: SC });

      await deliver(lockedEvent(world, runId, totals));
      const [entry] = await bySource(world, runId);
      const lines = await linesOf(entry!.id);
      expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
      const codes = byCode(lines);
      // Base rule: the mapped service_charge account is debited, as POS credited it.
      expect(codes["9190"]).toEqual({ debit: SC, credit: 0 });
      expect(codes["2106"]).toBeUndefined();
      expect(codes["6101"]).toEqual({ debit: 9_000_000, credit: 0 });

      expect((await deliver(reversedEvent(world, runId, totals))).status).toBe(
        "posted",
      );
      const { reversed } = await lockedAndReversed(world, runId);
      expect(reversed!["9190"]).toEqual({ debit: 0, credit: SC });
      expect(reversed!["6101"]).toEqual({ debit: 0, credit: 9_000_000 });
    },
  );

  it("revenue mapping with every follow-up in one run: custom, LATE and service charge", async () => {
    const world = await makeWorld();
    const revenue = await addAccount(world, "4190", "revenue");
    const koperasi = await addAccount(world, "2190", "liability");
    await remap(world, "service_charge", revenue);
    await remap(world, "payroll_custom_deduction", koperasi);
    const runId = randomUUID();
    const totals = totalsOf({
      serviceCharge: SC,
      late: 75_000,
      custom: 60_000,
    });

    await deliver(lockedEvent(world, runId, totals));
    const [entry] = await bySource(world, runId);
    const lines = await linesOf(entry!.id);
    expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
    const codes = byCode(lines);
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 75_000 });
    expect(codes["2190"]).toEqual({ debit: 0, credit: 60_000 });
    expect(codes["4190"]).toBeUndefined();

    await deliver(reversedEvent(world, runId, totals));
    const all = byCode(
      (
        await Promise.all((await entriesOf(world)).map((e) => linesOf(e.id)))
      ).flat(),
    );
    for (const row of Object.values(all)) expect(row.debit).toBe(row.credit);
  });

  it("a revenue mapping with no service charge in the run posts as usual", async () => {
    const world = await makeWorld();
    const revenue = await addAccount(world, "4190", "revenue");
    await remap(world, "service_charge", revenue);
    const runId = randomUUID();
    await deliver(lockedEvent(world, runId, totalsOf()));
    const [entry] = await bySource(world, runId);
    const codes = byCode(await linesOf(entry!.id));
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 0 });
    expect(codes["4190"]).toBeUndefined();
  });

  it("no service_charge mapping at all: a run with service charge fails ACCOUNT_MAPPING_MISSING and posts nothing", async () => {
    const world = await makeWorld();
    await unmap(world, "service_charge");
    await expect(
      deliver(
        lockedEvent(world, randomUUID(), totalsOf({ serviceCharge: SC })),
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_MAPPING_MISSING" });
    expect(await entriesOf(world)).toHaveLength(0);
  });

  it("no service_charge mapping but no service charge in the run: posts", async () => {
    const world = await makeWorld();
    await unmap(world, "service_charge");
    const result = await deliver(lockedEvent(world, randomUUID(), totalsOf()));
    expect(result.status).toBe("posted");
  });
});

describe("employee_loan.disbursed", () => {
  const loanEvent = (
    world: World,
    loanId: string,
    disbursedVia?: "cash" | "bank",
  ) =>
    employeeLoanDisbursed.envelopeSchema.parse(
      envelope(
        "employee_loan.disbursed",
        "employee_loan",
        loanId,
        PAID_AT,
        "employee_loan.disbursed.v1",
        {
          employeeLoanId: loanId,
          employeeId: world.employeeId,
          legalEntityId: world.entity,
          principalIdr: 1_500_000,
          ...(disbursedVia ? { disbursedVia } : {}),
          disbursedBy: randomUUID(),
          disbursedAt: PAID_AT,
        },
      ),
    );

  it.each([
    ["bank", "1103"],
    ["cash", "1102"],
    [undefined, "1102"],
  ] as const)(
    "disbursedVia %s credits %s (Dr 1204)",
    async (via, creditCode) => {
      const world = await makeWorld();
      const loanId = randomUUID();
      const result = await deliver(loanEvent(world, loanId, via));
      expect(result.status).toBe("posted");
      const entries = await byKey(world, `payroll-gl:loan:${loanId}`);
      expect(entries).toHaveLength(1);
      const lines = await linesOf(entries[0]!.id);
      expect(sumOf(lines, "debit")).toBe(sumOf(lines, "credit"));
      expect(byCode(lines)).toEqual({
        "1204": { debit: 1_500_000, credit: 0 },
        [creditCode]: { debit: 0, credit: 1_500_000 },
      });
    },
  );

  it("replaying a bank disbursement posts nothing new (same idempotency key)", async () => {
    const world = await makeWorld();
    const loanId = randomUUID();
    const event = loanEvent(world, loanId, "bank");
    const first = await deliver(event);
    const second = await deliver(event);
    expect(second).toEqual(first);
    expect(await entriesOf(world)).toHaveLength(1);
  });

  it("posts Dr 1204 / Cr 1102 by the principal", async () => {
    const world = await makeWorld();
    const loanId = randomUUID();
    const result = await deliver(
      employeeLoanDisbursed.envelopeSchema.parse(
        envelope(
          "employee_loan.disbursed",
          "employee_loan",
          loanId,
          PAID_AT,
          "employee_loan.disbursed.v1",
          {
            employeeLoanId: loanId,
            employeeId: world.employeeId,
            legalEntityId: world.entity,
            principalIdr: 1_500_000,
            disbursedBy: randomUUID(),
            disbursedAt: PAID_AT,
          },
        ),
      ),
    );
    expect(result.status).toBe("posted");
    const entries = await byKey(world, `payroll-gl:loan:${loanId}`);
    expect(entries).toHaveLength(1);
    expect(byCode(await linesOf(entries[0]!.id))).toEqual({
      "1204": { debit: 1_500_000, credit: 0 },
      "1102": { debit: 0, credit: 1_500_000 },
    });
  });
});

describe("reimbursement.paid", () => {
  const reimbursement = (
    world: World,
    reimbursementId: string,
    payout: "payroll" | "cash",
  ) =>
    reimbursementPaid.envelopeSchema.parse(
      envelope(
        "reimbursement.paid",
        "reimbursement",
        reimbursementId,
        PAID_AT,
        "reimbursement.paid.v1",
        {
          reimbursementId,
          employeeId: world.employeeId,
          categoryId: randomUUID(),
          amountIdr: 300_000,
          payout,
          payrollRunId: payout === "payroll" ? randomUUID() : null,
          paidAt: PAID_AT,
        },
      ),
    );

  it("a payroll payout posts nothing", async () => {
    const world = await makeWorld();
    const id = randomUUID();
    const result = await deliver(reimbursement(world, id, "payroll"));
    expect(result).toEqual({ status: "skipped" });
    expect(await entriesOf(world)).toHaveLength(0);
  });

  it("a cash payout posts Dr 6110 / Cr 1102 on the employee's legal entity", async () => {
    const world = await makeWorld();
    const id = randomUUID();
    const result = await deliver(reimbursement(world, id, "cash"));
    expect(result.status).toBe("posted");
    const entries = await byKey(world, `payroll-gl:reimbursement:${id}`);
    expect(entries).toHaveLength(1);
    expect(byCode(await linesOf(entries[0]!.id))).toEqual({
      "6110": { debit: 300_000, credit: 0 },
      "1102": { debit: 0, credit: 300_000 },
    });
  });
});

describe("accounting disabled", () => {
  it("posts nothing for any payroll event", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf();
    await setModules(FLAGS_OFF);
    try {
      const results = [
        await deliver(lockedEvent(world, runId, totals)),
        await deliver(paidEvent(world, runId, totals)),
        await deliver(reversedEvent(world, runId, totals)),
      ];
      for (const result of results)
        expect(result).toEqual({ status: "ignored" });
    } finally {
      await setModules(FLAGS_ON);
    }
    expect(await entriesOf(world)).toHaveLength(0);
  });
  it("still settles and reverses a run locked while it was on", async () => {
    const world = await makeWorld();
    const paidRun = randomUUID();
    const reversedRun = randomUUID();
    const totals = totalsOf();
    await deliver(lockedEvent(world, paidRun, totals));
    await deliver(lockedEvent(world, reversedRun, totals));
    await setModules(FLAGS_OFF);
    try {
      expect((await deliver(paidEvent(world, paidRun, totals))).status).toBe(
        "posted",
      );
      expect(
        (await deliver(reversedEvent(world, reversedRun, totals))).status,
      ).toBe("posted");
    } finally {
      await setModules(FLAGS_ON);
    }
    expect(await byKey(world, `payroll-gl:paid:${paidRun}`)).toHaveLength(1);
    expect(
      await byKey(world, `payroll-gl:reversed:${reversedRun}`),
    ).toHaveLength(1);
  });
});

describe("all-zero run", () => {
  it("posts nothing and does not fail lock, paid or reversed", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const zero = payrollRunTotalsSchema.parse(
      Object.fromEntries(
        Object.entries(totalsOf()).map(([key, value]) => [
          key,
          key === "employeeCount" ? value : 0,
        ]),
      ),
    );
    const results = [
      await deliver(lockedEvent(world, runId, zero)),
      await deliver(paidEvent(world, runId, zero)),
      await deliver(reversedEvent(world, runId, zero)),
    ];
    for (const result of results) expect(result).toEqual({ status: "skipped" });
    expect(await entriesOf(world)).toHaveLength(0);
  });
});
