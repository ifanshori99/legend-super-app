import { describe, expect, it } from "vitest";

import {
  EscPosBuilder,
  formatDateTime,
  formatRupiah,
  markReprint,
} from "../edge/print/escpos.ts";
import {
  renderReceipt,
  renderShiftReport,
  renderStationTicket,
} from "../edge/print/templates.ts";
import type {
  ReceiptData,
  ShiftReportData,
  StationTicketData,
} from "../edge/print/types.ts";

const ESC = 0x1b;
const GS = 0x1d;

/** Command byte length after the leading ESC / GS byte. */
const COMMAND_LENGTH: Record<number, Record<number, number>> = {
  [0x1b]: { 0x40: 2, 0x74: 3, 0x61: 3, 0x45: 3, 0x64: 3 },
  [0x1d]: { 0x21: 3, 0x56: 4 },
};

/**
 * Readable dump: printable ASCII as is, LF as newline, each ESC/GS command as
 * one `<hex hex ...>` token.
 */
function dump(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    const length = COMMAND_LENGTH[byte]?.[bytes[i + 1]];
    if (length) {
      const hex = Array.from(bytes.subarray(i, i + length), (v) =>
        v.toString(16).padStart(2, "0"),
      );
      out += `<${hex.join(" ")}>`;
      i += length;
      continue;
    }
    if (byte === 0x0a) out += "\n";
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `<${byte.toString(16).padStart(2, "0")}>`;
    i += 1;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function includesSequence(bytes: Uint8Array, sequence: number[]): boolean {
  return toHex(bytes).includes(Buffer.from(sequence).toString("hex"));
}

/** Printable text lines (control bytes removed). */
function textLines(bytes: Uint8Array): string[] {
  return dump(bytes)
    .replace(/<[0-9a-f ]+>/g, "")
    .split("\n");
}

// 2026-11-08 07:05 UTC = 14:05 WIB.
const AT = new Date("2026-11-08T07:05:00.000Z");

const receipt: ReceiptData = {
  outletName: "Cafe Legend Kemang",
  outletAddress: "Jl. Kemang Raya No. 12, Jakarta Selatan",
  receiptNumber: "R-20261108-0042",
  cashierName: "Siti",
  issuedAt: AT,
  lines: [
    { name: "Nasi Goreng Spesial", qty: 2, unitPrice: 25000, total: 50000 },
    {
      name: "Es Teh Manis Jumbo Dengan Gula Aren Premium",
      qty: 1,
      unitPrice: 12000,
      total: 12000,
      note: "tanpa es",
    },
  ],
  subtotal: 62000,
  discount: 5000,
  serviceCharge: 2850,
  tax: 6000,
  total: 65850,
  payments: [{ method: "Tunai", amount: 70000 }],
  change: 4150,
  footer: "Terima kasih, sampai jumpa lagi!",
};

const ticket: StationTicketData = {
  stationName: "Dapur Panas",
  ticketNumber: "T-17",
  orderLabel: "Meja 12",
  orderType: "Dine in",
  createdAt: AT,
  items: [
    {
      name: "Nasi Goreng",
      qty: 2,
      modifiers: ["Pedas", "Telur mata sapi"],
      note: "jangan pakai kecap",
    },
    { name: "Mie Ayam", qty: 1 },
  ],
};

const shift: ShiftReportData = {
  outletName: "Cafe Legend Kemang",
  cashierName: "Siti",
  shiftOpenedAt: new Date("2026-11-08T01:00:00.000Z"),
  shiftClosedAt: new Date("2026-11-08T09:30:00.000Z"),
  openingCash: 500000,
  expectedCash: 1250000,
  countedCash: 1245000,
  variance: -5000,
  sales: [
    { method: "Tunai", count: 20, amount: 750000 },
    { method: "QRIS", count: 12, amount: 480000 },
  ],
  totalSales: 1230000,
  refunds: 25000,
  voids: 12000,
  denominations: [
    { label: "100.000", count: 10, amount: 1000000 },
    { label: "50.000", count: 4, amount: 200000 },
    { label: "5.000", count: 9, amount: 45000 },
  ],
};

describe("EscPosBuilder", () => {
  it("emits init, align, bold, size, feed and cut sequences", () => {
    const bytes = new EscPosBuilder()
      .init()
      .align("center")
      .bold(true)
      .size("double")
      .text("A")
      .size("tall")
      .size("normal")
      .align("right")
      .bold(false)
      .feed(3)
      .cut()
      .bytes();
    expect(toHex(bytes)).toBe(
      [
        "1b40", // ESC @
        "1b7400", // ESC t 0
        "1b6101", // center
        "1b4501", // bold on
        "1d2111", // double
        "41", // A
        "1d2101", // tall
        "1d2100", // normal
        "1b6102", // right
        "1b4500", // bold off
        "1b6403", // feed 3
        "1d564203", // GS V 66 3
      ].join(""),
    );
  });

  it("encodes left alignment and line feeds", () => {
    const bytes = new EscPosBuilder().align("left").line("ok").line().bytes();
    expect(toHex(bytes)).toBe("1b6100" + "6f6b" + "0a" + "0a");
  });

  it("transliterates accents and replaces unknown characters", () => {
    const bytes = new EscPosBuilder().text("Café Crème Ñandú Straße").bytes();
    expect(dump(bytes)).toBe("Cafe Creme Nandu Strasse");
    expect(dump(new EscPosBuilder().text("Kopi ☕ 日本").bytes())).toBe(
      "Kopi ? ??",
    );
  });

  it("strips control characters so text cannot inject commands", () => {
    const bytes = new EscPosBuilder().text("a\x1bb\x1dc\nd\te\x00").bytes();
    expect(dump(bytes)).toBe("abcde");
  });

  it("builds divider lines of the exact width", () => {
    expect(dump(new EscPosBuilder().divider("=", 5).bytes())).toBe("=====\n");
  });

  it.each([32, 48] as const)(
    "pads columns to exactly %i characters, truncating the left side",
    (width) => {
      const bytes = new EscPosBuilder()
        .columns("Total", "Rp 25.000", width)
        .columns("X".repeat(80), "Rp 1.000.000", width)
        .bytes();
      const [first, second] = dump(bytes).split("\n");
      expect(first).toHaveLength(width);
      expect(first.startsWith("Total")).toBe(true);
      expect(first.endsWith("Rp 25.000")).toBe(true);
      expect(second).toHaveLength(width);
      expect(second.endsWith(" Rp 1.000.000")).toBe(true);
      expect(second.startsWith("X")).toBe(true);
    },
  );

  it("keeps the right column and caps it at the line width", () => {
    const line = dump(
      new EscPosBuilder().columns("a", "b".repeat(40), 32).bytes(),
    );
    expect(line).toBe(`${"b".repeat(32)}\n`);
  });
});

describe("formatRupiah", () => {
  it.each([
    [0, "Rp 0"],
    [999, "Rp 999"],
    [25000, "Rp 25.000"],
    [1234567, "Rp 1.234.567"],
    [-5000, "-Rp 5.000"],
    [1500.4, "Rp 1.500"],
  ])("formats %s as %s", (amount, expected) => {
    expect(formatRupiah(amount)).toBe(expected);
  });
});

describe("formatDateTime", () => {
  it("formats in Asia/Jakarta regardless of the host zone", () => {
    expect(formatDateTime(AT)).toBe("08/11/2026 14:05");
    // 18:30 UTC rolls over to the next day in WIB (UTC+7).
    expect(formatDateTime(new Date("2026-12-31T18:30:00.000Z"))).toBe(
      "01/01/2027 01:30",
    );
    expect(formatDateTime(new Date("2026-11-07T17:00:00.000Z"))).toBe(
      "08/11/2026 00:00",
    );
  });
});

describe("markReprint", () => {
  it("inserts a centered bold label right after ESC @ and ESC t 0", () => {
    const original = renderReceipt(receipt, 32);
    const marked = markReprint(original);
    expect(toHex(marked.subarray(0, 5))).toBe("1b401b7400");
    const bannerHex = toHex(
      new EscPosBuilder()
        .align("center")
        .bold(true)
        .line("** CETAK ULANG **")
        .bold(false)
        .align("left")
        .bytes(),
    );
    expect(toHex(marked.subarray(5)).startsWith(bannerHex)).toBe(true);
    // The rest of the job is untouched and still ends with the cut.
    expect(toHex(marked.subarray(5 + bannerHex.length / 2))).toBe(
      toHex(original.subarray(5)),
    );
    expect(marked.at(-4)).toBe(GS);
  });

  it("supports a custom label and a job with only ESC @", () => {
    const bytes = new Uint8Array([ESC, 0x40, 0x41]);
    const marked = markReprint(bytes, "COPY");
    expect(dump(marked)).toBe(
      "<1b 40><1b 61 01><1b 45 01>COPY\n<1b 45 00><1b 61 00>A",
    );
  });
});

describe("templates", () => {
  it.each([32, 48] as const)(
    "start with init and end with feed + cut (%i)",
    (width) => {
      for (const bytes of [
        renderReceipt(receipt, width),
        renderStationTicket(ticket, width),
        renderShiftReport(shift, width),
      ]) {
        expect(toHex(bytes.subarray(0, 5))).toBe("1b401b7400");
        expect(toHex(bytes.subarray(-7))).toBe("1b64031d564203");
      }
    },
  );

  it.each([32, 48] as const)(
    "never produce a text line wider than %i characters",
    (width) => {
      for (const bytes of [
        renderReceipt(receipt, width),
        renderStationTicket(ticket, width),
        renderShiftReport(shift, width),
      ]) {
        for (const line of textLines(bytes)) {
          expect(line.length).toBeLessThanOrEqual(width);
        }
      }
    },
  );

  it("wraps a long item name instead of overflowing the line", () => {
    const lines = textLines(renderReceipt(receipt, 32));
    expect(lines).toContain("Es Teh Manis Jumbo Dengan Gula");
    expect(lines).toContain("Aren Premium");
    // On 80 mm paper the same name fits on one line.
    expect(textLines(renderReceipt(receipt, 48))).toContain(
      "Es Teh Manis Jumbo Dengan Gula Aren Premium",
    );
  });

  it("prints the training banner only in training mode", () => {
    const normal = textLines(renderReceipt(receipt, 32)).join("\n");
    const training = textLines(
      renderReceipt({ ...receipt, trainingMode: true }, 32),
    ).join("\n");
    expect(normal).not.toContain("LATIHAN");
    expect(training).toContain("** LATIHAN - BUKAN TRANSAKSI **");
  });

  it("prints the KDS-down banner only for fallback tickets", () => {
    const normal = textLines(renderStationTicket(ticket, 32)).join("\n");
    const fallback = textLines(
      renderStationTicket({ ...ticket, fallback: true }, 32),
    ).join("\n");
    expect(normal).not.toContain("KDS MATI");
    expect(fallback).toContain("** KDS MATI - TIKET CADANGAN **");
  });

  it("renders station ticket items, modifiers and notes", () => {
    const text = textLines(renderStationTicket(ticket, 32));
    expect(text).toContain("2x Nasi Goreng");
    expect(text).toContain("  + Pedas");
    expect(text).toContain("  ! jangan pakai kecap");
    // Station name and order label are double size.
    expect(
      includesSequence(renderStationTicket(ticket, 32), [GS, 0x21, 0x11]),
    ).toBe(true);
  });

  it("renders a signed cash variance on the shift report", () => {
    const negative = textLines(renderShiftReport(shift, 32)).join("\n");
    expect(negative).toContain("LAPORAN TUTUP SHIFT");
    expect(negative).toContain("-Rp 5.000");
    const positive = textLines(
      renderShiftReport({ ...shift, variance: 7000 }, 32),
    ).join("\n");
    expect(positive).toContain("+Rp 7.000");
    const withoutDenominations = textLines(
      renderShiftReport({ ...shift, denominations: undefined }, 32),
    ).join("\n");
    expect(withoutDenominations).not.toContain("PECAHAN");
  });

  it("matches the receipt snapshot (32 and 48 wide)", () => {
    expect(dump(renderReceipt(receipt, 32))).toMatchSnapshot("32");
    expect(dump(renderReceipt(receipt, 48))).toMatchSnapshot("48");
  });

  it("matches the station ticket snapshot (normal and fallback)", () => {
    expect(dump(renderStationTicket(ticket, 32))).toMatchSnapshot("normal");
    expect(
      dump(renderStationTicket({ ...ticket, fallback: true }, 32)),
    ).toMatchSnapshot("fallback");
  });

  it("matches the shift report snapshot (32 and 48 wide)", () => {
    expect(dump(renderShiftReport(shift, 32))).toMatchSnapshot("32");
    expect(dump(renderShiftReport(shift, 48))).toMatchSnapshot("48");
  });
});
