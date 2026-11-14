// PII scanner for AI input and audit params (PRD §27 Input Minimum, AIG-02).
import { describe, expect, it } from "vitest";
import { redactJson, redactPii, scanPii } from "../lib/ai/pii.ts";

const kinds = (text: string) => scanPii(text).found;

describe("scanPii", () => {
  it("passes ordinary business questions", () => {
    expect(kinds("Berapa penjualan outlet Senayan minggu ini?")).toEqual([]);
    expect(kinds("Stok kopi tersisa 12 kg, harga Rp 85.000")).toEqual([]);
  });

  it("finds NIK, phone, email, and login codes", () => {
    expect(kinds("NIK 3174011501900001")).toEqual(["nik"]);
    expect(kinds("hubungi 0812-3456-7890")).toEqual(["phone"]);
    expect(kinds("hubungi +6281234567890")).toEqual(["phone"]);
    expect(kinds("kirim ke budi@example.com")).toEqual(["email"]);
    expect(kinds("MASUK Legend AB12-CD34")).toEqual(["login_code"]);
  });

  it("finds NPWP with and without dots, 15 and 16 digits", () => {
    expect(kinds("NPWP 09.254.294.3-407.000")).toEqual(["npwp"]);
    expect(kinds("npwp: 092542943407000")).toEqual(["npwp"]);
    expect(kinds("NPWP 0925429434070001")).toEqual(["npwp"]);
    expect(kinds("092542943407000")).toEqual(["npwp"]);
  });

  it("finds bank account numbers", () => {
    expect(kinds("rek. BCA 123 456 7890")).toEqual(["bank_account"]);
    expect(kinds("no rek: 1234567890")).toEqual(["bank_account"]);
    expect(kinds("rekening Mandiri 12-3456-78901")).toEqual(["bank_account"]);
  });

  it("finds salary amounts only in salary context", () => {
    expect(kinds("gaji Budi Rp 8.500.000")).toEqual(["salary"]);
    expect(kinds("salary: 12000000")).toEqual(["salary"]);
    expect(kinds("THP 7,5 juta")).toEqual(["salary"]);
    expect(kinds("penjualan Rp 8.500.000")).toEqual([]);
  });

  it.each([
    "Slip gaji Oktober 2026",
    "Slip gaji 31 Oktober 2026",
    "Slip gaji 31 Oktober",
    "Payroll 2026-10-31",
    "Upah tanggal 31/10/2026",
    "Slip gaji 31 Okt 2026",
    "Slip gaji 31 Okt. 2026",
    "Slip gaji 31.10.26",
    "salary October 31, 2026",
    "Gaji bulan ini belum dibayar",
  ])("does not classify words or dates as salary amounts: %s", (text) => {
    expect(kinds(text)).toEqual([]);
    expect(redactPii(text)).toBe(text);
  });

  it("does not report one value twice", () => {
    expect(kinds("3174011501900001")).toEqual(["nik"]);
  });
});

describe("redactPii", () => {
  it.each([
    ["gaji Budi Rp 8.500.000", "gaji Budi [salary amount]"],
    ["salary: 12000000", "salary: [salary amount]"],
    ["salary: 2026", "salary: [salary amount]"],
    ["THP 2000", "THP [salary amount]"],
    ["THP 7,5 juta", "THP [salary amount]"],
    ["Gaji 5000", "Gaji [salary amount]"],
    ["Gaji Rp 2.026", "Gaji [salary amount]"],
    ["salary: 2026.50", "salary: [salary amount]"],
    ["gaji 2026,50", "gaji [salary amount]"],
    ["gaji Mei 4500", "gaji Mei [salary amount]"],
    ["gaji Juni 9000", "gaji Juni [salary amount]"],
    ["salary Oct 31, 4500", "salary Oct 31, [salary amount]"],
    ["gaji 10.10.000", "gaji [salary amount]"],
    [
      "Slip gaji Oktober 2026: Rp 8.500.000",
      "Slip gaji Oktober 2026: [salary amount]",
    ],
    [
      "Gaji 31 Oktober 2026 Rp 8.500.000",
      "Gaji 31 Oktober 2026 [salary amount]",
    ],
    [
      "Slip gaji 31 Okt 2026 Rp 8.500.000",
      "Slip gaji 31 Okt 2026 [salary amount]",
    ],
    ["Slip gaji 31.10.26 Rp 8.500.000", "Slip gaji 31.10.26 [salary amount]"],
    [
      "Slip gaji 31 Oktober Rp 8.500.000",
      "Slip gaji 31 Oktober [salary amount]",
    ],
    [
      "Slip gaji tanggal 31 Oktober 2026 sebesar Rp 8.500.000",
      "Slip gaji tanggal 31 Oktober 2026 sebesar [salary amount]",
    ],
    [
      "Gaji dibayar pada tanggal 31 Oktober 2026 Rp 8.500.000",
      "Gaji dibayar pada tanggal 31 Oktober 2026 [salary amount]",
    ],
  ])(
    "redacts salary amounts while preserving context: %s",
    (text, expected) => {
      expect(kinds(text)).toEqual(["salary"]);
      expect(redactPii(text)).toBe(expected);
    },
  );

  it("replaces each finding with a neutral placeholder", () => {
    const out = redactPii("Hubungi budi@example.com atau 081234567890.");
    expect(out).toBe("Hubungi [email address] atau [phone number].");
  });

  it("leaves clean text unchanged", () => {
    expect(redactPii("Penjualan hari ini")).toBe("Penjualan hari ini");
  });
});

describe("redactJson", () => {
  it("redacts nested strings and keeps other values", () => {
    const out = redactJson({
      q: "email budi@example.com",
      n: 5,
      ok: true,
      none: null,
      list: ["NIK 3174011501900001", { deep: "0812 3456 7890" }],
    });
    expect(out).toEqual({
      q: "email [email address]",
      n: 5,
      ok: true,
      none: null,
      list: ["NIK [NIK]", { deep: "[phone number]" }],
    });
  });

  it("does not mutate its input", () => {
    const input = { q: "budi@example.com" };
    redactJson(input);
    expect(input.q).toBe("budi@example.com");
  });
});
