// Print templates of the edge Print Agent (bead legend-46p; PRD v1.7 §3 F5
// "Print Agent", §3 F12 "Fallback Cetak"): customer receipt, KDS station
// ticket and shift closing report. Pure: the same input always yields the
// same bytes. Every template starts with init and ends with feed + cut.
import { messagesId } from "@starter/shared/i18n";
import {
  EscPosBuilder,
  formatDateTime,
  formatRupiah,
  toPrintableAscii,
} from "./escpos.ts";
import type {
  PaperWidth,
  ReceiptData,
  ShiftReportData,
  StationTicketData,
} from "./types.ts";

const TRAINING_BANNER = "** LATIHAN - BUKAN TRANSAKSI **";
const KDS_DOWN_BANNER = "** KDS MATI - TIKET CADANGAN **";

/** Word-wraps to `width` characters; words longer than a line are split. */
function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of toPrintableAscii(value).split(/\s+/)) {
    if (word === "") continue;
    let rest = word;
    while (rest.length > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (current === "") {
      current = rest;
    } else if (current.length + 1 + rest.length <= width) {
      current += ` ${rest}`;
    } else {
      lines.push(current);
      current = rest;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function wrapped(builder: EscPosBuilder, value: string, width: number) {
  for (const row of wrap(value, width)) builder.line(row);
}

/** Money with an explicit sign: "+Rp 5.000", "-Rp 5.000", "Rp 0". */
function formatSigned(amount: number): string {
  return amount > 0 ? `+${formatRupiah(amount)}` : formatRupiah(amount);
}

function finish(builder: EscPosBuilder): Uint8Array {
  return builder.feed(3).cut().bytes();
}

export function renderReceipt(
  data: ReceiptData,
  width: PaperWidth,
): Uint8Array {
  const b = new EscPosBuilder().init();
  if (data.status === "voided") {
    b.align("center")
      .bold(true)
      .line(messagesId.deviceRegistry.receiptPrintLabels.voided)
      .bold(false)
      .align("left");
  }
  if (data.trainingMode) {
    b.align("center").bold(true);
    wrapped(b, TRAINING_BANNER, width);
    b.bold(false).align("left");
  }
  b.align("center").bold(true);
  wrapped(b, data.outletName, width);
  b.bold(false);
  if (data.outletAddress) wrapped(b, data.outletAddress, width);
  b.align("left").divider("-", width);
  b.columns("No", data.receiptNumber, width);
  b.columns("Kasir", data.cashierName, width);
  b.columns("Waktu", formatDateTime(data.issuedAt), width);
  b.divider("-", width);

  for (const item of data.lines) {
    wrapped(b, item.name, width);
    b.columns(
      `  ${item.qty} x ${formatRupiah(item.unitPrice)}`,
      formatRupiah(item.total),
      width,
    );
    if (item.note) {
      for (const row of wrap(item.note, width - 4)) b.line(`  ! ${row}`);
    }
  }
  b.divider("-", width);

  b.columns("Subtotal", formatRupiah(data.subtotal), width);
  if (data.discount) {
    b.columns("Diskon", formatRupiah(-Math.abs(data.discount)), width);
  }
  // legend-974: an inclusive bill's subtotal already holds service and tax.
  const included = data.pricesIncludeTax ? "Termasuk " : "";
  if (data.serviceCharge) {
    b.columns(`${included}Service`, formatRupiah(data.serviceCharge), width);
  }
  if (data.tax) b.columns(`${included}Pajak`, formatRupiah(data.tax), width);
  if (data.rounding)
    b.columns(
      messagesId.deviceRegistry.receiptPrintLabels.rounding,
      formatRupiah(data.rounding),
      width,
    );
  b.bold(true).columns("TOTAL", formatRupiah(data.total), width).bold(false);

  // DP is a prepaid bucket, not a tender: shown before the payment rows and
  // never added to payments or change.
  const deposit = data.depositAppliedIdr ?? 0;
  if (data.payments.length > 0 || deposit > 0) b.divider("-", width);
  if (deposit > 0) b.columns("Uang muka (DP)", formatRupiah(deposit), width);
  for (const payment of data.payments) {
    b.columns(payment.method, formatRupiah(payment.amount), width);
  }
  // 1272 K4: the guest service fee is not part of the order total (no PB1,
  // no service charge): its own line, then what the guest paid in all.
  if (data.guestFee && data.guestFee > 0) {
    const labels = messagesId.deviceRegistry.receiptPrintLabels;
    b.columns(labels.guestFee, formatRupiah(data.guestFee), width);
    b.columns(
      labels.paidTotal,
      formatRupiah(
        data.payments.reduce((sum, row) => sum + row.amount, 0) + data.guestFee,
      ),
      width,
    );
  }
  if (data.change) b.columns("Kembali", formatRupiah(data.change), width);

  if (data.footer) {
    b.divider("-", width).align("center");
    wrapped(b, data.footer, width);
    b.align("left");
  }
  return finish(b);
}

export function renderStationTicket(
  data: StationTicketData,
  width: PaperWidth,
): Uint8Array {
  const b = new EscPosBuilder().init();
  if (data.fallback) {
    b.align("center").bold(true);
    wrapped(b, KDS_DOWN_BANNER, width);
    b.bold(false).align("left").divider("=", width);
  }
  // Double size halves the characters per line.
  const bigWidth = Math.floor(width / 2);
  b.align("center").bold(true).size("double");
  wrapped(b, data.stationName, bigWidth);
  wrapped(b, data.orderLabel, bigWidth);
  b.size("normal").bold(false).align("left");
  b.divider("-", width);
  b.columns(
    `Tiket ${data.ticketNumber}`,
    formatDateTime(data.createdAt),
    width,
  );
  if (data.orderType) b.line(data.orderType);
  b.divider("-", width);

  for (const item of data.items) {
    b.bold(true);
    wrapped(b, `${item.qty}x ${item.name}`, width);
    b.bold(false);
    for (const modifier of item.modifiers ?? []) {
      for (const row of wrap(modifier, width - 4)) b.line(`  + ${row}`);
    }
    if (item.note) {
      for (const row of wrap(item.note, width - 4)) b.line(`  ! ${row}`);
    }
  }
  b.divider("-", width);
  return finish(b);
}

export function renderShiftReport(
  data: ShiftReportData,
  width: PaperWidth,
): Uint8Array {
  const b = new EscPosBuilder().init();
  b.align("center").bold(true).line("LAPORAN TUTUP SHIFT").bold(false);
  wrapped(b, data.outletName, width);
  b.align("left").divider("-", width);
  b.columns("Kasir", data.cashierName, width);
  b.columns("Buka", formatDateTime(data.shiftOpenedAt), width);
  b.columns("Tutup", formatDateTime(data.shiftClosedAt), width);
  b.divider("-", width);

  b.bold(true).line("PENJUALAN").bold(false);
  for (const sale of data.sales) {
    b.columns(
      `${sale.method} (${sale.count})`,
      formatRupiah(sale.amount),
      width,
    );
  }
  b.bold(true)
    .columns("Total penjualan", formatRupiah(data.totalSales), width)
    .bold(false);
  if (data.refunds) b.columns("Refund", formatRupiah(data.refunds), width);
  if (data.voids) b.columns("Void", formatRupiah(data.voids), width);
  b.divider("-", width);

  b.bold(true).line("KAS").bold(false);
  b.columns("Kas awal", formatRupiah(data.openingCash), width);
  b.columns("Kas seharusnya", formatRupiah(data.expectedCash), width);
  b.columns("Kas dihitung", formatRupiah(data.countedCash), width);
  b.bold(true)
    .columns("Selisih", formatSigned(data.variance), width)
    .bold(false);

  if (data.denominations && data.denominations.length > 0) {
    b.divider("-", width).bold(true).line("PECAHAN").bold(false);
    for (const row of data.denominations) {
      b.columns(`${row.label} x ${row.count}`, formatRupiah(row.amount), width);
    }
  }
  return finish(b);
}
