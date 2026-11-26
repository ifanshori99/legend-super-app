// O4 offline detection and the double guard (bead legend-wasr7.8, Keputusan
// CTO O4 no. 2).
//
// Assumptions (from the decision):
// - Offline = the browser says offline, OR two pings of the API in a row fail
//   (timeout, refused, or an HTTP 5xx: Keputusan CTO 27 Nov, review K P2 3,
//   a dead VPS behind the proxy answers 502). A 4xx answer is online.
// - Back online only after a ping succeeds, not on the browser's word alone.
// - A cart whose cloud order request is unclear is never sold offline; a new
//   cart is.
import {
  FAILURES_TO_OFFLINE,
  initialReachability,
  nextReachability,
  pingApi,
  type ReachEvent,
} from "@/features/ws04-pos-kasir/offline/connectivity";
import { offlineSaleBlock } from "@/features/ws04-pos-kasir/offline/sale-guard";
import type { CartLine, OrderSnapshot } from "@/features/ws04-pos-order/types";

const run = (events: ReachEvent[], online = true) =>
  events.reduce(nextReachability, initialReachability(online));

describe("offline detection", () => {
  test("two network failures in a row turn the tablet offline", () => {
    expect(FAILURES_TO_OFFLINE).toBe(2);
    expect(run(["ping_failed"]).online).toBe(true);
    expect(run(["ping_failed", "ping_failed"]).online).toBe(false);
  });

  test("a success between two failures resets the count", () => {
    expect(run(["ping_failed", "ping_ok", "ping_failed"]).online).toBe(true);
  });

  test("the browser going offline is offline at once", () => {
    expect(run(["browser_offline"]).online).toBe(false);
  });

  test("back online only after a ping succeeds", () => {
    const down = run(["ping_failed", "ping_failed"]);
    expect(nextReachability(down, "browser_online").online).toBe(false);
    expect(nextReachability(down, "ping_failed").online).toBe(false);
    expect(nextReachability(down, "ping_ok").online).toBe(true);
    const off = run(["browser_offline", "browser_online"]);
    expect(off.online).toBe(false);
    expect(nextReachability(off, "ping_ok").online).toBe(true);
  });

  test("a 2xx-4xx answer is a reachable API; a 5xx answer is a failure", async () => {
    for (const status of [200, 404])
      expect(await pingApi(async () => ({ status }), "https://api.test")).toBe(
        "ok",
      );
    for (const status of [500, 502, 503, 522])
      expect(await pingApi(async () => ({ status }), "https://api.test")).toBe(
        "failed",
      );
  });

  test("a proxy answering 502 twice turns the tablet offline; 200 brings it back", async () => {
    const ping = (status: number) =>
      pingApi(async () => ({ status }), "https://api.test").then((result) =>
        result === "ok" ? "ping_ok" : "ping_failed",
      );
    const events: ReachEvent[] = [await ping(502), await ping(502)];
    const down = run(events);
    expect(down.online).toBe(false);
    expect(nextReachability(down, await ping(200)).online).toBe(true);
  });

  test("a refused connection or a timeout is a network failure", async () => {
    expect(
      await pingApi(async () => {
        throw new TypeError("Failed to fetch");
      }, "https://api.test"),
    ).toBe("failed");
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    expect(await pingApi(hang, "https://api.test", 20)).toBe("failed");
  });

  test("the ping reads the health status cross-origin and sends no cookie", async () => {
    const seen: { url: string; credentials: string; mode: string }[] = [];
    await pingApi(async (url, init) => {
      seen.push({ url, credentials: init.credentials, mode: init.mode });
      return { status: 200 };
    }, "https://api.test");
    expect(seen).toEqual([
      {
        url: "https://api.test/api/health",
        credentials: "omit",
        mode: "cors",
      },
    ]);
  });
});

const line = (
  menuItemId: string,
  quantity: number,
  options: string[] = [],
): CartLine => ({
  lineId: `${menuItemId}-${quantity}`,
  menuItemId,
  variantId: null,
  variantName: null,
  name: menuItemId,
  unitPriceIdr: 10_000,
  quantity,
  modifiers: options.map((optionId) => ({
    groupId: "g",
    optionId,
    name: optionId,
    priceDeltaIdr: 0,
  })),
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

describe("offline sale guard", () => {
  const cart = [line("kopi", 2, ["shot"]), line("teh", 1)];

  test("the cart of an unclear order request is not sold offline", () => {
    expect(
      offlineSaleBlock({
        lines: cart,
        channel: "dine_in",
        pending: snapshot(cart),
        submitting: false,
        cloudOrderId: null,
        canAcceptPayment: true,
      }),
    ).toBe("uncertain_order");
  });

  test("same food on another channel or order is still the unclear cart", () => {
    expect(
      offlineSaleBlock({
        lines: [...cart].reverse().map((row) => ({ ...row, lineId: "x" })),
        channel: "takeaway",
        pending: snapshot(cart),
        submitting: false,
        cloudOrderId: null,
        canAcceptPayment: true,
      }),
    ).toBe("uncertain_order");
  });

  test("pending plus one more item is still the unclear cart", () => {
    expect(
      offlineSaleBlock({
        lines: [...cart, line("roti", 1)],
        channel: "dine_in",
        pending: snapshot(cart),
        submitting: false,
        cloudOrderId: null,
        canAcceptPayment: true,
      }),
    ).toBe("uncertain_order");
  });

  test("one line of the unclear order, other quantity, is still that cart", () => {
    expect(
      offlineSaleBlock({
        lines: [line("kopi", 1, ["shot"])],
        channel: "takeaway",
        pending: snapshot(cart),
        submitting: false,
        cloudOrderId: null,
        canAcceptPayment: true,
      }),
    ).toBe("uncertain_order");
  });

  test("a cashier who may not take payment does not sell offline", () => {
    expect(
      offlineSaleBlock({
        lines: [line("kopi", 1)],
        channel: "takeaway",
        pending: null,
        submitting: false,
        cloudOrderId: null,
        canAcceptPayment: false,
      }),
    ).toBe("noPermission");
  });

  test("a new cart sells offline even while an older request is unclear", () => {
    expect(
      offlineSaleBlock({
        lines: [line("kopi", 1)],
        channel: "takeaway",
        pending: snapshot(cart),
        submitting: false,
        cloudOrderId: null,
        canAcceptPayment: true,
      }),
    ).toBeNull();
  });

  test("a request in flight, a cloud order, ojol or an empty cart: no sale", () => {
    const base = {
      lines: cart,
      channel: "dine_in" as const,
      pending: null,
      submitting: false,
      cloudOrderId: null,
      canAcceptPayment: true,
    };
    expect(offlineSaleBlock({ ...base, submitting: true })).toBe("sending");
    expect(offlineSaleBlock({ ...base, cloudOrderId: "01J" })).toBe(
      "cloud_order",
    );
    expect(offlineSaleBlock({ ...base, channel: "ojol_manual" })).toBe(
      "channel",
    );
    expect(offlineSaleBlock({ ...base, lines: [] })).toBe("empty");
    expect(offlineSaleBlock(base)).toBeNull();
  });
});
