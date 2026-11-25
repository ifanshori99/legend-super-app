// 1268 W2: the cashier payment calls on the REAL endpoints. Only the network
// edge (`apiFetch`) and localStorage are faked; the typed contract layer, the
// payment intent store and the api functions are real. Bugs 1-4 of
// docs/briefs/1268-pos-wire.md: a lost answer repeats the same key and body, an
// unknown result locks every method, a paid order is never forced complete, and
// no QRIS is made without a tap.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

import { ApiError } from "@/lib/api/errors";

const ORDER = "01JCQ8Z5N0M3X4Y5Z6A7B8C9E1";
const OUTLET = "0a1b2c3d-0000-4000-8000-0000000000a1";
const CASHIER = "0a1b2c3d-0000-4000-8000-0000000000c1";
const OTHER = "0a1b2c3d-0000-4000-8000-0000000000c2";
const TERMINAL = "0a1b2c3d-0000-4000-8000-0000000000d1";
const TENDER = "0a1b2c3d-0000-4000-8000-0000000000e1";
const OVERRIDE = "01JCQ8Z5N0M3X4Y5Z6A7B8C9F1";

type Call = { path: string; method: string; body?: Record<string, unknown> };

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
    request: { method?: string; body?: Record<string, unknown> } = {},
  ) => {
    const call = { path, method: request.method ?? "GET", body: request.body };
    // A deep copy: what went over the wire cannot change afterwards.
    net.calls.push(JSON.parse(JSON.stringify(call)) as Call);
    return net.respond(call);
  },
}));

import {
  applyVoucherCode,
  cancelAttempt,
  completePaidOrder,
  confirmCash,
  fetchEdcTerminals,
  fetchPaymentMethods,
  fetchPaymentSession,
  printReceipt,
  recordEdcStandalone,
  redeemPointsValue,
  replayPayment,
  startPayment,
} from "@/features/ws04-pos-kasir/api";
import {
  isDefinitiveRefusal,
  readIntent,
} from "@/features/ws04-pos-kasir/payment-intent-store";

type Tender = Record<string, unknown>;
type Order = Record<string, unknown> & { tenders: Tender[] };

const tender = (over: Tender): Tender => ({
  id: TENDER,
  method: "cash",
  amountIdr: 100_000,
  receivedIdr: 150_000,
  changeIdr: 50_000,
  reference: null,
  edcTransactionId: null,
  status: "captured",
  requestedAt: "2026-11-26T03:00:00.000Z",
  resolvedAt: "2026-11-26T03:00:00.000Z",
  ...over,
});

const orderOf = (over: Record<string, unknown> = {}): Order => ({
  id: ORDER,
  number: "LG-0048",
  status: "awaiting_payment",
  items: [{ status: "fired", fireStatus: "fired", quantity: 1 }],
  subtotalIdr: 100_000,
  serviceChargeIdr: 0,
  taxIdr: 0,
  totalIdr: 100_000,
  depositAppliedIdr: 0,
  discounts: [],
  edcAttempts: [],
  receipt: null,
  tenders: [],
  ...over,
});

const server = {
  order: orderOf(),
  qris: null as Record<string, unknown> | null,
  /** What the next money request does. */
  onTender: (_call: Call): unknown => undefined,
  onComplete: (_call: Call): unknown => undefined,
  onReceipt: (_call: Call): unknown => undefined,
};

const lost = () => {
  throw new ApiError(0, "NETWORK_ERROR", "lost");
};
const refuse = (status: number, code: string) => () => {
  throw new ApiError(status, code, code);
};
const pay = (t: Tender, status = "sent") => {
  server.order = orderOf({ status, tenders: [t] });
  return { data: { order: server.order, tender: t, remainingIdr: 0 } };
};

let store: Map<string, string>;
const storage = () => ({
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
const scope = { outletId: OUTLET, orderId: ORDER, slot: "payment" as const };
const state = () => readIntent(storage(), scope).status;

const money = () =>
  net.calls.filter((c) => c.method === "POST" && c.path.endsWith("/tenders"));
const posts = () => net.calls.filter((c) => c.method === "POST");

const cash = (receivedIdr = 150_000, actor = CASHIER) =>
  confirmCash(OUTLET, actor, {
    orderId: ORDER,
    amountIdr: 100_000,
    receivedIdr,
  });
const qris = (actor = CASHIER) =>
  startPayment(OUTLET, actor, {
    orderId: ORDER,
    method: "qris",
    amountIdr: 100_000,
  });
const edc = (over: Record<string, unknown> = {}) =>
  recordEdcStandalone(OUTLET, CASHIER, {
    orderId: ORDER,
    terminalId: TERMINAL,
    amountIdr: 100_000,
    edcMode: "card",
    bankRef: "736214805192",
    overrideId: OVERRIDE,
    ...over,
  });

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", storage());
  // Response parsing off, as in production: the fixtures stay small.
  vi.stubEnv("DEV", false);
  net.calls.length = 0;
  server.order = orderOf();
  server.qris = null;
  server.onTender = () => pay(tender({}));
  server.onComplete = () => {
    server.order = { ...server.order, status: "completed" };
    return { data: server.order };
  };
  server.onReceipt = () => {
    throw new Error("no receipt");
  };
  net.respond = (call) => {
    if (call.path.endsWith("/tenders")) return server.onTender(call);
    if (call.path.endsWith("/complete")) return server.onComplete(call);
    if (call.path.endsWith("/receipts")) return server.onReceipt(call);
    if (call.path.endsWith("/qris/cancel")) {
      server.qris = { ...server.qris, state: "cancelling" };
      return { data: server.qris };
    }
    if (call.path.endsWith("/qris")) {
      if (!server.qris) throw new ApiError(404, "NOT_FOUND", "no hold");
      return { data: server.qris };
    }
    if (call.path.endsWith(`/orders/${ORDER}`)) return { data: server.order };
    throw new Error(`no response for ${call.path}`);
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const hold = (over: Record<string, unknown> = {}) => ({
  id: "hold-1",
  orderId: ORDER,
  tenderId: TENDER,
  state: "open",
  amountIdr: 100_000,
  expiresAt: "2026-11-26T03:05:00.000Z",
  cancelRequestedAt: null,
  lastCheckedAt: null,
  closeReason: null,
  qrPayload: "00020101021226670016COM.TEST",
  ...over,
});

describe("bug 1: a lost cash answer repeats the same request", () => {
  it("sends no price and stores the request before it is sent", async () => {
    let storedAtSend: string | undefined;
    server.onTender = () => {
      storedAtSend = state();
      return pay(tender({}));
    };
    const session = await cash();
    expect(storedAtSend).toBe("pending");
    expect(state()).toBe("none");
    expect(session.bill.paid).toBe(true);
    const body = money()[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual([
      "expectedStatus",
      "idempotencyKey",
      "method",
      "receivedIdr",
    ]);
  });

  it("replays key and body although the bill reads paid and the status moved", async () => {
    server.onTender = () => {
      pay(tender({}));
      return lost();
    };
    await expect(cash()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(state()).toBe("pending");
    // A refresh: only localStorage survives.
    server.onTender = () => ({
      data: { order: server.order, tender: tender({}), remainingIdr: 0 },
    });
    const session = await cash();
    expect(session.bill.paid).toBe(true);
    expect(money()).toHaveLength(2);
    expect(money()[1]?.body).toEqual(money()[0]?.body);
    expect(money()[1]?.body?.expectedStatus).toBe("awaiting_payment");
    expect(state()).toBe("none");
  });

  it.each([
    [500, "INTERNAL"],
    [503, "HTTP_ERROR"],
    [408, "TIMEOUT"],
  ])("keeps the request after a %i", async (status, code) => {
    server.onTender = refuse(status, code);
    await expect(cash()).rejects.toThrow();
    expect(state()).toBe("pending");
  });

  it.each([401, 403, 404, 429, 500, 0])(
    "keeps an unknown request when its repeat gets %i",
    async (status) => {
      server.onTender = lost;
      await expect(cash()).rejects.toThrow();
      server.onTender = refuse(status, "X");
      await expect(cash()).rejects.toThrow();
      expect(state()).toBe("pending");
    },
  );

  it("forgets the request on a definitive refusal, and then sends a new key", async () => {
    server.onTender = refuse(409, "SHIFT_NOT_OPEN");
    await expect(cash()).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    expect(state()).toBe("none");
    server.onTender = () => pay(tender({}));
    await cash();
    expect(money()[1]?.body?.idempotencyKey).not.toBe(
      money()[0]?.body?.idempotencyKey,
    );
  });

  it("never calls a reused key a refusal", () => {
    const reused = new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "x");
    expect(isDefinitiveRefusal(reused, false)).toBe(false);
    expect(isDefinitiveRefusal(reused, true)).toBe(false);
  });

  it("sends nothing when the request cannot be stored", async () => {
    vi.stubGlobal("localStorage", {
      ...storage(),
      setItem: () => {
        throw new Error("full");
      },
    });
    await expect(cash()).rejects.toMatchObject({
      code: "INTENT_STORAGE_UNAVAILABLE",
    });
    expect(money()).toHaveLength(0);
  });

  it("refuses a partial amount before anything is stored", async () => {
    await expect(
      confirmCash(OUTLET, CASHIER, {
        orderId: ORDER,
        amountIdr: 50_000,
        receivedIdr: 50_000,
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_PENDING" });
    expect(money()).toHaveLength(0);
    expect(state()).toBe("none");
  });
});

describe("bug 3: an unknown result locks every method of the bill", () => {
  beforeEach(async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    net.calls.length = 0;
    server.onTender = () => pay(tender({}));
  });

  it.each([
    ["QRIS", () => qris()],
    ["another cash amount", () => cash(200_000)],
    ["EDC", () => edc()],
    ["points", () => redeemPointsValue(OUTLET, ORDER, CASHIER, 10, "k")],
    ["a voucher", () => applyVoucherCode(OUTLET, ORDER, "X", "key-12345")],
  ])("blocks %s", async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
    expect(posts()).toHaveLength(0);
    expect(state()).toBe("pending");
  });

  it("blocks another cashier, whose repeat the server would refuse", async () => {
    await expect(cash(150_000, OTHER)).rejects.toMatchObject({
      code: "PAYMENT_UNRESOLVED",
    });
    await expect(replayPayment(OUTLET, ORDER, OTHER)).rejects.toMatchObject({
      code: "PAYMENT_UNRESOLVED",
    });
    expect(posts()).toHaveLength(0);
  });

  it("stays locked when what is stored cannot be read", async () => {
    for (const key of store.keys()) store.set(key, "{broken");
    await expect(cash()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
    await expect(replayPayment(OUTLET, ORDER, CASHIER)).rejects.toMatchObject({
      code: "PAYMENT_UNRESOLVED",
    });
    expect(posts()).toHaveLength(0);
  });

  it("replays the stored request from the unresolved panel", async () => {
    const session = await replayPayment(OUTLET, ORDER, CASHIER);
    expect(session.bill.paid).toBe(true);
    expect(money()).toHaveLength(1);
    expect(state()).toBe("none");
  });

  it("leaves other bills open", async () => {
    const other = { ...scope, orderId: "01JCQ8Z5N0M3X4Y5Z6A7B8C9E9" };
    expect(readIntent(storage(), other).status).toBe("none");
  });
});

describe("two tabs", () => {
  it("send one key for the same tap in both tabs", async () => {
    await Promise.allSettled([cash(), cash()]);
    const keys = new Set(money().map((c) => c.body?.idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it("a tab that asks for QRIS while the other sends cash is refused", async () => {
    let answer: () => void = () => undefined;
    server.onTender = () =>
      new Promise((resolve) => {
        answer = () => resolve(pay(tender({})));
      });
    const first = cash();
    await vi.waitFor(() => expect(money()).toHaveLength(1));
    await expect(qris()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
    answer();
    await first;
    expect(money()).toHaveLength(1);
  });
});

describe("bug 2: complete is separate from the payment", () => {
  it("cash never completes the order by itself", async () => {
    await cash();
    expect(posts().some((c) => c.path.endsWith("/complete"))).toBe(false);
  });

  it("a paid order with a held item is paid, not completed", async () => {
    server.order = orderOf({
      status: "sent",
      tenders: [tender({})],
      items: [{ status: "pending", fireStatus: "held", quantity: 1 }],
    });
    const session = await completePaidOrder(OUTLET, ORDER, CASHIER);
    expect(session.bill.paid).toBe(true);
    expect(session.completion).toBe("held");
    await expect(printReceipt(OUTLET, ORDER, CASHIER)).rejects.toMatchObject({
      code: "ORDER_COMPLETE_FAILED",
    });
    expect(posts()).toHaveLength(0);
  });

  it("ignores a voided held item and never completes an unsent order", async () => {
    const voided = [{ status: "voided", fireStatus: "held", quantity: 1 }];
    server.order = orderOf({
      status: "sent",
      tenders: [tender({})],
      items: voided,
    });
    expect((await fetchPaymentSession(OUTLET, ORDER)).completion).toBe("ready");
    server.order = { ...server.order, status: "awaiting_payment" };
    await completePaidOrder(OUTLET, ORDER, CASHIER);
    expect(posts()).toHaveLength(0);
  });

  it("repeats the same complete request after a lost answer", async () => {
    server.order = orderOf({ status: "sent", tenders: [tender({})] });
    server.onComplete = lost;
    await expect(completePaidOrder(OUTLET, ORDER, CASHIER)).rejects.toThrow();
    server.onComplete = () => {
      server.order = { ...server.order, status: "completed" };
      return { data: server.order };
    };
    const session = await completePaidOrder(OUTLET, ORDER, CASHIER);
    expect(session.completion).toBe("done");
    expect(posts()[1]?.body).toEqual(posts()[0]?.body);
    expect(state()).toBe("none");
  });
});

describe("bug 4: QRIS", () => {
  it("is made by the call only; reading the bill makes none", async () => {
    await fetchPaymentSession(OUTLET, ORDER);
    expect(posts()).toHaveLength(0);
  });

  it("authorized is never paid and waits for the provider", async () => {
    server.onTender = () => {
      server.qris = hold();
      return pay(tender({ method: "qris", status: "authorized" }));
    };
    const session = await qris();
    expect(session.bill.paid).toBe(false);
    expect(session.bill.remainingIdr).toBe(100_000);
    expect(session.activeAttempt).toMatchObject({
      method: "qris",
      status: "waiting",
      qrShown: true,
    });
  });

  it("stays locked when the hold cannot be read after the start", async () => {
    server.onTender = () =>
      pay(tender({ method: "qris", status: "authorized" }));
    const respond = net.respond;
    net.respond = (call) =>
      call.path.endsWith("/qris") ? lost() : respond(call);
    const session = await qris();
    expect(session.activeAttempt).toMatchObject({
      status: "waiting",
      qrShown: false,
    });
  });

  it("an unpaid bill whose hold cannot be read is an error, not a free bill", async () => {
    const respond = net.respond;
    net.respond = (call) =>
      call.path.endsWith("/qris") ? lost() : respond(call);
    await expect(fetchPaymentSession(OUTLET, ORDER)).rejects.toThrow();
  });

  it("past its expiry it still waits for proof", async () => {
    server.qris = hold({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const session = await fetchPaymentSession(OUTLET, ORDER);
    expect(session.activeAttempt?.status).toBe("waiting");
  });

  it("cancel hides the QR and stays locked until the provider answers", async () => {
    server.order = orderOf({
      tenders: [tender({ method: "qris", status: "authorized" })],
    });
    server.qris = hold();
    const session = await cancelAttempt(OUTLET, {
      orderId: ORDER,
      attemptId: TENDER,
      method: "qris",
    });
    expect(session.activeAttempt?.status).toBe("cancelling");
    expect(session.bill.paid).toBe(false);
    server.order = orderOf({
      tenders: [tender({ method: "qris", status: "voided" })],
    });
    server.qris = hold({ state: "closed", closeReason: "provider_cancelled" });
    expect((await fetchPaymentSession(OUTLET, ORDER)).activeAttempt).toBeNull();
  });

  it("a guest split-bill QR is not the cashier's to cancel", async () => {
    server.qris = hold({ tenderId: null });
    const session = await fetchPaymentSession(OUTLET, ORDER);
    expect(session.activeAttempt).toMatchObject({
      status: "waiting",
      cancellable: false,
    });
  });

  it("is expired only on the provider's word", async () => {
    server.order = orderOf({
      tenders: [tender({ method: "qris", status: "failed" })],
    });
    server.qris = hold({ state: "closed", closeReason: "provider_expired" });
    const session = await fetchPaymentSession(OUTLET, ORDER);
    expect(session.activeAttempt?.status).toBe("expired");
  });

  it("cash against a live hold is a definitive 409 and keeps nothing", async () => {
    server.onTender = refuse(409, "QRIS_HOLD_ACTIVE");
    await expect(cash()).rejects.toMatchObject({ code: "QRIS_HOLD_ACTIVE" });
    expect(state()).toBe("none");
  });
});

describe("EDC standalone", () => {
  it("records the approved slip and keeps the request until it is answered", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    server.onTender = () => pay(tender({ method: "edc_card" }));
    await edc();
    expect(money()[1]?.body).toEqual(money()[0]?.body);
    expect(money()[0]?.body).toMatchObject({
      method: "edc_card",
      standalone: {
        terminalId: TERMINAL,
        bankRef: "736214805192",
        overrideId: OVERRIDE,
      },
    });
    expect(JSON.stringify(money())).not.toContain("amount");
  });

  it("refuses an approval for another amount", async () => {
    await expect(edc({ amountIdr: 90_000 })).rejects.toMatchObject({
      code: "OVERRIDE_INVALID",
    });
    expect(money()).toHaveLength(0);
  });

  it("refuses a bank reference that looks like a card number, storing nothing", async () => {
    await expect(edc({ bankRef: "4111111111111111" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(money()).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it.each(["pending", "unknown", "approved"])(
    "a %s request on the machine locks the bill",
    async (status) => {
      server.order = orderOf({
        edcAttempts: [
          {
            id: "0a1b2c3d-0000-4000-8000-0000000000f1",
            status,
            amountIdr: 100_000,
            terminalId: TERMINAL,
            terminalLabel: "BCA",
            bank: "bca",
            method: "card",
            mode: "ecr",
            declineReason: null,
            responseCode: null,
            createdAt: "2026-11-26T03:00:00.000Z",
          },
        ],
      });
      const session = await fetchPaymentSession(OUTLET, ORDER);
      expect(session.bill.paid).toBe(false);
      expect(session.activeAttempt?.status).toBe(
        status === "pending" ? "waiting" : "unknown",
      );
    },
  );
});

describe("payment options", () => {
  const row = (method: string, reason: string | null = null) => ({
    method,
    enabled: reason === null,
    unavailableReason: reason,
  });
  const options = (methods: unknown[]) => {
    net.respond = () => ({
      data: {
        outletId: OUTLET,
        methods,
        edc: {
          ecrEnabled: true,
          terminals: [
            {
              id: TERMINAL,
              bankCode: "bca",
              model: "A920",
              terminalIdLast4: "4821",
              supportedMethods: ["card"],
            },
          ],
        },
      },
    });
  };

  it("locks unsupported methods, even if the server would allow one", async () => {
    options([
      row("cash"),
      row("qris", "gateway_down"),
      row("va"),
      row("ewallet", "not_supported"),
      row("card", "not_supported"),
      row("edc_card"),
      row("edc_qris", "no_terminal"),
    ]);
    const methods = await fetchPaymentMethods(OUTLET);
    expect(Object.fromEntries(methods.map((m) => [m.code, m.enabled]))).toEqual(
      {
        qris: false,
        va: false,
        ewallet: false,
        card: false,
        cash: true,
        edc: true,
      },
    );
    expect(methods.find((m) => m.code === "qris")?.unavailableReason).toBe(
      "gateway_down",
    );
    expect(methods.find((m) => m.code === "va")?.unavailableReason).toBe(
      "not_supported",
    );
  });

  it("never offers to send an amount to a machine", async () => {
    options([]);
    const [terminal] = await fetchEdcTerminals(OUTLET);
    expect(terminal).toMatchObject({ integrated: false, modes: ["card"] });
    await expect(
      startPayment(OUTLET, CASHIER, {
        orderId: ORDER,
        method: "edc",
        amountIdr: 100_000,
        terminalId: TERMINAL,
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_PENDING" });
  });
});

describe("receipt (legend-9yw78.6)", () => {
  const issue = (printResult: string, reprintCount = 0) => ({
    data: {
      receipt: {
        id: TENDER,
        number: "R-1",
        issuedAt: "2026-11-26T03:00:00.000Z",
        reprintCount,
      },
      printResult,
    },
  });
  beforeEach(() => {
    server.order = orderOf({ status: "completed", tenders: [tender({})] });
  });

  it.each(["queued_to_printer", "not_printed"])(
    "passes %s through as the server said",
    async (printResult) => {
      server.onReceipt = () => issue(printResult);
      expect(await printReceipt(OUTLET, ORDER, CASHIER)).toMatchObject({
        printResult,
        receiptNo: "R-1",
        receiptId: TENDER,
      });
    },
  );

  it("a lost answer repeats the key; an answered one prints again", async () => {
    server.onReceipt = lost;
    await expect(printReceipt(OUTLET, ORDER, CASHIER)).rejects.toThrow();
    server.onReceipt = () => issue("not_printed");
    await printReceipt(OUTLET, ORDER, CASHIER);
    await printReceipt(OUTLET, ORDER, CASHIER);
    const keys = posts().map((c) => c.body?.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("does not lock payments and another cashier may print", async () => {
    server.onReceipt = lost;
    await expect(printReceipt(OUTLET, ORDER, CASHIER)).rejects.toThrow();
    expect(state()).toBe("none");
    server.onReceipt = () => issue("queued_to_printer");
    await printReceipt(OUTLET, ORDER, OTHER);
    const keys = posts().map((c) => c.body?.idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
