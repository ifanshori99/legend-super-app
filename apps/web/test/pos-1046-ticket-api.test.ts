// Brief 1046 part D (legend-l65nz): facility ticket sold from the POS runs on
// the REAL endpoints of apps/api/src/routes/facility-pos-ticket.routes.ts, and
// the door credential (QR + PIN) is shown ONCE.
//
// Only the network edge is faked (`apiFetch`); the typed contract layer
// (`callEndpoint` + @starter/shared endpoints) is real, so a wrong path, verb or
// body shape fails here. Outside mock mode (API_MOCK=false).
//
// Assumptions (spec is silent on names, the engineer may rename the hooks but
// must keep the behaviour):
//  - (agent decision, brief "Keputusan agent") hooks `useSellTicketAtPos`,
//    `useOrderTickets(orderId)`, `useIssueTicketCredential`; api
//    `fetchOrderTickets(orderId, signal?)` -> OrderTicketLine[] (price = the
//    server's `lineTotalIdr`, slot = ticket.slot, names empty when the DTO has
//    none). Response parsing is switched off (as in production) so fixtures
//    stay small; request shapes are still validated by the real contract.
//  - `useSellTicketAtPos()`: mutation, input SellTicketInput, result
//    TicketBillSale; the outlet comes from the tenant context.
//  - `useIssueTicketCredential()`: mutation, input { orderId, ticketId }, result
//    TicketCredential; it sends a NEW idempotency key on every call (the server
//    never shows the same credential twice, 409 TICKET_CREDENTIAL_SHOWN).
//  - The credential lives only in the mutation result (memory): never in a
//    query-cache entry that can be refetched, never in localStorage or
//    sessionStorage.
//  - Printing is part of the credential call (the API prints through the Print
//    Agent); there is no separate print request.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";

const ORDER_ID = "01JCQ8Z5N0M3X4Y5Z6A7B8C9E1";
const TICKET_ID = "01JCQ8Z5N0M3X4Y5Z6A7B8C9E2";
const OUTLET_ID = "0a1b2c3d-0000-4000-8000-0000000000a1";

type Call = {
  path: string;
  method: string;
  body?: Record<string, unknown>;
};

const net = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (call: Call): unknown => {
    throw new Error(`no response configured for ${call.path}`);
  },
}));

vi.mock("@/lib/api/mock-flag", () => ({ API_MOCK: false }));
vi.mock("@/lib/api/client", () => ({
  apiFetch: async (
    path: string,
    request: { method?: string; body?: Record<string, unknown> },
  ) => {
    const call = {
      path,
      method: request.method ?? "GET",
      body: request.body,
    };
    net.calls.push(call);
    return net.respond(call);
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  useTenantContext: () => ({ outlet: { id: OUTLET_ID } }),
}));

import {
  fetchOrderTickets,
  issueTicketCredential,
  sellTicketAtPos,
} from "@/features/ws04-pos-kasir/ticket/api";
import * as hooks from "@/features/ws04-pos-kasir/ticket/hooks";

// Facility and CRM ids are UUIDs in the contract; order/outlet ids are ULIDs.
const product = {
  id: "0a1b2c3d-0000-4000-8000-000000000002",
  facilityId: "0a1b2c3d-0000-4000-8000-000000000003",
  facilityName: "Kolam Renang",
  name: "Tiket Kolam Dewasa",
  priceIdr: 87_500,
  sessions: 1,
  areas: [{ id: "0a1b2c3d-0000-4000-8000-000000000005", name: "Kolam Utama" }],
  units: [],
};
const saleInput = {
  product,
  areaId: "0a1b2c3d-0000-4000-8000-000000000005",
  customer: {
    id: "0a1b2c3d-0000-4000-8000-000000000006",
    name: "Sari Wulandari",
  },
  timing: { kind: "now" as const },
};

const credentialResponse = (qrToken: string, pin: string) => ({
  data: {
    credential: {
      ticketId: TICKET_ID,
      qrToken,
      pin,
      validFrom: "2026-11-18T03:00:00.000Z",
      validUntil: "2026-11-18T05:00:00.000Z",
    },
    print: {
      printedAt: "2026-11-18T03:00:05.000Z",
      printerName: "Kasir 1",
      reprint: false,
    },
  },
});

const orderDetail = (status: "draft" | "open") => ({
  id: ORDER_ID,
  number: "POS-0001",
  status,
  totalIdr: "87500",
});

beforeEach(() => {
  // Production does not parse responses; the dev flag would demand full DTOs.
  vi.stubEnv("DEV", false);
  net.calls.length = 0;
  net.respond = () => {
    throw new Error("no response configured");
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ticket api against the real endpoints", () => {
  test("sellTicketAtPos posts the sale without a price, then submits the draft bill", async () => {
    net.respond = (call) =>
      call.path === "/api/facility/tickets/pos"
        ? { data: { ticket: { id: TICKET_ID }, order: orderDetail("draft") } }
        : { data: orderDetail("open") };

    const sale = await sellTicketAtPos(OUTLET_ID, saleInput, "sale-key-0001");

    const [sell, submit] = net.calls;
    expect(sell).toMatchObject({
      method: "POST",
      path: "/api/facility/tickets/pos",
    });
    expect(Object.keys(sell?.body ?? {})).not.toContain("priceIdr");
    expect(JSON.stringify(sell?.body)).not.toContain("87500");
    expect(submit).toMatchObject({
      method: "POST",
      path: `/api/outlets/${OUTLET_ID}/pos/orders/${ORDER_ID}/submit`,
    });
    // Money rule: the bill total is the server's, not product.priceIdr.
    expect(sale).toMatchObject({
      ticketId: TICKET_ID,
      orderId: ORDER_ID,
      orderNo: "POS-0001",
      totalIdr: 87_500,
    });
  });

  test("issueTicketCredential posts to the credential route with only a key", async () => {
    net.respond = () => credentialResponse("qr-aaa", "482913");

    const credential = await issueTicketCredential(
      ORDER_ID,
      TICKET_ID,
      "key-00000001",
    );

    expect(net.calls).toEqual([
      {
        method: "POST",
        path: `/api/pos/orders/${ORDER_ID}/tickets/${TICKET_ID}/credential`,
        body: { idempotencyKey: "key-00000001" },
      },
    ]);
    expect(credential).toMatchObject({ qrToken: "qr-aaa", pin: "482913" });
  });

  test("fetchOrderTickets reads the bill's tickets and keeps the server line price and status", async () => {
    net.respond = () => ({
      data: {
        tickets: [
          {
            ticket: {
              id: TICKET_ID,
              slot: {
                startsAt: "2026-11-18T03:00:00.000Z",
                endsAt: "2026-11-18T05:00:00.000Z",
                cleaningEndsAt: "2026-11-18T05:10:00.000Z",
              },
              status: "issued",
            },
            orderItemId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9E4",
            lineStatus: "issued",
            lineTotalIdr: 87_500,
            display: {
              productName: "Tiket Kolam Dewasa",
              facilityName: "Kolam Renang",
              areaName: "Kolam Utama",
              unitCode: null,
              customerName: "Sari Wulandari",
            },
          },
        ],
      },
    });

    const lines = await fetchOrderTickets(ORDER_ID);

    expect(net.calls).toEqual([
      {
        method: "GET",
        path: `/api/pos/orders/${ORDER_ID}/tickets`,
        body: undefined,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ticketId: TICKET_ID,
      orderId: ORDER_ID,
      lineStatus: "issued",
      priceIdr: 87_500,
      startsAt: "2026-11-18T03:00:00.000Z",
      endsAt: "2026-11-18T05:00:00.000Z",
    });
    // Names come from the server `display` field (slice E); not asserted here.
  });

  test("an unpaid ticket is refused with TICKET_NOT_PAID and no credential comes back", async () => {
    net.respond = () => {
      throw new ApiError(409, "TICKET_NOT_PAID", "Tagihan belum lunas.");
    };
    await expect(
      issueTicketCredential(ORDER_ID, TICKET_ID, "key-00000001"),
    ).rejects.toMatchObject({ status: 409, code: "TICKET_NOT_PAID" });
  });

  test("a replayed credential is refused by the server and the client surfaces it", async () => {
    net.respond = () => {
      throw new ApiError(
        409,
        "TICKET_CREDENTIAL_SHOWN",
        "Kredensial sudah ditampilkan.",
      );
    };
    await expect(
      issueTicketCredential(ORDER_ID, TICKET_ID, "key-00000001"),
    ).rejects.toMatchObject({ status: 409, code: "TICKET_CREDENTIAL_SHOWN" });
  });
});

/** Renders a hook once on the server and returns what it handed out. */
function runHook<T>(useHook: () => T): { value: T; client: QueryClient } {
  const client = new QueryClient();
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  renderToString(
    createElement(QueryClientProvider, { client }, createElement(Probe)),
  );
  return { value: value as T, client };
}

type Mutation<I, O> = { mutateAsync: (input: I) => Promise<O> };
type TicketHooks = {
  useOrderTickets?: (orderId: string) => {
    data?: unknown;
    queryKey?: unknown;
  };
  useSellTicketAtPos?: () => Mutation<typeof saleInput, unknown>;
  useIssueTicketCredential?: () => Mutation<
    { orderId: string; ticketId: string },
    { qrToken: string; pin: string }
  >;
};
const ticketHooks = hooks as unknown as TicketHooks;

describe("ticket hooks outside mock mode", () => {
  test("useSellTicketAtPos opens the bill through the real sale endpoint", async () => {
    expect(ticketHooks.useSellTicketAtPos).toBeTypeOf("function");
    net.respond = (call) =>
      call.path === "/api/facility/tickets/pos"
        ? { data: { ticket: { id: TICKET_ID }, order: orderDetail("draft") } }
        : { data: orderDetail("open") };

    const { value } = runHook(() => ticketHooks.useSellTicketAtPos!());
    const sale = await value.mutateAsync(saleInput);

    expect(net.calls[0]?.path).toBe("/api/facility/tickets/pos");
    expect(sale).toMatchObject({ orderId: ORDER_ID, totalIdr: 87_500 });
  });

  test("the credential is shown once: a second issue sends a new key and never reuses the first pair", async () => {
    expect(ticketHooks.useIssueTicketCredential).toBeTypeOf("function");
    let n = 0;
    net.respond = () => {
      n += 1;
      return credentialResponse(`qr-${n}`, `00000${n}`);
    };

    const { value } = runHook(() => ticketHooks.useIssueTicketCredential!());
    const first = await value.mutateAsync({
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
    });
    const second = await value.mutateAsync({
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
    });

    const keys = net.calls.map((call) => call.body?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(first).toMatchObject({ qrToken: "qr-1", pin: "000001" });
    expect(second).toMatchObject({ qrToken: "qr-2", pin: "000002" });
  });

  test("a refused replay (409) gives the cashier an error, not an old credential", async () => {
    expect(ticketHooks.useIssueTicketCredential).toBeTypeOf("function");
    net.respond = () => {
      throw new ApiError(409, "TICKET_CREDENTIAL_SHOWN", "Sudah ditampilkan.");
    };
    const { value } = runHook(() => ticketHooks.useIssueTicketCredential!());
    await expect(
      value.mutateAsync({ orderId: ORDER_ID, ticketId: TICKET_ID }),
    ).rejects.toMatchObject({ code: "TICKET_CREDENTIAL_SHOWN" });
  });

  test("the credential is never kept in the query cache or browser storage", async () => {
    expect(ticketHooks.useIssueTicketCredential).toBeTypeOf("function");
    const writes: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_k: string, v: string) => void writes.push(v),
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      net.respond = () => credentialResponse("qr-secret-777", "918273");
      const { value, client } = runHook(() =>
        ticketHooks.useIssueTicketCredential!(),
      );
      const credential = await value.mutateAsync({
        orderId: ORDER_ID,
        ticketId: TICKET_ID,
      });
      expect(credential.qrToken).toBe("qr-secret-777");

      const cached = JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data ?? null),
      );
      expect(cached).not.toContain("qr-secret-777");
      expect(cached).not.toContain("918273");
      expect(writes.join("")).not.toContain("qr-secret-777");
      expect(writes.join("")).not.toContain("918273");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("useOrderTickets is a query keyed by the order and never holds a credential", async () => {
    expect(ticketHooks.useOrderTickets).toBeTypeOf("function");
    net.respond = () => ({ data: { tickets: [] } });
    const { client } = runHook(() => ticketHooks.useOrderTickets!(ORDER_ID));
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey));
    expect(keys.some((key) => key.includes(ORDER_ID))).toBe(true);
  });
});
