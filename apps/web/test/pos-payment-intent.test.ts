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
const OTHER_TERMINAL = "0a1b2c3d-0000-4000-8000-0000000000b9";
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
  resolvePayment,
  startPayment,
} from "@/features/ws04-pos-kasir/api";
import {
  isDefinitiveRefusal,
  readIntent,
  wasRefused,
} from "@/features/ws04-pos-kasir/payment-intent-store";
import { isSendingIntent } from "@/features/ws04-pos-kasir/payment-intent-browser";
import {
  edcApprovalKey,
  edcSlipRefProblem,
} from "@/features/ws04-pos-kasir/components/payment/payment-helpers";
import { trackSender } from "@/features/ws04-pos-kasir/sender-lock";

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
  version: 7,
  depositAppliedIdr: 0,
  discounts: [],
  edcAttempts: [],
  receipt: null,
  tenders: [],
  ...over,
});

/** The EDC ledger row of a slip keyed for this bill. */
const SLIP_ROW = {
  id: "0a1b2c3d-0000-4000-8000-0000000000e5",
  status: "approved",
  amountIdr: 100_000,
  terminalId: TERMINAL,
  terminalLabel: "BCA",
  bank: "bca",
  method: "card",
  mode: "standalone",
  declineReason: null,
  responseCode: null,
  createdAt: "2026-11-26T03:00:00.000Z",
};

const server = {
  order: orderOf(),
  qris: null as Record<string, unknown> | null,
  /** What the next money request does. */
  onTender: (): unknown => undefined,
  onComplete: (): unknown => undefined,
  onReceipt: (): unknown => undefined,
};

const lost = () => {
  throw new ApiError(0, "NETWORK_ERROR", "lost");
};
const refuse = (status: number, code: string) => () => {
  throw new ApiError(status, code, code);
};
const pay = (t: Tender, status = "sent") => {
  const edcAttempts = t.edcTransactionId ? [SLIP_ROW] : [];
  server.order = orderOf({ status, tenders: [t], edcAttempts });
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
    if (call.path.endsWith("/tenders")) return server.onTender();
    if (call.path.endsWith("/complete")) return server.onComplete();
    if (call.path.endsWith("/receipts")) return server.onReceipt();
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
      "expectedVersion",
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
    expect(isDefinitiveRefusal("cash", reused, false)).toBe(false);
    expect(isDefinitiveRefusal("cash", reused, true)).toBe(false);
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

/** A slip of this bank reference, captured on the bill. */
const slipTender = (over: Tender = {}) =>
  tender({
    method: "edc_card",
    reference: "736214805192",
    edcTransactionId: SLIP_ROW.id,
    ...over,
  });

const EDC_REFUSALS: [number, string][] = [
  [400, "VALIDATION_ERROR"],
  [401, "UNAUTHORIZED"],
  [403, "EDC_STANDALONE_APPROVAL_REQUIRED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [412, "PRECONDITION_FAILED"],
  [422, "VALIDATION_ERROR"],
  [423, "LOCKED"],
];

describe("re-review 1: a refused EDC slip does not mean the card was not charged", () => {
  const staysLocked = async (error: unknown, code: string) => {
    expect(error).toMatchObject({ code });
    expect(wasRefused(error)).toBe(false);
    expect(state()).toBe("pending");
    await expect(cash()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
    await expect(qris()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
  };

  it.each(EDC_REFUSALS)("first send, %i %s", async (status, code) => {
    server.onTender = refuse(status, code);
    await staysLocked(await edc().catch((caught: unknown) => caught), code);
  });

  it.each(EDC_REFUSALS)("repeat, %i %s", async (status, code) => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    server.onTender = refuse(status, code);
    await staysLocked(
      await replayPayment(OUTLET, ORDER, CASHIER).catch(
        (caught: unknown) => caught,
      ),
      code,
    );
  });

  it("other methods still open on a refusal", async () => {
    server.onTender = refuse(409, "CONFLICT");
    await expect(cash()).rejects.toThrow();
    expect(state()).toBe("none");
  });
});

describe("review 2: a gateway without an answer", () => {
  it("repeated gateway 503s keep the QRIS request", async () => {
    server.onTender = refuse(503, "PAYMENT_GATEWAY_UNAVAILABLE");
    for (let i = 0; i < 3; i += 1) {
      await expect(qris()).rejects.toThrow();
      expect(state()).toBe("pending");
    }
    const keys = new Set(money().map((c) => c.body?.idempotencyKey));
    expect(keys.size).toBe(1);
    await expect(cash()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
  });
});

describe("review 3: only the sender stays open while a request is sent", () => {
  it("is sending from the tap, before the bill is read, until the answer", async () => {
    let answer: () => void = () => undefined;
    const respond = net.respond;
    net.respond = (call) =>
      call.method === "GET"
        ? new Promise((resolve) => {
            answer = () => resolve(respond(call));
          })
        : respond(call);
    const sent = cash();
    expect(isSendingIntent(scope)).toBe(true);
    await vi.waitFor(() => expect(net.calls).toHaveLength(1));
    net.respond = respond;
    answer();
    await sent;
    expect(isSendingIntent(scope)).toBe(false);
  });

  it("a replay is sending too", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    server.onTender = () => {
      expect(isSendingIntent(scope)).toBe(true);
      return pay(tender({}));
    };
    await replayPayment(OUTLET, ORDER, CASHIER);
    expect(isSendingIntent(scope)).toBe(false);
  });

  const none = { status: "none", sender: null } as const;

  it("the panel on screen when the request starts is the sender", () => {
    expect(trackSender(none, "sending", "pay:cash").sender).toBe("pay:cash");
  });

  it("leaving it loses the sender, also after coming back to it", () => {
    let s = trackSender(none, "sending", "pay:qris");
    s = trackSender(s, "sending", "methods");
    expect(s.sender).toBeNull();
    s = trackSender(s, "sending", "pay:qris");
    expect(s.sender).toBeNull();
    s = trackSender(s, "none", "pay:qris");
    expect(trackSender(s, "sending", "pay:qris").sender).toBe("pay:qris");
  });

  it("a screen opened while sending has no sender, nor does a replay", () => {
    const opened = { status: "sending", sender: null } as const;
    expect(trackSender(opened, "sending", "pay:cash").sender).toBeNull();
    const locked = { status: "pending", sender: null } as const;
    expect(trackSender(locked, "sending", "pay:cash").sender).toBeNull();
  });
});

describe("review 4: every payment body states the version it was made for", () => {
  it.each([
    ["cash", () => cash()],
    ["QRIS", () => qris()],
    ["EDC", () => edc()],
  ])("%s", async (_name, run) => {
    server.onTender = refuse(409, "X");
    await expect(run()).rejects.toThrow();
    expect(money()[0]?.body?.expectedVersion).toBe(7);
  });

  it("points", async () => {
    await expect(
      redeemPointsValue(OUTLET, ORDER, CASHIER, 10, "k"),
    ).rejects.toThrow();
    const redeem = posts().find((c) => c.path.endsWith("/points/redeem"));
    expect(redeem?.body).toMatchObject({ points: 10, expectedVersion: 7 });
  });

  it("complete", async () => {
    server.order = orderOf({ status: "sent", tenders: [tender({})] });
    await completePaidOrder(OUTLET, ORDER, CASHIER);
    const sent = posts().find((c) => c.path.endsWith("/complete"));
    expect(sent?.body?.expectedVersion).toBe(7);
  });

  it("a repeat keeps the version of the first send", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    server.order = { ...server.order, version: 9 };
    server.onTender = refuse(412, "PRECONDITION_FAILED");
    await expect(cash()).rejects.toThrow();
    expect(money()[1]?.body?.expectedVersion).toBe(7);
    expect(state()).toBe("none");
  });
});

describe("a supervisor resolves the request", () => {
  const PIN = "582914";
  const NEW_OVERRIDE = "01JCQ8Z5N0M3X4Y5Z6A7B8C9G1";
  let outcome: string;
  let onResolve: () => unknown;
  const sent = (suffix: string) =>
    posts().filter((c) => c.path.endsWith(suffix));
  const resolve = (over: Record<string, unknown> = {}, actor = OTHER) =>
    resolvePayment(OUTLET, actor, {
      orderId: ORDER,
      reason: "Kasir awal pulang",
      approverUserId: CASHIER,
      pin: PIN,
      ...over,
    });
  const corrupt = () => {
    for (const key of store.keys()) store.set(key, "{broken");
  };

  beforeEach(() => {
    outcome = "closed";
    onResolve = () => ({ data: { outcome, order: server.order } });
    const respond = net.respond;
    net.respond = (call) => {
      if (call.path.endsWith("/payment-intents/resolve")) return onResolve();
      if (call.path.endsWith("/pos-overrides"))
        return { data: { id: NEW_OVERRIDE } };
      return respond(call);
    };
  });

  it("closed: the bill opens, also for another cashier", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    const key = money()[0]?.body?.idempotencyKey;
    await resolve();
    expect(sent("/resolve")[0]?.body).toEqual({
      key,
      reason: "Kasir awal pulang",
      approverUserId: CASHIER,
      pin: PIN,
    });
    expect(state()).toBe("none");
    expect(JSON.stringify([...store])).not.toContain(PIN);
  });

  it("recorded: loads the paid bill", async () => {
    server.onTender = () => {
      pay(tender({}));
      return lost();
    };
    await expect(cash()).rejects.toThrow();
    outcome = "recorded";
    const session = await resolve();
    expect(session.bill.paid).toBe(true);
    expect(state()).toBe("none");
    expect(money()).toHaveLength(1);
  });

  it.each([
    [0, "NETWORK_ERROR"],
    [401, "PIN_INVALID"],
    [403, "PERMISSION_DENIED"],
    [409, "QRIS_HOLD_ACTIVE"],
    [503, "HTTP_ERROR"],
  ])("stays locked when the server answers %i %s", async (status, code) => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    onResolve = refuse(status, code);
    await expect(resolve()).rejects.toMatchObject({ code });
    expect(state()).toBe("pending");
    corrupt();
    await expect(resolve()).rejects.toMatchObject({ code });
    expect(state()).toBe("corrupt");
  });

  it("unreadable: no key is sent, and the fenced bill opens", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    corrupt();
    outcome = "fenced";
    await resolve({ card: "not_debited" });
    expect(sent("/resolve")[0]?.body).toMatchObject({
      key: null,
      card: "not_debited",
    });
    expect(state()).toBe("none");
  });

  it("another request stored meanwhile is left alone", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    onResolve = () => {
      for (const [key, value] of store)
        store.set(key, value.replaceAll("cash:", "cash:other-"));
      return { data: { outcome, order: server.order } };
    };
    await resolve();
    expect(state()).toBe("pending");
  });

  it("a charged card is recorded again without the lock ever opening", async () => {
    server.onTender = lost;
    await expect(edc({ approvalCode: "A1B2" })).rejects.toThrow();
    const first = money()[0]?.body;
    const states: string[] = [];
    onResolve = () => {
      states.push(state());
      return { data: { outcome, order: { ...server.order, version: 8 } } };
    };
    server.onTender = () => {
      states.push(state());
      return pay(slipTender());
    };
    const session = await resolve({ card: "recording" });
    expect(session.bill.paid).toBe(true);
    expect(states).toEqual(["pending", "pending"]);
    expect(sent("/pos-overrides")[0]?.body).toMatchObject({
      action: "edc_standalone",
      valueIdr: 100_000,
    });
    const again = money()[1]?.body;
    expect(again).toMatchObject({
      method: "edc_card",
      expectedVersion: 8,
      standalone: {
        terminalId: TERMINAL,
        bankRef: "736214805192",
        approvalCode: "A1B2",
        overrideId: NEW_OVERRIDE,
      },
    });
    expect(again?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect(state()).toBe("none");
  });

  it("a lost answer of that record locks again under its own key", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    const first = readIntent(storage(), scope);
    await expect(resolve({ card: "recording" })).rejects.toThrow();
    const second = readIntent(storage(), scope);
    expect(second).toMatchObject({
      status: "pending",
      intent: { actorId: OTHER, kind: "edc_standalone" },
    });
    expect(second).not.toEqual(first);
  });

  it("records nothing again when the first send had been recorded", async () => {
    server.onTender = () => {
      pay(slipTender());
      return lost();
    };
    await expect(edc()).rejects.toThrow();
    const session = await resolve({ card: "recording" });
    expect(session.bill.paid).toBe(true);
    expect(money()).toHaveLength(1);
    expect(state()).toBe("none");
  });

  it("nor when it is recorded while the supervisor settles it", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    onResolve = () => {
      pay(slipTender());
      return { data: { outcome: "recorded", order: server.order } };
    };
    await resolve({ card: "recording" });
    expect(money()).toHaveLength(1);
    expect(state()).toBe("none");
  });

  it.each([
    ["not_debited", {}],
    ["voided", { voidRef: "000123" }],
  ])(
    "paid another way: the EDC note is closed only as %s",
    async (card, over) => {
      server.onTender = lost;
      await expect(edc()).rejects.toThrow();
      pay(tender({}));
      await expect(resolve({ card: "recording" })).rejects.toMatchObject({
        code: "EDC_SLIP_AMOUNT_MISMATCH",
      });
      expect(state()).toBe("pending");
      const session = await resolve({ card, ...over });
      expect(session.bill.paid).toBe(true);
      expect(state()).toBe("none");
      expect(money()).toHaveLength(1);
    },
  );

  it.each(EDC_REFUSALS)(
    "a refused record stays locked, %i %s, and can be recorded again",
    async (status, code) => {
      server.onTender = lost;
      await expect(edc()).rejects.toThrow();
      server.onTender = refuse(status, code);
      await expect(resolve({ card: "recording" })).rejects.toMatchObject({
        code,
      });
      expect(state()).toBe("pending");
      await expect(cash()).rejects.toMatchObject({
        code: "PAYMENT_UNRESOLVED",
      });
      server.onTender = () => pay(slipTender());
      const session = await resolve({ card: "recording" });
      expect(session.bill.paid).toBe(true);
      expect(state()).toBe("none");
      expect(new Set(money().map((c) => c.body?.idempotencyKey)).size).toBe(3);
    },
  );

  it("the slip's amount is kept beside the request, never in its body", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    expect(readIntent(storage(), scope)).toMatchObject({
      intent: { amountIdr: 100_000 },
    });
    expect(JSON.stringify(money())).not.toContain("amount");
  });

  it("another amount than the remaining bill is not recorded", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    server.order = orderOf({ totalIdr: 90_000, version: 8 });
    await expect(resolve({ card: "recording" })).rejects.toMatchObject({
      code: "EDC_SLIP_AMOUNT_MISMATCH",
    });
    expect(sent("/pos-overrides")).toHaveLength(0);
    expect(sent("/resolve")).toHaveLength(0);
    expect(state()).toBe("pending");
  });

  it("a note without the slip's amount is not recorded", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    for (const [key, value] of store)
      store.set(key, value.replace(/"amountIdr":\d+,?/, ""));
    await expect(resolve({ card: "recording" })).rejects.toThrow();
    expect(sent("/resolve")).toHaveLength(0);
    expect(state()).not.toBe("none");
  });

  it("voided on the machine: the void number is sent and the bill opens", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    await resolve({ card: "voided", voidRef: "000123" });
    expect(sent("/resolve")[0]?.body).toMatchObject({
      key: money()[0]?.body?.idempotencyKey,
      card: "voided",
      voidRef: "000123",
      // From the note: the server refuses it when the bill holds that slip.
      bankRef: "736214805192",
    });
    expect(state()).toBe("none");
    expect(money()).toHaveLength(1);
  });

  it("voided stays locked while the server does not take it", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    onResolve = refuse(409, "CONFLICT");
    await expect(
      resolve({ card: "voided", voidRef: "000123" }),
    ).rejects.toThrow();
    expect(state()).toBe("pending");
  });

  describe("an unreadable request whose card was charged", () => {
    const slip = {
      amountIdr: 100_000,
      edcMode: "card",
      terminalId: TERMINAL,
      bankRef: "736214805192",
      approvalCode: "A1B2",
    };
    const record = (over: Record<string, unknown> = {}) =>
      resolve({ card: "recording", slip: { ...slip, ...over } });

    beforeEach(async () => {
      server.onTender = lost;
      await expect(edc()).rejects.toThrow();
      net.calls.length = 0;
      corrupt();
      outcome = "fenced";
      server.onTender = () => pay(slipTender());
    });

    it("is recorded from the slip without the lock ever opening", async () => {
      const states: string[] = [];
      onResolve = () => {
        states.push(state());
        return { data: { outcome, order: { ...server.order, version: 8 } } };
      };
      server.onTender = () => {
        states.push(state());
        return pay(slipTender());
      };
      const session = await record();
      expect(session.bill.paid).toBe(true);
      expect(states).toEqual(["corrupt", "pending"]);
      expect(sent("/pos-overrides")[0]?.body).toMatchObject({
        action: "edc_standalone",
        valueIdr: 100_000,
      });
      const body = sent("/resolve")[0]?.body;
      expect(body).toMatchObject({
        key: null,
        card: "recording",
        bankRef: "736214805192",
      });
      expect(body).not.toHaveProperty("slip");
      expect(money()[0]?.body).toMatchObject({
        method: "edc_card",
        expectedVersion: 8,
        standalone: {
          terminalId: TERMINAL,
          bankRef: "736214805192",
          approvalCode: "A1B2",
          overrideId: NEW_OVERRIDE,
        },
      });
      expect(JSON.stringify(money())).not.toContain("amount");
      expect(state()).toBe("none");
    });

    it.each(EDC_REFUSALS)(
      "refused %i %s: an EDC note stays",
      async (status, code) => {
        server.onTender = refuse(status, code);
        await expect(record()).rejects.toMatchObject({ code });
        expect(readIntent(storage(), scope)).toMatchObject({
          status: "pending",
          intent: { kind: "edc_standalone", amountIdr: 100_000 },
        });
      },
    );

    it.each([
      ["another amount", { amountIdr: 90_000 }],
      ["a card number as reference", { bankRef: "4111111111111111" }],
      ["no reference", { bankRef: "" }],
    ])("%s is refused before any PIN is asked", async (_name, over) => {
      await expect(record(over)).rejects.toThrow();
      expect(posts()).toHaveLength(0);
      expect(state()).toBe("corrupt");
    });

    it("needs the slip", async () => {
      await expect(resolve({ card: "recording" })).rejects.toMatchObject({
        code: "PAYMENT_UNRESOLVED",
      });
      expect(posts()).toHaveLength(0);
      expect(state()).toBe("corrupt");
    });

    it("paid another way meanwhile: the charged card is not forgotten", async () => {
      onResolve = () => {
        pay(tender({}));
        return { data: { outcome: "recorded", order: server.order } };
      };
      await expect(record()).rejects.toMatchObject({
        code: "EDC_SLIP_NOT_RECORDED",
      });
      expect(money()).toHaveLength(0);
      expect(state()).toBe("corrupt");
    });

    describe("on a paid bill", () => {
      beforeEach(() => {
        outcome = "recorded";
        server.order = orderOf({
          status: "sent",
          tenders: [slipTender()],
          edcAttempts: [SLIP_ROW],
        });
      });

      it("the slip is on the bill: closed as recorded, with no approval to spend", async () => {
        const session = await record();
        expect(session.bill.paid).toBe(true);
        expect(sent("/pos-overrides")).toHaveLength(0);
        expect(sent("/resolve")[0]?.body).toMatchObject({
          key: null,
          card: "recording",
          bankRef: "736214805192",
        });
        expect(money()).toHaveLength(0);
        expect(state()).toBe("none");
      });

      it.each([
        ["reference", { bankRef: "736214805193" }],
        ["amount", { amountIdr: 90_000 }],
        ["terminal", { terminalId: OTHER_TERMINAL }],
      ])("another %s is not called recorded", async (_name, over) => {
        await expect(record(over)).rejects.toMatchObject({
          code: "EDC_SLIP_NOT_RECORDED",
        });
        expect(posts()).toHaveLength(0);
        expect(state()).toBe("corrupt");
      });

      it("voided sends the slip's reference, and a refusal keeps the warning", async () => {
        onResolve = refuse(409, "CONFLICT");
        await expect(
          resolve({
            card: "voided",
            voidRef: "000123",
            bankRef: "736214805192",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(sent("/resolve")[0]?.body).toMatchObject({
          key: null,
          card: "voided",
          voidRef: "000123",
          bankRef: "736214805192",
        });
        expect(state()).toBe("corrupt");
      });

      it("another slip, voided, closes it", async () => {
        await resolve({
          card: "voided",
          voidRef: "000123",
          bankRef: "736214805193",
        });
        expect(state()).toBe("none");
      });

      it("no message says to void a slip that does not match", async () => {
        const error: unknown = await record({ amountIdr: 90_000 }).catch(
          (caught: unknown) => caught,
        );
        expect((error as ApiError).message).toContain(
          "jangan void bila sudah tercatat",
        );
      });
    });

    it("paid by this very slip: the lock goes", async () => {
      onResolve = () => {
        pay(slipTender());
        return { data: { outcome: "recorded", order: server.order } };
      };
      await record();
      expect(money()).toHaveLength(0);
      expect(state()).toBe("none");
    });
  });
});

describe("two separate pages (own modules, one localStorage)", () => {
  const otherPage = async () => {
    vi.resetModules();
    const api = await import("@/features/ws04-pos-kasir/api");
    expect(api.confirmCash).not.toBe(confirmCash);
    return api;
  };

  it("the second page is locked while the first sends, and after it is lost", async () => {
    const page = await otherPage();
    let fail: () => void = () => undefined;
    server.onTender = () =>
      new Promise((_resolve, reject) => {
        fail = () => reject(new ApiError(0, "NETWORK_ERROR", "lost"));
      });
    const first = cash();
    await vi.waitFor(() => expect(money()).toHaveLength(1));
    const ask = { orderId: ORDER, method: "qris", amountIdr: 100_000 } as const;
    await expect(page.startPayment(OUTLET, CASHIER, ask)).rejects.toMatchObject(
      { code: "PAYMENT_UNRESOLVED" },
    );
    fail();
    await expect(first).rejects.toThrow();
    await expect(page.startPayment(OUTLET, CASHIER, ask)).rejects.toMatchObject(
      { code: "PAYMENT_UNRESOLVED" },
    );
    expect(money()).toHaveLength(1);
    server.onTender = () => pay(tender({}));
    await page.replayPayment(OUTLET, ORDER, CASHIER);
    expect(money()[1]?.body).toEqual(money()[0]?.body);
    expect(state()).toBe("none");
  });

  it("both pages tapping cash together send one key", async () => {
    const page = await otherPage();
    await Promise.allSettled([
      cash(),
      page.confirmCash(OUTLET, CASHIER, {
        orderId: ORDER,
        amountIdr: 100_000,
        receivedIdr: 150_000,
      }),
    ]);
    const keys = new Set(money().map((c) => c.body?.idempotencyKey));
    expect(keys.size).toBe(1);
  });
});

// legend-9yw78.15 review: the reference is read before the supervisor approval
// is asked, whose reason text names it and is stored with the audit trail.
describe("a reference that looks like a card number never reaches an approval", () => {
  it.each([
    "4111111111111111",
    "4111-1111-1111-1111",
    " 4111111111111111 ",
    "A4111111111111111",
    "12345",
  ])("refuses %j", (ref) => {
    expect(edcSlipRefProblem(ref)).toEqual(expect.any(String));
  });

  it.each(["736214805192", "7788-99AB1234", " 736214805192 "])(
    "accepts %j",
    (ref) => {
      expect(edcSlipRefProblem(ref)).toBeUndefined();
    },
  );
});

describe("review 6: one PIN approves one slip", () => {
  const input = {
    orderId: ORDER,
    terminalId: TERMINAL,
    amountIdr: 100_000,
    approverId: OTHER,
    bankRef: "736214805192",
  };

  it("another bank reference needs another PIN", () => {
    expect(edcApprovalKey({ ...input, bankRef: "736214805193" })).not.toBe(
      edcApprovalKey(input),
    );
    expect(edcApprovalKey({ ...input, bankRef: " 736214805192 " })).toBe(
      edcApprovalKey(input),
    );
  });
});

describe("review 6: the note goes once the server proves the bill paid", () => {
  it("a pending note", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    await fetchPaymentSession(OUTLET, ORDER);
    expect(state()).toBe("pending");
    pay(tender({}));
    await fetchPaymentSession(OUTLET, ORDER);
    expect(state()).toBe("none");
  });

  it("an unreadable note may be a charged card: it stays", async () => {
    server.onTender = lost;
    await expect(cash()).rejects.toThrow();
    for (const key of store.keys()) store.set(key, "{broken");
    pay(tender({}));
    expect((await fetchPaymentSession(OUTLET, ORDER)).bill.paid).toBe(true);
    expect(state()).toBe("corrupt");
  });

  it.each([
    ["cash", tender({})],
    ["another slip", slipTender({ reference: "736214805193" })],
    ["a slip not captured", slipTender({ status: "voided" })],
    ["QRIS with that reference", slipTender({ method: "qris" })],
    ["that reference, another amount", slipTender({ amountIdr: 60_000 })],
    ["a slip without its ledger row", slipTender({ edcTransactionId: null })],
  ])("an EDC note stays when the bill is paid by %s", async (_name, paidBy) => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    server.order = orderOf({
      status: "sent",
      tenders: [paidBy, tender({ id: `${TENDER}-2` })],
      edcAttempts: [SLIP_ROW],
    });
    expect((await fetchPaymentSession(OUTLET, ORDER)).bill.paid).toBe(true);
    expect(state()).toBe("pending");
  });

  it("an EDC note stays when that reference was keyed on another terminal", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    server.order = orderOf({
      status: "sent",
      tenders: [slipTender()],
      edcAttempts: [{ ...SLIP_ROW, terminalId: OTHER_TERMINAL }],
    });
    expect((await fetchPaymentSession(OUTLET, ORDER)).bill.paid).toBe(true);
    expect(state()).toBe("pending");
  });

  it("an EDC note goes when its own slip is captured", async () => {
    server.onTender = lost;
    await expect(edc()).rejects.toThrow();
    pay(slipTender());
    await fetchPaymentSession(OUTLET, ORDER);
    expect(state()).toBe("none");
  });

  it("authorized money is not proof", async () => {
    server.onTender = lost;
    await expect(qris()).rejects.toThrow();
    server.order = orderOf({
      tenders: [tender({ method: "qris", status: "authorized" })],
    });
    server.qris = hold();
    await fetchPaymentSession(OUTLET, ORDER);
    expect(state()).toBe("pending");
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

  // legend-9yw78.17: the card may be charged before any check of the bill, so a
  // refusal never comes before the note: the bill stays locked, others closed.
  const lockedAfter = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toMatchObject({ code });
    expect(money()).toHaveLength(0);
    expect(state()).toBe("pending");
    await expect(cash()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
    await expect(qris()).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
  };

  it("refuses an approval for another amount, the note and its amount kept", async () => {
    await lockedAfter(edc({ amountIdr: 90_000 }), "OVERRIDE_INVALID");
    const kept = readIntent(storage(), scope);
    expect(kept.status === "pending" && kept.intent.amountIdr).toBe(90_000);
  });

  it("refuses a bank reference that looks like a card number, never storing it", async () => {
    await lockedAfter(edc({ bankRef: "4111111111111111" }), "VALIDATION_ERROR");
    expect([...store.values()].join()).not.toContain("4111111111111111");
  });

  it("a bill that cannot be read still keeps the note", async () => {
    const read = net.respond;
    net.respond = (call) => {
      if (call.method === "GET" && call.path.endsWith(`/orders/${ORDER}`))
        throw new ApiError(503, "UNAVAILABLE", "down");
      return read(call);
    };
    await lockedAfter(edc(), "UNAVAILABLE");
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
