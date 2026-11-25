// Backfill of the employee PPh 21 receivable open item (bead legend-i848k,
// brief docs/briefs/983-hr-sisa.md card A; follows 972 / legend-itph).
//
// A receivable raised before the open item of 972 existed has no item in
// accounting_open_items, so the finance list shows less than the payslips say
// the employee owes. This gives each such employee ONE item for the missing
// part. Money rule: never more than what the employee really owes, so doubt
// holds the employee back (reported, nothing written, nothing guessed).
//
// Per legal entity of the tenant (locked/paid runs only), per employee:
//  - balance = the latest-payslip balance (`loadPph21ReceivableBalances`,
//    `total`: raised minus collected, the same oracle the lock uses);
//  - existing = sum(original - settled) of the employee's receivable items;
//  - gap = balance - existing. gap <= 0: nothing to do (an item of the 972
//    sync, a settled item, a zero balance). Existing above the balance is
//    reported, never lowered here;
//  - gap > 0: one item (original = gap, settled = 0), id = UUIDv5 of
//    tenant + legal entity + employee, ON CONFLICT DO NOTHING. A second run
//    sees existing = balance and does nothing.
// Held back and reported: an unreadable or inconsistent payslip, an employee
// without a name row, an item id that is taken already.
//
// One writer per legal entity receivable: takes `lockPph21ReceivableScope`.
// Operator entrypoint: `pnpm payroll:backfill-pph21-receivable`
// (src/scripts/payroll-pph21-receivable-backfill.ts).

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import {
  idr,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { payrollRunIdSchema } from "@starter/shared/hris/payroll";
import { accountingOpenItems } from "../db/schema/accounting-ap-fa.ts";
import { employees } from "../db/schema/hris.ts";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import {
  loadPph21ReceivableBalances,
  lockPph21ReceivableScope,
} from "./payroll-run-pph21.service.ts";
import type { Tx } from "./permission-resolver.ts";

export type Pph21ReceivableBackfillHold = {
  legalEntityId: string;
  employeeId: string;
  reason:
    | "payslip_unreadable"
    | "item_exceeds_balance"
    | "employee_missing"
    | "id_taken";
};

/** One legal entity: what this run adds and what is already open there. */
export type Pph21ReceivableBackfillEntity = {
  legalEntityId: string;
  created: number;
  createdIdr: number;
  /** Outstanding (original - settled) of the employee receivable items that
   * existed before this run, whoever the employee. Compare
   * existingIdr + createdIdr with the balance of account 1204. */
  existingIdr: number;
};

export type Pph21ReceivableBackfillReport = {
  created: number;
  createdIdr: number;
  held: Pph21ReceivableBackfillHold[];
  entities: Pph21ReceivableBackfillEntity[];
};

/** Thrown inside the balance oracle for a payslip that cannot be read. */
class UnreadablePayslip extends Error {}

/** Namespace of the UUIDv5 item ids written by this file. */
const ITEM_ID_NAMESPACE = Buffer.from(
  "8c41d7a02b6e4f93a5d1e07c39b2f684",
  "hex",
);

/** Deterministic UUID version 5 of `name` (same pattern as loyalty expiry). */
function itemUuid(name: string): string {
  const bytes = createHash("sha1")
    .update(ITEM_ID_NAMESPACE)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Document number prefix of the items written here (the reversal looks for it). */
export const PPH21_BACKFILL_DOCUMENT_PREFIX = "PPH21-BACKFILL-";

/** The whole balance whatever the pay date: every run is "on or before". */
const FAR_FUTURE = "9999-12-31" as BusinessDate;

export async function backfillPph21ReceivableOpenItemsInTransaction(
  tx: Tx,
  scope: ScopedTenantContext,
): Promise<Pph21ReceivableBackfillReport> {
  const tenantId = scope.tenant.tenantId;
  const report: Pph21ReceivableBackfillReport = {
    created: 0,
    createdIdr: 0,
    held: [],
    entities: [],
  };
  // Every employee with a payslip in a locked or paid run, per legal entity,
  // with the pay date of the latest one (the item's document date).
  const pairs = await tx
    .select({
      legalEntityId: payrollRuns.legalEntityId,
      employeeId: payslips.employeeId,
      lastPayDate: max(payrollRuns.payDate),
    })
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
        inArray(payrollRuns.status, ["locked", "paid"]),
      ),
    )
    .groupBy(payrollRuns.legalEntityId, payslips.employeeId)
    .orderBy(payrollRuns.legalEntityId, payslips.employeeId);

  const byEntity = new Map<
    string,
    { employeeId: string; lastPayDate: string }[]
  >();
  for (const pair of pairs)
    byEntity.set(pair.legalEntityId, [
      ...(byEntity.get(pair.legalEntityId) ?? []),
      { employeeId: pair.employeeId, lastPayDate: String(pair.lastPayDate) },
    ]);

  for (const [legalEntityId, entityPairs] of byEntity) {
    // Same serialization as the lock and the 972 sync; read everything after.
    await lockPph21ReceivableScope(tx, tenantId, legalEntityId);
    const employeeIds = entityPairs.map((pair) => pair.employeeId);
    const nameRows = await tx
      .select({ id: employees.id, fullName: employees.fullName })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          inArray(employees.id, employeeIds),
        ),
      );
    const names = new Map(nameRows.map((row) => [row.id, row.fullName]));
    const existingRows = await tx
      .select({
        employeeId: accountingOpenItems.counterpartyId,
        outstanding: sql<string>`sum(${accountingOpenItems.originalIdr} - ${accountingOpenItems.settledIdr})`,
      })
      .from(accountingOpenItems)
      .where(
        and(
          eq(accountingOpenItems.tenantId, tenantId),
          eq(accountingOpenItems.kind, "receivable"),
          eq(accountingOpenItems.legalEntityId, legalEntityId),
          eq(accountingOpenItems.counterpartyType, "employee"),
        ),
      )
      .groupBy(accountingOpenItems.counterpartyId);
    const existing = new Map(
      existingRows.map((row) => [row.employeeId, Number(row.outstanding)]),
    );
    const entity: Pph21ReceivableBackfillEntity = {
      legalEntityId,
      created: 0,
      createdIdr: 0,
      existingIdr: existingRows.reduce(
        (sum, row) => sum + Number(row.outstanding),
        0,
      ),
    };
    report.entities.push(entity);

    for (const { employeeId, lastPayDate } of entityPairs) {
      const hold = (reason: Pph21ReceivableBackfillHold["reason"]) =>
        report.held.push({ legalEntityId, employeeId, reason });
      // One employee at a time: an unreadable slip holds only that employee.
      let balance: number;
      try {
        const { total } = await loadPph21ReceivableBalances(
          tx,
          {
            tenantId,
            legalEntityId,
            runId: payrollRunIdSchema.parse(randomUUID()),
            payDate: FAR_FUTURE,
            employeeIds: [employeeId],
          },
          () => new UnreadablePayslip(),
        );
        balance = total.get(employeeId) ?? 0;
      } catch (error) {
        // Only an unreadable payslip holds the employee back. A database
        // error (dropped connection, timeout) aborts the tenant: reporting it
        // as "unreadable" would hide a failure behind a clean-looking report.
        if (!(error instanceof UnreadablePayslip)) throw error;
        hold("payslip_unreadable");
        continue;
      }
      if (!Number.isSafeInteger(balance) || balance < 0) {
        hold("payslip_unreadable");
        continue;
      }
      const have = existing.get(employeeId) ?? 0;
      if (have > balance) {
        hold("item_exceeds_balance");
        continue;
      }
      const gap = balance - have;
      if (gap <= 0) continue;
      const name = names.get(employeeId);
      if (name === undefined) {
        hold("employee_missing");
        continue;
      }
      const inserted = await tx
        .insert(accountingOpenItems)
        .values({
          tenantId,
          kind: "receivable" as const,
          id: itemUuid(`${tenantId}:${legalEntityId}:${employeeId}`),
          legalEntityId,
          outletId: null,
          counterpartyType: "employee" as const,
          counterpartyId: employeeId,
          counterpartyName: name,
          documentNumber: `${PPH21_BACKFILL_DOCUMENT_PREFIX}${lastPayDate}-${employeeId.slice(0, 8)}`,
          documentDate: lastPayDate as BusinessDate,
          dueOn: lastPayDate as BusinessDate,
          originalIdr: idr(gap),
          journalEntryId: null,
          createdBy: null,
        })
        .onConflictDoNothing()
        .returning({ id: accountingOpenItems.id });
      if (inserted.length === 0) {
        hold("id_taken");
        continue;
      }
      report.created += 1;
      report.createdIdr += gap;
      entity.created += 1;
      entity.createdIdr += gap;
    }
  }
  return report;
}
