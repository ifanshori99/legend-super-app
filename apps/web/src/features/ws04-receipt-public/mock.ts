// Mock for the public e-receipt (VITE_API_MOCK=true), the mockup's example:
// 2 × Kopi susu + 1 × Nasi ayam, service charge and tax, paid by QRIS.
// Demo switches (query string, browser only):
//   ?demo=invalid  the link is unknown or expired (404, one and the same answer)
//   ?demo=error    the read fails (network-style 503, "Coba lagi" recovers)
//   ?demo=kuitansi the same sale as a kuitansi
// A token of "invalid" behaves like ?demo=invalid. `?mock=error` / `slow` work
// as everywhere (lib/mock/control.ts).
import { cafeLegendPosFixtures } from "@starter/shared/pos";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { getPublicReceipt } from "./endpoints.ts";

const base = cafeLegendPosFixtures.receiptDocuments[0];

function demo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("demo");
  } catch {
    return null;
  }
}

registerMock(getPublicReceipt, ({ params }) => {
  const seed = demo();
  if (seed === "invalid" || params.token === "invalid")
    throw new ApiError(404, "NOT_FOUND", "Struk tidak ditemukan.");
  if (seed === "error")
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "Layanan belum tersedia.");
  return {
    data: {
      ...base,
      id: "doc-public-000048",
      receiptNumber: "POS01-000048",
      orderNumber: "BDG-01-POS-0048",
      documentKind:
        seed === "kuitansi" ? ("kuitansi" as const) : ("receipt" as const),
      issuedAt: "2026-11-11T07:32:00.000Z",
      items: [
        {
          name: "Kopi susu",
          quantity: 2,
          unitPriceIdr: 30_000,
          modifiersTotalIdr: 0,
          lineTotalIdr: 60_000,
          note: null,
        },
        {
          name: "Nasi ayam",
          quantity: 1,
          unitPriceIdr: 40_000,
          modifiersTotalIdr: 0,
          lineTotalIdr: 40_000,
          note: null,
        },
      ],
      discounts: [],
      serviceCharge: { rateBp: 500, baseIdr: 100_000, amountIdr: 5_000 },
      taxLines: [
        {
          ...base.taxLines[0],
          baseIdr: 105_000,
          amountIdr: 10_500,
        },
      ],
      subtotalIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 5_000,
      taxIdr: 10_500,
      roundingIdr: 0,
      totalIdr: 115_500,
      tenders: [
        { method: "qris" as const, amountIdr: 115_500, reference: null },
      ],
      cashierName: null,
      customerName: null,
    },
  };
});
