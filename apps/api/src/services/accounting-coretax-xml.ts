// Coretax XML for a finalised tax report (bead legend-5nhkp, WS-07; PRD v1.7
// §3.19). A pure function of the report row: no clock, no randomness, so the
// same revision always renders the same bytes. `<Revision>` is the Legend
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
 * A line reference starting with this is an auditor warning for the screen
 * (legend-powk0: no warnings field on a line yet). It is never exported.
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

export function buildCoretaxXml(report: CoretaxXmlReport): string {
  // Only a finalised row has a revision number and a finalisation time.
  if (report.revisionNo === null || report.finalizedAt === null)
    throw new AccountingError("INVALID_TRANSITION");
  const lines = report.lines.map((line) =>
    [
      "    <Line>",
      element("SubjectType", line.subjectType, "      "),
      element("SubjectId", line.subjectId, "      "),
      element("SubjectName", line.subjectName, "      "),
      element("TaxId", line.taxIdMasked ?? "", "      "),
      element("OutletId", line.outletId ?? "", "      "),
      element("BaseIdr", line.baseIdr, "      "),
      element("TaxIdr", line.taxIdr, "      "),
      ...(line.direction === undefined
        ? []
        : [element("Direction", line.direction, "      ")]),
      "      <References>",
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
