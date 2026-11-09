// Acceptance rules for the PO PDF renderer, without a database (bead
// legend-9yz slice B).
import { describe, expect, it } from "vitest";
import type {
  PurchaseOrder,
  PurchaseOrderLine,
} from "@starter/shared/inventory";
import {
  COLUMNS,
  formatRupiah,
  type PurchaseOrderPdfInput,
  renderPurchaseOrderPdf,
  textWidth,
} from "./purchasing-po-pdf";
import { allText, drawnText } from "../test/pdf-text.ts";

const order = {
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  outletId: "00000000-0000-4000-8000-000000000003",
  supplierId: "00000000-0000-4000-8000-000000000004",
  number: "PO/202611/0001",
  purchaseRequestId: null,
  status: "approved",
  expectedDate: "2026-11-15",
  subtotalIdr: 1234567,
  taxIdr: 0,
  totalIdr: 1234567,
  source: "user",
  createdBy: "00000000-0000-4000-8000-000000000005",
  createdAt: "2026-11-08T03:00:00.000Z",
  approvedBy: "00000000-0000-4000-8000-000000000006",
  approvedAt: "2026-11-08T04:00:00.000Z",
  sentAt: null,
  sentTo: null,
  closedAt: null,
  note: null,
} as unknown as PurchaseOrder;

function line(
  index: number,
  itemName: string,
): PurchaseOrderPdfInput["lines"][number] {
  return {
    id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    tenantId: order.tenantId,
    purchaseOrderId: order.id,
    inventoryItemId: "00000000-0000-4000-8000-000000000009",
    quantity: "2.5000",
    uomId: "00000000-0000-4000-8000-00000000000a",
    unitPriceIdr: "12500.0000",
    lineTotalIdr: 31250,
    itemName,
    uomCode: "kg",
  } as unknown as PurchaseOrderLine & { itemName: string; uomCode: string };
}

function input(
  overrides: Partial<PurchaseOrderPdfInput> = {},
): PurchaseOrderPdfInput {
  return {
    tenantName: "Legend Resto",
    outletName: "Outlet Menteng",
    supplier: { name: "CV Sumber Rasa", address: "Jl. Mawar 1", phone: "0812" },
    order,
    lines: [line(1, "Beras Premium")],
    issuedAt: new Date("2026-11-08T03:00:00.000Z"),
    ...overrides,
  };
}

describe("renderPurchaseOrderPdf", () => {
  it("[9yz-PDF-1] starts with %PDF- and carries number and total", async () => {
    const pdf = await renderPurchaseOrderPdf(input());
    const text = allText(pdf);
    expect(pdf.toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(text).toContain("PO/202611/0001");
    expect(text).toContain("Rp 1.234.567");
    expect(text).toContain("Beras Premium");
    expect(pdf.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("[9yz-PDF-2] xref offsets point at each object", async () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      line(index, `Barang ${index}`),
    );
    const pdf = await renderPurchaseOrderPdf(input({ lines: many }));
    const text = pdf.toString("latin1");
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const [header, ...rest] = text.slice(start).split("\n");
    expect(header).toBe("xref");
    const count = Number(rest[0]?.split(" ")[1]);
    expect(count).toBeGreaterThan(5);
    expect(text).toMatch(/\/Count [2-9]/);
    for (let id = 1; id < count; id += 1) {
      const offset = Number(rest[1 + id]?.slice(0, 10));
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(
        `${id} 0 obj`,
      );
    }
  });

  it("[9yz-PDF-3] keeps parentheses and backslashes", async () => {
    const text = allText(
      await renderPurchaseOrderPdf(
        input({
          supplier: { name: "Toko (A) \\ B", address: null, phone: null },
        }),
      ),
    );
    expect(text).toContain("Toko (A) \\ B");
  });

  it("[uokb-PDF-1] prints Latin Extended, Greek and Cyrillic, no ?", async () => {
    const name = "Kopi Ñ é Ελληνικά Кириллица";
    const text = allText(
      await renderPurchaseOrderPdf(
        input({
          supplier: { name: "Café Ünïcode Łódź", address: null, phone: null },
          lines: [line(1, name)],
        }),
      ),
    );
    expect(text).toContain(name);
    expect(text).toContain("Café Ünïcode Łódź");
    expect(text).not.toContain("?");
    expect(text).not.toContain("\uFFFD");
  });

  it("[uokb-PDF-2] a glyph outside the subset does not break the file", async () => {
    const pdf = await renderPurchaseOrderPdf(
      input({ lines: [line(1, "Teh 茶 \u{1F375} hijau")] }),
    );
    const text = allText(pdf);
    expect(text).toContain("Teh");
    expect(text).toContain("hijau");
    expect(text).not.toContain("?");
  });

  it("[uokb-PDF-3] a re-send renders the same bytes", async () => {
    const first = await renderPurchaseOrderPdf(input());
    const second = await renderPurchaseOrderPdf(input());
    expect(second.equals(first)).toBe(true);
  });

  it("[uokb-PDF-4] long Greek and Cyrillic names wrap inside the item column", async () => {
    const long = Array.from({ length: 12 }, () => "Ελληνικά Кириллица").join(
      " ",
    );
    const drawn = drawnText(
      await renderPurchaseOrderPdf(input({ lines: [line(1, long)] })),
    ).filter((entry) => entry.x === 40 + COLUMNS.item.x);
    expect(drawn.length).toBeGreaterThan(2);
    for (const entry of drawn)
      expect(textWidth(entry.text, entry.size)).toBeLessThanOrEqual(
        COLUMNS.item.width + 0.01,
      );
  });

  it("[9yz-PDF-5] formats rupiah with dot grouping", () => {
    expect(formatRupiah(1234567)).toBe("Rp 1.234.567");
    expect(formatRupiah(0)).toBe("Rp 0");
  });

  it("[9yz-PDF-6] 10-digit amounts stay inside their column", async () => {
    const big = {
      ...line(1, "Daging Wagyu"),
      quantity: "9999999999.9999",
      unitPriceIdr: "9999999999.9999",
      lineTotalIdr: 9999999999,
    } as unknown as PurchaseOrderPdfInput["lines"][number];
    const drawn = drawnText(
      await renderPurchaseOrderPdf(
        input({
          lines: [big],
          order: {
            ...order,
            subtotalIdr: 9999999999,
            totalIdr: 9999999999,
          } as unknown as PurchaseOrder,
        }),
      ),
    );
    expect(drawn.map((entry) => entry.text)).toContain("Rp 9.999.999.999");

    const margin = 40;
    const cell = (value: string) => {
      const found = drawn.find((entry) => entry.text === value);
      if (!found) throw new Error(`cell not found: ${value}`);
      return {
        left: found.x,
        right: found.x + textWidth(value, found.size),
      };
    };
    const within = (
      drawn: { left: number; right: number },
      column: { x: number; width: number },
    ) => {
      expect(drawn.left).toBeGreaterThanOrEqual(margin + column.x - 0.01);
      expect(drawn.right).toBeLessThanOrEqual(
        margin + column.x + column.width + 0.01,
      );
    };
    const qty = cell("9.999.999.999,9999");
    const price = cell("Rp 9.999.999.999,9999");
    const total = cell("Rp 9.999.999.999");
    within(qty, COLUMNS.qty);
    within(price, COLUMNS.price);
    within(total, COLUMNS.total);
    expect(qty.right).toBeLessThan(margin + COLUMNS.unit.x);
    expect(price.right).toBeLessThan(total.left);
  });
});
