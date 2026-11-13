// Payee bank snapshot of a payroll run (bead legend-89cl7; PAYR-04, HR-03).
//
// When a run locks, the bank details each bank_transfer payslip will be paid to
// are frozen in `payslip_bank_snapshots`: account number, account holder and
// bank name, sealed in one value (lib/payroll-sealed.ts, field `bankSnapshot`).
// The bank export reads ONLY this snapshot, never the employee's current
// account, so editing an employee after the lock cannot redirect a salary.
//
// HR data holds only the account number (`employees.bank_account_encrypted`):
// there is no holder or bank field. The snapshot therefore stores the account
// number, the holder = employee full name at lock, the employee code and name
// at lock (the export shows the payee as locked), and bankName = null. If HR
// gains those fields, add them here (the sealed JSON is versioned).
//
// The employee's BI bank code (`employees.bank_code`, 3 digits) is copied into
// the snapshot row at lock too; the disbursement batch reads the code from the
// snapshot only, so a later HR edit cannot change which bank a frozen item uses.
//
// The run service that locks calls `snapshotPayeeBankForLock` inside its lock
// transaction, after it inserted the payslips (the DB refuses a snapshot for an
// unlocked run or a non-bank_transfer payslip). No account number is ever
// logged or put in an error: errors name employee ids only.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TenantId } from "@starter/shared/core";
import type { EmployeeId } from "@starter/shared/hris";
import type { PayrollRunId, PayslipId } from "@starter/shared/hris/payroll";
import { employees } from "../db/schema/hris.ts";
import { payslipBankSnapshots } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { normalizeHrisPii, openHrisPii } from "../lib/hris-pii.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import type { Tx } from "./permission-resolver.ts";

const snapshotSchema = z
  .object({
    v: z.literal(1),
    accountNumber: z.string().min(6).max(34),
    accountHolder: z.string().min(1).max(150),
    employeeCode: z.string().min(1).max(50),
    employeeName: z.string().min(1).max(150),
    bankName: z.string().min(1).max(100).nullable(),
  })
  .strict();

export type PayeeBankSnapshot = Omit<z.infer<typeof snapshotSchema>, "v">;

const refuse = (code: string, message: string) =>
  new HttpError(422, code, message);

function idList(ids: readonly string[]): string {
  const sorted = [...new Set(ids)].sort();
  const shown = sorted.slice(0, 20).join(", ");
  return sorted.length > 20 ? `${shown}, ...` : shown;
}

const bindingOf = (tenantId: string, snapshotId: string) =>
  ({
    tenantId,
    table: "payslip_bank_snapshots",
    rowId: snapshotId,
    field: "bankSnapshot",
  }) as const;

/** Opens a stored snapshot; throws on a wrong key, tamper or malformed body. */
export function openPayeeBankSnapshot(row: {
  id: string;
  tenantId: string;
  snapshotEncrypted: Buffer;
  piiKeyVersion: number;
}): PayeeBankSnapshot {
  const parsed = snapshotSchema.parse(
    JSON.parse(
      openPayrollValue(
        row.snapshotEncrypted,
        bindingOf(row.tenantId, row.id),
        row.piiKeyVersion,
      ),
    ),
  );
  return {
    accountNumber: parsed.accountNumber,
    accountHolder: parsed.accountHolder,
    employeeCode: parsed.employeeCode,
    employeeName: parsed.employeeName,
    bankName: parsed.bankName,
  };
}

/**
 * Lock step: freezes the payee bank details of `payees` (the run's
 * bank_transfer payslips that carry a transfer, i.e. net > 0). Must run inside
 * the lock transaction `tx`, after the payslips were inserted. A payee with no
 * account number, or one that cannot be opened/normalised, refuses the lock
 * (422 PAYROLL_BANK_ACCOUNT_MISSING / PAYROLL_BANK_ACCOUNT_UNREADABLE) so a run
 * is never locked with a payee that cannot be paid. Returns the count stored.
 */
export async function snapshotPayeeBankForLock(
  tx: Tx,
  tenantId: string,
  payrollRunId: string,
  payees: readonly { payslipId: string; employeeId: string }[],
): Promise<number> {
  if (payees.length === 0) return 0;
  const people = await tx
    .select({
      id: employees.id,
      employeeNo: employees.employeeNo,
      fullName: employees.fullName,
      bankCode: employees.bankCode,
      bankAccountEncrypted: employees.bankAccountEncrypted,
      piiKeyVersion: employees.piiKeyVersion,
    })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, tenantId as TenantId),
        inArray(
          employees.id,
          payees.map((payee) => payee.employeeId as EmployeeId),
        ),
      ),
    );
  const personById = new Map(people.map((person) => [person.id, person]));
  const missing: string[] = [];
  const unreadable: string[] = [];
  const rows: (typeof payslipBankSnapshots.$inferInsert)[] = [];
  for (const payee of payees) {
    const person = personById.get(payee.employeeId);
    if (!person?.bankAccountEncrypted) {
      missing.push(payee.employeeId);
      continue;
    }
    let sealed: Buffer;
    const id = randomUUID();
    try {
      const accountNumber = normalizeHrisPii(
        "bankAccount",
        openHrisPii(
          person.bankAccountEncrypted,
          {
            tenantId,
            table: "employees",
            rowId: person.id,
            field: "bankAccount",
          },
          person.piiKeyVersion,
        ),
      );
      sealed = sealPayrollValue(
        JSON.stringify({
          v: 1,
          accountNumber,
          accountHolder: person.fullName,
          employeeCode: person.employeeNo,
          employeeName: person.fullName,
          bankName: null,
        } satisfies z.infer<typeof snapshotSchema>),
        bindingOf(tenantId, id),
        PAYROLL_SEAL_KEY_VERSION,
      );
    } catch {
      // The error may carry the account number: record the id only.
      unreadable.push(payee.employeeId);
      continue;
    }
    rows.push({
      id,
      tenantId: tenantId as TenantId,
      payrollRunId: payrollRunId as PayrollRunId,
      payslipId: payee.payslipId as PayslipId,
      employeeId: payee.employeeId as EmployeeId,
      snapshotEncrypted: sealed,
      piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
      // BI bank code, plain and not secret (0516); null when HR has none.
      bankCode: person.bankCode ?? null,
    });
  }
  if (missing.length > 0)
    throw refuse(
      "PAYROLL_BANK_ACCOUNT_MISSING",
      `Rekening bank karyawan belum diisi (ID karyawan: ${idList(missing)}).`,
    );
  if (unreadable.length > 0)
    throw refuse(
      "PAYROLL_BANK_ACCOUNT_UNREADABLE",
      `Rekening bank karyawan tidak bisa dibaca (ID karyawan: ${idList(unreadable)}).`,
    );
  await tx.insert(payslipBankSnapshots).values(rows);
  return rows.length;
}
