// Brief 936 part C money rule: outside mock mode the facility ticket sale is
// "not connected" (CONTRACT_PENDING). The sale endpoint takes no payment, so a
// real ticket must never be issued from the POS without money received.
// Vite injects this build flag; the unit config does not.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

import { sellTicket } from "@/features/ws04-pos-kasir/ticket/api";

vi.mock("@/lib/api/mock-flag", () => ({ API_MOCK: false }));

describe("ticket sale outside mock mode", () => {
  test("sellTicket rejects with CONTRACT_PENDING and issues nothing", async () => {
    await expect(
      sellTicket(
        {
          product: {
            id: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D2",
            facilityId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D3",
            facilityName: "Kolam Renang",
            name: "Tiket Kolam Dewasa",
            priceIdr: 87_500,
            sessions: 1,
            areas: [{ id: "area-1", name: "Kolam Utama" }],
            units: [],
          },
          areaId: "area-1",
          customer: { id: "c1", name: "Sari Wulandari" },
          timing: { kind: "now" },
        },
        "ticket-sale:key-1",
      ),
    ).rejects.toMatchObject({ code: "CONTRACT_PENDING" });
  });
});
