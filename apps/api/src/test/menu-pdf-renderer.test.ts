// Tests for the printable-menu PDF renderer (bead legend-hspr8, legend-iuvq;
// brief docs/briefs/menu-pdf-engine.md). No database. Fail-first:
// src/services/menu-pdf-renderer.ts does not exist yet.
//
// Assumptions (brief is silent):
//  - A table cell for an item is `name` alone when there is no description
//    (so no blank line), and starts with `name` when there is one.
//  - Header subtitle is "<outletName> · <date>" (separator not asserted, only
//    that both parts are in it).
//
// Sample output: set LEGEND_MENU_PDF_SAMPLE_DIR=docs/screenshots/menu-pdf (an
// absolute path, or relative to the cwd of the test run) to write
// menu-sample.pdf plus one PNG per page (macOS `sips`).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { layoutPdfDocument } from "../services/pdf/pdf-document";
import {
  buildMenuPdfSpec,
  createMenuPdfRenderer,
} from "../services/menu-pdf-renderer";
import {
  formatRupiah,
  PRINT_TAX_NOTE,
  type PrintableMenu,
} from "../services/menu-print.service";
import { allText } from "./pdf-text";
import { realMeasure } from "./pdf-measure";

const menu: PrintableMenu = {
  brandName: "Cafe Legend",
  outletName: "Dago",
  date: "2026-03-10",
  categories: [
    {
      name: "Kopi",
      items: [
        {
          name: "Kopi Susu Aren",
          description: "Espresso, susu segar, gula aren",
          priceIdr: 25000,
        },
        { name: "Americano", description: "", priceIdr: 18000 },
      ],
    },
    {
      name: "Non-Kopi",
      items: [
        { name: "Matcha Latte", description: "Matcha Uji", priceIdr: 28000 },
        { name: "Teh Tarik", description: "", priceIdr: 15000 },
      ],
    },
    {
      name: "Makanan",
      items: [
        {
          name: "Nasi Goreng Kampung",
          description: "Telur mata sapi, ayam suwir, acar",
          priceIdr: 32000,
        },
      ],
    },
  ],
};

const layoutOf = (value: PrintableMenu) =>
  layoutPdfDocument(buildMenuPdfSpec(value), realMeasure).pages;
const textsOf = (pages: { text: string }[][]) =>
  pages.flatMap((page) => page.map((entry) => entry.text));

function bigMenu(itemCount: number): PrintableMenu {
  return {
    brandName: "Cafe Legend",
    outletName: "Dago",
    date: "2026-03-10",
    categories: [
      {
        name: "Semua Menu",
        items: Array.from({ length: itemCount }, (_, i) => ({
          name: `Menu Nomor ${i}`,
          description: i % 2 === 0 ? "Deskripsi singkat" : "",
          priceIdr: 10000 + i * 500,
        })),
      },
    ],
  };
}

describe("buildMenuPdfSpec", () => {
  const built = buildMenuPdfSpec(menu);

  it("puts brand, outlet and date in the header and the tax note in the footer", () => {
    expect(built.header?.title).toBe("Cafe Legend");
    expect(built.header?.subtitle).toContain("Dago");
    expect(built.header?.subtitle).toContain("2026-03-10");
    expect(built.footer).toBe(PRINT_TAX_NOTE);
    expect(built.title).toContain("Cafe Legend");
  });

  it("makes one level-2 heading plus one two-column table per category, in order", () => {
    const headings = built.blocks.filter((b) => b.type === "heading");
    expect(headings.map((b) => (b.type === "heading" ? b.text : ""))).toEqual([
      "Kopi",
      "Non-Kopi",
      "Makanan",
    ]);
    for (const heading of headings)
      expect(heading.type === "heading" && heading.level).toBe(2);
    const tables = built.blocks.filter((b) => b.type === "table");
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      if (table.type !== "table") continue;
      expect(table.columns).toHaveLength(2);
      expect(table.columns[0].width).toBeCloseTo(0.75, 2);
      expect(table.columns[1].width).toBeCloseTo(0.25, 2);
      expect(table.columns[1].align).toBe("right");
    }
    // heading comes right before its table
    const order = built.blocks.map((b) => b.type).filter((t) => t !== "spacer");
    expect(order.slice(0, 2)).toEqual(["heading", "table"]);
  });

  it("formats prices as Rp with dot separators and adds no blank row for items without description", () => {
    const first = built.blocks.find((b) => b.type === "table");
    if (first?.type !== "table") throw new Error("no table");
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0][1]).toBe(formatRupiah(25000));
    expect(first.rows[0][1]).toBe("Rp 25.000");
    expect(first.rows[0][0]).toContain("Kopi Susu Aren");
    expect(first.rows[0][0]).toContain("Espresso, susu segar, gula aren");
    // No description: the cell is the name alone, nothing trailing.
    expect(first.rows[1][0]).toBe("Americano");
    expect(first.rows[1][1]).toBe("Rp 18.000");
  });

  it("is pure: the same model gives the same spec and the input is not mutated", () => {
    const copy = structuredClone(menu);
    expect(buildMenuPdfSpec(copy)).toEqual(buildMenuPdfSpec(menu));
    expect(copy).toEqual(menu);
  });
});

describe("menu PDF layout and file", () => {
  it("renders a 3-category menu as a valid PDF whose layout holds every item name and price", async () => {
    const texts = textsOf(layoutOf(menu));
    for (const needle of [
      "Cafe Legend",
      "Kopi",
      "Non-Kopi",
      "Makanan",
      "Kopi Susu Aren",
      "Americano",
      "Matcha Latte",
      "Teh Tarik",
      "Nasi Goreng Kampung",
      "Rp 25.000",
      "Rp 18.000",
      "Rp 28.000",
      "Rp 15.000",
      "Rp 32.000",
      PRINT_TAX_NOTE,
    ])
      expect(texts.join("\n")).toContain(needle);

    const bytes = await createMenuPdfRenderer().render(menu);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    const fileText = allText(Buffer.from(bytes));
    for (const needle of [
      "Kopi Susu Aren",
      "Rp 25.000",
      "Nasi Goreng Kampung",
      "Rp 32.000",
      PRINT_TAX_NOTE,
    ])
      expect(fileText).toContain(needle);
  });

  it("draws no empty text lines for items without a description", () => {
    expect(textsOf(layoutOf(menu)).filter((t) => t.trim() === "")).toEqual([]);
  });

  it("a 120-item menu spans several pages, each page with the footer and nothing lost", async () => {
    const big = bigMenu(120);
    const pages = layoutOf(big);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, index) => {
      const joined = page.map((entry) => entry.text).join(" ");
      expect(joined).toContain(PRINT_TAX_NOTE);
      expect(joined).toContain(`Halaman ${index + 1}/${pages.length}`);
    });
    const all = textsOf(pages);
    for (let i = 0; i < 120; i += 1) {
      expect(all.filter((t) => t === `Menu Nomor ${i}`)).toHaveLength(1);
      expect(all).toContain(formatRupiah(10000 + i * 500));
    }
    const loaded = await PDFDocument.load(
      await createMenuPdfRenderer().render(big),
    );
    expect(loaded.getPageCount()).toBe(pages.length);
  });

  it("keeps Indonesian text: accents, ñ, Rp 12.500 and long descriptions lose no characters", async () => {
    const description =
      "Kopi single origin dari lereng gunung, diseduh manual dengan air panas 92 derajat, " +
      "disajikan dengan susu oat dan sedikit karamel asin; cocok untuk pagi yang dingin di Bandung " +
      "dan menemani obrolan panjang bersama teman, keluarga, atau rekan kerja.";
    const accented: PrintableMenu = {
      brandName: "Café Señor",
      outletName: "Dago Atas",
      date: "2026-03-10",
      categories: [
        {
          name: "Spesial é ñ",
          items: [
            { name: "Crème Brûlée Latte", description, priceIdr: 12500 },
            { name: "Piña Colada", description: "", priceIdr: 12500 },
          ],
        },
      ],
    };
    const pages = layoutOf(accented);
    const all = textsOf(pages).join("\n");
    expect(all).not.toContain("?");
    for (const needle of [
      "Café Señor",
      "Spesial é ñ",
      "Crème Brûlée Latte",
      "Piña Colada",
      "Rp 12.500",
    ])
      expect(all).toContain(needle);
    // Every description word is drawn, in order (wrapping only moves them).
    const drawn = all.split(/\s+/);
    let cursor = 0;
    for (const word of description.split(/\s+/)) {
      cursor = drawn.indexOf(word, cursor);
      expect(cursor, word).toBeGreaterThanOrEqual(0);
      cursor += 1;
    }
    const fileText = allText(
      Buffer.from(await createMenuPdfRenderer().render(accented)),
    );
    for (const needle of [
      "Café Señor",
      "Crème Brûlée Latte",
      "Piña Colada",
      "Rp 12.500",
    ])
      expect(fileText).toContain(needle);
  });

  it("replaces emoji in a menu name with ? instead of a box, keeping the rest", () => {
    const emoji = structuredClone(menu);
    emoji.categories[0].items[0].name = "Kopi 😀 Susu";
    const all = textsOf(layoutOf(emoji)).join("\n");
    expect(all).toContain("Kopi ? Susu");
    expect(all).not.toContain("😀");
  });

  it("an empty menu (no categories) is still a valid PDF with header and tax note", async () => {
    const empty: PrintableMenu = { ...menu, categories: [] };
    const bytes = await createMenuPdfRenderer().render(empty);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    const text = allText(Buffer.from(bytes));
    expect(text).toContain("Cafe Legend");
    expect(text).toContain(PRINT_TAX_NOTE);
  });
});

// Sample PDF + per-page PNGs for review (docs/screenshots/menu-pdf). Only runs
// when LEGEND_MENU_PDF_SAMPLE_DIR is set; PNG needs macOS `sips`.
const sampleDir = process.env.LEGEND_MENU_PDF_SAMPLE_DIR;
describe("menu PDF sample", () => {
  it.skipIf(!sampleDir)(
    "writes menu-sample.pdf (3 categories, one longer than a page) and a PNG per page",
    async () => {
      const dir = resolve(sampleDir as string);
      mkdirSync(dir, { recursive: true });
      const sample: PrintableMenu = {
        brandName: "Cafe Legend",
        outletName: "Dago",
        date: "2026-03-10",
        categories: [
          {
            name: "Kopi",
            items: Array.from({ length: 70 }, (_, i) => ({
              name: `Kopi Spesial ${i + 1}`,
              description:
                i % 3 === 0
                  ? "Biji pilihan, diseduh manual, rasa karamel dan cokelat gelap"
                  : "",
              priceIdr: 18000 + (i % 10) * 1500,
            })),
          },
          {
            name: "Non-Kopi",
            items: [
              {
                name: "Matcha Latte",
                description: "Matcha Uji",
                priceIdr: 28000,
              },
              { name: "Teh Tarik", description: "", priceIdr: 15000 },
              {
                name: "Cokelat Panas",
                description: "Dark 70%",
                priceIdr: 24000,
              },
            ],
          },
          {
            name: "Makanan",
            items: [
              {
                name: "Nasi Goreng Kampung",
                description: "Telur mata sapi, ayam suwir, acar",
                priceIdr: 32000,
              },
              {
                name: "Roti Bakar Cokelat Keju",
                description: "",
                priceIdr: 22000,
              },
            ],
          },
        ],
      };
      const bytes = await createMenuPdfRenderer().render(sample);
      writeFileSync(join(dir, "menu-sample.pdf"), bytes);
      const source = await PDFDocument.load(bytes);
      const count = source.getPageCount();
      expect(count).toBeGreaterThan(1);

      const work = mkdtempSync(join(tmpdir(), "menu-pdf-"));
      try {
        for (let index = 0; index < count; index += 1) {
          const single = await PDFDocument.create();
          const [page] = await single.copyPages(source, [index]);
          single.addPage(page);
          const pdfPath = join(work, `p${index + 1}.pdf`);
          writeFileSync(pdfPath, await single.save());
          execFileSync("sips", [
            "-s",
            "format",
            "png",
            pdfPath,
            "--out",
            join(dir, `menu-sample-page-${index + 1}.png`),
          ]);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
