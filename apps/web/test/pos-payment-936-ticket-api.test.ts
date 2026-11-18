// Brief 936 part C money rule, retargeted by 1046 (legend-l65nz): outside mock
// mode the ticket sale is connected (real endpoints), but selling a ticket
// never issues a credential: the sale only opens a bill (ticket
// `pending_payment`), and the QR+PIN is requested later, by the cashier, for a
// paid ticket. So no ticket is usable without money received.
// Vite injects this build flag; the unit config does not.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

const paths = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/api/mock-flag", () => ({ API_MOCK: false }));
vi.mock("@/lib/api/client", () => ({
  apiFetch: async (path: string) => {
    paths.push(path);
    return path === "/api/facility/tickets/pos"
      ? {
          data: {
            ticket: { id: "01JCQ8Z5N0M3X4Y5Z6A7B8C9E2" },
            order: {
              id: "01JCQ8Z5N0M3X4Y5Z6A7B8C9E1",
              number: "POS-0002",
              status: "open",
              totalIdr: "87500",
            },
          },
        }
      : { data: {} };
  },
}));

import { sellTicketAtPos } from "@/features/ws04-pos-kasir/ticket/api";
import { TICKET_SALE_CONNECTED } from "@/features/ws04-pos-kasir/ticket/connected";

describe("ticket sale outside mock mode", () => {
  test("the sale screen is not locked", () => {
    expect(TICKET_SALE_CONNECTED).toBe(true);
  });

  test("selling opens a bill and requests no credential", async () => {
    vi.stubEnv("DEV", false);
    try {
      const sale = await sellTicketAtPos(
        "0a1b2c3d-0000-4000-8000-0000000000a1",
        {
          product: {
            id: "0a1b2c3d-0000-4000-8000-000000000002",
            facilityId: "0a1b2c3d-0000-4000-8000-000000000003",
            facilityName: "Kolam Renang",
            name: "Tiket Kolam Dewasa",
            priceIdr: 87_500,
            sessions: 1,
            areas: [
              {
                id: "0a1b2c3d-0000-4000-8000-000000000005",
                name: "Kolam Utama",
              },
            ],
            units: [],
          },
          areaId: "0a1b2c3d-0000-4000-8000-000000000005",
          customer: {
            id: "0a1b2c3d-0000-4000-8000-000000000006",
            name: "Sari Wulandari",
          },
          timing: { kind: "now" },
        },
        "ticket-sale:key-0001",
      );
      expect(sale.orderId).toBe("01JCQ8Z5N0M3X4Y5Z6A7B8C9E1");
      expect(paths.some((path) => path.includes("/credential"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
