// Receipt email copy and address masking (PRD v1.7 §3 F11 "Struk & Kuitansi";
// POS-07). Pure helpers: the worker sends the message, the DTO only ever
// carries the masked address.

import type { ReceiptDocument } from "@starter/shared/pos";
import { formatRupiah } from "./pos-receipt-pdf.ts";

/** `owner@example.com` -> `o***@example.com`; never the raw address. */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at === trimmed.length - 1) return "***";
  return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
}

/** Subject and plain-text body of the e-receipt email (Indonesian). */
export function renderReceiptEmail(
  doc: ReceiptDocument,
  linkUrl: string | null,
): { subject: string; body: string } {
  const title = doc.documentKind === "kuitansi" ? "Kuitansi" : "Struk";
  const subject = `${title} ${doc.outletName} - ${doc.receiptNumber}`;
  const lines = [
    "Halo,",
    "",
    ...(doc.reprint ? ["CETAK ULANG", ""] : []),
    `Terima kasih sudah berkunjung ke ${doc.outletName}.`,
    `${title} nomor ${doc.receiptNumber} untuk pesanan ${doc.orderNumber} berjumlah ${formatRupiah(doc.totalIdr)}.`,
    "",
    doc.outletName,
    doc.outletAddress,
  ];
  if (linkUrl)
    lines.push("", "Lihat dan unduh struk Anda di tautan berikut:", linkUrl);
  lines.push("", "Salam,", doc.outletName);
  return { subject, body: lines.join("\n") };
}
