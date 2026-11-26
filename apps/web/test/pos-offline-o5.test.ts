// O5 release must-haves (bead legend-wasr7.9; Keputusan CTO 27 Nov in
// docs/qa/1272-o4-review.md).
//
// Assumptions (from the decision):
// - (1) An unclear order (its cloud request was lost) holds every cart that
//   shares a line with it, however long the tablet stays offline. The way out
//   is the cashier marking "pelanggan lain" with a written reason; the sale is
//   then recorded offline and goes to Finance as "perlu dicek". Without the
//   reason the same lines stay refused.
// - (2) The day close lists every shift still open, also one opened yesterday
//   or earlier: all pages, no business-day limit.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

type Call = { path: string; query?: Record<string, unknown> };

const net = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (call: Call): unknown => {
    throw new Error(`no response for ${call.path}`);
  },
}));

vi.mock("@/lib/api/mock-flag", () => ({ API_MOCK: false }));
vi.mock("@/lib/api/client", () => ({
  apiFetch: async (
    path: string,
    request: { query?: Record<string, unknown> } = {},
  ) => {
    const call = { path, query: request.query };
    net.calls.push(JSON.parse(JSON.stringify(call)) as Call);
    return net.respond(call);
  },
}));

import { fetchOpenShiftsOfDay } from "@/features/ws04-pos-kasir/shift-api";
import {
  OFFLINE_OTHER_CUSTOMER_REASON_MIN,
  offlineSaleBlock,
} from "@/features/ws04-pos-kasir/offline/sale-guard";
import { saveOfflineSale } from "@/features/ws04-pos-kasir/offline/sale-view";
import type { CartLine, OrderSnapshot } from "@/features/ws04-pos-order/types";

const OUTLET = "0a1b2c3d-0000-4000-8000-0000000000a1";
const shiftId = (n: number) =>
  `0a1b2c3d-0000-4000-8000-0000000000b${n.toString(16)}`;

const shiftRow = (n: number, status: "open" | "closed", date: string) => ({
  id: shiftId(n),
  status,
  businessDate: date,
  openedAt: `${date}T08:00:00.000Z`,
  openingFloatIdr: "100000",
});

describe("O5 (2): the day close lists the shifts still open since before today", () => {
  beforeEach(() => {
    net.calls.length = 0;
  });

  it("reads every page and sends no business date, keeping only open shifts", async () => {
    const pages: Record<string, unknown> = {
      "": {
        data: [
          shiftRow(1, "open", "2026-11-27"),
          shiftRow(2, "closed", "2026-11-27"),
        ],
        meta: { limit: 100, nextCursor: "c1" },
      },
      c1: {
        data: [
          shiftRow(3, "open", "2026-11-26"),
          shiftRow(4, "closed", "2026-11-26"),
        ],
        meta: { limit: 100, nextCursor: "c2" },
      },
      c2: {
        data: [shiftRow(5, "open", "2026-11-24")],
        meta: { limit: 100, nextCursor: null },
      },
    };
    net.respond = (call) => pages[String(call.query?.cursor ?? "")];
    const shifts = await fetchOpenShiftsOfDay(OUTLET, "2026-11-27");
    expect(shifts.map((shift) => shift.id)).toEqual([
      shiftId(1),
      shiftId(3),
      shiftId(5),
    ]);
    expect(shifts.map((shift) => shift.businessDate)).toEqual([
      "2026-11-27",
      "2026-11-26",
      "2026-11-24",
    ]);
    expect(net.calls).toHaveLength(3);
    for (const call of net.calls)
      expect(call.query).not.toHaveProperty("businessDate");
    expect(net.calls.map((call) => call.query?.cursor)).toEqual([
      undefined,
      "c1",
      "c2",
    ]);
  });

  it("an outlet with no open shift lists none", async () => {
    net.respond = () => ({
      data: [shiftRow(1, "closed", "2026-11-26")],
      meta: { limit: 100, nextCursor: null },
    });
    expect(await fetchOpenShiftsOfDay(OUTLET, "2026-11-27")).toEqual([]);
  });
});

const line = (menuItemId: string, quantity: number): CartLine => ({
  lineId: `${menuItemId}-${quantity}`,
  menuItemId,
  variantId: null,
  variantName: null,
  name: menuItemId,
  unitPriceIdr: 10_000,
  quantity,
  modifiers: [],
  note: "",
  course: { id: "c", label: "Course 1", order: 1 },
  hold: false,
});

const snapshot = (lines: CartLine[]): OrderSnapshot =>
  ({
    lines,
    meta: {
      channel: "dine_in",
      tableLabel: "08",
      tableSessionId: "s",
      ojolPlatform: null,
      ojolRef: "",
    },
  }) as OrderSnapshot;

describe("O5 (1): another customer is the way out of an unclear order", () => {
  const base = {
    lines: [line("kopi", 1)],
    channel: "dine_in" as const,
    pending: snapshot([line("kopi", 2)]),
    submitting: false,
    cloudOrderId: null,
    canAcceptPayment: true,
  };

  it("without a reason the shared line stays held", () => {
    expect(offlineSaleBlock(base)).toBe("uncertain_order");
    expect(offlineSaleBlock({ ...base, otherCustomerReason: null })).toBe(
      "uncertain_order",
    );
    expect(offlineSaleBlock({ ...base, otherCustomerReason: "   " })).toBe(
      "uncertain_order",
    );
    expect(offlineSaleBlock({ ...base, otherCustomerReason: "ab" })).toBe(
      "uncertain_order",
    );
  });

  it("a written reason lets the sale go", () => {
    expect(OFFLINE_OTHER_CUSTOMER_REASON_MIN).toBe(4);
    expect(
      offlineSaleBlock({
        ...base,
        otherCustomerReason: "Meja 4, pelanggan lain",
      }),
    ).toBeNull();
  });

  it("the reason opens only the unclear-order hold, never another refusal", () => {
    const reason = "Meja 4, pelanggan lain";
    expect(
      offlineSaleBlock({ ...base, otherCustomerReason: reason, lines: [] }),
    ).toBe("empty");
    expect(
      offlineSaleBlock({
        ...base,
        otherCustomerReason: reason,
        canAcceptPayment: false,
      }),
    ).toBe("noPermission");
    expect(
      offlineSaleBlock({
        ...base,
        otherCustomerReason: reason,
        submitting: true,
      }),
    ).toBe("sending");
    expect(
      offlineSaleBlock({
        ...base,
        otherCustomerReason: reason,
        cloudOrderId: "01J",
      }),
    ).toBe("cloud_order");
    expect(
      offlineSaleBlock({
        ...base,
        otherCustomerReason: reason,
        channel: "ojol_manual",
      }),
    ).toBe("channel");
  });

  it("the sale view hands the trimmed reason to the queue", async () => {
    const recorded: unknown[] = [];
    const queue = {
      recordSale: async (_cart: unknown, _tenders: unknown, options: unknown) => {
        recorded.push(options);
        return {
          sequenceNumber: 7,
          tenders: [],
        } as never;
      },
    };
    const kit = { receiptRun: { prefix: "L1" } } as never;
    const cart = { serviceType: "takeaway", lines: [] } as never;
    const tender = {
      method: "edc_card",
      amountIdr: 1000,
      reference: "S1",
    } as never;
    await saveOfflineSale(queue, kit, cart, tender, "  pelanggan lain  ");
    await saveOfflineSale(queue, kit, cart, tender);
    expect(recorded).toEqual([
      { otherCustomerReason: "pelanggan lain" },
      undefined,
    ]);
  });
});
