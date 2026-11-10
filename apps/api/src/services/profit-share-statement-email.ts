// Statement email copy (PRD v1.7 §3.37, SH-01; bead legend-2ljb). Pure helper
// like `pos-receipt-email.ts`: the service sends the message, logs only the
// masked address. The message carries this shareholder's own figures only and
// never the payout account or NPWP.

import type { DistributionStatement } from "@starter/shared/accounting";
import { maskEmail } from "./pos-receipt-email.ts";
import { formatRupiah } from "./purchasing-po-pdf.ts";

export { maskEmail };

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
];

function periodLabel(period: string): string {
  const [year, month] = period.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : period;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type StatementEmail = { subject: string; text: string; html: string };

/** Subject, plain text and HTML of the statement notice (Indonesian). */
export function renderStatementEmail(
  statement: DistributionStatement,
  meta: { tenantName: string },
): StatementEmail {
  const period = periodLabel(statement.period);
  const kind = statement.runType === "adjustment" ? " (penyesuaian)" : "";
  // Header-safe: the subject is a single line.
  const subject =
    `Pernyataan Bagi Hasil ${period}${kind} - ${statement.profitEntityName}`
      .replace(/\s+/g, " ")
      .trim();
  const rows: [string, string][] = [
    ["Periode", period],
    ["Bagian kotor", formatRupiah(statement.grossIdr)],
    ["Pajak dipotong", formatRupiah(statement.taxWithheldIdr)],
    ["Bagian bersih", formatRupiah(statement.netIdr)],
  ];
  if (statement.paymentRef) rows.push(["Referensi", statement.paymentRef]);
  const intro = `Pembagian hasil ${statement.profitEntityName} untuk periode ${period}${kind} sudah dibayarkan.`;
  const closing =
    "Pernyataan lengkap tersedia di aplikasi pada menu Bagi Hasil.";
  const text = [
    `Halo ${statement.shareholderName},`,
    "",
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    closing,
    "",
    "Salam,",
    meta.tenantName,
  ].join("\n");
  const html = [
    `<p>Halo ${escapeHtml(statement.shareholderName)},</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    "<table>",
    ...rows.map(
      ([label, value]) =>
        `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`,
    ),
    "</table>",
    `<p>${escapeHtml(closing)}</p>`,
    `<p>Salam,<br>${escapeHtml(meta.tenantName)}</p>`,
  ].join("\n");
  return { subject, text, html };
}
