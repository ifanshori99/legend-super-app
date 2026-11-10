// Statement PDF and email copy (bead legend-2ljb slice C; SH-01, SH-04), no
// database. Text is read back out of the PDF with `pdf-text.ts`.
import { describe, expect, it } from "vitest";
import {
  distributionStatementSchema,
  type DistributionStatement,
} from "@starter/shared/accounting";
import {
  maskEmail,
  renderStatementEmail,
} from "../services/profit-share-statement-email.ts";
import { renderDistributionStatementPdf } from "../services/profit-share-statement-pdf.ts";
import { allText, drawnText } from "./pdf-text.ts";

const OTHER_SHAREHOLDER = "Budi Santoso Pemegang Lain";

function statement(
  overrides: Partial<Record<string, unknown>> = {},
): DistributionStatement {
  return distributionStatementSchema.parse({
    distributionRunId: "00000000-0000-4000-8000-000000000001",
    distributionLineId: "00000000-0000-4000-8000-000000000002",
    shareholderId: "00000000-0000-4000-8000-000000000003",
    shareholderName: "Siti Rahayu",
    profitEntityId: "00000000-0000-4000-8000-000000000004",
    profitEntityName: "Kopi Legend Pusat",
    basis: "closed_period",
    period: "2026-10",
    runType: "regular",
    adjustsRunId: null,
    shareBp: 3333,
    grossIdr: 3333333,
    taxWithheldIdr: 166667,
    netIdr: 3166666,
    paymentStatus: "paid",
    paymentRef: "TRF-20261110-001",
    paidAt: "2026-11-10T03:00:00.000Z",
    statementFileKey: null,
    ...overrides,
  });
}

const render = async (value: DistributionStatement) =>
  Buffer.from(
    await renderDistributionStatementPdf(value, { tenantName: "PT Legend" }),
  );

describe("renderDistributionStatementPdf", () => {
  it("writes a PDF with the period, share, amounts and payment details", async () => {
    const pdf = await render(statement());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = allText(pdf);
    expect(text).toContain("Pernyataan Bagi Hasil");
    expect(text).toContain("Siti Rahayu");
    expect(text).toContain("Kopi Legend Pusat");
    expect(text).toContain("Oktober 2026");
    expect(text).toContain("33,33%");
    expect(text).toContain("Rp 3.333.333");
    expect(text).toContain("Rp 166.667");
    expect(text).toContain("Rp 3.166.666");
    expect(text).toContain("TRF-20261110-001");
    expect(text).toContain("10/11/2026");
    expect(text).not.toContain("Penyesuaian");
  });

  it("shows no other shareholder's data", async () => {
    // The statement object carries one shareholder; the page can only show it.
    const text = allText(await render(statement()));
    expect(text).not.toContain(OTHER_SHAREHOLDER);
    expect(text).not.toContain("Budi");
    expect(text).not.toMatch(/NPWP|rekening/i);
  });

  it("marks an adjustment and prints a claw-back as negative", async () => {
    const text = allText(
      await render(
        statement({
          runType: "adjustment",
          adjustsRunId: "00000000-0000-4000-8000-000000000009",
          grossIdr: -500000,
          taxWithheldIdr: -25000,
          netIdr: -475000,
        }),
      ),
    );
    expect(text).toContain("Penyesuaian");
    expect(text).toContain("Catatan penyesuaian (pengembalian)");
    expect(text).toContain("-Rp 500.000");
    expect(text).toContain("-Rp 475.000");
  });

  it("reads a carry deduction top to bottom: share before the cut, the cut, then the gross share", async () => {
    // Gross after the cut 3.233.333 + cut 100.000 = 3.333.333 before it.
    const pdf = await render(
      statement({ grossIdr: 3233333, carryDeductedIdr: 100000 }),
    );
    const rows = drawnText(pdf);
    const top = (label: string) => {
      const row = rows.find((drawn) => drawn.text === label);
      expect(row, label).toBeDefined();
      return row!.y;
    };
    const valueOn = (label: string) =>
      rows.find(
        (drawn) => drawn.y === top(label) && drawn.text.startsWith("Rp"),
      )?.text;
    // PDF y grows upward: a higher row has a larger y.
    expect(top("Bagian sebelum potongan")).toBeGreaterThan(
      top("Potongan kekurangan koreksi"),
    );
    expect(top("Potongan kekurangan koreksi")).toBeGreaterThan(
      top("Bagian kotor"),
    );
    expect(valueOn("Bagian sebelum potongan")).toBe("Rp 3.333.333");
    expect(valueOn("Potongan kekurangan koreksi")).toBe("Rp 100.000");
    expect(valueOn("Bagian kotor")).toBe("Rp 3.233.333");
  });

  it("shows no carry rows when nothing was deducted", async () => {
    const text = allText(await render(statement()));
    expect(text).not.toContain("Bagian sebelum potongan");
    expect(text).not.toContain("Potongan kekurangan koreksi");
  });

  it("is byte-identical when rendered twice", async () => {
    const value = statement();
    expect((await render(value)).equals(await render(value))).toBe(true);
  });
});

describe("renderStatementEmail", () => {
  it("carries this shareholder's figures and a single-line subject", () => {
    const mail = renderStatementEmail(statement(), { tenantName: "PT Legend" });
    expect(mail.subject).toBe(
      "Pernyataan Bagi Hasil Oktober 2026 - Kopi Legend Pusat",
    );
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain("Siti Rahayu");
    expect(mail.text).toContain("Rp 3.166.666");
    expect(mail.html).toContain("Rp 3.166.666");
    expect(mail.text).not.toContain(OTHER_SHAREHOLDER);
  });

  it("escapes HTML in names", () => {
    const mail = renderStatementEmail(
      statement({ shareholderName: "<b>Siti</b> & Co" }),
      { tenantName: "PT Legend" },
    );
    expect(mail.html).toContain("&lt;b&gt;Siti&lt;/b&gt; &amp; Co");
    expect(mail.html).not.toContain("<b>Siti");
  });

  it("masks the address for logs", () => {
    expect(maskEmail("siti@example.com")).toBe("s***@example.com");
  });
});
