// Brief 936 part C (legend-5w6): facility ticket sale from the POS and ticket
// print. Money rule: the price shown is the product's server price, the sell
// and print buttons cannot double-send, and outside mock mode the sale is
// "not connected" (no ticket is issued without a payment contract).
//
// Assumptions: wording from the catalog ("Jual tiket", "Cetak tiket",
// "belum tersambung"); a failed print never voids the ticket (QR/PIN stay).
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import {
  buttonsOf,
  mutation,
  rupiah,
  visibleText,
} from "./pos-payment-936-helpers";

const state = vi.hoisted(() => ({
  products: [] as unknown[],
  connected: true,
  sell: {} as Record<string, unknown>,
  print: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) =>
    // Plain anchor stand-in: the router is not mounted in server rendering.
    children,
}));

vi.mock("@/features/ws04-pos-kasir/hooks", () => ({
  CONTRACT_PENDING: "CONTRACT_PENDING",
  isContractPending: (error: unknown) =>
    (error as { code?: string } | null)?.code === "CONTRACT_PENDING",
}));

function query(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isLoading: false,
    isPending: false,
    isFetching: false,
    refetch: async () => undefined,
    ...over,
  };
}

vi.mock("@/features/ws04-pos-kasir/ticket/hooks", () => ({
  CUSTOMER_SEARCH_MIN_CHARS: 2,
  useTicketProducts: () => query({ data: state.products }),
  useTicketCustomerSearch: () => query({ data: [] }),
  useTicketSlots: () => query({ data: [] }),
  useTicketReady: () => true,
  useTicketSaleConnected: () => state.connected,
  useSellTicket: () => state.sell,
  usePrintTicket: () => state.print,
}));

import { IssuedTicket } from "@/features/ws04-pos-kasir/components/ticket/issued-ticket";
import { SaleSummary } from "@/features/ws04-pos-kasir/components/ticket/sale-summary";
import { TicketSaleScreen } from "@/features/ws04-pos-kasir/components/ticket/ticket-sale-screen";

const product = {
  id: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D2",
  facilityId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D3",
  facilityName: "Kolam Renang",
  name: "Tiket Kolam Dewasa",
  // Deliberately odd: a UI that computed a price could not produce it.
  priceIdr: 87_500,
  sessions: 1,
  areas: [{ id: "area-1", name: "Kolam Utama" }],
  units: [],
};

const ticket = {
  ticketId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D4",
  productName: "Tiket Kolam Dewasa",
  priceIdr: 87_500,
  customerName: "Sari Wulandari",
  facilityName: "Kolam Renang",
  areaName: "Kolam Utama",
  unitCode: null,
  startsAt: "2026-11-17T03:00:00.000Z",
  endsAt: "2026-11-17T05:00:00.000Z",
  validFrom: "2026-11-17T02:45:00.000Z",
  validUntil: "2026-11-17T05:15:00.000Z",
  qrToken: "qr-token-936-abcdefghijklmnop",
  pin: "482913",
};

function summary(over: Record<string, unknown> = {}) {
  return renderToString(
    createElement(SaleSummary, {
      product,
      customer: { id: "c1", name: "Sari Wulandari" },
      areaName: "Kolam Utama",
      timing: { kind: "now" },
      canSell: true,
      connected: true,
      selling: false,
      error: null,
      onSell: () => {},
      ...over,
    } as never),
  );
}

function issued() {
  return renderToString(
    createElement(IssuedTicket, { ticket, onSellAnother: () => {} }),
  );
}

beforeEach(() => {
  state.products = [product];
  state.connected = true;
  state.sell = mutation();
  state.print = mutation();
});

describe("ticket sale: sell button", () => {
  test("ready: Jual tiket is enabled", () => {
    const sell = buttonsOf(summary()).find((b) => /jual tiket/i.test(b.label));
    expect(sell?.disabled).toBe(false);
  });

  test("incomplete selection: Jual tiket is locked", () => {
    const sell = buttonsOf(summary({ canSell: false })).find((b) =>
      /jual tiket/i.test(b.label),
    );
    expect(sell?.disabled).toBe(true);
  });

  test("no payment contract: Jual tiket is locked and says not connected", () => {
    const html = summary({ connected: false });
    const sell = buttonsOf(html).find((b) => /jual tiket/i.test(b.label));
    expect(sell?.disabled).toBe(true);
    expect(visibleText(html)).toMatch(/belum tersambung/i);
  });

  test("whole screen outside mock mode locks the sale and says so", () => {
    state.connected = false;
    const html = renderToString(createElement(TicketSaleScreen));
    const sell = buttonsOf(html).find((b) => /^jual tiket$/i.test(b.label));
    expect(sell?.disabled).toBe(true);
    expect(visibleText(html)).toMatch(/belum tersambung/i);
  });

  test("selling: the button is disabled and busy (no double sale)", () => {
    const buttons = buttonsOf(summary({ selling: true }));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(buttons.some((b) => b.busy)).toBe(true);
  });

  test("whole screen with a sale running keeps Jual tiket locked", () => {
    state.sell = mutation({ isPending: true });
    const buttons = buttonsOf(
      renderToString(createElement(TicketSaleScreen)),
    ).filter((b) => /jual tiket|menjual/i.test(b.label));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });
});

describe("ticket sale: price comes from the server product", () => {
  test("the summary shows product.priceIdr", () => {
    expect(visibleText(summary())).toContain(rupiah(87_500));
  });

  test("the product list shows product.priceIdr", () => {
    const text = visibleText(renderToString(createElement(TicketSaleScreen)));
    expect(text).toContain("Tiket Kolam Dewasa");
    expect(text).toContain(rupiah(87_500));
  });

  test("a different product price is shown as is, not recomputed", () => {
    state.products = [{ ...product, priceIdr: 42_000 }];
    const text = visibleText(renderToString(createElement(TicketSaleScreen)));
    expect(text).toContain(rupiah(42_000));
    expect(text).not.toContain(rupiah(87_500));
  });

  test("a rejected sale says so with a recovery step, not the raw message", () => {
    const error = new Error("Pelanggan tidak ditemukan");
    const text = visibleText(summary({ error }));
    expect(text).toMatch(/belum terjual/i);
    expect(text).toMatch(/coba jual lagi/i);
    expect(text).not.toContain("Pelanggan tidak ditemukan");
  });

  test("sale without contract says it is not connected", () => {
    const error = Object.assign(new Error("pending"), {
      code: "CONTRACT_PENDING",
    });
    expect(visibleText(summary({ error }))).toMatch(/belum tersambung/i);
  });
});

describe("issued ticket: print", () => {
  test("shows the ticket with its PIN and a print button", () => {
    const html = issued();
    const text = visibleText(html);
    expect(text).toContain("482913");
    expect(text).toContain("Sari Wulandari");
    expect(text).toContain(rupiah(87_500));
    const print = buttonsOf(html).find((b) => /cetak tiket/i.test(b.label));
    expect(print?.disabled).toBe(false);
  });

  test("printing: the print button is disabled and busy", () => {
    state.print = mutation({ isPending: true });
    const print = buttonsOf(issued()).find((b) => /mencetak/i.test(b.label));
    expect(print?.disabled).toBe(true);
    expect(print?.busy).toBe(true);
  });

  test("print without contract: shows the message and keeps the ticket", () => {
    state.print = mutation({
      error: Object.assign(new Error("pending"), { code: "CONTRACT_PENDING" }),
    });
    const text = visibleText(issued());
    expect(text).toMatch(/belum tersambung/i);
    // The sale already happened: the ticket stays on screen.
    expect(text).toContain("482913");
    expect(text).toContain("Tiket Kolam Dewasa");
  });

  test("print error: tells the cashier and keeps the ticket", () => {
    state.print = mutation({ error: new Error("Printer offline") });
    const text = visibleText(issued());
    expect(text).toMatch(/belum tercetak/i);
    expect(text).toContain("482913");
  });

  test("printed: says which printer and offers a reprint", () => {
    state.print = mutation({
      data: {
        printedAt: "2026-11-17T03:01:00.000Z",
        printerName: "Printer Kasir",
        reprint: false,
      },
    });
    const html = issued();
    expect(visibleText(html)).toContain("Printer Kasir");
    expect(buttonsOf(html).some((b) => /cetak ulang/i.test(b.label))).toBe(
      true,
    );
  });
});
