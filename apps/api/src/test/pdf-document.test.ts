// Pure tests for the generic PDF document engine (bead legend-hspr8, legend-iuvq;
// brief docs/briefs/menu-pdf-engine.md). No database. Written from the brief's
// contract, fail-first: src/services/pdf/pdf-document.ts does not exist yet.
//
// Assumptions (brief is silent):
//  - A4 is 595.28 x 841.89 pt; every drawn text must lie inside the page.
//  - `PdfLayoutText.x` is the left edge of the drawn string (also for
//    right-aligned text), so `x + measure(text)` must stay inside the margin.
//  - Characters missing from the font become `?` inside `layoutPdfDocument`
//    (it receives only `measure`, so it must consult the bundled font), and
//    the written PDF never contains them either.

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  layoutPdfDocument,
  renderPdfDocument,
  type PdfBlock,
  type PdfDocumentSpec,
} from "../services/pdf/pdf-document";
import { allText } from "./pdf-text";
import { hasGlyph, realMeasure } from "./pdf-measure";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const EPS = 0.75;

/** Fake metric: every character is half the font size wide. */
const fakeMeasure = (text: string, _bold: boolean, size: number) =>
  text.length * size * 0.5;

const spec = (
  blocks: PdfBlock[],
  extra: Partial<PdfDocumentSpec> = {},
): PdfDocumentSpec => ({ title: "Uji", blocks, ...extra });

const pageTexts = (pages: { text: string }[][]) =>
  pages.map((page) => page.map((entry) => entry.text));
const pageOf = (pages: { text: string }[][], needle: string) =>
  pages.findIndex((page) => page.some((entry) => entry.text.includes(needle)));

const words = (count: number, prefix = "kata") =>
  Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i).padStart(3, "0")}`,
  );

describe("layoutPdfDocument: text", () => {
  it("wraps long text per word and keeps every word, in order, inside the margins", () => {
    const list = words(150);
    const { pages } = layoutPdfDocument(
      spec([{ type: "text", text: list.join(" ") }]),
      fakeMeasure,
    );
    const lines = pages.flat();
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.flatMap((l) => l.text.split(" ").filter(Boolean))).toEqual(
      list,
    );
    for (const line of lines) {
      expect(line.x).toBeGreaterThanOrEqual(MARGIN - EPS);
      expect(
        line.x + fakeMeasure(line.text, line.bold, line.size),
      ).toBeLessThanOrEqual(PAGE_W - MARGIN + EPS);
    }
  });

  it("splits a word longer than the column per character without losing any", () => {
    const long = "X".repeat(400);
    const { pages } = layoutPdfDocument(
      spec([{ type: "text", text: long }]),
      fakeMeasure,
    );
    const lines = pages.flat();
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.text).join("")).toBe(long);
    for (const line of lines)
      expect(
        line.x + fakeMeasure(line.text, line.bold, line.size),
      ).toBeLessThanOrEqual(PAGE_W - MARGIN + EPS);
  });

  it("honours a custom margin", () => {
    const { pages } = layoutPdfDocument(
      spec([{ type: "text", text: words(80).join(" ") }], {
        page: { margin: 100 },
      }),
      fakeMeasure,
    );
    for (const line of pages.flat()) {
      expect(line.x).toBeGreaterThanOrEqual(100 - EPS);
      expect(
        line.x + fakeMeasure(line.text, line.bold, line.size),
      ).toBeLessThanOrEqual(PAGE_W - 100 + EPS);
    }
  });

  it("adds pages automatically; page numbers are 0-based in order and all text stays on the page", () => {
    const blocks: PdfBlock[] = Array.from({ length: 220 }, (_, i) => ({
      type: "text",
      text: `Baris ${i}`,
    }));
    const { pages } = layoutPdfDocument(spec(blocks), fakeMeasure);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, index) => {
      expect(page.length).toBeGreaterThan(0);
      for (const entry of page) {
        expect(entry.page).toBe(index);
        expect(entry.y).toBeGreaterThan(0);
        expect(entry.y).toBeLessThan(PAGE_H);
      }
    });
    const all = pageTexts(pages).flat();
    for (let i = 0; i < 220; i += 1) expect(all).toContain(`Baris ${i}`);
  });

  it("draws header title and subtitle on the first page and the footer with 'Halaman n/N' on every page", () => {
    const blocks: PdfBlock[] = Array.from({ length: 200 }, (_, i) => ({
      type: "text",
      text: `Isi ${i}`,
    }));
    const { pages } = layoutPdfDocument(
      spec(blocks, {
        header: { title: "Cafe Legend", subtitle: "Dago · 2026-03-10" },
        footer: "Harga belum termasuk pajak.",
      }),
      fakeMeasure,
    );
    const total = pages.length;
    expect(total).toBeGreaterThan(1);
    const texts = pageTexts(pages);
    expect(texts[0].join(" ")).toContain("Cafe Legend");
    expect(texts[0].join(" ")).toContain("Dago · 2026-03-10");
    texts.forEach((page, index) => {
      const joined = page.join(" ");
      expect(joined).toContain("Harga belum termasuk pajak.");
      expect(joined).toContain(`Halaman ${index + 1}/${total}`);
    });
  });
});

describe("layoutPdfDocument: tables", () => {
  const columns = [
    { header: "KolomNama", width: 0.75 },
    { header: "KolomHarga", width: 0.25, align: "right" as const },
  ];

  it("wraps a cell inside its own column", () => {
    const description = words(60, "desk").join(" ");
    const { pages } = layoutPdfDocument(
      spec([
        { type: "table", columns, rows: [[`Kopi ${description}`, "Rp 1.000"]] },
      ]),
      fakeMeasure,
    );
    const lines = pages.flat();
    const nameLines = lines.filter((l) => /desk|Kopi/.test(l.text));
    expect(nameLines.length).toBeGreaterThan(1);
    const priceLine = lines.find((l) => l.text.includes("Rp 1.000"));
    expect(priceLine).toBeDefined();
    const contentW = PAGE_W - 2 * MARGIN;
    for (const line of nameLines) {
      expect(line.x).toBeGreaterThanOrEqual(MARGIN - EPS);
      expect(
        line.x + fakeMeasure(line.text, line.bold, line.size),
      ).toBeLessThanOrEqual(MARGIN + contentW * 0.75 + EPS);
    }
    // The price cell is right of the name column.
    expect(priceLine!.x).toBeGreaterThanOrEqual(MARGIN + contentW * 0.75 - EPS);
    expect(
      priceLine!.x + fakeMeasure(priceLine!.text, false, priceLine!.size),
    ).toBeLessThanOrEqual(PAGE_W - MARGIN + EPS);
  });

  it("repeats the table header on continuation pages", () => {
    const rows = Array.from({ length: 160 }, (_, i) => [
      `Item ${i}`,
      `Rp ${i}.000`,
    ]);
    const { pages } = layoutPdfDocument(
      spec([{ type: "table", columns, rows }]),
      fakeMeasure,
    );
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pageTexts(pages)) {
      expect(page).toContain("KolomNama");
      expect(page).toContain("KolomHarga");
    }
    // every row exactly once
    const all = pageTexts(pages).flat();
    for (let i = 0; i < 160; i += 1)
      expect(all.filter((t) => t === `Item ${i}`)).toHaveLength(1);
  });

  it("never splits a table row across pages", () => {
    // Each row wraps over several lines: first word R<i>, last word E<i>.
    const rows = Array.from({ length: 70 }, (_, i) => {
      const id = String(i).padStart(3, "0");
      return [`R${id} ${words(40, "w").join(" ")} E${id}`, `Rp ${i}`];
    });
    const { pages } = layoutPdfDocument(
      spec([{ type: "table", columns, rows }]),
      fakeMeasure,
    );
    expect(pages.length).toBeGreaterThan(1);
    for (let i = 0; i < 70; i += 1) {
      const id = String(i).padStart(3, "0");
      const first = pageOf(pages, `R${id}`);
      const last = pageOf(pages, `E${id}`);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBe(first);
    }
  });
});

describe("layoutPdfDocument: headings", () => {
  it("never leaves a heading alone at the bottom of a page (keep with next)", () => {
    // Sweep the number of filler lines so that, for some n, the heading would
    // fall on the last line of page 1 (and of page 2). The page height and
    // line height are not part of the contract, so the sweep covers them.
    const columns = [{ header: "Kol", width: 1 }];
    for (let n = 0; n <= 140; n += 1) {
      const blocks: PdfBlock[] = [
        ...Array.from({ length: n }, (_, i): PdfBlock => ({
          type: "text",
          text: `Isi ${i}`,
        })),
        { type: "heading", text: "JUDUL-UJI", level: 2 },
        { type: "table", columns, rows: [["SEL-UJI"]] },
      ];
      const { pages } = layoutPdfDocument(spec(blocks), fakeMeasure);
      const headingPage = pageOf(pages, "JUDUL-UJI");
      expect(headingPage, `n=${n}`).toBeGreaterThanOrEqual(0);
      expect(pageOf(pages, "SEL-UJI"), `n=${n}`).toBe(headingPage);
    }
  });

  it("keeps a heading with the text that follows it", () => {
    for (let n = 0; n <= 140; n += 1) {
      const blocks: PdfBlock[] = [
        ...Array.from({ length: n }, (_, i): PdfBlock => ({
          type: "text",
          text: `Isi ${i}`,
        })),
        { type: "heading", text: "JUDUL-TEKS" },
        { type: "text", text: "ISI-SETELAH-JUDUL" },
      ];
      const { pages } = layoutPdfDocument(spec(blocks), fakeMeasure);
      expect(pageOf(pages, "ISI-SETELAH-JUDUL"), `n=${n}`).toBe(
        pageOf(pages, "JUDUL-TEKS"),
      );
    }
  });

  it("draws a heading larger than body text and bold", () => {
    const { pages } = layoutPdfDocument(
      spec([
        { type: "heading", text: "Minuman", level: 2 },
        { type: "text", text: "isi biasa" },
      ]),
      fakeMeasure,
    );
    const heading = pages[0].find((l) => l.text === "Minuman")!;
    const body = pages[0].find((l) => l.text === "isi biasa")!;
    expect(heading.bold).toBe(true);
    expect(heading.size).toBeGreaterThan(body.size);
  });
});

describe("layoutPdfDocument: characters missing from the font", () => {
  it("replaces emoji and CJK with ? (no .notdef boxes) and keeps Latin and rupiah", () => {
    const { pages } = layoutPdfDocument(
      spec([
        { type: "text", text: "Kopi 😀 漢字 é ñ Rp 12.500" },
        {
          type: "table",
          columns: [{ header: "Nama", width: 1 }],
          rows: [["Teh 🍵"]],
        },
      ]),
      realMeasure,
    );
    const joined = pageTexts(pages).flat().join("\n");
    expect(joined).toContain("Kopi ? ?? é ñ Rp 12.500");
    expect(joined).toContain("Teh ?");
    expect(joined).not.toMatch(/[😀漢字🍵]/u);
    // Everything that survives has a glyph in the bundled font.
    for (const char of joined.replace(/\n/g, "")) {
      expect(hasGlyph(char.codePointAt(0)!), `U+${char.codePointAt(0)}`).toBe(
        true,
      );
    }
  });
});

describe("renderPdfDocument", () => {
  const realSpec = spec(
    [
      { type: "heading", text: "Minuman", level: 2 },
      {
        type: "table",
        columns: [
          { header: "Nama", width: 0.75 },
          { header: "Harga", width: 0.25, align: "right" },
        ],
        rows: [
          ["Kopi Susu Aren", "Rp 25.000"],
          ["Café Crème Brûlée", "Rp 12.500"],
        ],
      },
      { type: "rule" },
      { type: "spacer", height: 10 },
      { type: "text", text: "Catatan 😀 漢字", muted: true },
    ],
    {
      header: { title: "Cafe Legend", subtitle: "Dago · 2026-03-10" },
      footer: "Harga belum termasuk pajak.",
    },
  );

  it("writes a PDF that loads again with at least one page and carries the text", async () => {
    const bytes = await renderPdfDocument(realSpec);
    expect(Buffer.from(bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(loaded.getTitle()).toBe("Uji");
    const text = allText(Buffer.from(bytes));
    for (const needle of [
      "Cafe Legend",
      "Kopi Susu Aren",
      "Rp 25.000",
      "Café Crème Brûlée",
      "Rp 12.500",
      "Harga belum termasuk pajak.",
      "Halaman 1/1",
    ])
      expect(text).toContain(needle);
    // emoji / CJK become "?" in the file too
    expect(text).toContain("Catatan ? ??");
    expect(text).not.toMatch(/[😀漢字]/u);
  });

  it("layout with real font metrics matches the page count of the written PDF", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => [
      `Menu nomor ${i} dengan deskripsi cukup panjang untuk dibungkus ke baris berikutnya di kolom nama`,
      `Rp ${i}.500`,
    ]);
    const big = spec(
      [
        {
          type: "table",
          columns: [
            { header: "Nama", width: 0.75 },
            { header: "Harga", width: 0.25, align: "right" },
          ],
          rows,
        },
      ],
      { footer: "Footer" },
    );
    const layout = layoutPdfDocument(big, realMeasure);
    const loaded = await PDFDocument.load(await renderPdfDocument(big));
    expect(layout.pages.length).toBeGreaterThan(1);
    expect(loaded.getPageCount()).toBe(layout.pages.length);
  });

  it("accepts an empty block list (still a valid one-page PDF)", async () => {
    const loaded = await PDFDocument.load(
      await renderPdfDocument(spec([], { footer: "Kosong" })),
    );
    expect(loaded.getPageCount()).toBe(1);
  });
});
