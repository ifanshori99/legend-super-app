// Pure tests for the printable menu content (bead legend-dmi; PRD v1.7 §3 F8
// "Menu Cetak Otomatis", §7 HTML -> PDF). No database.

import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatRupiah,
  printableMenuHash,
  PRINT_TAX_NOTE,
  renderMenuPrintHtml,
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
      ],
    },
  ],
};

describe("printable menu HTML", () => {
  it("escapes tenant text and shows rupiah prices", () => {
    const html = renderMenuPrintHtml(menu);
    expect(html).toContain("Cafe &lt;Legend&gt;");
    expect(html).toContain("Kopi &amp; Susu");
    expect(html).not.toContain("<b>dingin</b>");
    expect(html).toContain("Rp 25.000");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
    expect(formatRupiah(1250000)).toBe("Rp 1.250.000");
  });

  it("states that prices exclude tax and service (owner decision)", () => {
    expect(renderMenuPrintHtml(menu)).toContain(PRINT_TAX_NOTE);
    expect(PRINT_TAX_NOTE).toMatch(/belum termasuk pajak/);
  });

  it("loads no remote resources (self-contained for the PDF engine)", () => {
    expect(renderMenuPrintHtml(menu)).not.toMatch(/(src|href)=["']https?:/);
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
