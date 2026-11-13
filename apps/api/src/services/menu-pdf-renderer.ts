// Menu print PDF (legend-hspr8): PrintableMenu -> generic PDF block spec ->
// pdf-lib. This file imports from menu-print.service.ts; the service only
// knows the MenuPdfRenderer port, so there is no import cycle. Wiring
// (worker, route) calls `createMenuPdfRenderer`.

import {
  PRINT_TAX_NOTE,
  formatRupiah,
  type MenuPdfRenderer,
  type PrintableMenu,
} from "./menu-print.service.ts";
import {
  renderPdfDocument,
  type PdfBlock,
  type PdfDocumentSpec,
} from "./pdf/pdf-document.ts";

/** Pure: the document layout for one outlet menu. */
export function buildMenuPdfSpec(menu: PrintableMenu): PdfDocumentSpec {
  const blocks: PdfBlock[] = [];
  for (const category of menu.categories) {
    blocks.push({ type: "heading", text: category.name, level: 2 });
    blocks.push({
      type: "table",
      columns: [
        { header: "Nama", width: 0.75 },
        { header: "Harga", width: 0.25, align: "right" },
      ],
      rows: category.items.map((item) => [
        item.description === ""
          ? item.name
          : `${item.name}\n${item.description}`,
        formatRupiah(item.priceIdr),
      ]),
    });
  }
  return {
    title: `Menu ${menu.brandName} ${menu.outletName}`,
    header: {
      title: menu.brandName,
      subtitle: `${menu.outletName} · ${menu.date}`,
    },
    blocks,
    footer: PRINT_TAX_NOTE,
  };
}

export function createMenuPdfRenderer(): MenuPdfRenderer {
  return {
    render: (menu) => renderPdfDocument(buildMenuPdfSpec(menu)),
  };
}
