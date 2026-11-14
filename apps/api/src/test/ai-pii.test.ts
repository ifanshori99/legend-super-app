// PII scanner for AI input and audit params (PRD §27 Input Minimum, AIG-02).
import { describe, expect, it } from "vitest";
import {
  redactJson,
  redactPii,
  redactToolResultContent,
  scanPii,
} from "../lib/ai/pii.ts";
import { prepareAiRequest } from "../lib/ai/request-policy.ts";

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

  it("does not report one value twice", () => {
    expect(kinds("3174011501900001")).toEqual(["nik"]);
  });
});

describe("redactPii", () => {
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

describe("redactToolResultContent (AIG-02)", () => {
  it("redacts string values in JSON and keeps numbers and keys", () => {
    const content = JSON.stringify({
      total: 6200000000,
      rows: [{ note: "hubungi budi@example.com atau 0812 3456 7890" }],
    });
    const out = JSON.parse(redactToolResultContent(content));
    expect(out).toEqual({
      total: 6200000000,
      rows: [{ note: "hubungi [email address] atau [phone number]" }],
    });
  });

  it("returns clean JSON byte for byte, even with large integers", () => {
    const content = '{"id":12345678901234567890,"name":"Kopi"}';
    expect(redactToolResultContent(content)).toBe(content);
  });

  it("redacts non-JSON error text as plain text", () => {
    expect(redactToolResultContent("gagal untuk budi@example.com")).toBe(
      "gagal untuk [email address]",
    );
  });

  it("prepareAiRequest masks tool_result blocks and leaves the input intact", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "SOP?" }],
      },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "t1",
            name: "search_sop",
            input: {},
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "t1",
            content: JSON.stringify({ snippet: "email budi@example.com" }),
          },
        ],
      },
    ];
    const prepared = prepareAiRequest(
      {
        system: "s",
        messages,
        tools: [],
        maxTokens: 100,
      } as never,
      {
        contextWindow: 100000,
        maxOutputTokens: 1000,
        supportsTools: true,
        supportsReasoning: false,
        reasoningEfforts: [],
      } as never,
    );
    expect(JSON.stringify(prepared.messages)).not.toContain("budi@example.com");
    expect(JSON.stringify(prepared.messages)).toContain("[email address]");
    expect(JSON.stringify(messages)).toContain("budi@example.com");
  });
});

describe("redactJson structured data and phone boundaries (AIG-02)", () => {
  it.each([
    ["bank account by key", { accountNumber: "1234567890" }],
    ["phone without prefix by key", { phone: "812 3456 7890" }],
    ["nik as number by key", { nik: 3201234567890123 }],
    ["email by snake_case key", { customer_email: "x" }],
  ])("masks %s", (_name, input) => {
    expect(JSON.stringify(redactJson(input))).toContain("[redacted]");
  });

  it("redacts personal data used as an object key", () => {
    expect(JSON.stringify(redactJson({ "budi@example.com": 5 }))).not.toContain(
      "budi@example.com",
    );
  });

  it("keeps ids and chart-of-accounts fields intact", () => {
    const input = {
      accountId: "c0812345-6789-4abc-8def-0123456789ab",
      accountCode: "1100",
      accountName: "Kas",
      amount: "120812345678",
    };
    expect(redactJson(input)).toEqual(input);
  });

  it("does not read a UUID segment or longer digit string as a phone", () => {
    expect(redactPii("c0812345-6789-4abc")).toBe("c0812345-6789-4abc");
    expect(redactPii("120812345678")).toBe("120812345678");
    expect(redactPii("telp 0812 3456 7890")).toBe("telp [phone number]");
  });
});
