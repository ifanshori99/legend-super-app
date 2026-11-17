// Payroll GL: company PPh 21 refund (bead legend-51h1, card 972).
// Expected (docs/briefs/972-payroll-sisa.md, shared posting rules): when a run
// withheld more than the tax owed, the PPh 21 payable (2202) the locked journal
// credits equals
//   pph21Idr = withheld + employer borne + receivable - employee refund - employer refund
// the journal balances, posts once per run (idempotent even when the event is
// redelivered under another envelope id), and the reversal nets 2202 to zero.
//
// Same harness as payroll-gl-consumer.test.ts (real services, disposable
// PostgreSQL, fresh tenant and legal entity per test). GL codes: 2202 Utang
// PPh 21, 2103 Utang gaji, 6101 beban gaji, 6111 beban PPh 21 ditanggung.
//
// ASSUMPTION: shared totals already carry the refund/borne columns, so this is
// a regression pin. A failure means the journal drops a refund leg, understates
// the payable, double-posts a run, or fails to balance.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  payrollLocked,
  payrollReversed,
  payrollRunTotalsSchema,
  type PayrollRunTotals,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import {
  deliverPayrollGlEvent,
  type PayrollGlResult,
} from "../services/payroll-gl-consumer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const NOW = new Date("2026-11-30T03:00:00Z");
const PERIOD_START = "2026-09-26";
const PERIOD_END = "2026-10-25";
const PAY_DATE = "2026-10-27";
const LOCKED_AT = "2026-10-26T05:00:00.000Z";
const REVERSED_AT = "2026-11-09T05:00:00.000Z";

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

type World = { entity: string };

async function makeWorld(): Promise<World> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity Refund ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Refund', 'Jl. Gaji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `RF-${short()}`.toUpperCase()],
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
  return { entity };
}

type TotalsInput = {
  gross?: number;
  withheld?: number;
  borne?: number;
  receivable?: number;
  refund?: number;
  employerRefund?: number;
  employerAllowanceRefund?: number;
};

/** Consistent run totals (net, deductions and pph21Idr from the contract formulas). */
function totalsOf(o: TotalsInput = {}): PayrollRunTotals {
  const gross = o.gross ?? 10_000_000;
  const withheld = o.withheld ?? 250_000;
  const borne = o.borne ?? 0;
  const receivable = o.receivable ?? 0;
  const refund = o.refund ?? 0;
  const erf = o.employerRefund ?? 0;
  const bpjsEmp = 300_000;
  const deductions = bpjsEmp + withheld;
  const net = gross - deductions;
  return payrollRunTotalsSchema.parse({
    employeeCount: 1,
    grossIdr: gross,
    deductionsIdr: deductions,
    netIdr: net,
    bpjsEmployeeIdr: bpjsEmp,
    bpjsCompanyIdr: 400_000,
    pph21Idr: withheld + borne + receivable - refund - erf,
    pph21WithheldIdr: withheld,
    pph21EmployerBorneIdr: borne,
    pph21RefundIdr: refund,
    pph21EmployerRefundIdr: erf,
    pph21EmployerAllowanceRefundIdr: o.employerAllowanceRefund ?? 0,
    loanRepaymentIdr: 0,
    pph21ReceivableIdr: receivable,
    pph21ReceivableCollectedIdr: 0,
    otherDeductionsIdr: 0,
    customDeductionsIdr: 0,
    serviceChargeIdr: 0,
    reimbursementIdr: 0,
    bankTransferIdr: net,
    cashIdr: 0,
  });
}

function envelope(
  name: string,
  runId: string,
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
    aggregateType: "payroll",
    aggregateId: runId,
    sequence: 1,
    occurredAt,
    actor: { type: "user" as const, id: randomUUID() },
    deviceId: null,
    // A fresh key per event: idempotency per run must come from the run, not
    // from the envelope.
    idempotencyKey: `${name}-${runId}-${randomUUID()}`,
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
    envelope("payroll.locked", runId, LOCKED_AT, "payroll.locked.v1", {
      ...runRef(world, runId),
      totals,
      lockedBy: randomUUID(),
      lockedAt: LOCKED_AT,
    }),
  );

const reversedEvent = (world: World, runId: string, totals: PayrollRunTotals) =>
  payrollReversed.envelopeSchema.parse(
    envelope("payroll.reversed", runId, REVERSED_AT, "payroll.reversed.v1", {
      ...runRef(world, runId),
      totals,
      requestedBy: randomUUID(),
      approvedBy: randomUUID(),
      reversedAt: REVERSED_AT,
    }),
  );

type AnyEvent = Parameters<typeof deliverPayrollGlEvent>[1];

function deliver(event: unknown): Promise<PayrollGlResult> {
  return withTenant(db, context(), (tx) =>
    deliverPayrollGlEvent(context(), event as AnyEvent, tx, NOW),
  );
}

async function entryIdsOf(world: World, runId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3
      ORDER BY created_at, id`,
    [tenantId, world.entity, runId],
  );
  return rows.map((r) => r.id);
}

type Row = { debit: number; credit: number };

/** Sum of lines by GL code over the given entries (all entries when omitted). */
async function byCode(
  world: World,
  entryIds?: string[],
): Promise<Record<string, Row>> {
  const { rows } = await owner.query<{
    code: string;
    debit_idr: string;
    credit_idr: string;
  }>(
    `SELECT a.code, l.debit_idr::text AS debit_idr, l.credit_idr::text AS credit_idr
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2
        AND ($3::uuid[] IS NULL OR l.entry_id = ANY($3::uuid[]))`,
    [tenantId, world.entity, entryIds ?? null],
  );
  const out: Record<string, Row> = {};
  for (const r of rows) {
    const row = (out[r.code] ??= { debit: 0, credit: 0 });
    row.debit += Number(r.debit_idr);
    row.credit += Number(r.credit_idr);
  }
  return out;
}

const total = (codes: Record<string, Row>, side: keyof Row) =>
  Object.values(codes).reduce((s, r) => s + r[side], 0);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantId = randomUUID();
  brandId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Payroll Refund', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantId,
      `uji-payroll-refund-${tenantId.slice(0, 8)}`,
      JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
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
  await owner.end();
});

describe("payroll.locked with PPh 21 refunds (legend-51h1)", () => {
  it("employee refund: Cr 2202 = pph21Idr (withheld - refund), journal balanced", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    // Withheld 250.000, tax owed 200.000; 50.000 paid back to the employee as
    // an earning line (inside gross).
    const totals = totalsOf({ withheld: 250_000, refund: 50_000 });
    expect((await deliver(lockedEvent(world, runId, totals))).status).toBe(
      "posted",
    );
    const codes = await byCode(world, await entryIdsOf(world, runId));
    expect(total(codes, "debit")).toBe(total(codes, "credit"));
    expect(codes["2202"]).toEqual({ debit: 0, credit: 200_000 });
    expect(codes["2202"]!.credit).toBe(totals.pph21Idr);
    expect(codes["2103"]).toEqual({ debit: 0, credit: totals.netIdr });
  });

  it("company refund: the borne part returns to 6111, payable shrinks by the refund", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({
      withheld: 250_000,
      borne: 100_000,
      employerRefund: 40_000,
    });
    await deliver(lockedEvent(world, runId, totals));
    const codes = await byCode(world, await entryIdsOf(world, runId));
    expect(codes["2202"]).toEqual({ debit: 0, credit: 310_000 });
    expect(codes["6111"]).toEqual({ debit: 100_000, credit: 40_000 });
    expect(total(codes, "debit")).toBe(total(codes, "credit"));
  });

  it("company refund of a gross-up allowance returns to 6101, rest to 6111; payable = withheld - refund", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({
      withheld: 250_000,
      employerRefund: 40_000,
      employerAllowanceRefund: 30_000,
    });
    await deliver(lockedEvent(world, runId, totals));
    const codes = await byCode(world, await entryIdsOf(world, runId));
    expect(codes["2202"]).toEqual({ debit: 0, credit: 210_000 });
    expect(codes["6101"]).toEqual({ debit: 10_000_000, credit: 30_000 });
    expect(codes["6111"]).toEqual({ debit: 0, credit: 10_000 });
    expect(total(codes, "debit")).toBe(total(codes, "credit"));
  });

  it("all legs at once: employee refund, company refund, borne tax, receivable", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({
      withheld: 300_000,
      borne: 80_000,
      receivable: 25_000,
      refund: 60_000,
      employerRefund: 20_000,
      employerAllowanceRefund: 5_000,
    });
    await deliver(lockedEvent(world, runId, totals));
    const codes = await byCode(world, await entryIdsOf(world, runId));
    // 300.000 + 80.000 + 25.000 - 60.000 - 20.000
    expect(codes["2202"]).toEqual({ debit: 0, credit: 325_000 });
    expect(codes["2202"]!.credit).toBe(totals.pph21Idr);
    expect(total(codes, "debit")).toBe(total(codes, "credit"));
  });

  it("idempotent per run: a second locked event for the same run (new envelope id and key) posts nothing", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({ withheld: 250_000, refund: 50_000 });
    const first = await deliver(lockedEvent(world, runId, totals));
    const second = await deliver(lockedEvent(world, runId, totals));
    expect(second).toEqual(first);
    expect(await entryIdsOf(world, runId)).toHaveLength(1);
    expect((await byCode(world))["2202"]).toEqual({
      debit: 0,
      credit: 200_000,
    });
  });

  it("two runs add up in 2202 (no run overwrites the other)", async () => {
    const world = await makeWorld();
    await deliver(
      lockedEvent(
        world,
        randomUUID(),
        totalsOf({ withheld: 250_000, refund: 50_000 }),
      ),
    );
    await deliver(
      lockedEvent(
        world,
        randomUUID(),
        totalsOf({ withheld: 250_000, employerRefund: 40_000 }),
      ),
    );
    expect((await byCode(world))["2202"]).toEqual({
      debit: 0,
      credit: 200_000 + 210_000,
    });
  });
});

describe("payroll.reversed with PPh 21 refunds (legend-51h1)", () => {
  it("reversal nets 2202, 6111 and 6101 to zero and is idempotent per run", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    const totals = totalsOf({
      withheld: 300_000,
      borne: 80_000,
      refund: 60_000,
      employerRefund: 20_000,
      employerAllowanceRefund: 5_000,
    });
    await deliver(lockedEvent(world, runId, totals));
    const reversal = reversedEvent(world, runId, totals);
    expect((await deliver(reversal)).status).toBe("posted");
    // Redelivered under a new envelope: still one reversal. The reversal entry
    // is sourced from the locked entry, not the run, so only the locked entry
    // carries the run id; a second reversal would unbalance the netting below.
    await deliver(reversedEvent(world, runId, totals));
    expect(await entryIdsOf(world, runId)).toHaveLength(1);

    const codes = await byCode(world);
    for (const code of ["2202", "6111", "6101", "2103", "2104"])
      expect(codes[code]!.debit).toBe(codes[code]!.credit);
    expect(total(codes, "debit")).toBe(total(codes, "credit"));
  });

  it("a reversal whose refund differs from the locked run is refused and posts nothing", async () => {
    const world = await makeWorld();
    const runId = randomUUID();
    await deliver(
      lockedEvent(
        world,
        runId,
        totalsOf({ withheld: 250_000, refund: 50_000 }),
      ),
    );
    await expect(
      deliver(
        reversedEvent(
          world,
          runId,
          totalsOf({ withheld: 250_000, refund: 20_000 }),
        ),
      ),
    ).rejects.toThrow(/differ from the locked entry/);
    expect(await entryIdsOf(world, runId)).toHaveLength(1);
  });
});
