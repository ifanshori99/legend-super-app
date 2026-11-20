// legend 1229 (SO 1227 item 1): a Coretax export goes stale when a run of its
// month (or year) is reversed, or a new run of that month is locked, after the
// export was made. The caller holds the month advisory lock and runs this in
// the same transaction as the reversal or lock, so the mark commits with it.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import type { PayrollTaxExportSuperseded } from "@starter/shared/hris/payroll";
import { payrollTaxExports } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import type { Tx } from "./permission-resolver.ts";

export type TaxExportSupersedeReason = "run_reversed" | "run_locked";

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

/** "Ekspor pajak bulan Juli 2026 sudah tidak sesuai. ..." (tahun for A1). */
export function taxExportSupersededMessage(
  kind: string,
  taxPeriod: string,
): string {
  const label =
    kind === "annual_statement"
      ? `tahun ${taxPeriod}`
      : `bulan ${MONTHS[Number(taxPeriod.slice(5, 7)) - 1]} ${taxPeriod.slice(0, 4)}`;
  return `Ekspor pajak ${label} sudah tidak sesuai. Buat ekspor baru dan lakukan pembetulan SPT bila sudah dilaporkan.`;
}

/** 409 for a replay of a stale export: the caller must export again. */
export function taxExportSupersededError(
  kind: string,
  taxPeriod: string,
): HttpError {
  return new HttpError(
    409,
    "PAYROLL_TAX_EXPORT_SUPERSEDED",
    taxExportSupersededMessage(kind, taxPeriod),
  );
}

/**
 * Marks every ready, not yet stale export of the legal entity whose month (or
 * year) holds `payDate`, with one audit row each. Returns the marked exports.
 */
export async function supersedeTaxExportsInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  input: {
    payrollRunId: string;
    legalEntityId: string;
    payDate: string;
    reason: TaxExportSupersedeReason;
  },
  now = new Date(),
): Promise<PayrollTaxExportSuperseded[]> {
  const tenantId = context.tenant.tenantId;
  const month = input.payDate.slice(0, 7);
  const year = input.payDate.slice(0, 4);
  const marked = await tx
    .update(payrollTaxExports)
    .set({
      supersededAt: now,
      supersededReason: input.reason,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(payrollTaxExports.tenantId, tenantId),
        eq(payrollTaxExports.legalEntityId, input.legalEntityId),
        eq(payrollTaxExports.status, "ready"),
        isNull(payrollTaxExports.supersededAt),
        or(
          and(
            eq(payrollTaxExports.kind, "monthly_withholding"),
            eq(payrollTaxExports.taxPeriod, month),
          ),
          and(
            eq(payrollTaxExports.kind, "annual_statement"),
            eq(payrollTaxExports.taxPeriod, year),
          ),
        ),
      ),
    )
    .returning({
      id: payrollTaxExports.id,
      kind: payrollTaxExports.kind,
      taxPeriod: payrollTaxExports.taxPeriod,
    });
  marked.sort((a, b) => a.id.localeCompare(b.id));
  for (const row of marked)
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actor,
        deviceId: null,
        action: "payroll.tax_export.superseded",
        objectType: "payroll_tax_export",
        objectId: row.id,
        reason: taxExportSupersededMessage(row.kind, row.taxPeriod),
        maskedChanges: {
          before: null,
          after: {
            payrollRunId: input.payrollRunId,
            legalEntityId: input.legalEntityId,
            kind: row.kind,
            taxPeriod: row.taxPeriod,
            supersededReason: input.reason,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      [
        "payrollRunId",
        "legalEntityId",
        "kind",
        "taxPeriod",
        "supersededReason",
      ],
    );
  return marked.map((row) => ({
    id: row.id,
    kind: row.kind as PayrollTaxExportSuperseded["kind"],
    taxPeriod: row.taxPeriod,
    supersededAt: now.toISOString(),
    message: taxExportSupersededMessage(row.kind, row.taxPeriod),
  }));
}
