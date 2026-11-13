// Real tax ids for the Coretax export (bead legend-xysyi, WS-07). The stored
// report only keeps masked ids; the export opens the real ones here, inside the
// export transaction, from the source rows: employees (sealed NPWP, NIK as the
// fallback the PPh 21 source used), the NPWP snapshotted on the supplier
// invoices the report line was built from, and the legal entity (sealed NPWP;
// missing = refused). The caller (`buildCoretaxXml`) checks each real id's last
// four digits against the line mask. A value is never logged or put in an
// error message.

import { and, eq, inArray } from "drizzle-orm";
import {
  AccountingError,
  type TaxReport,
  type TaxReportLine,
} from "@starter/shared/accounting";
import { employees, legalEntities } from "../db/schema";
import { normalizeHrisPii, openHrisPii } from "../lib/hris-pii";
import { openSecret } from "../lib/secrets";
import type { TenantTransaction } from "./accounting-shared";
import { supplierNpwpSnapshots } from "./accounting-tax-source-vat-wht";

/** NPWP (15 digits) or NIK-based NPWP (16 digits), separators removed. */
export const NPWP_DIGITS = /^[0-9]{15,16}$/;

export const normalizeNpwp = (raw: string): string | null => {
  const digits = raw.replace(/[\s.\-/]/g, "");
  return NPWP_DIGITS.test(digits) ? digits : null;
};

const unavailable = (message: string) =>
  new AccountingError("TAX_REPORT_SOURCE_UNAVAILABLE", message);

export type CoretaxTaxIds = {
  /** subjectId -> digits, for employee and supplier lines. */
  lines: Map<string, string>;
  /** Legal entity NPWP digits, null when the entity has none. */
  taxpayer: string | null;
};

export async function resolveCoretaxTaxIds(
  tx: TenantTransaction,
  tenantId: string,
  report: Pick<TaxReport, "legalEntityId" | "type" | "period"> & {
    lines: readonly TaxReportLine[];
  },
): Promise<CoretaxTaxIds> {
  const { lines, legalEntityId } = report;
  const resolved = new Map<string, string>();

  const employeeIds = lines
    .filter((l) => l.subjectType === "employee" && l.taxIdMasked !== null)
    .map((l) => l.subjectId);
  if (employeeIds.length > 0) {
    const rows = await tx
      .select({
        id: employees.id,
        npwpEncrypted: employees.npwpEncrypted,
        nikEncrypted: employees.nikEncrypted,
        piiKeyVersion: employees.piiKeyVersion,
      })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          inArray(employees.id, employeeIds),
        ),
      );
    for (const row of rows) {
      for (const field of ["npwp", "nik"] as const) {
        const sealed = field === "npwp" ? row.npwpEncrypted : row.nikEncrypted;
        if (!sealed) continue;
        try {
          const plaintext = openHrisPii(
            sealed,
            { tenantId, table: "employees", rowId: row.id, field },
            row.piiKeyVersion,
          );
          if (!plaintext.trim()) continue;
          // Same rule as the PPh 21 source: NPWP first, NIK when absent.
          resolved.set(row.id, normalizeHrisPii(field, plaintext));
          break;
        } catch {
          throw unavailable(
            `${field.toUpperCase()} karyawan tidak bisa dibaca, ekspor tidak bisa dibuat.`,
          );
        }
      }
    }
  }

  if (
    (report.type === "pph23" || report.type === "ppn") &&
    lines.some((l) => l.subjectType === "supplier" && l.taxIdMasked !== null)
  ) {
    const snapshots = await supplierNpwpSnapshots(
      tx,
      {
        tenantId,
        legalEntityId,
        type: report.type,
        period: report.period,
      },
      report.type,
    );
    for (const l of lines) {
      if (l.subjectType !== "supplier" || l.taxIdMasked === null) continue;
      const raw = snapshots.get(l.subjectId);
      const digits = raw == null ? null : normalizeNpwp(raw);
      if (digits !== null) resolved.set(l.subjectId, digits);
    }
  }

  const [entity] = await tx
    .select({ npwpEncrypted: legalEntities.npwpEncrypted })
    .from(legalEntities)
    .where(
      and(
        eq(legalEntities.tenantId, tenantId),
        eq(legalEntities.id, legalEntityId),
      ),
    );
  // Fail closed: a Coretax file without the taxpayer's own NPWP is refused.
  let taxpayer: string | null = null;
  if (entity?.npwpEncrypted) {
    try {
      taxpayer = normalizeNpwp(
        openSecret(entity.npwpEncrypted, `legal_entity:${tenantId}`),
      );
    } catch {
      taxpayer = null;
    }
  }
  if (taxpayer === null)
    throw unavailable(
      "NPWP badan usaha belum diisi, tidak bisa dibaca, atau formatnya salah. Ekspor tidak bisa dibuat.",
    );

  return { lines: resolved, taxpayer };
}
