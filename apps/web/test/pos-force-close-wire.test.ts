// O4 (legend-wasr7.8, Keputusan CTO O4): the supervisor force close on the
// REAL endpoints (O3 API), so a cafe whose tablet holds an offline queue is
// never locked out. Only the network edge (`apiFetch`) is faked.
//
// Assumptions (from the API contract, pos-shift.service.ts forceClosePosShift):
// - The supervisor (not the cashier) counts the drawer: a normal `POST
//   .../counts` from their session, stored as a forced count.
// - A third person (neither the counter nor the cashier, holding
//   `shift.cash.approve_close`) approves THAT count by PIN: override
//   `cash_shift_close` on object `pos_shift_count`, value |variance|.
// - The close sends the count, the written reason (>= 10 letters), the
//   approver and the override, once per intent (idempotency key).
// - A refused stale count asks for a recount; nothing is closed by the client.
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

const OUTLET = "0a1b2c3d-0000-4000-8000-0000000000a1";
const SHIFT = "0a1b2c3d-0000-4000-8000-0000000000b1";
const COUNT = "0a1b2c3d-0000-4000-8000-0000000000c1";
const CASHIER_COUNT = "0a1b2c3d-0000-4000-8000-0000000000c0";
const CASHIER = "0a1b2c3d-0000-4000-8000-0000000000e1";
const SUPERVISOR = "0a1b2c3d-0000-4000-8000-0000000000d1";
const WITNESS = "0a1b2c3d-0000-4000-8000-0000000000d2";
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
    net.calls.push(JSON.parse(JSON.stringify(call)) as Call);
    return net.respond(call);
  },
}));

import { ApiError } from "@/lib/api/errors";
import {
  discardForceCloseApproval,
  fetchForceCloseView,
  fetchWitnesses,
  forceCloseNoteValid,
  forceCloseShift,
  submitForcedCount,
  witnessForcedCount,
} from "@/features/ws04-pos-kasir/shift-extra-api";

const viewer = { userId: SUPERVISOR, name: "Supervisor Satu" };

function countRow(id: string, sequence: number, submittedBy: string) {
  return {
    id,
    shiftId: SHIFT,
    sequence,
    counts: [{ denominationIdr: 100_000, quantity: 2 }],
    countedIdr: "200000",
    expectedIdr: "250000",
    varianceIdr: "-50000",
    heldCashOutIdr: "0",
    submittedBy,
    submittedAt: "2026-11-27T10:00:00.000Z",
  };
}

type World = {
  status: "open" | "closed";
  counts: ReturnType<typeof countRow>[];
  forceClose?: () => unknown;
};
let world: World;

function server() {
  net.respond = (call) => {
    const shiftPath = `/api/outlets/${OUTLET}/pos/shifts/${SHIFT}`;
    if (call.path === shiftPath && call.method === "GET")
      return {
        data: {
          shift: {
            id: SHIFT,
            cashierId: CASHIER,
            status: world.status,
            openedAt: "2026-11-27T08:00:00.000Z",
            businessDate: "2026-11-27",
          },
          movements: [],
          receiptGaps: [],
        },
      };
    if (call.path === `${shiftPath}/counts` && call.method === "GET")
      return { data: world.counts };
    if (call.path === `${shiftPath}/counts` && call.method === "POST") {
      world.counts.push(countRow(COUNT, world.counts.length + 1, SUPERVISOR));
      return {
        data: {
          id: COUNT,
          shiftId: SHIFT,
          sequence: world.counts.length,
          countedIdr: "200000",
          noteRequired: true,
          submittedAt: "2026-11-27T10:00:00.000Z",
        },
      };
    }
    if (call.path.startsWith("/api/pos-overrides/approvers"))
      return {
        data: [
          { userId: SUPERVISOR, displayName: "Supervisor Satu" },
          { userId: WITNESS, displayName: "Supervisor Dua" },
          { userId: CASHIER, displayName: "Kasir" },
        ],
      };
    if (call.path === "/api/pos-overrides") return { data: { id: OVERRIDE } };
    if (call.path === `${shiftPath}/force-close`) {
      if (world.forceClose) return world.forceClose();
      world.status = "closed";
      return { data: { id: SHIFT } };
    }
    throw new Error(`no response for ${call.method} ${call.path}`);
  };
}

const calls = (suffix: string, method = "POST") =>
  net.calls.filter((c) => c.path.endsWith(suffix) && c.method === method);

const approval = {
  shiftId: SHIFT,
  countId: COUNT,
  valueIdr: 50_000,
  approverUserId: WITNESS,
  approverName: "Supervisor Dua",
  pin: "123456",
  reason: "Menyetujui hitungan supervisor untuk penutupan paksa",
};

const NOTE = "Tablet kasir rusak, antrean offline belum terkirim";

beforeEach(() => {
  vi.stubEnv("DEV", false);
  net.calls.length = 0;
  discardForceCloseApproval(OUTLET, SHIFT);
  world = { status: "open", counts: [countRow(CASHIER_COUNT, 1, CASHIER)] };
  server();
});

describe("O4 force close on the real wire", () => {
  it("starts at the count while the supervisor has not counted (the cashier's count does not count)", async () => {
    const view = await fetchForceCloseView(OUTLET, SHIFT, viewer);
    expect(view).toMatchObject({
      shiftId: SHIFT,
      stage: "count",
      ownShift: false,
      count: null,
      stale: false,
      cashierId: CASHIER,
    });
  });

  it("tells the cashier of the shift they cannot force close it", async () => {
    const view = await fetchForceCloseView(OUTLET, SHIFT, {
      userId: CASHIER,
      name: "Kasir",
    });
    expect(view.ownShift).toBe(true);
  });

  it("sends the supervisor's count as a normal blind count, then waits for a third person", async () => {
    await submitForcedCount(
      OUTLET,
      {
        shiftId: SHIFT,
        counts: [
          { denominationIdr: 100_000, quantity: 2 },
          { denominationIdr: 50_000, quantity: 0 },
        ],
        otherAmountIdr: 0,
      },
      "force-count:one",
    );
    expect(calls("/counts")[0]?.body).toEqual({
      counts: [{ denominationIdr: 100_000, quantity: 2 }],
      idempotencyKey: "force-count:one",
    });
    const view = await fetchForceCloseView(OUTLET, SHIFT, viewer);
    expect(view.stage).toBe("witness");
    expect(view.count).toMatchObject({
      id: COUNT,
      countedIdr: 200_000,
      expectedIdr: 250_000,
      varianceIdr: -50_000,
      countedByName: "Supervisor Satu",
    });
  });

  it("offers witnesses who are neither the counter nor the cashier", async () => {
    const options = await fetchWitnesses(OUTLET, [SUPERVISOR, CASHIER]);
    expect(options).toEqual([{ userId: WITNESS, name: "Supervisor Dua" }]);
    expect(
      net.calls.find((c) => c.path.startsWith("/api/pos-overrides/approvers")),
    ).toBeDefined();
  });

  it("approves that exact count by the witness PIN (pos_shift_count, |variance|)", async () => {
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    await witnessForcedCount(OUTLET, approval, viewer);
    expect(calls("/api/pos-overrides")[0]?.body).toMatchObject({
      outletId: OUTLET,
      action: "cash_shift_close",
      valueIdr: 50_000,
      objectType: "pos_shift_count",
      objectId: COUNT,
      approval: {
        method: "supervisor_pin",
        approverUserId: WITNESS,
        pin: "123456",
      },
    });
    const view = await fetchForceCloseView(OUTLET, SHIFT, viewer);
    expect(view).toMatchObject({
      stage: "ready",
      witnessName: "Supervisor Dua",
    });
  });

  it("refuses the counter or the cashier as witness before any PIN is sent", async () => {
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    for (const approverUserId of [SUPERVISOR, CASHIER]) {
      await expect(
        witnessForcedCount(OUTLET, { ...approval, approverUserId }, viewer, {
          cashierId: CASHIER,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    }
    expect(calls("/api/pos-overrides")).toHaveLength(0);
  });

  it("closes with the count, the written reason, the witness and the override", async () => {
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    await witnessForcedCount(OUTLET, approval, viewer);
    await forceCloseShift(
      OUTLET,
      { shiftId: SHIFT, note: `  ${NOTE}  ` },
      "force-close:one",
    );
    expect(calls("/force-close")).toHaveLength(1);
    expect(calls("/force-close")[0]?.body).toEqual({
      countId: COUNT,
      note: NOTE,
      approvedBy: WITNESS,
      approvalRequestId: OVERRIDE,
      idempotencyKey: "force-close:one",
    });
    const view = await fetchForceCloseView(OUTLET, SHIFT, viewer);
    expect(view.stage).toBe("closed");
  });

  it("asks for a reason of at least 10 letters and sends nothing shorter", async () => {
    expect(forceCloseNoteValid("Rusak")).toBe(false);
    expect(forceCloseNoteValid("   tablet   ")).toBe(false);
    expect(forceCloseNoteValid("Tablet rusak")).toBe(true);
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    await witnessForcedCount(OUTLET, approval, viewer);
    await expect(
      forceCloseShift(OUTLET, { shiftId: SHIFT, note: "Rusak" }, "k:short1"),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls("/force-close")).toHaveLength(0);
  });

  it("will not close without the witness approval of the latest count", async () => {
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    await expect(
      forceCloseShift(OUTLET, { shiftId: SHIFT, note: NOTE }, "k:noapprove"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls("/force-close")).toHaveLength(0);
  });

  it("asks for a recount when the server finds the count stale", async () => {
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    await witnessForcedCount(OUTLET, approval, viewer);
    world.forceClose = () => {
      throw new ApiError(409, "SHIFT_COUNT_STALE", "Kas berubah.");
    };
    await expect(
      forceCloseShift(OUTLET, { shiftId: SHIFT, note: NOTE }, "k:stale1"),
    ).rejects.toMatchObject({ code: "SHIFT_COUNT_STALE" });
    const view = await fetchForceCloseView(OUTLET, SHIFT, viewer);
    expect(view.stale).toBe(true);
  });

  it("is stale when a newer count follows the supervisor's", async () => {
    world.counts.push(countRow(COUNT, 2, SUPERVISOR));
    world.counts.push(countRow(CASHIER_COUNT, 3, CASHIER));
    const view = await fetchForceCloseView(OUTLET, SHIFT, viewer);
    expect(view.stale).toBe(true);
  });
});
