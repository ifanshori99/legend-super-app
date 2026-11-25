// 1268 W3: the shift count and close on the REAL endpoints. Only the network
// edge (`apiFetch`) is faked. The cashier counts blind, a supervisor enters a
// PIN on the cashier's device (override of `pos_shift_count`), then the close
// names that override. Nothing the cashier can read carries expected or
// variance; a lost answer closes once; a stale count asks for a recount.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

import { ApiError } from "@/lib/api/errors";

const OUTLET = "0a1b2c3d-0000-4000-8000-0000000000a1";
const SHIFT = "0a1b2c3d-0000-4000-8000-0000000000b1";
const COUNT = "0a1b2c3d-0000-4000-8000-0000000000c1";
const SUPERVISOR = "0a1b2c3d-0000-4000-8000-0000000000d1";
const OVERRIDE = "01JCQ8Z5N0M3X4Y5Z6A7B8C9F1";

type Call = {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

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
    request: {
      method?: string;
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    } = {},
  ) => {
    const call = {
      path,
      method: request.method ?? "GET",
      body: request.body,
      query: request.query,
    };
    net.calls.push(JSON.parse(JSON.stringify(call)) as Call);
    return net.respond(call);
  },
}));

import {
  closeShiftWithApproval,
  discardOwnCount,
  fetchActiveShift,
  fetchSupervisors,
  isCloseStale,
  isQrisHoldBlock,
  submitBlindCount,
} from "@/features/ws04-pos-kasir/shift-api";
import {
  fetchOwnCountSummary,
  forceCloseShift,
} from "@/features/ws04-pos-kasir/shift-extra-api";

const ZERO = [{ denominationIdr: 100_000, quantity: 0 }];

const approval = {
  shiftId: SHIFT,
  countId: COUNT,
  noteRequired: false,
  approverUserId: SUPERVISOR,
  pin: "123456",
  reason: "Laci cocok dengan hitungan",
};

const blindReceipt = {
  data: {
    id: COUNT,
    shiftId: SHIFT,
    sequence: 1,
    countedIdr: 250_000,
    noteRequired: false,
    submittedAt: "2026-11-26T10:00:00.000Z",
  },
};

const openShift = {
  id: SHIFT,
  status: "open",
  businessDate: "2026-11-26",
  openedAt: "2026-11-26T08:00:00.000Z",
  openingFloatIdr: "100000",
};

function server(options: { close?: () => unknown } = {}) {
  net.respond = (call) => {
    if (call.path.endsWith("/counts")) return blindReceipt;
    if (call.path === "/api/pos-overrides") return { data: { id: OVERRIDE } };
    if (call.path.endsWith("/close"))
      return options.close ? options.close() : { data: { id: SHIFT } };
    if (call.path.startsWith("/api/pos-overrides/approvers"))
      return { data: [{ userId: SUPERVISOR, displayName: "Supervisor Satu" }] };
    if (call.path.endsWith("/pos/shifts")) return { data: [openShift] };
    throw new Error(`no response for ${call.method} ${call.path}`);
  };
}

const closeCalls = () => net.calls.filter((c) => c.path.endsWith("/close"));
const overrideCalls = () =>
  net.calls.filter((c) => c.path === "/api/pos-overrides");

beforeEach(() => {
  vi.stubEnv("DEV", false);
  net.calls.length = 0;
  discardOwnCount(OUTLET, SHIFT);
  server();
});

describe("the blind count", () => {
  it("sends only counted denominations and stores the blind receipt", async () => {
    await submitBlindCount(
      OUTLET,
      {
        shiftId: SHIFT,
        counts: [
          { denominationIdr: 100_000, quantity: 2 },
          { denominationIdr: 50_000, quantity: 0 },
          { denominationIdr: 10_000, quantity: 5 },
        ],
        otherAmountIdr: 0,
      },
      "shift-count:one",
    );
    const body = net.calls[0]!.body!;
    expect(body.counts).toEqual([
      { denominationIdr: 100_000, quantity: 2 },
      { denominationIdr: 10_000, quantity: 5 },
    ]);
    expect(body.idempotencyKey).toBe("shift-count:one");
    const summary = await fetchOwnCountSummary(OUTLET, SHIFT);
    expect(summary).toMatchObject({
      countId: COUNT,
      sequence: 1,
      countedIdr: 250_000,
      noteRequired: false,
    });
    // Blind: nothing of the system figure reaches the cashier view.
    expect(Object.keys(summary!).join()).not.toMatch(/expected|variance/i);
  });

  it("sends an empty drawer as one zero row, and refuses a lump sum", async () => {
    await submitBlindCount(
      OUTLET,
      {
        shiftId: SHIFT,
        counts: [{ denominationIdr: 100_000, quantity: 0 }],
        otherAmountIdr: 0,
      },
      "shift-count:zero",
    );
    expect(net.calls[0]!.body!.counts).toEqual([
      { denominationIdr: 100_000, quantity: 0 },
    ]);
    net.calls.length = 0;
    await expect(
      submitBlindCount(
        OUTLET,
        { shiftId: SHIFT, counts: [], otherAmountIdr: 5_000 },
        "shift-count:lump",
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(net.calls).toHaveLength(0);
  });

  it("marks the shift as waiting once counted, and counts again after a recount", async () => {
    expect((await fetchActiveShift(OUTLET))?.countSubmitted).toBe(false);
    await submitBlindCount(
      OUTLET,
      { shiftId: SHIFT, counts: ZERO, otherAmountIdr: 0 },
      "shift-count:wait",
    );
    expect((await fetchActiveShift(OUTLET))?.countSubmitted).toBe(true);
    discardOwnCount(OUTLET, SHIFT);
    expect((await fetchActiveShift(OUTLET))?.countSubmitted).toBe(false);
    expect(await fetchOwnCountSummary(OUTLET, SHIFT)).toBeNull();
  });
});

describe("the supervisor close on the cashier's device", () => {
  beforeEach(async () => {
    await submitBlindCount(
      OUTLET,
      { shiftId: SHIFT, counts: ZERO, otherAmountIdr: 0 },
      "shift-count:close",
    );
    net.calls.length = 0;
  });

  it("asks only the supervisors the server lists for the close", async () => {
    expect(await fetchSupervisors(OUTLET, "cash_shift_close")).toEqual([
      { userId: SUPERVISOR, name: "Supervisor Satu" },
    ]);
    expect(net.calls[0]!.query).toEqual({
      outletId: OUTLET,
      action: "cash_shift_close",
    });
    await expect(fetchSupervisors(OUTLET)).rejects.toMatchObject({
      status: 501,
    });
  });

  it("approves the exact count with the PIN, then closes naming that approval", async () => {
    const approved: string[] = [];
    await closeShiftWithApproval(
      OUTLET,
      approval,
      null,
      "shift-close:k1",
      (id) => approved.push(id),
    );
    const override = overrideCalls()[0]!.body!;
    expect(override).toMatchObject({
      outletId: OUTLET,
      action: "cash_shift_close",
      objectType: "pos_shift_count",
      objectId: COUNT,
      approval: {
        method: "supervisor_pin",
        approverUserId: SUPERVISOR,
        pin: "123456",
      },
    });
    expect(closeCalls()).toHaveLength(1);
    expect(closeCalls()[0]!.body).toEqual({
      countId: COUNT,
      approvedBy: SUPERVISOR,
      approvalRequestId: OVERRIDE,
      idempotencyKey: "shift-close:k1",
    });
    expect(approved).toEqual([OVERRIDE]);
    // Closed: the count on this device is spent.
    expect(await fetchOwnCountSummary(OUTLET, SHIFT)).toBeNull();
  });

  it("sends the supervisor's note as the variance note only when one is due", async () => {
    await closeShiftWithApproval(
      OUTLET,
      { ...approval, noteRequired: true },
      null,
      "shift-close:k2",
      () => undefined,
    );
    expect(closeCalls()[0]!.body!.varianceNote).toBe(approval.reason);
  });

  it("a lost answer repeats the same close once: no second approval, same key", async () => {
    let lost = true;
    server({
      close: () => {
        if (lost) throw new ApiError(0, "NETWORK", "offline");
        return { data: { id: SHIFT } };
      },
    });
    let overrideId = "";
    await expect(
      closeShiftWithApproval(OUTLET, approval, null, "shift-close:k3", (id) => {
        overrideId = id;
      }),
    ).rejects.toThrow();
    lost = false;
    await closeShiftWithApproval(
      OUTLET,
      approval,
      { overrideId },
      "shift-close:k3",
      () => undefined,
    );
    expect(overrideCalls()).toHaveLength(1);
    expect(closeCalls()).toHaveLength(2);
    expect(closeCalls()[1]!.body).toEqual(closeCalls()[0]!.body);
    expect(await fetchOwnCountSummary(OUTLET, SHIFT)).toBeNull();
  });

  it.each(["SHIFT_COUNT_STALE", "SHIFT_COUNT_SUPERSEDED"])(
    "%s keeps the cashier on the count until a recount, with no second close",
    async (code) => {
      server({
        close: () => {
          throw new ApiError(409, code, "stale");
        },
      });
      const error = await closeShiftWithApproval(
        OUTLET,
        approval,
        null,
        "shift-close:k4",
        () => undefined,
      ).catch((e: unknown) => e);
      expect(isCloseStale(error)).toBe(true);
      expect(isQrisHoldBlock(error)).toBe(false);
      expect(closeCalls()).toHaveLength(1);
      discardOwnCount(OUTLET, SHIFT);
      expect(await fetchOwnCountSummary(OUTLET, SHIFT)).toBeNull();
    },
  );

  it("a QRIS still waiting blocks the close and keeps the count", async () => {
    server({
      close: () => {
        throw new ApiError(409, "QRIS_HOLD_ACTIVE", "hold");
      },
    });
    const error = await closeShiftWithApproval(
      OUTLET,
      approval,
      null,
      "shift-close:k5",
      () => undefined,
    ).catch((e: unknown) => e);
    expect(isQrisHoldBlock(error)).toBe(true);
    expect(await fetchOwnCountSummary(OUTLET, SHIFT)).not.toBeNull();
  });

  it("a wrong PIN stops before any close call", async () => {
    net.respond = (call) => {
      if (call.path === "/api/pos-overrides")
        throw new ApiError(403, "FORBIDDEN", "PIN salah");
      throw new Error(`unexpected ${call.path}`);
    };
    await expect(
      closeShiftWithApproval(
        OUTLET,
        approval,
        null,
        "shift-close:k6",
        () => undefined,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(closeCalls()).toHaveLength(0);
  });
});

describe("force close", () => {
  it("stays locked on the real wire (no contract yet)", async () => {
    await expect(
      forceCloseShift({ shiftId: SHIFT, note: "x".repeat(12) } as never),
    ).rejects.toMatchObject({ status: 501 });
  });
});
