// Pure tests for the printable menu content (bead legend-dmi; PRD v1.7 §3 F8
// "Menu Cetak Otomatis", §7 PDF). No database.

import { describe, expect, it } from "vitest";
import { buildMenuPdfSpec } from "../services/menu-pdf-renderer";
import {
  formatRupiah,
  printableMenuHash,
  PRINT_TAX_NOTE,
  type PrintableMenu,
} from "../services/menu-print.service";

const menu: PrintableMenu = {
  brandName: "Cafe <Legend>",
  outletName: "Dago",
  date: "2026-03-10",
  categories: [
    {
      name: "Minuman",
      items: [
        { name: "Kopi & Susu", description: "<b>dingin</b>", priceIdr: 25000 },
        { name: "Teh", description: "", priceIdr: 12500 },
      ],
    },
    {
      name: "Makanan",
      items: [{ name: "Nasi", description: "", priceIdr: 30000 }],
    },
  ],
};

describe("printable menu PDF spec", () => {
  it("keeps tenant text verbatim (no markup interpretation) and shows rupiah prices", () => {
    const json = JSON.stringify(buildMenuPdfSpec(menu));
    expect(json).toContain("Cafe <Legend>");
    expect(json).toContain("Kopi & Susu");
    expect(json).toContain("<b>dingin</b>");
    expect(json).toContain("Rp 25.000");
    expect(formatRupiah(1250000)).toBe("Rp 1.250.000");
  });

  it("states that prices exclude tax and service (owner decision)", () => {
    expect(buildMenuPdfSpec(menu).footer).toBe(PRINT_TAX_NOTE);
    expect(PRINT_TAX_NOTE).toMatch(/belum termasuk pajak/);
  });

  it("header carries brand, outlet and date", () => {
    const { header } = buildMenuPdfSpec(menu);
    expect(header?.title).toBe("Cafe <Legend>");
    expect(header?.subtitle).toContain("Dago");
    expect(header?.subtitle).toContain("2026-03-10");
  });

  it("keeps category order and item order; an item without description has no empty line", () => {
    const spec = buildMenuPdfSpec(menu);
    const headings = spec.blocks.flatMap((b) =>
      b.type === "heading" ? [b.text] : [],
    );
    expect(headings).toEqual(["Minuman", "Makanan"]);
    const tables = spec.blocks.flatMap((b) => (b.type === "table" ? [b] : []));
    expect(tables).toHaveLength(2);
    expect(tables[0].rows.map((r) => r[1])).toEqual(["Rp 25.000", "Rp 12.500"]);
    expect(tables[0].rows[0][0]).toContain("<b>dingin</b>");
    expect(tables[0].rows[1][0]).toBe("Teh");
  });

  it("hashes the printed payload: price change differs, same payload equal", () => {
    const changed = structuredClone(menu);
    changed.categories[0].items[0].priceIdr = 26000;
    expect(printableMenuHash(menu)).toBe(
      printableMenuHash(structuredClone(menu)),
    );
    expect(printableMenuHash(menu)).not.toBe(printableMenuHash(changed));
  });
});
