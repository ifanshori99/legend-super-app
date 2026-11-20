// Payroll exports: bank transfer file and Coretax PPh 21 (BPMP) import XML
// (bead legend-34qx, brief docs/briefs/ws10-payroll-bank-coretax.md; PRD v1.7
// §3 D.30 "Pembayaran Gaji" and "Dokumen Pajak"; PAYR-04, HR-03).
//
// Both exports are read-only views of a LOCKED payroll run: they open the
// sealed payslips, never change an amount and never recompute tax. Unlocked
// run -> 409. Creating a file needs `payroll.lock` (the permission that locks
// and marks paid), reading the list `payroll.view`; both are re-checked inside
// the tenant transaction. Personal data (account number, NIK, NPWP) is opened
// only to build the file: it is never logged, never put in an audit row and
// never echoed in an error (errors name employee ids only).
//
// Bank file: rows are exactly the run's bank_transfer payslips with net > 0 and
// `assertBankFileMatchesRun` (PAYR-04) runs before anything is rendered or
// stored; a mismatch with the run totals refuses (409). An empty file is
// refused (422). The layout comes from `getBankFormatter` (generic_csv only).
// Payee accounts come only from the snapshot sealed at lock
// (`payslip_bank_snapshots`, payroll-bank-snapshot.service.ts, legend-89cl7);
// a run without one is 422 PAYROLL_BANK_SNAPSHOT_MISSING, never the current account.
//
// Coretax: one BPMP row per permanent employee (employment type `pkwtt` or `pkwt`) per
// tax month, from payslips of locked/paid runs of the legal entity whose pay
// date falls in the month and whose tax method is TER. Several slips of one
// employee are summed; the TER rate and the summed PPh 21 are re-derived with
// the run's pinned TER table (`lookupTerRate`) and PPh 21 policy rounding (`rupiahAtRate`) and
// must equal what the slips carry, otherwise the export is refused (422): no
// tax figure is ever guessed or recomputed into the file.
//
// The files are plain text, so they go straight to the object storage
// (`uploadStorage` only accepts images and PDFs); the rows keep the object key
// and a short-lived signed URL is minted on every read.

import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  createUlid,
  encodeCursor,
  idr,
  type BusinessDate,
  type Idr,
  type RoundingMode,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { employeeIdSchema, type EmployeeId } from "@starter/shared/hris";
import {
  PayrollError,
  assertBankFileMatchesRun,
  bankTransferFileSchema,
  lookupTerRate,
  pph21PolicyForRun,
  rupiahAtRate,
  payrollRunTotalsSchema,
  payrollTaxExportSchema,
  payslipCalculationSchema,
  payslipPaymentMethodSchema,
  statutoryTableVersionSchema,
  statutoryVersionRefSchema,
  type BankTransferFile,
  type BankTransferFormat,
  type PayrollRunId,
  type PayrollRunStatus,
  type PayslipId,
  type PayrollTaxExport,
  type PayslipCalculation,
  type StatutoryTableVersionOf,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { payrollDisbursementBatches } from "../db/schema/payroll-payout.ts";
import { payrollRapelFinalizations } from "../db/schema/payroll-rapel.ts";
import {
  bankTransferFiles,
  payrollRuns,
  payrollTaxExports,
  payslipBankSnapshots,
  payslips,
  statutoryRates,
} from "../db/schema/payroll.ts";
import { legalEntities } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { normalizeHrisPii, openHrisPii } from "../lib/hris-pii.ts";
import { payrollGrossEnvelopeSchema } from "../lib/payroll-gross-envelope.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { getBankFormatter } from "../lib/payroll-export/bank-formats.ts";
import type { BankFileRow } from "../lib/payroll-export/bank-formats.ts";
import {
  buildBpmpXml,
  type BpmpRow,
} from "../lib/payroll-export/coretax-bpmp.ts";
import { openSecret } from "../lib/secrets.ts";
import { recordAudit } from "./core-audit.ts";
import { buildAnnualA1Xml } from "./payroll-coretax-a1.service.ts";
import {
  openPayeeBankSnapshot,
  type PayeeBankSnapshot,
} from "./payroll-bank-snapshot.service.ts";
import { openRapelFinalizedPayslip } from "./payroll-rapel-finalize.service.ts";
import { loadPph21PolicyVersionsForRun } from "./payroll-pph21-policy.service.ts";
import type { StorageRuntime } from "./core-storage-runtime.ts";
import { cursorPair, notFound } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { lockPayrollTaxYear } from "./payroll-run-pph21.service.ts";
import { taxExportSupersededError } from "./payroll-tax-export-supersede.ts";
import type { Tx } from "./permission-resolver.ts";

const READ_CODE: PermissionCode = "payroll.view";
const LOCK_CODE: PermissionCode = "payroll.lock";
const SIGNED_URL_SECONDS = 300;
/** Statuses a run can be exported in (frozen by the lock, PAYR-02). */
const EXPORTABLE_STATUSES = ["locked", "paid"] as const;
/** "Pegawai tetap" (object code 21-100-01) per PMK 168/2023 includes regularly paid fixed-term (pkwt) staff; daily and intern are excluded. */
const PERMANENT_EMPLOYMENT_TYPES: readonly string[] = ["pkwtt", "pkwt"];
/** Field names only: every value in an export audit row is an id, count, enum or hash. */
const AUDIT_SAFE_FIELDS = [
  "payrollRunId",
  "legalEntityId",
  "format",
  "kind",
  "taxPeriod",
  "rowCount",
  "totalIdr",
  "checksumSha256",
  "nonPermanentEmployee",
  "annualRecalculation",
  "zeroGross",
  "excluded",
] as const;

export type BankTransferFilePage = {
  readonly data: BankTransferFile[];
  readonly meta: { readonly limit: number; readonly nextCursor: string | null };
};

const refuse = (code: string, message: string) =>
  new HttpError(422, code, message);

/** Employee ids only (never a name, NIK or account), capped for the message. */
function idList(ids: readonly string[]): string {
  const sorted = [...new Set(ids)].sort();
  const shown = sorted.slice(0, 20).join(", ");
  return sorted.length > 20 ? `${shown}, ...` : shown;
}

const unreadableSlip = () =>
  refuse(
    "PAYROLL_PAYSLIP_UNREADABLE",
    "Slip gaji tidak bisa dibaca atau tidak sesuai format, berkas tidak bisa dibuat.",
  );

function sealedCalculation(row: {
  id: string;
  tenantId: string;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
}): PayslipCalculation {
  try {
    return payslipCalculationSchema.parse(
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
    throw unreadableSlip();
  }
}

type BankSlip = {
  employeeId: EmployeeId;
  paymentMethod: PayslipCalculation["paymentMethod"];
  netIdr: Idr;
  source: "full" | "rapel";
};

/**
 * One payslip of a bank file run. A full payslip must agree with its row
 * columns. A rapel-finalized payslip (gross envelope) is accepted only when
 * its finalization receipt vouches for it (PAYR-04): employee and payment
 * method come from the row columns (the receipt binds the employee; the
 * payslips immutability trigger, drizzle/0248, keeps payment_method fixed),
 * and the net from the envelope. Anything else fails closed.
 */
function bankSlipOf(
  row: {
    id: PayslipId;
    tenantId: TenantId;
    employeeId: string;
    paymentMethod: string;
    calculationEncrypted: Buffer;
    piiKeyVersion: number;
  },
  runId: PayrollRunId,
  receipts: ReadonlyMap<string, typeof payrollRapelFinalizations.$inferSelect>,
): BankSlip {
  let sealed: unknown;
  try {
    sealed = JSON.parse(
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
    );
  } catch {
    // Never echo the decrypt or parse error: it may carry payroll values.
    throw unreadableSlip();
  }
  const full = payslipCalculationSchema.safeParse(sealed);
  if (full.success) {
    // The row's own columns must agree with the sealed body.
    if (
      full.data.employeeId !== row.employeeId ||
      full.data.paymentMethod !== row.paymentMethod
    )
      throw new PayrollError("PAYROLL_BANK_FILE_MISMATCH");
    return {
      employeeId: full.data.employeeId,
      paymentMethod: full.data.paymentMethod,
      netIdr: full.data.netIdr,
      source: "full",
    };
  }
  if (!payrollGrossEnvelopeSchema.safeParse(sealed).success)
    throw unreadableSlip();
  const method = payslipPaymentMethodSchema.safeParse(row.paymentMethod);
  const employeeId = employeeIdSchema.safeParse(row.employeeId);
  if (!method.success || !employeeId.success)
    throw new PayrollError("PAYROLL_BANK_FILE_MISMATCH");
  let envelope: ReturnType<typeof openRapelFinalizedPayslip>;
  try {
    envelope = openRapelFinalizedPayslip(row, receipts.get(row.id), runId);
  } catch {
    throw new PayrollError("PAYROLL_BANK_FILE_MISMATCH");
  }
  return {
    employeeId: employeeId.data,
    paymentMethod: method.data,
    netIdr: envelope.netIdr,
    source: "rapel",
  };
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  action: string,
  objectType: string,
  objectId: string,
  after: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const now = new Date();
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
      objectType,
      objectId,
      reason,
      maskedChanges: {
        before: null,
        after: maskAuditChanges(after, AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      // The file holds personal data; this row itself holds only ids, counts and enums.
      sensitiveAccess: true,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

async function signedUrl(
  context: ScopedTenantContext,
  runtime: StorageRuntime,
  reference: string,
  key: string,
  downloadFileName: string,
): Promise<string> {
  return runtime.storage.signedGetUrl(context, {
    tenantId: context.tenant.tenantId,
    outletId: null,
    reference,
    key,
    visibility: "private",
    expiresInSeconds: SIGNED_URL_SECONDS,
    downloadFileName,
  });
}

async function storeFile(
  context: ScopedTenantContext,
  runtime: StorageRuntime,
  reference: string,
  key: string,
  contentType: string,
  content: string,
): Promise<() => Promise<void>> {
  const lookup = {
    tenantId: context.tenant.tenantId,
    outletId: null,
    reference,
    key,
  };
  await runtime.storage.put(context, {
    ...lookup,
    contentType,
    content,
    visibility: "private",
  });
  // Used when a later step fails, so no orphan file stays behind.
  return async () => {
    await Promise.allSettled([
      runtime.storage.delete(context, { ...lookup, visibility: "private" }),
    ]);
  };
}

// ---- Bank transfer file ---------------------------------------------------

const bankFileName = (periodLabel: string, runId: string, extension: string) =>
  `bank-transfer-${periodLabel}-${runId.slice(0, 8)}.${extension}`;

async function loadRun(
  tx: Tx,
  tenantId: TenantId,
  runId: PayrollRunId,
  options: { shareLock?: boolean } = {},
) {
  const query = tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .limit(1);
  // `shareLock` is for the bank-file write only: a concurrent reversal approve
  // holds the row, so this waits for its commit and then sees `reversed`
  // (READ COMMITTED re-reads the locked row). It takes FOR UPDATE, not SHARE:
  // the bank-file guard trigger (0344) locks the run FOR UPDATE, so two
  // concurrent creates holding SHARE would deadlock. Run row first, always.
  // Other exports stay lock-free.
  const [run] = options.shareLock ? await query.for("update") : await query;
  if (!run) throw notFound("Payroll");
  return run;
}

/** Frozen runs only: a reversed or unlocked run gives no file and no download link. */
function assertExportable(run: { status: string }): void {
  if (!(EXPORTABLE_STATUSES as readonly string[]).includes(run.status))
    throw new HttpError(
      409,
      "PAYROLL_RUN_NOT_LOCKED",
      "Berkas hanya tersedia untuk payroll yang sudah dikunci.",
    );
}

type BankFileRowRecord = typeof bankTransferFiles.$inferSelect;

function toBankFile(row: BankFileRowRecord, fileUrl: string): BankTransferFile {
  return bankTransferFileSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    payrollRunId: row.payrollRunId,
    format: row.format,
    rowCount: row.rowCount,
    totalIdr: row.totalIdr,
    checksumSha256: row.checksumSha256,
    fileUrl,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Internal/legacy bank file builder. NOT routed: POST bank-transfer-files
 * answers 409 LEGACY_BANK_EXPORT_DISABLED (bead legend-yjbjb); payment files
 * come from approved payout batches. Kept exported for internal callers only.
 */
export async function createBankTransferFile(
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  input: { format: BankTransferFormat; idempotencyKey: string },
  runtime: StorageRuntime,
): Promise<BankTransferFile> {
  // Unsupported layout is refused before any run or personal data is read.
  const formatter = getBankFormatter(input.format);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      LOCK_CODE,
    );
    let fresh = false;
    const created = await idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "payroll.bank_transfer_file.create",
      { actor, payrollRunId, format: input.format },
      async () => {
        fresh = true;
        const run = await loadRun(tx, tenantId, payrollRunId, {
          shareLock: true,
        });
        assertExportable(run);
        // H1: a run with a bank disbursement batch is paid by that batch,
        // never also by this old file. The share lock above waits for a
        // concurrent batch creator, which holds the run row.
        const [bankBatch] = await tx
          .select({ id: payrollDisbursementBatches.id })
          .from(payrollDisbursementBatches)
          .where(
            and(
              eq(payrollDisbursementBatches.tenantId, tenantId),
              eq(payrollDisbursementBatches.payrollRunId, payrollRunId),
              ne(payrollDisbursementBatches.channel, "cash"),
              ne(payrollDisbursementBatches.status, "cancelled"),
            ),
          )
          .limit(1);
        if (bankBatch)
          throw new HttpError(
            409,
            "PAYOUT_RUN_HAS_PAYOUT_BATCH",
            "Payroll ini sudah punya batch pembayaran bank, jadi berkas transfer lama tidak bisa dibuat.",
          );
        const totals = payrollRunTotalsSchema.safeParse(run.totals);
        if (!totals.success)
          throw new PayrollError("PAYROLL_BANK_FILE_MISMATCH");

        const slipRows = await tx
          .select({
            id: payslips.id,
            tenantId: payslips.tenantId,
            employeeId: payslips.employeeId,
            paymentMethod: payslips.paymentMethod,
            calculationEncrypted: payslips.calculationEncrypted,
            piiKeyVersion: payslips.piiKeyVersion,
          })
          .from(payslips)
          .where(
            and(
              eq(payslips.tenantId, tenantId),
              eq(payslips.payrollRunId, payrollRunId),
            ),
          );
        const receiptRows = await tx
          .select()
          .from(payrollRapelFinalizations)
          .where(
            and(
              eq(payrollRapelFinalizations.tenantId, tenantId),
              eq(payrollRapelFinalizations.payrollRunId, payrollRunId),
            ),
          );
        const receipts = new Map(receiptRows.map((r) => [r.payslipId, r]));
        const calculations = slipRows.map((row) =>
          bankSlipOf(row, payrollRunId, receipts),
        );
        // A run is all full payslips or all rapel-finalized ones, never both.
        if (new Set(calculations.map((calc) => calc.source)).size > 1)
          throw new PayrollError("PAYROLL_BANK_FILE_MISMATCH");

        const bankSlips = calculations.filter(
          (calc) => calc.paymentMethod === "bank_transfer" && calc.netIdr > 0,
        );
        // PAYR-04 before anything is rendered or stored.
        assertBankFileMatchesRun(
          bankSlips.map((calc) => ({
            employeeId: calc.employeeId,
            amountIdr: calc.netIdr,
          })),
          calculations,
          totals.data,
        );
        if (bankSlips.length === 0)
          throw refuse(
            "PAYROLL_BANK_FILE_EMPTY",
            "Tidak ada gaji transfer bank untuk diekspor pada payroll ini.",
          );

        // legend-89cl7: payees come ONLY from the snapshot sealed at lock,
        // never from the employee's current account. No snapshot (a run
        // locked before snapshots existed) refuses; nothing falls back.
        const snapshotRows = await tx
          .select({
            id: payslipBankSnapshots.id,
            tenantId: payslipBankSnapshots.tenantId,
            payslipId: payslipBankSnapshots.payslipId,
            employeeId: payslipBankSnapshots.employeeId,
            snapshotEncrypted: payslipBankSnapshots.snapshotEncrypted,
            piiKeyVersion: payslipBankSnapshots.piiKeyVersion,
          })
          .from(payslipBankSnapshots)
          .where(
            and(
              eq(payslipBankSnapshots.tenantId, tenantId),
              eq(payslipBankSnapshots.payrollRunId, payrollRunId),
            ),
          );
        const snapshotByEmployee = new Map(
          snapshotRows.map((row) => [row.employeeId, row]),
        );
        const slipIdByEmployee = new Map(
          slipRows.map((row) => [row.employeeId, row.id]),
        );
        const missing: string[] = [];
        const unreadable: string[] = [];
        const rows: BankFileRow[] = [];
        for (const calc of bankSlips) {
          const snapshot = snapshotByEmployee.get(calc.employeeId);
          if (!snapshot) {
            missing.push(calc.employeeId);
            continue;
          }
          let payee: PayeeBankSnapshot;
          try {
            // The snapshot must belong to this employee's payslip of this run.
            if (snapshot.payslipId !== slipIdByEmployee.get(calc.employeeId))
              throw new Error("snapshot payslip mismatch");
            payee = openPayeeBankSnapshot(snapshot);
          } catch {
            // The error may carry the account number: record the id only.
            unreadable.push(calc.employeeId);
            continue;
          }
          rows.push({
            employeeId: calc.employeeId,
            employeeCode: payee.employeeCode,
            employeeName: payee.employeeName,
            bankName: payee.bankName,
            accountNumber: payee.accountNumber,
            accountHolder: payee.accountHolder,
            amountIdr: calc.netIdr,
          });
        }
        if (missing.length > 0)
          throw refuse(
            "PAYROLL_BANK_SNAPSHOT_MISSING",
            `Rekening tujuan gaji belum dibekukan saat payroll dikunci, sehingga berkas transfer tidak bisa dibuat. Rekening karyawan saat ini tidak dipakai (ID karyawan: ${idList(missing)}).`,
          );
        if (unreadable.length > 0)
          throw refuse(
            "PAYROLL_BANK_ACCOUNT_UNREADABLE",
            `Rekening bank karyawan tidak bisa dibaca (ID karyawan: ${idList(unreadable)}).`,
          );
        rows.sort(
          (a, b) =>
            a.employeeCode.localeCompare(b.employeeCode) ||
            a.employeeId.localeCompare(b.employeeId),
        );

        const periodLabel = run.periodEnd.slice(0, 7);
        const text = formatter.render(rows, {
          payrollRunId,
          periodLabel,
          payDate: run.payDate,
        });
        const totalIdr = idr(rows.reduce((sum, row) => sum + row.amountIdr, 0));
        const fileId = randomUUID();
        const objectKey = `payroll/bank-transfer-files/${payrollRunId}/${fileId}.${formatter.extension}`;
        const removeFile = await storeFile(
          context,
          runtime,
          fileId,
          objectKey,
          formatter.contentType,
          text,
        );
        try {
          await tx.insert(bankTransferFiles).values({
            id: fileId as BankFileRowRecord["id"],
            tenantId,
            payrollRunId,
            format: input.format,
            rowCount: rows.length,
            totalIdr,
            checksumSha256: createHash("sha256")
              .update(text, "utf8")
              .digest("hex"),
            objectKey,
            createdBy: actor,
          });
          await audit(
            tx,
            context,
            actor,
            "payroll.bank_transfer_file.created",
            "bank_transfer_file",
            fileId,
            {
              payrollRunId,
              format: input.format,
              rowCount: rows.length,
              totalIdr,
            },
            "Ekspor berkas transfer gaji (rekening bank karyawan).",
          );
        } catch (error) {
          await removeFile();
          throw error;
        }
        return { fileId: fileId as BankFileRowRecord["id"] };
      },
    );
    // The stored response holds no URL: a replay gets a fresh one.
    const [row] = await tx
      .select()
      .from(bankTransferFiles)
      .where(
        and(
          eq(bankTransferFiles.tenantId, tenantId),
          eq(bankTransferFiles.id, created.fileId),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Bank transfer file was not stored");
    const fileRun = await loadRun(tx, tenantId, row.payrollRunId);
    assertExportable(fileRun);
    const url = await signedUrl(
      context,
      runtime,
      row.id,
      row.objectKey,
      bankFileName(
        fileRun.periodEnd.slice(0, 7),
        row.payrollRunId,
        getBankFormatter(input.format).extension,
      ),
    );
    // A replay mints a new link: audit it too (the first call audited the file).
    if (!fresh)
      await audit(
        tx,
        context,
        actor,
        "payroll.bank_transfer_file.download_link_created",
        "bank_transfer_file",
        row.id,
        { payrollRunId: row.payrollRunId, format: input.format },
        "Tautan unduh berkas transfer gaji dibuat ulang.",
      );
    return toBankFile(row, url);
  });
}

export async function listBankTransferFiles(
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  query: { cursor?: string | undefined; limit: number },
  runtime: StorageRuntime,
): Promise<BankTransferFilePage> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      READ_CODE,
    );
    const run = await loadRun(tx, tenantId, payrollRunId);
    assertExportable(run);
    const filters: SQL[] = [
      eq(bankTransferFiles.tenantId, tenantId),
      eq(bankTransferFiles.payrollRunId, payrollRunId),
    ];
    if (query.cursor) {
      const [createdAt, id] = cursorPair(query.cursor);
      // The cursor carries the database's own text form of the timestamp, so
      // microseconds survive the round trip.
      filters.push(
        sql`(${bankTransferFiles.createdAt}, ${bankTransferFiles.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
      );
    }
    const rows = await tx
      .select({
        row: bankTransferFiles,
        createdAtKey: sql<string>`${bankTransferFiles.createdAt}::text`,
      })
      .from(bankTransferFiles)
      .where(and(...filters))
      .orderBy(desc(bankTransferFiles.createdAt), desc(bankTransferFiles.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const periodLabel = run.periodEnd.slice(0, 7);
    const data = await Promise.all(
      page.map(async ({ row }) =>
        toBankFile(
          row,
          await signedUrl(
            context,
            runtime,
            row.id,
            row.objectKey,
            bankFileName(
              periodLabel,
              payrollRunId,
              getBankFormatter(row.format as BankTransferFormat).extension,
            ),
          ),
        ),
      ),
    );
    if (data.length > 0)
      await audit(
        tx,
        context,
        actor,
        "payroll.bank_transfer_file.download_link_created",
        "payroll_run",
        payrollRunId,
        { payrollRunId, rowCount: data.length },
        "Tautan unduh berkas transfer gaji dibuat (daftar berkas).",
      );
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAtKey, last.row.id])
            : null,
      },
    };
  });
}

// ---- Coretax PPh 21 (BPMP) --------------------------------------------------

type TerVersion = StatutoryTableVersionOf<"pph21_ter">;

type TaxSlip = {
  employeeId: string;
  runId: string;
  payDate: string;
  calc: PayslipCalculation;
};

type TaxExportSummary = NonNullable<PayrollTaxExport["summary"]>;

/** First day of the month after `YYYY-MM`. */
function nextMonthStart(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** PPh 21 "K/I" statuses are not in the Coretax sample list: refused, never mapped. */
const isUnsupportedPtkp = (status: string) => status.startsWith("K/I/");

/** The TER table a locked run pinned at lock (PAYR-02), checked against its ref. */
async function loadPinnedTerVersion(
  tx: Tx,
  tenantId: TenantId,
  configSnapshot: unknown,
): Promise<TerVersion> {
  const refs = statutoryVersionRefSchema
    .array()
    .safeParse(
      (configSnapshot as { statutoryVersions?: unknown } | null)
        ?.statutoryVersions,
    );
  const ref = refs.success
    ? refs.data.find((pinned) => pinned.type === "pph21_ter")
    : undefined;
  const unavailable = () =>
    refuse(
      "PAYROLL_TAX_EXPORT_TER_MISMATCH",
      "Tabel TER yang dipakai payroll tidak tersedia, ekspor pajak tidak bisa diverifikasi.",
    );
  if (!ref) throw unavailable();
  const [row] = await tx
    .select()
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.tenantId, tenantId),
        eq(statutoryRates.id, ref.versionId),
      ),
    )
    .limit(1);
  if (!row) throw unavailable();
  const parsed = statutoryTableVersionSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    legalBasis: row.legalBasis,
    parameters: row.parameters,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
  });
  if (
    !parsed.success ||
    parsed.data.type !== "pph21_ter" ||
    parsed.data.status !== "published" ||
    parsed.data.version !== ref.version ||
    parsed.data.effectiveFrom !== ref.effectiveFrom
  )
    throw unavailable();
  return parsed.data as TerVersion;
}

function taxFileName(kind: string, taxPeriod: string): string {
  return kind === "annual_statement"
    ? `coretax-pph21-a1-${taxPeriod}.xml`
    : `coretax-pph21-bpmp-${taxPeriod}.xml`;
}

type TaxExportRecord = typeof payrollTaxExports.$inferSelect;

function toTaxExport(
  row: TaxExportRecord,
  fileUrl: string | null,
  summary: TaxExportSummary | undefined,
): PayrollTaxExport {
  return payrollTaxExportSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    kind: row.kind,
    taxPeriod: row.taxPeriod,
    status: row.status,
    fileUrl,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    ...(summary ? { summary } : {}),
  });
}

/** Stores the rendered Coretax file and its row, with one audit row (ids and counts only). */
async function storeTaxExport(
  tx: Tx,
  context: ScopedTenantContext,
  runtime: StorageRuntime,
  actor: UserId,
  input: { legalEntityId: string; kind: string; taxPeriod: string },
  xml: string,
  summary: TaxExportSummary,
): Promise<{ exportId: TaxExportRecord["id"]; summary: TaxExportSummary }> {
  const tenantId = context.tenant.tenantId;
  const exportId = randomUUID();
  const objectKey = `payroll/tax-exports/${exportId}/${taxFileName(input.kind, input.taxPeriod)}`;
  const removeFile = await storeFile(
    context,
    runtime,
    exportId,
    objectKey,
    "application/xml",
    xml,
  );
  try {
    await tx.insert(payrollTaxExports).values({
      id: exportId as TaxExportRecord["id"],
      tenantId,
      legalEntityId: input.legalEntityId,
      kind: input.kind,
      taxPeriod: input.taxPeriod,
      status: "ready",
      objectKey,
      createdBy: actor,
    });
    await audit(
      tx,
      context,
      actor,
      "payroll.tax_export.created",
      "payroll_tax_export",
      exportId,
      {
        legalEntityId: input.legalEntityId,
        kind: input.kind,
        taxPeriod: input.taxPeriod,
        rowCount: summary.rowCount,
        excluded: summary.excluded,
      },
      "Ekspor PPh 21 Coretax (NIK dan NPWP karyawan).",
    );
  } catch (error) {
    await removeFile();
    throw error;
  }
  return { exportId: exportId as TaxExportRecord["id"], summary };
}

export async function createPayrollTaxExport(
  context: ScopedTenantContext,
  actorUserId: string,
  input: {
    legalEntityId: string;
    kind: "monthly_withholding" | "annual_statement";
    taxPeriod: string;
    idempotencyKey: string;
  },
  runtime: StorageRuntime,
): Promise<PayrollTaxExport> {
  if (input.kind !== "annual_statement" && input.kind !== "monthly_withholding")
    throw refuse(
      "PAYROLL_TAX_EXPORT_NOT_SUPPORTED",
      "Jenis ekspor pajak ini belum tersedia.",
    );
  const annual = input.kind === "annual_statement";
  if (
    annual
      ? !/^\d{4}$/.test(input.taxPeriod)
      : !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.taxPeriod)
  )
    throw refuse(
      "PAYROLL_TAX_EXPORT_PERIOD_INVALID",
      annual
        ? "Tahun pajak harus berformat YYYY."
        : "Masa pajak bulanan harus berformat YYYY-MM.",
    );
  const tenantId = context.tenant.tenantId;
  const taxYear = Number(input.taxPeriod.slice(0, 4));
  const taxMonth = Number(input.taxPeriod.slice(5, 7));

  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      LOCK_CODE,
    );
    // legend 1229: the year lock a run lock, reversal or rapel finalize holds.
    // An export waits for one in progress and sees its slips; one that starts
    // later marks this export stale.
    await lockPayrollTaxYear(
      tx,
      tenantId,
      input.legalEntityId,
      input.taxPeriod.slice(0, 4),
    );
    let fresh = false;
    const created = await idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "payroll.tax_export.create",
      {
        actor,
        legalEntityId: input.legalEntityId,
        kind: input.kind,
        taxPeriod: input.taxPeriod,
      },
      async () => {
        fresh = true;
        // Withholder (legal entity) NPWP: 16 digits, the 15-digit legacy form is refused.
        const [entity] = await tx
          .select({ id: legalEntities.id, npwp: legalEntities.npwpEncrypted })
          .from(legalEntities)
          .where(
            and(
              eq(legalEntities.tenantId, tenantId),
              eq(legalEntities.id, input.legalEntityId),
            ),
          )
          .limit(1);
        if (!entity) throw notFound("Badan hukum");
        if (!entity.npwp)
          throw refuse(
            "PAYROLL_TAX_EXPORT_WITHHOLDER_NPWP_INVALID",
            "NPWP badan hukum belum diisi.",
          );
        let tin16: string;
        try {
          tin16 = openSecret(entity.npwp, `legal_entity:${tenantId}`).replace(
            /\D/g,
            "",
          );
        } catch {
          throw refuse(
            "PAYROLL_TAX_EXPORT_WITHHOLDER_NPWP_INVALID",
            "NPWP badan hukum tidak bisa dibaca.",
          );
        }
        if (!/^\d{16}$/.test(tin16))
          throw refuse(
            "PAYROLL_TAX_EXPORT_WITHHOLDER_NPWP_INVALID",
            "NPWP badan hukum harus 16 digit (format 15 digit lama ditolak).",
          );
        // NITKU = NPWP16 + 6 zeros (head office). No NITKU column exists: assumption.
        const nitku22 = `${tin16}000000`;

        if (annual) {
          const built = await buildAnnualA1Xml(tx, {
            tenantId,
            legalEntityId: input.legalEntityId,
            taxYear,
            withholderTin16: tin16,
            nitku22,
          });
          return storeTaxExport(tx, context, runtime, actor, input, built.xml, {
            rowCount: built.rowCount,
            excluded: built.excluded,
          });
        }

        const slipRows = await tx
          .select({
            id: payslips.id,
            tenantId: payslips.tenantId,
            employeeId: payslips.employeeId,
            calculationEncrypted: payslips.calculationEncrypted,
            piiKeyVersion: payslips.piiKeyVersion,
            runId: payrollRuns.id,
            payDate: payrollRuns.payDate,
            runStatus: payrollRuns.status,
            configSnapshot: payrollRuns.configSnapshot,
            employmentType: employees.employmentType,
            nikEncrypted: employees.nikEncrypted,
            employeePiiKeyVersion: employees.piiKeyVersion,
          })
          .from(payslips)
          .innerJoin(
            payrollRuns,
            and(
              eq(payrollRuns.tenantId, payslips.tenantId),
              eq(payrollRuns.id, payslips.payrollRunId),
            ),
          )
          .innerJoin(
            employees,
            and(
              eq(employees.tenantId, payslips.tenantId),
              eq(employees.id, payslips.employeeId),
            ),
          )
          .where(
            and(
              eq(payslips.tenantId, tenantId),
              eq(payrollRuns.legalEntityId, input.legalEntityId),
              inArray(payrollRuns.status, [...EXPORTABLE_STATUSES]),
              gte(payrollRuns.payDate, `${input.taxPeriod}-01`),
              lt(payrollRuns.payDate, nextMonthStart(input.taxPeriod)),
            ),
          );

        const excluded = {
          nonPermanentEmployee: 0,
          annualRecalculation: 0,
          zeroGross: 0,
        };
        const slipsByEmployee = new Map<string, TaxSlip[]>();
        const configByRun = new Map<
          string,
          { status: string; payDate: string; configSnapshot: unknown }
        >();
        const identityByEmployee = new Map<
          string,
          { nikEncrypted: Buffer | null; piiKeyVersion: number }
        >();
        for (const row of slipRows) {
          const calc = sealedCalculation(row);
          if (calc.employeeId !== row.employeeId)
            throw refuse(
              "PAYROLL_PAYSLIP_UNREADABLE",
              "Slip gaji tidak sesuai dengan karyawannya, berkas tidak bisa dibuat.",
            );
          if (!PERMANENT_EMPLOYMENT_TYPES.includes(row.employmentType)) {
            excluded.nonPermanentEmployee += 1;
            continue;
          }
          if (calc.tax.method !== "ter") {
            excluded.annualRecalculation += 1;
            continue;
          }
          configByRun.set(row.runId, {
            status: row.runStatus,
            payDate: row.payDate,
            configSnapshot: row.configSnapshot,
          });
          identityByEmployee.set(row.employeeId, {
            nikEncrypted: row.nikEncrypted,
            piiKeyVersion: row.employeePiiKeyVersion,
          });
          const list = slipsByEmployee.get(row.employeeId) ?? [];
          list.push({
            employeeId: row.employeeId,
            runId: row.runId,
            payDate: row.payDate,
            calc,
          });
          slipsByEmployee.set(row.employeeId, list);
        }

        // Employees with a month's gross to report, in a stable order.
        const groups: {
          employeeId: string;
          slips: TaxSlip[];
          gross: number;
        }[] = [];
        for (const [employeeId, slips] of [...slipsByEmployee].sort((a, b) =>
          a[0].localeCompare(b[0]),
        )) {
          const gross = slips.reduce(
            (sum, slip) => sum + slip.calc.tax.taxableGrossIdr,
            0,
          );
          if (gross === 0) {
            excluded.zeroGross += slips.length;
            continue;
          }
          groups.push({ employeeId, slips, gross });
        }

        // One clear refusal for the whole export (ids only).
        const unsupportedPtkp = groups
          .filter((group) =>
            group.slips.some((slip) =>
              isUnsupportedPtkp(slip.calc.tax.ptkpStatus),
            ),
          )
          .map((group) => group.employeeId);
        if (unsupportedPtkp.length > 0)
          throw refuse(
            "PAYROLL_TAX_EXPORT_PTKP_UNSUPPORTED",
            `Status PTKP K/I belum didukung impor Coretax (ID karyawan: ${idList(unsupportedPtkp)}).`,
          );

        // Re-derive the TER rate and the PPh 21 like the engine: the run's pinned
        // TER table gives the rate, the run's pinned PPh 21 policy the rounding
        // (pph21.ts `taxOf`), not the TER table's own roundingMode.
        const policyVersions = await loadPph21PolicyVersionsForRun(context, tx);
        const versionByRun = new Map<
          string,
          { version: TerVersion; mode: RoundingMode }
        >();
        const terMismatch: string[] = [];
        const rowsBase: {
          employeeId: string;
          ptkpStatus: string;
          gross: number;
          terRateBp: number;
          slips: TaxSlip[];
        }[] = [];
        for (const group of groups) {
          const pinned: { version: TerVersion; mode: RoundingMode }[] = [];
          for (const slip of group.slips) {
            let entry = versionByRun.get(slip.runId);
            if (!entry) {
              const run = configByRun.get(slip.runId)!;
              entry = {
                version: await loadPinnedTerVersion(
                  tx,
                  tenantId,
                  run.configSnapshot,
                ),
                mode: pph21PolicyForRun(
                  {
                    status: run.status as PayrollRunStatus,
                    payDate: run.payDate as BusinessDate,
                    configSnapshot: run.configSnapshot as Parameters<
                      typeof pph21PolicyForRun
                    >[0]["configSnapshot"],
                  },
                  policyVersions,
                ).parameters.roundingMode,
              };
              versionByRun.set(slip.runId, entry);
            }
            pinned.push(entry);
          }
          const versions = pinned.map((entry) => entry.version);
          const first = group.slips[0]!;
          const ptkpStatus = first.calc.tax.ptkpStatus;
          const gross = idr(group.gross);
          const derivedRate = lookupTerRate(versions[0]!, ptkpStatus, gross);
          const derivedTax = rupiahAtRate(
            gross,
            derivedRate.rateBp,
            pinned[0]!.mode,
          );
          const slipTax = group.slips.reduce(
            (sum, slip) => sum + slip.calc.tax.pph21Idr,
            0,
          );
          const consistent =
            pinned.every(
              (entry) =>
                entry.version.id === versions[0]!.id &&
                entry.mode === pinned[0]!.mode,
            ) &&
            group.slips.every(
              (slip) =>
                // The no-tax-id surcharge changes the engine's tax: not verifiable here, so refused.
                !slip.calc.tax.noTaxIdSurchargeApplied &&
                slip.calc.tax.ptkpStatus === ptkpStatus &&
                // Runs of one month: each slip carries the TER rate of the
                // month total up to its run (never above the total's rate);
                // the run that completed the total carries the total's rate.
                slip.calc.tax.terRateBp !== null &&
                slip.calc.tax.terRateBp <= derivedRate.rateBp,
            ) &&
            group.slips.some(
              (slip) => slip.calc.tax.terRateBp === derivedRate.rateBp,
            ) &&
            derivedTax === slipTax;
          if (!consistent) {
            terMismatch.push(group.employeeId);
            continue;
          }
          rowsBase.push({
            employeeId: group.employeeId,
            ptkpStatus,
            gross: group.gross,
            terRateBp: derivedRate.rateBp,
            slips: group.slips,
          });
        }
        if (terMismatch.length > 0)
          throw refuse(
            "PAYROLL_TAX_EXPORT_TER_MISMATCH",
            `Tarif TER atau PPh 21 slip tidak sesuai tabel TER payroll (ID karyawan: ${idList(terMismatch)}).`,
          );

        // NIK (CounterpartTin) and position: missing data refuses, nothing is invented.
        const badNik: string[] = [];
        const noPosition: string[] = [];
        const rows: BpmpRow[] = [];
        for (const base of rowsBase) {
          const identity = identityByEmployee.get(base.employeeId);
          let nik16: string | null = null;
          if (identity?.nikEncrypted) {
            try {
              nik16 = normalizeHrisPii(
                "nik",
                openHrisPii(
                  identity.nikEncrypted,
                  {
                    tenantId,
                    table: "employees",
                    rowId: base.employeeId,
                    field: "nik",
                  },
                  identity.piiKeyVersion,
                ),
              );
            } catch {
              nik16 = null;
            }
          }
          if (nik16 === null || !/^\d{16}$/.test(nik16)) {
            badNik.push(base.employeeId);
            continue;
          }
          const latest = [...base.slips].sort((a, b) =>
            a.payDate.localeCompare(b.payDate),
          );
          const withholding = latest[latest.length - 1]!;
          const position = withholding.calc.positionName?.trim() ?? "";
          if (position === "") {
            noPosition.push(base.employeeId);
            continue;
          }
          rows.push({
            taxMonth,
            taxYear,
            nik16,
            ptkpStatus: base.ptkpStatus,
            position,
            grossIdr: base.gross,
            terRateBp: base.terRateBp,
            withholdingDate: withholding.payDate,
          });
        }
        if (badNik.length > 0)
          throw refuse(
            "PAYROLL_TAX_EXPORT_NIK_INVALID",
            `NIK karyawan kosong atau tidak valid (ID karyawan: ${idList(badNik)}).`,
          );
        if (noPosition.length > 0)
          throw refuse(
            "PAYROLL_TAX_EXPORT_POSITION_MISSING",
            `Jabatan karyawan belum diisi pada slip gaji (ID karyawan: ${idList(noPosition)}).`,
          );
        if (rows.length === 0)
          throw refuse(
            "PAYROLL_TAX_EXPORT_EMPTY",
            "Tidak ada PPh 21 TER pegawai tetap untuk diekspor pada masa pajak ini.",
          );

        const xml = buildBpmpXml({ withholderTin16: tin16, nitku22, rows });
        return storeTaxExport(tx, context, runtime, actor, input, xml, {
          rowCount: rows.length,
          excluded,
        });
      },
    );
    // The stored response holds no URL: a replay gets a fresh one.
    const [row] = await tx
      .select()
      .from(payrollTaxExports)
      .where(
        and(
          eq(payrollTaxExports.tenantId, tenantId),
          eq(payrollTaxExports.id, created.exportId),
        ),
      )
      .limit(1);
    if (!row?.objectKey) throw new Error("Payroll tax export was not stored");
    if (!fresh) {
      // A replay: no link once a reversal or a later lock left the file stale
      // (legend 1229). An export made after the reversal replays normally.
      if (row.supersededAt)
        throw taxExportSupersededError(row.kind, row.taxPeriod);
    }
    const url = await signedUrl(
      context,
      runtime,
      row.id,
      row.objectKey,
      taxFileName(row.kind, row.taxPeriod),
    );
    if (!fresh)
      await audit(
        tx,
        context,
        actor,
        "payroll.tax_export.download_link_created",
        "payroll_tax_export",
        row.id,
        {
          legalEntityId: row.legalEntityId,
          kind: row.kind,
          taxPeriod: row.taxPeriod,
        },
        "Tautan unduh ekspor PPh 21 Coretax dibuat ulang.",
      );
    return toTaxExport(row, url, created.summary);
  });
}
