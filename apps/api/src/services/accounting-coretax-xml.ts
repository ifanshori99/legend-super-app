// Coretax XML for a finalised tax report (bead legend-5nhkp, WS-07; PRD v1.7
// §3.19). A pure function of the report row and the real tax ids the caller
// opened (`resolveCoretaxTaxIds`): no clock, no randomness, so the same inputs
// always render the same bytes. `<Revision>` is the Legend
// revision number (0 = normal, n = correction n), the same figure Coretax
// asks as the SPT "pembetulan" code.

import { AccountingError, type TaxReport } from "@starter/shared/accounting";

// XML 1.0 forbids most control characters even when escaped; drop them.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Reports stored before `warnings` existed kept an auditor note in
 * `references`, starting with this prefix. It is never exported: a safety net
 * for that old stored data (legend-wqorb).
 */
export const TAX_LINE_WARNING_PREFIX = "Peringatan:";

const element = (name: string, value: string | number, indent: string) =>
  `${indent}<${name}>${escapeXml(String(value))}</${name}>`;

export type CoretaxXmlReport = Pick<
  TaxReport,
  | "id"
  | "legalEntityId"
  | "type"
  | "period"
  | "revisionNo"
  | "amountIdr"
  | "lines"
  | "finalizedAt"
>;

export type CoretaxTaxIdsInput = {
  /** subjectId -> NPWP digits (15 or 16) opened at export time. */
  lines: ReadonlyMap<string, string>;
  taxpayer: string | null;
};

const NPWP_DIGITS = /^[0-9]{15,16}$/;

export function buildCoretaxXml(
  report: CoretaxXmlReport,
  taxIds: CoretaxTaxIdsInput = { lines: new Map(), taxpayer: null },
): string {
  // Only a finalised row has a revision number and a finalisation time.
  if (report.revisionNo === null || report.finalizedAt === null)
    throw new AccountingError("INVALID_TRANSITION");
  // Fail closed: a line that carried a tax id on screen must export the real,
  // well-formed one. The id is never echoed in the error.
  if (taxIds.taxpayer !== null && !NPWP_DIGITS.test(taxIds.taxpayer))
    throw new AccountingError(
      "TAX_REPORT_SOURCE_UNAVAILABLE",
      "NPWP badan usaha tidak valid, ekspor tidak bisa dibuat.",
    );
  const taxIdOf = (line: CoretaxXmlReport["lines"][number]): string => {
    if (line.taxIdMasked === null) return "";
    const real = taxIds.lines.get(line.subjectId);
    // The real id must be 15/16 digits and end with the digits shown masked on
    // the report; a different id means the source changed after finalisation.
    const maskedLast4 = /(\d{4})\s*$/.exec(line.taxIdMasked)?.[1];
    if (
      real === undefined ||
      !NPWP_DIGITS.test(real) ||
      maskedLast4 === undefined ||
      real.slice(-4) !== maskedLast4
    )
      throw new AccountingError(
        "TAX_REPORT_SOURCE_UNAVAILABLE",
        `NPWP ${line.subjectName} tidak tersedia, formatnya salah (harus 15 atau 16 digit), atau berbeda dari laporan, ekspor tidak bisa dibuat.`,
      );
    return real;
  };
  const lines = report.lines.map((line) =>
    [
      "    <Line>",
      element("SubjectType", line.subjectType, "      "),
      element("SubjectId", line.subjectId, "      "),
      element("SubjectName", line.subjectName, "      "),
      element("TaxId", taxIdOf(line), "      "),
      element("OutletId", line.outletId ?? "", "      "),
      element("BaseIdr", line.baseIdr, "      "),
      element("TaxIdr", line.taxIdr, "      "),
      ...(line.direction === undefined
        ? []
        : [element("Direction", line.direction, "      ")]),
      "      <References>",
      // `line.warnings` is for the screen and is never exported.
      ...line.references
        .filter((ref) => !ref.startsWith(TAX_LINE_WARNING_PREFIX))
        .map((ref) => element("Reference", ref, "        ")),
      "      </References>",
      "    </Line>",
    ].join("\n"),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<TaxReport>",
    "  <Header>",
    element("ReportId", report.id, "    "),
    element("LegalEntityId", report.legalEntityId, "    "),
    element("TaxpayerId", taxIds.taxpayer ?? "", "    "),
    element("Type", report.type, "    "),
    element("Period", report.period, "    "),
    element("Revision", report.revisionNo, "    "),
    element("FinalizedAt", report.finalizedAt, "    "),
    element("AmountIdr", report.amountIdr, "    "),
    "  </Header>",
    "  <Lines>",
    ...lines,
    "  </Lines>",
    "</TaxReport>",
    "",
  ].join("\n");
}
