// Tax recap and exports (PRD v1.7 §3.19 "Pajak [P0] — Rekap PBJT, PPh 21 (dari
// payroll), PPh 23 (jasa supplier), dan PPN masukan bila badan usaha PKP,
// dengan ekspor dalam format yang siap diunggah ke Coretax DJP"; §6 F
// `tax_reports`: type pbjt/pph21/pph23/ppn, period, amount_idr, file_key,
// status). Rates are tenant/tax configuration (WS-05 tax contract), never
// constants here: a report only sums what was posted.

import { z } from "zod";
import {
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
});
export type TaxReportLine = z.infer<typeof taxReportLineSchema>;

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
  })
  .superRefine((report, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const sum = report.lines.reduce((total, line) => total + line.taxIdr, 0);
    if (sum !== report.amountIdr)
      issue("amountIdr", "amount = sum of line tax");
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
 * afterwards (a reopen would need a new draft).
 */
export function transitionTaxReport(
  current: Pick<TaxReport, "status">,
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
      return "exported";
  }
}

export const generateTaxReportInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  type: taxReportTypeSchema,
  period: periodKeySchema,
});

/** Coretax export name `coretax-<type>-<period>.xml`: only `[a-z0-9-]` plus the
 * extension, so it is safe in a Content-Disposition header. Throws on invalid input. */
export function coretaxExportFileName(
  type: TaxReportType,
  period: string,
): string {
  return `coretax-${taxReportTypeSchema.parse(type)}-${periodKeySchema.parse(period)}.xml`;
}

export const taxReportExportSchema = z.strictObject({
  taxReportId: taxReportIdSchema,
  fileKey: z.string().min(1).max(500),
  fileName: z.string().min(1).max(150),
  /** Short-lived signed download URL from the storage adapter. */
  downloadUrl: z.url(),
  expiresAt: isoDateTimeSchema,
});
