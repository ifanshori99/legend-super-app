// Brief 936 part C (legend-5w6) + 1046 (legend-l65nz): facility ticket sale
// from the POS, then issue of the QR+PIN after the bill is paid. Money rule: the
// price shown is the server price, buttons cannot double-send, and the cashier
// explicitly presses "Terbitkan tiket" (never automatic on open).
//
// Assumptions: wording from the catalog ("Jual tiket", "Terbitkan tiket",
// "Cetak tiket", "belum tersambung"); the credential is on screen only while
// the parent holds it (props), a failed re-issue keeps the code already shown.
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
  tickets: {} as Record<string, unknown>,
  issue: {} as Record<string, unknown>,
  issueCalls: 0,
  /** Credential the next TicketIssueStep render starts with (see react mock). */
  seed: null as unknown,
}));

// Server rendering cannot click, so the step's credential state is seeded: the
// first useState(null) of a render (the step's own) returns the seed once.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: ((init: unknown) => {
      if (init === null && state.seed !== null) {
        const seed = state.seed;
        state.seed = null;
        return [seed, () => {}];
      }
      return actual.useState(init as never);
    }) as typeof actual.useState,
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) =>
    // Plain anchor stand-in: the router is not mounted in server rendering.
    children,
  useNavigate: () => () => Promise.resolve(),
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
  useSellTicketAtPos: () => state.sell,
  useOrderTickets: () => state.tickets,
  useIssueTicketCredential: () => state.issue,
}));

import { ApiError } from "@/lib/api/errors";
import { IssuedTicket } from "@/features/ws04-pos-kasir/components/ticket/issued-ticket";
import { SaleSummary } from "@/features/ws04-pos-kasir/components/ticket/sale-summary";
import { TicketIssueStep } from "@/features/ws04-pos-kasir/components/ticket/ticket-issue-step";
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

const line = {
  ticketId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D4",
  orderId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9D7",
  lineStatus: "issued",
  productName: "Tiket Kolam Dewasa",
  customerName: "Sari Wulandari",
  facilityName: "Kolam Renang",
  areaName: "Kolam Utama",
  unitCode: null,
  startsAt: "2026-11-17T03:00:00.000Z",
  endsAt: "2026-11-17T05:00:00.000Z",
  // Deliberately odd: the screen shows the server's line total as is.
  priceIdr: 87_500,
};

const credential = {
  ticketId: line.ticketId,
  qrToken: "qr-token-936-abcdefghijklmnop",
  pin: "482913",
  validFrom: "2026-11-17T02:45:00.000Z",
  validUntil: "2026-11-17T05:15:00.000Z",
  print: {
    printedAt: "2026-11-17T03:01:00.000Z" as string | null,
    printerName: "Printer Kasir" as string | null,
    reprint: false,
  },
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

function issued(over: Record<string, unknown> = {}) {
  return renderToString(
    createElement(IssuedTicket, {
      line,
      credential,
      rotated: false,
      reissuing: false,
      onReissue: () => {},
      ...over,
    } as never),
  );
}

function step() {
  return renderToString(
    createElement(TicketIssueStep, {
      orderId: line.orderId,
      ticketId: line.ticketId,
    }),
  );
}

function ticketsQuery(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isLoading: false,
    isError: false,
    isPending: false,
    refetch: async () => undefined,
    ...over,
  };
}

beforeEach(() => {
  state.products = [product];
  state.connected = true;
  state.sell = mutation();
  state.tickets = ticketsQuery({ data: [line] });
  state.issue = {
    ...mutation(),
    mutate: () => {
      state.issueCalls += 1;
    },
  };
  state.issueCalls = 0;
  state.seed = null;
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

describe("issue step: the cashier issues the ticket explicitly", () => {
  test("a paid ticket shows Terbitkan tiket enabled and issues nothing on open", () => {
    const html = step();
    const text = visibleText(html);
    expect(text).toContain("Tiket Kolam Dewasa");
    expect(text).toContain(rupiah(87_500));
    const issue = buttonsOf(html).find((b) =>
      /^terbitkan tiket$/i.test(b.label),
    );
    expect(issue?.disabled).toBe(false);
    expect(state.issueCalls).toBe(0);
    // Nothing secret before the cashier presses the button.
    expect(text).not.toContain("482913");
  });

  test("issuing: the button is disabled and busy (no double issue)", () => {
    state.issue = mutation({ isPending: true });
    const issue = buttonsOf(step()).find((b) => /menerbitkan/i.test(b.label));
    expect(issue?.disabled).toBe(true);
    expect(issue?.busy).toBe(true);
  });

  test("an unpaid bill says so, links to payment and offers no issue button", () => {
    state.tickets = ticketsQuery({
      data: [{ ...line, lineStatus: "pending" }],
    });
    const html = step();
    expect(visibleText(html)).toMatch(/tagihan belum lunas/i);
    expect(visibleText(html)).toMatch(/ke layar bayar/i);
    expect(
      buttonsOf(html).some((b) => /^terbitkan tiket$/i.test(b.label)),
    ).toBe(false);
  });

  test.each(["cancelled", "refunded"])(
    "a %s ticket cannot be issued",
    (lineStatus) => {
      state.tickets = ticketsQuery({ data: [{ ...line, lineStatus }] });
      const html = step();
      expect(visibleText(html)).toMatch(/tidak bisa diterbitkan/i);
      expect(
        buttonsOf(html).some((b) => /^terbitkan tiket$/i.test(b.label)),
      ).toBe(false);
    },
  );

  test("loading shows a status, not an empty card", () => {
    state.tickets = ticketsQuery({ isLoading: true });
    expect(visibleText(step())).toMatch(/memuat tiket/i);
  });

  test("a load error says so", () => {
    state.tickets = ticketsQuery({
      isError: true,
      error: new Error("boom"),
    });
    expect(visibleText(step())).toMatch(/tiket belum bisa dimuat/i);
  });

  test("an unknown ticket id says not found", () => {
    state.tickets = ticketsQuery({ data: [] });
    expect(visibleText(step())).toMatch(/tiket tidak ditemukan/i);
  });

  test("a refused issue (bill not paid) tells the cashier and shows no code", () => {
    state.issue = mutation({
      error: new ApiError(409, "TICKET_NOT_PAID", "x"),
    });
    const text = visibleText(step());
    expect(text).toMatch(/tagihan belum lunas/i);
    expect(text).not.toContain("482913");
  });
});

describe("issued ticket: QR, PIN and print", () => {
  test("shows the PIN, the customer and a print button", () => {
    const html = issued();
    const text = visibleText(html);
    expect(text).toContain("482913");
    expect(text).toContain("Sari Wulandari");
    const print = buttonsOf(html).find((b) => /cetak tiket/i.test(b.label));
    expect(print?.disabled).toBe(false);
  });

  test("reissuing: the print button is disabled and busy", () => {
    const print = buttonsOf(issued({ reissuing: true })).find((b) =>
      /mencetak/i.test(b.label),
    );
    expect(print?.disabled).toBe(true);
    expect(print?.busy).toBe(true);
  });

  test("printed: says which printer", () => {
    expect(visibleText(issued())).toContain("Printer Kasir");
  });

  test("no printer (cloud): says so and keeps the QR and PIN on screen", () => {
    const text = visibleText(
      issued({
        credential: {
          ...credential,
          print: { printedAt: null, printerName: null, reprint: false },
        },
      }),
    );
    expect(text).toMatch(/printer tidak tersedia/i);
    expect(text).toContain("482913");
  });

  test("after a second issue the screen says the old code no longer works", () => {
    expect(visibleText(issued({ rotated: true }))).toMatch(
      /sebelumnya tidak berlaku/i,
    );
    expect(visibleText(issued())).not.toMatch(/kode baru sudah dibuat/i);
  });

  test.each([
    ["an unknown error", new Error("Printer offline")],
    ["a known refusal", new ApiError(409, "TICKET_NOT_PAID", "x")],
  ])(
    "a failed reissue (%s) drops the old QR and PIN and returns to Terbitkan tiket",
    (_name, error) => {
      state.seed = credential;
      state.issue = mutation({ error });
      const html = step();
      const text = visibleText(html);
      expect(text).not.toContain("482913");
      expect(html).not.toContain('data-slot="ticket-qr"');
      expect(html).not.toContain('data-slot="ticket-pin"');
      expect(
        buttonsOf(html).some((b) => /^terbitkan tiket$/i.test(b.label)),
      ).toBe(true);
      expect(buttonsOf(html).some((b) => /cetak tiket/i.test(b.label))).toBe(
        false,
      );
    },
  );

  test("a failed reissue shows the error and says the previous code may be dead", () => {
    state.seed = credential;
    state.issue = mutation({ error: new Error("Printer offline") });
    expect(visibleText(step())).toMatch(
      /tiket belum terbit.*kode sebelumnya mungkin sudah tidak berlaku\. terbitkan ulang\./i,
    );
  });

  test("a successful issue still shows the code (seeded state, no error)", () => {
    state.seed = credential;
    const html = step();
    expect(visibleText(html)).toContain("482913");
    expect(html).toContain('data-slot="ticket-pin"');
  });
});
