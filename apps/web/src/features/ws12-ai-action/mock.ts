// Mock handlers for the AI action request screens (VITE_API_MOCK=true).
// Fixtures come from @starter/shared/ai; every response is validated with the
// contract schema. Reach each state by URL (mock mode):
//   /kelola/tanya-ai/aksi/a1010000-0000-4000-8000-00000000000N
//     N=1 pending (Tanya AI), 2 pending (MCP), 3 approved, 4 executed,
//     5 rejected, 6 failed (with reason), 7 expired; any other id is not found.
//   ?mock=slow loading, ?mock=error failure with retry, ?mock=offline offline.
import {
  actionRequestReviewSchema,
  cafeLegendAiFixtures as fixtures,
  getActionRequest,
  getActionRequestByApproval,
  getAiTool,
  type ActionRequest,
  type ActionRequestReview,
} from "@starter/shared/ai";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendFixtures } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";

const people = Object.values(cafeLegendAccessFixtures.users) as {
  id: string;
  displayName: string;
}[];

const notFound = () =>
  new ApiError(
    404,
    "ACTION_REQUEST_NOT_FOUND",
    "Pengajuan tindakan tidak ditemukan.",
  );

const idr = (value: unknown) =>
  typeof value === "number"
    ? `Rp${value.toLocaleString("id-ID")}`
    : String(value);

/** Readable, redacted lines for the draft view (mock stand-in for the API's `summary`). */
function summaryFor(request: ActionRequest): ActionRequestReview["summary"] {
  const payload = request.payload as Record<string, unknown>;
  switch (request.toolCode) {
    case "TL-17": {
      const changes = (payload.changes as { newPriceIdr: number }[]) ?? [];
      return [
        { label: "Menu diubah", value: `${changes.length} menu` },
        {
          label: "Harga Cappuccino",
          value: `Rp30.000 → ${idr(changes[0]?.newPriceIdr)}`,
        },
        { label: "Mulai berlaku", value: "8 Nov 2026, 07.00" },
      ];
    }
    case "TL-13":
      return [
        { label: "Pemasok", value: "Pemasok contoh" },
        { label: "Jenis permintaan", value: "Draf pesanan pembelian" },
      ];
    case "TL-14":
      return [
        { label: "Barang", value: "Susu segar" },
        { label: "Stok", value: "42 liter → 38 liter" },
      ];
    case "TL-15":
      return [
        { label: "Promo", value: "Diskon akhir pekan" },
        { label: "Potongan", value: "10 %" },
      ];
    case "TL-16":
      return [
        { label: "Periode jadwal", value: "16–22 November 2026" },
        { label: "Area", value: "Pelayanan" },
        { label: "Shift pagi", value: "08.00–16.00 · 3 staf" },
        { label: "Shift sore", value: "16.00–00.00 · 4 staf" },
      ];
    case "TL-18":
      return [
        { label: "Menu", value: "Croissant" },
        { label: "Ketersediaan", value: "Tersedia → Habis" },
      ];
  }
}

function reviewOf(request: ActionRequest): ActionRequestReview {
  const outlet = cafeLegendFixtures.outlets.find(
    (entry) => entry.id === request.outletId,
  );
  return actionRequestReviewSchema.parse({
    actionRequest: request,
    toolTitleId: getAiTool(request.toolCode)?.titleId ?? "Permintaan aksi",
    requestedByName:
      people.find((person) => person.id === request.requestedByUserId)
        ?.displayName ?? "Pengguna",
    outletName: outlet?.name ?? null,
    summary: summaryFor(request),
  });
}

registerMock(getActionRequest, ({ params }) => {
  const request = fixtures.actionRequests.find(
    (entry) => entry.id === params.actionRequestId,
  );
  if (!request) throw notFound();
  return { data: request };
});

registerMock(getActionRequestByApproval, ({ params }) => {
  const request = fixtures.actionRequests.find(
    (entry) => entry.approvalRequestId === params.approvalRequestId,
  );
  if (!request) throw notFound();
  return { data: reviewOf(request) };
});
