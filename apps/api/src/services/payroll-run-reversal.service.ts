// Payroll run reversal (PRD v1.7 §3 D.30, PAYR-05; beads legend-b9y4y,
// legend-yod9z; design docs/briefs/sub-payroll-run-lock-design.md §4). Trusted
// in-transaction writers: the caller wraps `withTenant`, a throw rolls back
// everything. Only a `locked` run can be reversed; a `paid` run never is.
//
// Lock order, same as the lock step: the tax-month advisory lock first, then
// the `payroll_runs` row `FOR UPDATE`, then plain reads, then writes. A request
// only touches its own run row (no month lock), so it never inverts the order.
//
// An approved reversal is refused while a live (locked or paid) run of the
// same tax month was computed on this run (`payroll_run_month_priors`, written
// at lock): reverse the later run first. The database trigger
// `payroll_runs_reversal_dependency_trg` enforces the same rule. Runs whose
// side effects the lock step does not perform (reimbursements, service charge,
// rapel) are not reversed here either: refusing never pays anyone more.
// Loans: the lock step lowers each loan by its recorded deduction
// (`payroll_loan_deductions`, legend-xo0xx, legend-8tfvr), so an approved
// reversal restores each loan's outstanding balance by exactly the recorded
// amount, once, and deletes those rows in the same transaction (a repeat finds
// none). The recorded sum has to equal the run's `loanRepaymentIdr`, otherwise
// the reversal is refused. Migration 0461 proves at commit that principal -
// outstanding equals the rows of locked or paid runs, so a missed or doubled
// restore cannot commit.
//
// A run that raised an employee receivable (`pph21ReceivableIdr` > 0) is also
// refused while another live run collected a receivable (`pph21_receivable`
// line) from the same employee: the collection would be left without its
// receivable. The collecting run has to be reversed first.

import { and, asc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  applyPayrollRunCommand,
  payrollReversed,
  payrollRunSchema,
  payslipCalculationSchema,
  type PayslipCalculation,
  type PayrollRun,
  type PayrollRunId,
} from "@starter/shared/hris/payroll";
import { accountingOpenItems } from "../db/schema/accounting-ap-fa.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import {
  payrollDisbursementBatches,
  payrollDisbursementItems,
} from "../db/schema/payroll-payout.ts";
import {
  payrollRapelFinalizations,
  payrollRapels,
} from "../db/schema/payroll-rapel.ts";
import {
  bankTransferFiles,
  employeeLoans,
  payrollLoanDeductions,
  payrollRunMonthPriors,
  payrollRuns,
  payslips,
} from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./hris-access.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { emitPayrollEvent } from "./payroll-events.ts";
import {
  assertNoSettledOvertimeCorrectionFromRun,
  lockOvertimeCorrectionScope,
  syncOvertimeCorrectionLedgerInTransaction,
} from "./payroll-overtime-correction.service.ts";
import { PPH21_BACKFILL_DOCUMENT_PREFIX } from "./payroll-pph21-receivable-backfill.service.ts";
import { syncPph21ReceivableOpenItemsInTransaction } from "./payroll-pph21-receivable-open-items.service.ts";
import {
  disputeFreezesBatchSql,
  disputeIsOpenSql,
} from "./payroll-payout-freeze-sql.ts";
import {
  lockPayrollRunMonth,
  lockPph21ReceivableScope,
} from "./payroll-run-pph21.service.ts";

type RunRow = typeof payrollRuns.$inferSelect;

const AUDIT_FIELDS = ["status", "reversalStatus"] as const;

/** Row to the shared run shape (ISO strings); also re-validates the row. */
function toPayrollRun(row: RunRow): PayrollRun {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return payrollRunSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    payrollPolicyId: row.payrollPolicyId,
    runType: row.runType,
    thrScheduleId: row.thrScheduleId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    status: row.status,
    simulationCount: row.simulationCount,
    lastSimulatedAt: iso(row.lastSimulatedAt),
    totals: row.totals,
    configSnapshot: row.configSnapshot,
    approvedByHr: row.approvedByHr,
    approvedByHrAt: iso(row.approvedByHrAt),
    approvedByFinance: row.approvedByFinance,
    approvedByFinanceAt: iso(row.approvedByFinanceAt),
    lockedBy: row.lockedBy,
    lockedAt: iso(row.lockedAt),
    paidBy: row.paidBy,
    paidAt: iso(row.paidAt),
    reversal: row.reversal,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function lockRunRow(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<RunRow> {
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .for("update");
  if (!row)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  return row;
}

/**
 * Totals that carry side effects the lock step does not perform. Loans are
 * checked apart (`restoreLoanDeductions`): they need recorded deductions.
 */
function hasUnsupportedTotals(run: PayrollRun): boolean {
  const totals = run.totals;
  return (
    totals !== null &&
    (totals.reimbursementIdr > 0 || totals.serviceChargeIdr > 0)
  );
}

async function assertNoRapelSideEffects(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
  const [finalized] = await tx
    .select({ payslipId: payrollRapelFinalizations.payslipId })
    .from(payrollRapelFinalizations)
    .where(
      and(
        eq(payrollRapelFinalizations.tenantId, tenantId),
        eq(payrollRapelFinalizations.payrollRunId, runId),
      ),
    )
    .limit(1);
  const [allocated] = await tx
    .select({ id: payrollRapels.id })
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenantId),
        eq(payrollRapels.payrollRunId, runId),
        eq(payrollRapels.status, "allocated"),
      ),
    )
    .limit(1);
  if (finalized || allocated) throw unsupported();
}

/**
 * Gives every loan the run deducted its recorded amount back, once, then
 * deletes the deduction rows so a repeat restores nothing. The recorded sum has
 * to equal the run's loan total; a run with a loan total and no matching rows
 * is refused (never guess an amount). A restore that would lift a loan above
 * its principal is refused. Loans lock in id order.
 */
async function restoreLoanDeductions(
  tx: Tx,
  tenantId: TenantId,
  run: PayrollRun,
  now: Date,
): Promise<void> {
  const rows = await tx
    .select({
      loanId: payrollLoanDeductions.loanId,
      amountIdr: payrollLoanDeductions.amountIdr,
    })
    .from(payrollLoanDeductions)
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(payrollLoanDeductions.payrollRunId, run.id),
      ),
    )
    .orderBy(payrollLoanDeductions.loanId);
  const recorded = rows.reduce((sum, row) => sum + Number(row.amountIdr), 0);
  if (recorded !== (run.totals?.loanRepaymentIdr ?? 0)) throw unsupported();
  if (rows.length === 0) return;
  for (const row of rows) {
    const [loan] = await tx
      .select({
        principalIdr: employeeLoans.principalIdr,
        outstandingIdr: employeeLoans.outstandingIdr,
        status: employeeLoans.status,
      })
      .from(employeeLoans)
      .where(
        and(
          eq(employeeLoans.tenantId, tenantId),
          eq(employeeLoans.id, row.loanId),
        ),
      )
      .for("update");
    const restored = loan
      ? Number(loan.outstandingIdr) + Number(row.amountIdr)
      : 0;
    if (
      !loan ||
      (loan.status !== "disbursed" && loan.status !== "settled") ||
      restored > Number(loan.principalIdr)
    )
      throw unsupported();
    await tx
      .update(employeeLoans)
      .set({
        outstandingIdr: idr(restored),
        status: "disbursed",
        settledAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(employeeLoans.tenantId, tenantId),
          eq(employeeLoans.id, row.loanId),
        ),
      );
  }
  await tx
    .delete(payrollLoanDeductions)
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(payrollLoanDeductions.payrollRunId, run.id),
      ),
    );
}

/**
 * legend-xo4cn: refuses the reversal of a run whose loan deductions touch an
 * employee with a completed offboarding. The frozen settlement snapshot holds
 * the loan balance as it was; restoring the deductions would lift the balance
 * above what the snapshot billed. Refusing is the safe rule (nobody is paid
 * more, no automatic difference is opened); reopening the settlement is a
 * separate, explicit decision. The employee's loans lock FOR UPDATE in id
 * order BEFORE the offboarding query, like `assertNoPendingPayrollDeduction`
 * in hris-offboarding.service.ts, so a completion running at the same time
 * either commits first (refused here) or waits for this transaction. One
 * affected employee refuses the whole run.
 */
async function assertNoCompletedSettlementLoanImpact(
  tx: Tx,
  tenantId: TenantId,
  run: Pick<PayrollRun, "id">,
): Promise<void> {
  const deducted = await tx
    .selectDistinct({ employeeId: payrollLoanDeductions.employeeId })
    .from(payrollLoanDeductions)
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(payrollLoanDeductions.payrollRunId, run.id),
      ),
    );
  if (deducted.length === 0) return;
  const employeeIds = deducted.map((row) => row.employeeId);
  await tx
    .select({ id: employeeLoans.id })
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, tenantId),
        inArray(employeeLoans.employeeId, employeeIds),
      ),
    )
    .orderBy(asc(employeeLoans.id))
    .for("update");
  const [settled] = await tx
    .select({ id: hrisOffboardings.id })
    .from(hrisOffboardings)
    .where(
      and(
        eq(hrisOffboardings.tenantId, tenantId),
        inArray(hrisOffboardings.employeeId, employeeIds),
        eq(hrisOffboardings.status, "completed"),
        sql`${hrisOffboardings.settlementSnapshot} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (settled)
    throw new HttpError(
      409,
      "PAYROLL_REVERSAL_LOAN_SETTLED",
      "Run tidak bisa dibatalkan: pinjaman karyawan sudah dibekukan di settlement offboarding yang selesai. Koreksi settlement dulu.",
    );
}

function unsupported(): HttpError {
  return new HttpError(
    409,
    "PAYROLL_RUN_LOCK_UNSUPPORTED",
    "Payroll ini memuat kasbon, reimbursement, service charge, atau rapel yang belum bisa dibatalkan lewat langkah ini.",
  );
}

/** Live (locked or paid) later runs computed on `runId`; caller holds locks. */
async function loadLiveDependentRunIds(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<PayrollRunId[]> {
  const rows = await tx
    .select({ id: payrollRunMonthPriors.payrollRunId })
    .from(payrollRunMonthPriors)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollRunMonthPriors.tenantId),
        eq(payrollRuns.id, payrollRunMonthPriors.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollRunMonthPriors.tenantId, tenantId),
        eq(payrollRunMonthPriors.priorPayrollRunId, runId),
        inArray(payrollRuns.status, ["locked", "paid"]),
      ),
    );
  return [...new Set(rows.map((row) => row.id))].sort();
}

/**
 * A bank file means money may already be on its way; freeing the period
 * would let a rerun pay the same people twice. Fail closed.
 */
async function assertNoBankFile(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
  const [file] = await tx
    .select({ id: bankTransferFiles.id })
    .from(bankTransferFiles)
    .where(
      and(
        eq(bankTransferFiles.tenantId, tenantId),
        eq(bankTransferFiles.payrollRunId, runId),
      ),
    )
    .limit(1);
  if (file)
    throw new HttpError(
      409,
      "PAYROLL_RUN_REVERSAL_BLOCKED",
      "File transfer bank sudah dibuat untuk payroll ini, jadi tidak bisa dibatalkan.",
    );
}

/**
 * A disbursement batch in progress, or any item that is on its way or paid,
 * means money may have left: freeing the period would let a rerun pay the same
 * people twice (legend-wnkep.1 R11). A batch frozen by a "not me" claim
 * (legend-l2zru) also blocks it, even when all its items failed: the claim must
 * be cleared first. The database trigger `payroll_runs_payout_guard_trg` is the
 * net; this gives the clear message.
 */
async function assertNoPayoutBatch(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
  const [openBatch] = await tx
    .select({ id: payrollDisbursementBatches.id })
    .from(payrollDisbursementBatches)
    .where(
      and(
        eq(payrollDisbursementBatches.tenantId, tenantId),
        eq(payrollDisbursementBatches.payrollRunId, runId),
        notInArray(payrollDisbursementBatches.status, [
          "completed",
          "partially_failed",
          "cancelled",
        ]),
      ),
    )
    .limit(1);
  const [movedItem] = await tx
    .select({ id: payrollDisbursementItems.id })
    .from(payrollDisbursementItems)
    .where(
      and(
        eq(payrollDisbursementItems.tenantId, tenantId),
        eq(payrollDisbursementItems.payrollRunId, runId),
        inArray(payrollDisbursementItems.status, [
          "sending",
          "exported",
          "unknown",
          "succeeded",
        ]),
      ),
    )
    .limit(1);
  const frozen = await tx.execute(sql`
    SELECT b.id FROM payroll_disbursement_batches b
     WHERE b.tenant_id = ${tenantId}::uuid AND b.payroll_run_id = ${runId}::uuid
       AND EXISTS (
         SELECT 1 FROM payroll_payout_batch_disputes d
          WHERE d.tenant_id = b.tenant_id
            AND ${disputeIsOpenSql}
            AND ${disputeFreezesBatchSql(sql`b.id`)})
     LIMIT 1`);
  if (frozen.rows.length > 0)
    throw new HttpError(
      409,
      "PAYOUT_BATCH_FROZEN",
      'Batch pembayaran payroll ini dibekukan karena ada pengakuan "bukan saya". Finance perlu memeriksanya dan membuka pembekuan.',
    );
  if (openBatch || movedItem)
    throw new HttpError(
      409,
      "PAYOUT_RUN_REVERSAL_BLOCKED",
      "Pembayaran gaji untuk payroll ini sedang berjalan atau sudah ada yang dibayar, jadi tidak bisa dibatalkan.",
    );
}

async function assertNoLiveDependents(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
  const dependents = await loadLiveDependentRunIds(tx, tenantId, runId);
  if (dependents.length > 0)
    throw new HttpError(
      409,
      "PAYROLL_RUN_REVERSAL_BLOCKED",
      `Payroll lain di bulan pajak ini dihitung dari payroll ini. Batalkan payroll yang lebih baru dulu. (${dependents.join(", ")})`,
    );
}

/** Opens and parses one stored payslip calculation; never echoes a value. */
function openCalculation(row: {
  id: string;
  tenantId: string;
  employeeId: string;
  calculationEncrypted: (typeof payslips.$inferSelect)["calculationEncrypted"];
  piiKeyVersion: number;
}): PayslipCalculation {
  let calc: PayslipCalculation;
  try {
    calc = payslipCalculationSchema.parse(
      JSON.parse(
        openPayrollValue(
          row.calculationEncrypted,
          {
            tenantId: row.tenantId,
            table: "payslips",
            rowId: row.id,
            field: "calculation",
          },
          row.piiKeyVersion,
        ),
      ),
    );
  } catch {
    throw reversalBlocked(
      "Slip gaji payroll ini tidak bisa dibaca, jadi tidak bisa dibatalkan.",
    );
  }
  if (calc.employeeId !== row.employeeId)
    throw reversalBlocked(
      "Slip gaji payroll ini tidak bisa dibaca, jadi tidak bisa dibatalkan.",
    );
  return calc;
}

function reversalBlocked(message: string): HttpError {
  return new HttpError(409, "PAYROLL_RUN_REVERSAL_BLOCKED", message);
}

const PAYSLIP_COLUMNS = {
  id: payslips.id,
  tenantId: payslips.tenantId,
  employeeId: payslips.employeeId,
  calculationEncrypted: payslips.calculationEncrypted,
  piiKeyVersion: payslips.piiKeyVersion,
} as const;

/**
 * Refuse while this run raised a receivable for an employee that another live
 * (locked or paid) run collected from: reversing would leave that collection
 * without its receivable and the employee short-paid.
 *
 * Also refuse while a live run locked LATER carries the open balance for an
 * employee this run raised or collected a receivable for
 * (`pph21ReceivableOpenAfterIdr`, legend-2fk79): that carried balance counts
 * this run and would go stale. Reverse the later run first. Refusing never
 * pays anyone more.
 */
async function assertNoCollectedReceivable(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
): Promise<void> {
  const mine = await tx
    .select(PAYSLIP_COLUMNS)
    .from(payslips)
    .where(
      and(eq(payslips.tenantId, tenantId), eq(payslips.payrollRunId, runId)),
    );
  const mineCalculations = mine.map((row) => ({
    employeeId: row.employeeId,
    calc: openCalculation(row),
  }));
  const raised = [
    ...new Set(
      mineCalculations
        .filter(({ calc }) => (calc.tax.pph21ReceivableIdr ?? 0) > 0)
        .map(({ employeeId }) => employeeId),
    ),
  ];
  const touched = [
    ...new Set(
      mineCalculations
        .filter(
          ({ calc }) =>
            (calc.tax.pph21ReceivableIdr ?? 0) > 0 ||
            calc.lines.some(
              (line) =>
                line.category === "pph21_receivable" && line.amountIdr > 0,
            ),
        )
        .map(({ employeeId }) => employeeId),
    ),
  ];
  if (touched.length === 0) return;
  const [thisRun] = await tx
    .select({
      lockedAt: payrollRuns.lockedAt,
      legalEntityId: payrollRuns.legalEntityId,
    })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)));
  // legend-i848k: a run before the open item existed was given ONE backfill
  // item for its employee. Reversing a run that raised OR collected a
  // receivable of that employee would move the slip balance away from that item
  // and the finance list would show more (or less) than the employee owes.
  if (touched.length > 0) {
    const [backfilled] = await tx
      .select({ id: accountingOpenItems.id })
      .from(accountingOpenItems)
      .where(
        and(
          eq(accountingOpenItems.tenantId, tenantId),
          eq(accountingOpenItems.kind, "receivable"),
          eq(accountingOpenItems.counterpartyType, "employee"),
          inArray(accountingOpenItems.counterpartyId, touched),
          thisRun
            ? eq(accountingOpenItems.legalEntityId, thisRun.legalEntityId)
            : undefined,
          sql`${accountingOpenItems.documentNumber} LIKE ${`${PPH21_BACKFILL_DOCUMENT_PREFIX}%`}`,
        ),
      )
      .limit(1);
    if (backfilled)
      throw reversalBlocked(
        "Kekurangan PPh 21 karyawan dari payroll ini sudah dicatat sebagai piutang susulan. Hubungi finance untuk menyelesaikan piutang itu sebelum payroll dibatalkan.",
      );
  }
  const others = await tx
    .select({ ...PAYSLIP_COLUMNS, runLockedAt: payrollRuns.lockedAt })
    .from(payslips)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payslips.tenantId),
        eq(payrollRuns.id, payslips.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payslips.tenantId, tenantId),
        ne(payrollRuns.id, runId),
        // Only the legal entity being reversed: the receivable is per entity.
        // Without the run row, stay unfiltered (refuses more, never less).
        thisRun
          ? eq(payrollRuns.legalEntityId, thisRun.legalEntityId)
          : undefined,
        inArray(payrollRuns.status, ["locked", "paid"]),
        inArray(payslips.employeeId, touched),
      ),
    );
  for (const row of others) {
    const calc = openCalculation(row);
    const collected =
      raised.includes(row.employeeId) &&
      calc.lines.some(
        (line) => line.category === "pph21_receivable" && line.amountIdr > 0,
      );
    if (collected)
      throw reversalBlocked(
        "Kekurangan PPh 21 dari payroll ini sudah ditagih di payroll lain. Batalkan payroll yang menagihnya dulu.",
      );
    // A missing lock time on either side cannot prove the order: refuse.
    const later =
      thisRun?.lockedAt == null ||
      row.runLockedAt === null ||
      row.runLockedAt > thisRun.lockedAt;
    if (later && calc.pph21ReceivableOpenAfterIdr !== undefined)
      throw reversalBlocked(
        "Saldo kekurangan PPh 21 karyawan sudah dibawa oleh payroll yang dikunci setelahnya. Batalkan payroll yang lebih baru dulu.",
      );
  }
}

async function writeRun(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  next: PayrollRun,
): Promise<void> {
  const updated = await tx
    .update(payrollRuns)
    .set({
      status: next.status,
      reversal: next.reversal,
      updatedAt: new Date(next.updatedAt),
    })
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, runId),
        eq(payrollRuns.status, "locked"),
      ),
    )
    .returning({ id: payrollRuns.id });
  if (updated.length !== 1)
    throw new HttpError(
      409,
      "PAYROLL_RUN_INVALID_TRANSITION",
      "Perubahan status payroll tidak diizinkan.",
    );
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  action: string,
  before: PayrollRun,
  after: PayrollRun,
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: "payroll_run",
      objectId: after.id,
      reason: null,
      maskedChanges: {
        before: {
          status: before.status,
          reversalStatus: before.reversal?.status ?? null,
        },
        after: {
          status: after.status,
          reversalStatus: after.reversal?.status ?? null,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_FIELDS,
  );
}

/** Ask to cancel a locked run. Status stays `locked`; a second person decides. */
export async function requestPayrollRunReversalInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  reason: string,
  now = new Date(),
): Promise<PayrollRun> {
  const tenantId = context.tenant.tenantId;
  // OPEN Q-b: the PRD names no request permission; payroll.lock is the default.
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.lock",
  );
  // LOCK ORDER (legend-72nod): the overtime correction lock comes BEFORE the
  // run row. The lock of a target run holds it while the ledger trigger waits
  // for a share lock on this (source) row.
  const [entityRow] = await tx
    .select({ legalEntityId: payrollRuns.legalEntityId })
    .from(payrollRuns)
    .where(
      and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, payrollRunId)),
    )
    .limit(1);
  if (!entityRow)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  await lockOvertimeCorrectionScope(tx, tenantId, entityRow.legalEntityId);
  const row = await lockRunRow(tx, tenantId, payrollRunId);
  const run = toPayrollRun(row);
  const next = applyPayrollRunCommand(run, {
    action: "request_reversal",
    actorId: actor,
    reason,
    at: now.toISOString(),
  });
  // Fast fail only; the decision re-checks under the month lock.
  await assertNoBankFile(tx, tenantId, payrollRunId);
  await assertNoPayoutBatch(tx, tenantId, payrollRunId);
  await assertNoLiveDependents(tx, tenantId, payrollRunId);
  await assertNoCollectedReceivable(tx, tenantId, payrollRunId);
  await assertNoSettledOvertimeCorrectionFromRun(
    tx,
    tenantId,
    row.legalEntityId,
    payrollRunId,
  );
  await assertNoCompletedSettlementLoanImpact(tx, tenantId, run);
  await writeRun(tx, tenantId, payrollRunId, next);
  await audit(
    tx,
    context,
    actor,
    "payroll.run.reversal_requested",
    run,
    next,
    now,
  );
  return next;
}

/** Approve or reject a pending reversal (someone other than the requester). */
export async function decidePayrollRunReversalInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  decision: "approve" | "reject",
  now = new Date(),
): Promise<PayrollRun> {
  const tenantId = context.tenant.tenantId;
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.cancel.approve",
  );
  // LOCK 1: tax month. LOCK 2: receivable scope. LOCK 3: run row.
  const month = await lockPayrollRunMonth(tx, tenantId, payrollRunId);
  await lockPph21ReceivableScope(tx, tenantId, month.legalEntityId);
  // LOCK 2b: overtime correction scope, before the run row (see the request).
  await lockOvertimeCorrectionScope(tx, tenantId, month.legalEntityId);
  const row = await lockRunRow(tx, tenantId, payrollRunId);
  if (
    row.legalEntityId !== month.legalEntityId ||
    row.payDate !== month.payDate
  )
    throw new HttpError(
      409,
      "PAYROLL_PPH21_RUN_MISMATCH",
      "Payroll berubah saat diproses. Coba lagi.",
    );
  const run = toPayrollRun(row);
  const next = applyPayrollRunCommand(run, {
    action: decision === "approve" ? "approve_reversal" : "reject_reversal",
    actorId: actor,
    at: now.toISOString(),
  });
  if (decision === "reject") {
    await writeRun(tx, tenantId, payrollRunId, next);
    await audit(
      tx,
      context,
      actor,
      "payroll.run.reversal_rejected",
      run,
      next,
      now,
    );
    return next;
  }
  if (hasUnsupportedTotals(run)) throw unsupported();
  await assertNoRapelSideEffects(tx, tenantId, payrollRunId);
  await assertNoBankFile(tx, tenantId, payrollRunId);
  await assertNoPayoutBatch(tx, tenantId, payrollRunId);
  await assertNoLiveDependents(tx, tenantId, payrollRunId);
  await assertNoCollectedReceivable(tx, tenantId, payrollRunId);
  await assertNoSettledOvertimeCorrectionFromRun(
    tx,
    tenantId,
    row.legalEntityId,
    payrollRunId,
  );
  await assertNoCompletedSettlementLoanImpact(tx, tenantId, run);
  await restoreLoanDeductions(tx, tenantId, run, now);
  const { totals, reversal } = next;
  if (totals === null || reversal === null)
    throw new HttpError(
      409,
      "PAYROLL_RUN_INVALID_TRANSITION",
      "Perubahan status payroll tidak diizinkan.",
    );
  await writeRun(tx, tenantId, payrollRunId, next);
  // legend-itph: the reversed run leaves no employee receivable open item, and
  // a receivable it collected is open again (receivable lock held above).
  await syncPph21ReceivableOpenItemsInTransaction(tx, context, payrollRunId);
  // legend-72nod: the overtime correction it settled becomes outstanding again.
  await syncOvertimeCorrectionLedgerInTransaction(tx, context, payrollRunId);
  await emitPayrollEvent(tx, context, payrollReversed, {
    aggregateId: payrollRunId,
    actor: { type: "user", id: actor },
    payload: {
      payrollRunId: next.id,
      legalEntityId: next.legalEntityId,
      runType: next.runType,
      periodStart: next.periodStart,
      periodEnd: next.periodEnd,
      payDate: next.payDate,
      totals,
      requestedBy: reversal.requestedBy,
      approvedBy: actor,
      reversedAt: now.toISOString(),
    },
    now,
  });
  await audit(tx, context, actor, "payroll.run.reversed", run, next, now);
  return next;
}
