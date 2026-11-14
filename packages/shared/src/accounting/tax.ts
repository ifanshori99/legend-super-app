// Tax recap and exports (PRD v1.7 §3.19 "Pajak [P0] — Rekap PBJT, PPh 21 (dari
// payroll), PPh 23 (jasa supplier), dan PPN masukan bila badan usaha PKP,
// dengan ekspor dalam format yang siap diunggah ke Coretax DJP"; §6 F
// `tax_reports`: type pbjt/pph21/pph23/ppn, period, amount_idr, file_key,
// status). Rates are tenant/tax configuration (WS-05 tax contract), never
// constants here: a report only sums what was posted.

import { z } from "zod";
import {
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { AccountingError } from "./errors.ts";
import { legalEntityIdSchema, taxReportIdSchema } from "./ids.ts";
import { periodKeySchema } from "./period-key.ts";
import type { FiscalPeriod } from "./period.ts";

export const TAX_REPORT_TYPES = ["pbjt", "pph21", "pph23", "ppn"] as const;
export const taxReportTypeSchema = z.enum(TAX_REPORT_TYPES);
export type TaxReportType = z.infer<typeof taxReportTypeSchema>;

export const taxReportStatusSchema = z.enum(["draft", "final", "exported"]);
export type TaxReportStatus = z.infer<typeof taxReportStatusSchema>;

const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Amount must be >= 0");

export const taxReportLineSchema = z.strictObject({
  /** Outlet (PBJT is per outlet/region), employee (PPh 21) or supplier (PPh 23 / PPN). */
  subjectType: z.enum(["outlet", "employee", "supplier"]),
  subjectId: uuidSchema,
  subjectName: z.string().trim().min(1).max(150),
  /** Masked tax id shown in the UI (e.g. NPWP ****1234); the export reads the real one server-side. */
  taxIdMasked: z.string().max(30).nullable(),
  outletId: outletIdSchema.nullable(),
  baseIdr: nonNegativeIdr,
  taxIdr: nonNegativeIdr,
  /** Source document numbers (invoice, payslip run) for the auditor. */
  references: z.array(z.string().max(60)).max(50),
  /**
   * Auditor notes for the screen only (e.g. non-PBJT tax left out of the PBJT
   * figures). Never exported to Coretax. Reports stored before this field
   * existed read as an empty list.
   */
  warnings: z.array(z.string().max(200)).max(20).default([]),
  /** PPN only: input tax (masukan) or output tax (keluaran); absent means keluaran. */
  direction: z.enum(["masukan", "keluaran"]).optional(),
});
export type TaxReportLine = z.infer<typeof taxReportLineSchema>;

/**
 * Report amount: the sum of line tax, except PPN where it is the payable
 * position, keluaran minus masukan, never negative (a lebih bayar position
 * reports 0 and is noted in the line references, not paid out as a negative).
 */
export function taxReportAmountIdr(
  type: TaxReportType,
  lines: readonly Pick<TaxReportLine, "taxIdr" | "direction">[],
): number {
  let output = 0;
  let input = 0;
  for (const line of lines)
    if (type === "ppn" && line.direction === "masukan") input += line.taxIdr;
    else output += line.taxIdr;
  return type === "ppn" ? Math.max(0, output - input) : output;
}

export const taxReportSchema = z
  .strictObject({
    id: taxReportIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    type: taxReportTypeSchema,
    period: periodKeySchema,
    amountIdr: nonNegativeIdr,
    lines: z.array(taxReportLineSchema),
    status: taxReportStatusSchema,
    exportFormat: z.enum(["coretax_xml"]).nullable(),
    /** Object storage key of the export file (storage adapter, tenant-prefixed). */
    fileKey: z.string().min(1).max(500).nullable(),
    generatedBy: userIdSchema,
    generatedAt: isoDateTimeSchema,
    finalizedBy: userIdSchema.nullable(),
    finalizedAt: isoDateTimeSchema.nullable(),
    exportedAt: isoDateTimeSchema.nullable(),
    /** NULL while draft; 0 for the original filing, n for correction n (Coretax pembetulan ke-n). */
    revisionNo: z.number().int().min(0).max(32767).nullable(),
    supersedesId: taxReportIdSchema.nullable(),
    supersededById: taxReportIdSchema.nullable(),
    supersededAt: isoDateTimeSchema.nullable(),
    /** Written reason, required from revision 1 on. */
    correctionReason: z.string().max(500).nullable(),
    /** `fiscal_periods.version` the lines were generated against (stale check at finalize). */
    fiscalPeriodVersion: z.number().int().min(1),
    /** The filing in force for its period: finalised and not replaced. */
    isCurrent: z.boolean(),
  })
  .superRefine((report, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (taxReportAmountIdr(report.type, report.lines) !== report.amountIdr)
      issue("amountIdr", "amount = sum of line tax (PPN: keluaran - masukan)");
    const exported = report.status === "exported";
    if (
      exported !==
      (report.fileKey !== null &&
        report.exportedAt !== null &&
        report.exportFormat !== null)
    )
      issue("fileKey", "export fields are set exactly when exported");
    if (
      (report.status !== "draft") !==
      (report.finalizedBy !== null && report.finalizedAt !== null)
    )
      issue("finalizedBy", "finalized fields are set once final");
    // Mirrors the tax_reports revision CHECKs (migration 0231).
    const draft = report.status === "draft";
    if (draft !== (report.revisionNo === null))
      issue("revisionNo", "revision number is set exactly once final");
    if (report.revisionNo !== null) {
      if ((report.revisionNo === 0) !== (report.supersedesId === null))
        issue("supersedesId", "only a correction supersedes an earlier report");
      if (report.revisionNo >= 1 !== (report.correctionReason !== null))
        issue("correctionReason", "a reason is set exactly for corrections");
    }
    if (
      report.correctionReason !== null &&
      report.correctionReason.trim() === ""
    )
      issue("correctionReason", "correction reason must not be blank");
    if ((report.supersededAt === null) !== (report.supersededById === null))
      issue("supersededAt", "superseded fields are set together");
    if (report.supersededById !== null && report.supersededById === report.id)
      issue("supersededById", "a report cannot supersede itself");
    if (report.isCurrent !== (!draft && report.supersededAt === null))
      issue("isCurrent", "current = finalised and not superseded");
  });
export type TaxReport = z.infer<typeof taxReportSchema>;

/** PPN masukan only applies to a PKP legal entity (§3.19). */
export function assertTaxTypeApplicable(
  type: TaxReportType,
  legalEntity: { isPkp: boolean },
): void {
  if (type === "ppn" && !legalEntity.isPkp)
    throw new AccountingError("TAX_REPORT_NOT_APPLICABLE");
}

/**
 *   draft ─regenerate→ draft ─finalize→ final ─export→ exported (export may repeat)
 * Finalising needs the fiscal period closed, so the filed numbers cannot move
 * afterwards. After a reopen the correction is a new draft that, once
 * finalised, supersedes the current report (revision chain); a superseded
 * report can no longer be exported (only downloaded for audit).
 */
export function transitionTaxReport(
  current: Pick<TaxReport, "status" | "supersededAt">,
  action: "regenerate" | "finalize" | "export",
  period: Pick<FiscalPeriod, "status">,
): TaxReportStatus {
  switch (action) {
    case "regenerate":
      if (current.status !== "draft")
        throw new AccountingError("INVALID_TRANSITION");
      return "draft";
    case "finalize":
      if (current.status !== "draft")
        throw new AccountingError("INVALID_TRANSITION");
      if (period.status !== "closed")
        throw new AccountingError("PERIOD_NOT_CLOSED");
      return "final";
    case "export":
      if (current.status === "draft")
        throw new AccountingError("INVALID_TRANSITION");
      if (current.supersededAt !== null && current.supersededAt !== undefined)
        throw new AccountingError("TAX_REPORT_SUPERSEDED");
      return "exported";
  }
}

export const generateTaxReportInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  type: taxReportTypeSchema,
  period: periodKeySchema,
});

/** Body of finalize: the correction reason is required from revision 1 on
 * (the server decides the revision number; revision 0 ignores a reason). */
export const finalizeTaxReportBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  correctionReason: z.string().trim().min(1).max(500).optional(),
});

/** Coretax export name `coretax-<type>-<period>-r<revisionNo>.xml`: only `[a-z0-9-]`
 * plus the extension, so it is safe in a Content-Disposition header. Throws on invalid input. */
export function coretaxExportFileName(
  type: TaxReportType,
  period: string,
  revisionNo: number,
): string {
  const revision = z.number().int().min(0).max(32767).parse(revisionNo);
  return `coretax-${taxReportTypeSchema.parse(type)}-${periodKeySchema.parse(period)}-r${revision}.xml`;
}

export const taxReportExportSchema = z.strictObject({
  taxReportId: taxReportIdSchema,
  fileKey: z.string().min(1).max(500),
  fileName: z.string().min(1).max(150),
  /** Short-lived signed download URL from the storage adapter. */
  downloadUrl: z.url(),
  expiresAt: isoDateTimeSchema,
});

/** Audit download of a stored file; works for superseded reports too. */
export const taxReportDownloadSchema = taxReportExportSchema.extend({
  revisionNo: z.number().int().min(0).max(32767).nullable(),
  supersededById: taxReportIdSchema.nullable(),
});
