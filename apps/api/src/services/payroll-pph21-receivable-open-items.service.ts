// Employee PPh 21 receivable as an accounting open item (bead legend-itph,
// brief docs/briefs/972-payroll-sisa.md; founder decision B8; account 1204).
//
// The payslip of a locked/paid run raises a receivable (`tax.pph21ReceivableIdr`)
// when the employee's pay could not carry the whole PPh 21; later payslips
// collect it (`pph21_receivable` lines). This service mirrors that as one
// receivable open item per slip that raises one (party `employee`, item id =
// the payslip id), settled by the runs that collect it, so finance sees what a
// (also departed) employee still owes.
//
// It opens the payslips of THE RUN ONLY (never the history: the lock keeps its
// "latest balance only" read) and works from the open item tables otherwise:
//  - raise: one item per raising payslip of the run (primary key tenant +
//    kind + payslip id, ON CONFLICT DO NOTHING; an existing item must carry
//    the same amount);
//  - collect: the collected amount of a payslip settles the employee's open
//    items oldest first, as one settlement row per (item, run) with the run id
//    as its source, only items raised on or before the run's pay date and not
//    on its own payslip. A run that already settled its collection is left
//    alone (idempotent). What no item carries (raised before open items
//    existed) stays unsettled, never settled above an item's room;
//  - reversal: the settlements of the run are deleted (the items owe again),
//    its own items are deleted, and refused (409) when anything else was
//    settled on them. A reversed run never creates an item.
// Doubt fails closed: an unreadable payslip or a changed amount refuses with
// 409 and rolls the caller (lock, reversal) back.
//
// Callers: the run lock and the approved reversal call it inside their own
// transaction, after the receivable scope lock they already hold. Simulate
// never touches open items. A standalone call takes that scope lock itself.

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  payslipCalculationSchema,
  type PayrollRunId,
} from "@starter/shared/hris/payroll";
import {
  accountingOpenItemSettlements,
  accountingOpenItems,
} from "../db/schema/accounting-ap-fa.ts";
import { employees } from "../db/schema/hris.ts";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { lockPph21ReceivableScope } from "./payroll-run-pph21.service.ts";
import type { Tx } from "./permission-resolver.ts";

const SYNC_STATUSES = ["locked", "paid", "reversed"] as const;

const unreadable = () =>
  new HttpError(
    409,
    "PAYROLL_PPH21_RECEIVABLE_UNREADABLE",
    "Slip gaji tidak dapat dibaca. Piutang PPh 21 tidak diproses.",
  );

const inconsistent = () =>
  new HttpError(
    409,
    "PAYROLL_PPH21_RECEIVABLE_INCONSISTENT",
    "Piutang PPh 21 karyawan tidak cocok dengan slip gaji. Proses dihentikan.",
  );

type Slip = {
  payslipId: string;
  employeeId: string;
  runId: string;
  payDate: string;
  lockedAt: number;
  raisedIdr: number;
  collectedIdr: number;
};

type SlipRow = {
  id: string;
  tenantId: TenantId;
  employeeId: string;
  runId: string;
  payDate: string;
  lockedAt: Date | null;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
};

function readSlip(row: SlipRow): Slip {
  let calc: ReturnType<typeof payslipCalculationSchema.parse>;
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
    // Never echo the decrypt or parse error: it may carry payroll values.
    throw unreadable();
  }
  if (calc.employeeId !== row.employeeId) throw unreadable();
  const raisedIdr = calc.tax.pph21ReceivableIdr ?? 0;
  let collectedIdr = 0;
  for (const line of calc.lines)
    if (line.category === "pph21_receivable") collectedIdr += line.amountIdr;
  if (
    !Number.isSafeInteger(raisedIdr) ||
    !Number.isSafeInteger(collectedIdr) ||
    raisedIdr < 0 ||
    collectedIdr < 0
  )
    throw unreadable();
  return {
    payslipId: row.id,
    employeeId: row.employeeId,
    runId: row.runId,
    payDate: row.payDate,
    lockedAt: row.lockedAt?.getTime() ?? 0,
    raisedIdr,
    collectedIdr,
  };
}

const slipSelect = {
  id: payslips.id,
  tenantId: payslips.tenantId,
  employeeId: payslips.employeeId,
  runId: payrollRuns.id,
  payDate: payrollRuns.payDate,
  lockedAt: payrollRuns.lockedAt,
  calculationEncrypted: payslips.calculationEncrypted,
  piiKeyVersion: payslips.piiKeyVersion,
} as const;

/**
 * Brings the employee receivable open items in line with the payslips of
 * `payrollRunId`. Idempotent. A run that is not locked, paid or reversed
 * changes nothing; another tenant's run is 404.
 */
export async function syncPph21ReceivableOpenItemsInTransaction(
  tx: Tx,
  scope: ScopedTenantContext,
  payrollRunId: PayrollRunId,
): Promise<void> {
  const tenantId = scope.tenant.tenantId;
  const readRun = async () => {
    const [row] = await tx
      .select({
        legalEntityId: payrollRuns.legalEntityId,
        status: payrollRuns.status,
      })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.tenantId, tenantId),
          eq(payrollRuns.id, payrollRunId),
        ),
      )
      .limit(1);
    if (!row)
      throw new HttpError(
        404,
        "PAYROLL_RUN_NOT_FOUND",
        "Payroll tidak ditemukan.",
      );
    return row;
  };
  const found = await readRun();
  if (!(SYNC_STATUSES as readonly string[]).includes(found.status)) return;
  // One writer per legal entity receivable (the lock and the reversal already
  // hold it; the same session takes it again at no cost). The run is read
  // again under it: its status may have moved while this waited.
  await lockPph21ReceivableScope(tx, tenantId, found.legalEntityId);
  const run = await readRun();
  if (!(SYNC_STATUSES as readonly string[]).includes(run.status)) return;
  const legalEntityId = run.legalEntityId;

  if (run.status === "reversed") {
    await undoRun(tx, tenantId, payrollRunId);
  }

  // The payslips of this run: the only ones ever opened here.
  const ownRows = await tx
    .select(slipSelect)
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
        eq(payslips.payrollRunId, payrollRunId),
      ),
    )
    .orderBy(asc(payslips.id));
  const own = ownRows
    .map(readSlip)
    .filter((slip) => slip.raisedIdr > 0 || slip.collectedIdr > 0);
  if (own.length === 0) return;

  if (run.status === "reversed") {
    await removeRaisedItems(
      tx,
      tenantId,
      own.filter((slip) => slip.raisedIdr > 0),
    );
    return;
  }

  await raiseItems(tx, tenantId, legalEntityId, own);
  await collectItems(tx, tenantId, legalEntityId, payrollRunId, own);
}

/** One item per payslip of the run that raises a receivable. */
async function raiseItems(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  own: readonly Slip[],
): Promise<void> {
  const raising = own.filter((slip) => slip.raisedIdr > 0);
  if (raising.length === 0) return;
  const employeeIds = [...new Set(raising.map((slip) => slip.employeeId))];
  const nameRows = await tx
    .select({ id: employees.id, fullName: employees.fullName })
    .from(employees)
    .where(
      and(eq(employees.tenantId, tenantId), inArray(employees.id, employeeIds)),
    );
  const names = new Map(nameRows.map((row) => [row.id, row.fullName]));
  for (const slip of raising) {
    const name = names.get(slip.employeeId);
    if (name === undefined) throw inconsistent();
    await tx
      .insert(accountingOpenItems)
      .values({
        tenantId,
        kind: "receivable" as const,
        id: slip.payslipId,
        legalEntityId,
        outletId: null,
        counterpartyType: "employee" as const,
        counterpartyId: slip.employeeId,
        counterpartyName: name,
        documentNumber: `PPH21-${slip.payDate}-${slip.payslipId.slice(0, 8)}`,
        documentDate: slip.payDate,
        dueOn: slip.payDate,
        originalIdr: idr(slip.raisedIdr),
        journalEntryId: null,
        createdBy: null,
      })
      .onConflictDoNothing();
    const [item] = await tx
      .select()
      .from(accountingOpenItems)
      .where(
        and(
          eq(accountingOpenItems.tenantId, tenantId),
          eq(accountingOpenItems.kind, "receivable"),
          eq(accountingOpenItems.id, slip.payslipId),
        ),
      )
      .limit(1);
    if (
      !item ||
      item.originalIdr !== slip.raisedIdr ||
      item.legalEntityId !== legalEntityId ||
      item.counterpartyType !== "employee" ||
      item.counterpartyId !== slip.employeeId
    )
      throw inconsistent();
  }
}

/**
 * The collection of each payslip of the run settles the employee's open items
 * oldest first (from the item tables, no payslip history).
 */
async function collectItems(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  runId: string,
  own: readonly Slip[],
): Promise<void> {
  for (const slip of own.filter((entry) => entry.collectedIdr > 0)) {
    const items = await tx
      .select()
      .from(accountingOpenItems)
      .where(
        and(
          eq(accountingOpenItems.tenantId, tenantId),
          eq(accountingOpenItems.kind, "receivable"),
          eq(accountingOpenItems.legalEntityId, legalEntityId),
          eq(accountingOpenItems.counterpartyType, "employee"),
          eq(accountingOpenItems.counterpartyId, slip.employeeId),
        ),
      )
      .orderBy(
        asc(accountingOpenItems.documentDate),
        asc(accountingOpenItems.id),
      )
      .for("update");
    // What this run already settled on this employee's items.
    const mine =
      items.length === 0
        ? []
        : await tx
            .select()
            .from(accountingOpenItemSettlements)
            .where(
              and(
                eq(accountingOpenItemSettlements.tenantId, tenantId),
                eq(accountingOpenItemSettlements.kind, "receivable"),
                eq(accountingOpenItemSettlements.sourceId, runId),
                inArray(
                  accountingOpenItemSettlements.openItemId,
                  items.map((item) => item.id),
                ),
              ),
            );
    // This run already settled its collection (a re-sync): never settle twice.
    if (mine.length > 0) continue;

    let left = slip.collectedIdr;
    for (const item of items) {
      if (left === 0) break;
      // Never collect backwards, never on the payslip that raised it.
      if (item.id === slip.payslipId || item.documentDate > slip.payDate)
        continue;
      const take = Math.min(item.originalIdr - item.settledIdr, left);
      if (take <= 0) continue;
      await tx.insert(accountingOpenItemSettlements).values({
        tenantId,
        kind: "receivable",
        openItemId: item.id,
        method: "payment",
        sourceId: runId,
        settledOn: slip.payDate,
        amountIdr: idr(take),
        journalEntryId: null,
        reason: null,
        createdBy: null,
      });
      await tx
        .update(accountingOpenItems)
        .set({ settledIdr: idr(item.settledIdr + take), updatedAt: new Date() })
        .where(
          and(
            eq(accountingOpenItems.tenantId, tenantId),
            eq(accountingOpenItems.kind, "receivable"),
            eq(accountingOpenItems.id, item.id),
          ),
        );
      left -= take;
    }
    // What no open item carries (a receivable raised before open items
    // existed) stays outside: the payslip engine already proved the
    // collection against the balance, an item only ever settles up to its own
    // room, so nothing is settled twice or above what was raised.
  }
}

/** A reversed run gives back what it settled: the items owe again. */
async function undoRun(
  tx: Tx,
  tenantId: TenantId,
  runId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(accountingOpenItemSettlements)
    .where(
      and(
        eq(accountingOpenItemSettlements.tenantId, tenantId),
        eq(accountingOpenItemSettlements.kind, "receivable"),
        eq(accountingOpenItemSettlements.method, "payment"),
        eq(accountingOpenItemSettlements.sourceId, runId),
      ),
    );
  if (rows.length === 0) return;
  const itemIds = [...new Set(rows.map((row) => row.openItemId))].sort();
  const items = await tx
    .select()
    .from(accountingOpenItems)
    .where(
      and(
        eq(accountingOpenItems.tenantId, tenantId),
        eq(accountingOpenItems.kind, "receivable"),
        inArray(accountingOpenItems.id, itemIds),
      ),
    )
    .orderBy(asc(accountingOpenItems.id))
    .for("update");
  await tx.delete(accountingOpenItemSettlements).where(
    and(
      eq(accountingOpenItemSettlements.tenantId, tenantId),
      inArray(
        accountingOpenItemSettlements.id,
        rows.map((row) => row.id),
      ),
    ),
  );
  for (const item of items) {
    const give = rows
      .filter((row) => row.openItemId === item.id)
      .reduce((total, row) => total + row.amountIdr, 0);
    if (give > item.settledIdr) throw inconsistent();
    await tx
      .update(accountingOpenItems)
      .set({ settledIdr: idr(item.settledIdr - give), updatedAt: new Date() })
      .where(
        and(
          eq(accountingOpenItems.tenantId, tenantId),
          eq(accountingOpenItems.kind, "receivable"),
          eq(accountingOpenItems.id, item.id),
        ),
      );
  }
}

/** The items a reversed run raised go away; anything settled on them refuses. */
async function removeRaisedItems(
  tx: Tx,
  tenantId: TenantId,
  raising: readonly Slip[],
): Promise<void> {
  if (raising.length === 0) return;
  const ids = raising.map((slip) => slip.payslipId);
  const items = await tx
    .select()
    .from(accountingOpenItems)
    .where(
      and(
        eq(accountingOpenItems.tenantId, tenantId),
        eq(accountingOpenItems.kind, "receivable"),
        inArray(accountingOpenItems.id, ids),
      ),
    )
    .orderBy(asc(accountingOpenItems.id))
    .for("update");
  if (items.length === 0) return;
  const settled = await tx
    .select({ id: accountingOpenItemSettlements.id })
    .from(accountingOpenItemSettlements)
    .where(
      and(
        eq(accountingOpenItemSettlements.tenantId, tenantId),
        eq(accountingOpenItemSettlements.kind, "receivable"),
        inArray(
          accountingOpenItemSettlements.openItemId,
          items.map((item) => item.id),
        ),
      ),
    )
    .limit(1);
  if (settled.length > 0 || items.some((item) => item.settledIdr !== 0))
    throw inconsistent();
  await tx.delete(accountingOpenItems).where(
    and(
      eq(accountingOpenItems.tenantId, tenantId),
      eq(accountingOpenItems.kind, "receivable"),
      inArray(
        accountingOpenItems.id,
        items.map((item) => item.id),
      ),
    ),
  );
}
